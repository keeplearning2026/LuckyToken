import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { Credential } from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";

import { isSafeProviderId } from "../providers/provider-id.js";

export const PROVIDER_CREDENTIAL_RECORD_SCHEMA_VERSION = 1 as const;

export interface PersistedCredentialProfileV1 {
  readonly credentialId: string;
  readonly credentialGeneration: string;
  readonly authType: Credential["type"];
  readonly authMethodLabel: string;
  readonly displayName: string;
  readonly note?: string;
  readonly identityHint?: string;
  readonly enabled: boolean;
  readonly priority: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly credential: Credential;
}

export interface PersistedProviderCredentialRecordV1 {
  readonly schemaVersion: typeof PROVIDER_CREDENTIAL_RECORD_SCHEMA_VERSION;
  readonly providerId: string;
  readonly revision: string;
  readonly selectionGeneration: string;
  readonly activeCredentialId?: string;
  readonly switchPolicy: {
    readonly apiKeyOn429: boolean;
    readonly oauthOn429: boolean;
  };
  readonly profiles: readonly PersistedCredentialProfileV1[];
}

export type ManagementMutation<T> =
  | { readonly kind: "commit"; readonly record: PersistedProviderCredentialRecordV1; readonly value: T }
  | { readonly kind: "unchanged"; readonly value: T };

export type ManagementMutationResult<T> =
  | {
      readonly kind: "committed";
      readonly record: PersistedProviderCredentialRecordV1;
      readonly value: T;
    }
  | {
      readonly kind: "unchanged";
      readonly record: PersistedProviderCredentialRecordV1 | undefined;
      readonly value: T;
    }
  | {
      readonly kind: "revision_conflict";
      readonly record: PersistedProviderCredentialRecordV1 | undefined;
    };

export type SelectionMutationResult<T> = Exclude<
  ManagementMutationResult<T>,
  { readonly kind: "revision_conflict" }
>;

export interface ProviderCredentialRecordStore {
  listProviderIds(): Promise<readonly string[]>;
  read(providerId: string): Promise<PersistedProviderCredentialRecordV1 | undefined>;
  /** Hold the Provider selection lock without mutating the record. Used to
   * publish derived state only while its captured binding is still current. */
  withSelectionLock<T>(
    providerId: string,
    operation: (
      current: PersistedProviderCredentialRecordV1 | undefined,
      assertOwned: () => void,
    ) => Promise<T>,
  ): Promise<T>;
  modifyManagement<T>(
    providerId: string,
    expectedRevision: string,
    mutation: (
      current: PersistedProviderCredentialRecordV1 | undefined,
    ) => ManagementMutation<T>,
  ): Promise<ManagementMutationResult<T>>;
  modifyCredential(
    providerId: string,
    credentialId: string,
    credentialGeneration: string,
    mutation: (current: Credential) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined>;
  modifySelection<T>(
    providerId: string,
    mutation: (
      current: PersistedProviderCredentialRecordV1 | undefined,
    ) => ManagementMutation<T>,
  ): Promise<SelectionMutationResult<T>>;
}

export const NO_PROVIDER_RECORD_REVISION = "absent";

const PROFILE_DIRECTORY_MODE = 0o700;
const PROFILE_FILE_MODE = 0o600;
const LOCK_STALE_MS = 30_000;

export class ProviderCredentialRecordSyntaxError extends Error {
  readonly code = "PROVIDER_CREDENTIAL_RECORD_SYNTAX" as const;

  constructor() {
    super("Invalid Provider credential record: expected valid JSON");
    this.name = "ProviderCredentialRecordSyntaxError";
  }
}

export class ProviderCredentialRecordShapeError extends Error {
  readonly code = "PROVIDER_CREDENTIAL_RECORD_SHAPE" as const;

  constructor(message: string) {
    super(message);
    this.name = "ProviderCredentialRecordShapeError";
  }
}

export interface ProviderCredentialRecordLockLease {
  assertOwned(): void;
  release(): Promise<void>;
}

export interface ProviderCredentialRecordLock {
  acquire(path: string): Promise<ProviderCredentialRecordLockLease>;
}

function createNodeProviderCredentialRecordLock(): ProviderCredentialRecordLock {
  return Object.freeze({
    async acquire(path: string): Promise<ProviderCredentialRecordLockLease> {
      let compromised: Error | undefined;
      const release = await lockfile.lock(path, {
        realpath: false,
        retries: 0,
        stale: LOCK_STALE_MS,
        onCompromised: (error) => {
          compromised = error;
        },
      });
      return Object.freeze({
        assertOwned(): void {
          if (compromised !== undefined) {
            throw new Error("Provider credential record lock ownership was compromised", {
              cause: compromised,
            });
          }
        },
        release,
      });
    },
  });
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return isObject(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isCredential(value: unknown): value is Credential {
  if (!isObject(value)) return false;
  if (value.type === "api_key") {
    return (
      (value.key === undefined || typeof value.key === "string") &&
      (value.env === undefined || isStringRecord(value.env))
    );
  }
  return (
    value.type === "oauth" &&
    typeof value.access === "string" &&
    typeof value.refresh === "string" &&
    typeof value.expires === "number" &&
    Number.isFinite(value.expires)
  );
}

function boundedString(
  value: unknown,
  maximumCharacters: number,
  options: { readonly allowEmpty?: boolean; readonly trimmed?: boolean } = {},
): value is string {
  if (typeof value !== "string") return false;
  if (options.allowEmpty !== true && value.length === 0) return false;
  if (options.trimmed === true && value.trim() !== value) return false;
  return Array.from(value).length <= maximumCharacters;
}

function boundedOptionalString(
  value: unknown,
  maximumCharacters: number,
): boolean {
  return value === undefined || boundedString(value, maximumCharacters, { allowEmpty: true });
}

function isProfile(value: unknown): value is PersistedCredentialProfileV1 {
  if (!isObject(value) || !isCredential(value.credential)) return false;
  return (
    boundedString(value.credentialId, 256) &&
    boundedString(value.credentialGeneration, 256) &&
    (value.authType === "api_key" || value.authType === "oauth") &&
    value.credential.type === value.authType &&
    boundedString(value.authMethodLabel, 128, { trimmed: true }) &&
    boundedString(value.displayName, 64, { trimmed: true }) &&
    boundedOptionalString(value.note, 200) &&
    boundedOptionalString(value.identityHint, 64) &&
    typeof value.enabled === "boolean" &&
    Number.isSafeInteger(value.priority) &&
    typeof value.createdAt === "number" &&
    Number.isSafeInteger(value.createdAt) &&
    value.createdAt >= 0 &&
    typeof value.updatedAt === "number" &&
    Number.isSafeInteger(value.updatedAt) &&
    value.updatedAt >= 0
  );
}

function parseRecord(content: string, expectedProviderId: string): PersistedProviderCredentialRecordV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw new ProviderCredentialRecordSyntaxError();
  }
  if (
    !isObject(parsed) ||
    parsed.schemaVersion !== PROVIDER_CREDENTIAL_RECORD_SCHEMA_VERSION ||
    parsed.providerId !== expectedProviderId ||
    !boundedString(parsed.revision, 256) ||
    !boundedString(parsed.selectionGeneration, 256) ||
    !(
      parsed.activeCredentialId === undefined ||
      boundedString(parsed.activeCredentialId, 256)
    ) ||
    !isObject(parsed.switchPolicy) ||
    typeof parsed.switchPolicy.apiKeyOn429 !== "boolean" ||
    typeof parsed.switchPolicy.oauthOn429 !== "boolean" ||
    !Array.isArray(parsed.profiles) ||
    !parsed.profiles.every(isProfile)
  ) {
    throw new ProviderCredentialRecordShapeError(
      `Invalid Provider credential record for ${JSON.stringify(expectedProviderId)}`,
    );
  }
  const record = parsed as unknown as PersistedProviderCredentialRecordV1;
  const credentialIds = new Set<string>();
  const credentialGenerations = new Set<string>();
  const displayNames = new Set<string>();
  for (const profile of record.profiles) {
    const normalizedName = profile.displayName.toLocaleLowerCase();
    if (
      credentialIds.has(profile.credentialId) ||
      credentialGenerations.has(profile.credentialGeneration) ||
      displayNames.has(normalizedName)
    ) {
      throw new ProviderCredentialRecordShapeError(
        `Invalid duplicate Provider credential Profile identity for ${JSON.stringify(expectedProviderId)}`,
      );
    }
    credentialIds.add(profile.credentialId);
    credentialGenerations.add(profile.credentialGeneration);
    displayNames.add(normalizedName);
  }
  if (
    record.activeCredentialId !== undefined &&
    !record.profiles.some(
      (profile) =>
        profile.credentialId === record.activeCredentialId && profile.enabled,
    )
  ) {
    throw new ProviderCredentialRecordShapeError(
      `Invalid active Provider credential Profile for ${JSON.stringify(expectedProviderId)}`,
    );
  }
  return structuredClone(record);
}

function validateRecord(
  record: PersistedProviderCredentialRecordV1,
  expectedProviderId: string,
): void {
  parseRecord(JSON.stringify(record), expectedProviderId);
}

function cloneRecord(
  record: PersistedProviderCredentialRecordV1 | undefined,
): PersistedProviderCredentialRecordV1 | undefined {
  return record === undefined ? undefined : structuredClone(record);
}

export function createInMemoryProviderCredentialRecordStore(options: {
  readonly createRevision: () => string;
}): ProviderCredentialRecordStore {
  const records = new Map<string, PersistedProviderCredentialRecordV1>();
  const tails = new Map<string, Promise<void>>();
  const credentialTails = new Map<string, Promise<void>>();

  const serializedIn = async <T>(
    targetTails: Map<string, Promise<void>>,
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const previous = targetTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    targetTails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (targetTails.get(key) === tail) {
        targetTails.delete(key);
      }
    }
  };

  const serialized = <T>(providerId: string, operation: () => Promise<T>): Promise<T> =>
    serializedIn(tails, providerId, operation);

  return Object.freeze({
    async listProviderIds(): Promise<readonly string[]> {
      return Object.freeze([...records.keys()].sort());
    },

    async read(providerId: string): Promise<PersistedProviderCredentialRecordV1 | undefined> {
      return cloneRecord(records.get(providerId));
    },

    async withSelectionLock<T>(
      providerId: string,
      operation: (
        current: PersistedProviderCredentialRecordV1 | undefined,
        assertOwned: () => void,
      ) => Promise<T>,
    ): Promise<T> {
      return serialized(providerId, () =>
        operation(cloneRecord(records.get(providerId)), () => undefined),
      );
    },

    async modifyManagement<T>(
      providerId: string,
      expectedRevision: string,
      mutation: (
        current: PersistedProviderCredentialRecordV1 | undefined,
      ) => ManagementMutation<T>,
    ): Promise<ManagementMutationResult<T>> {
      return serialized(providerId, async () => {
        const current = cloneRecord(records.get(providerId));
        const actualRevision = current?.revision ?? NO_PROVIDER_RECORD_REVISION;
        if (expectedRevision !== actualRevision) {
          return Object.freeze({ kind: "revision_conflict", record: current });
        }

        const outcome = mutation(current);
        if (outcome.kind === "unchanged") {
          return Object.freeze({ kind: "unchanged", record: current, value: outcome.value });
        }

        const committed = structuredClone({
          ...outcome.record,
          revision: options.createRevision(),
        });
        records.set(providerId, committed);
        return Object.freeze({
          kind: "committed",
          record: cloneRecord(committed)!,
          value: outcome.value,
        });
      });
    },

    async modifyCredential(
      providerId: string,
      credentialId: string,
      credentialGeneration: string,
      mutation: (current: Credential) => Promise<Credential | undefined>,
    ): Promise<Credential | undefined> {
      return serializedIn(
        credentialTails,
        `${providerId}\u0000${credentialId}`,
        async () => {
          const before = records.get(providerId)?.profiles.find(
            (profile) =>
              profile.credentialId === credentialId &&
              profile.credentialGeneration === credentialGeneration,
          );
          if (before === undefined) return undefined;
          const next = await mutation(structuredClone(before.credential));
          if (next !== undefined && (!isCredential(next) || next.type !== before.authType)) {
            throw new ProviderCredentialRecordShapeError(
              "Provider credential refresh returned an invalid credential payload",
            );
          }

          return serialized(providerId, async () => {
            const current = records.get(providerId);
            const profileIndex = current?.profiles.findIndex(
              (profile) =>
                profile.credentialId === credentialId &&
                profile.credentialGeneration === credentialGeneration,
            ) ?? -1;
            if (current === undefined || profileIndex < 0) return undefined;
            if (next === undefined) {
              return structuredClone(current.profiles[profileIndex]!.credential);
            }
            const profiles = [...current.profiles];
            profiles[profileIndex] = {
              ...profiles[profileIndex]!,
              credential: structuredClone(next),
            };
            records.set(providerId, { ...current, profiles });
            return structuredClone(next);
          });
        },
      );
    },

    async modifySelection<T>(
      providerId: string,
      mutation: (
        current: PersistedProviderCredentialRecordV1 | undefined,
      ) => ManagementMutation<T>,
    ): Promise<SelectionMutationResult<T>> {
      return serialized(providerId, async () => {
        const current = cloneRecord(records.get(providerId));
        const outcome = mutation(current);
        if (outcome.kind === "unchanged") {
          return Object.freeze({ kind: "unchanged", record: current, value: outcome.value });
        }
        const committed = structuredClone({
          ...outcome.record,
          revision: options.createRevision(),
        });
        records.set(providerId, committed);
        return Object.freeze({
          kind: "committed",
          record: cloneRecord(committed)!,
          value: outcome.value,
        });
      });
    },
  });
}

class FileProviderCredentialRecordStore implements ProviderCredentialRecordStore {
  readonly #directory: string;
  readonly #createRevision: () => string;
  readonly #lock: ProviderCredentialRecordLock;
  readonly #onLockDegraded: (error: unknown) => void;

  constructor(options: {
    readonly piDirectory: string;
    readonly createRevision: () => string;
    readonly lock?: ProviderCredentialRecordLock;
    readonly onLockDegraded?: (error: unknown) => void;
  }) {
    this.#directory = resolve(options.piDirectory, "credential-profiles");
    this.#createRevision = options.createRevision;
    this.#lock = options.lock ?? createNodeProviderCredentialRecordLock();
    this.#onLockDegraded = options.onLockDegraded ?? (() => undefined);
  }

  #recordPath(providerId: string): string {
    if (!isSafeProviderId(providerId)) {
      throw new Error(`Unsafe Provider ID ${JSON.stringify(providerId)}`);
    }
    return join(this.#directory, `${providerId}.json`);
  }

  async #ensureDirectory(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: PROFILE_DIRECTORY_MODE });
    await chmod(this.#directory, PROFILE_DIRECTORY_MODE);
  }

  async #readRecord(providerId: string): Promise<PersistedProviderCredentialRecordV1 | undefined> {
    const recordPath = this.#recordPath(providerId);
    let content: string;
    try {
      content = await readFile(recordPath, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
    return parseRecord(content, providerId);
  }

  async #acquireLock(recordPath: string): Promise<ProviderCredentialRecordLockLease> {
    const deadline = Date.now() + LOCK_STALE_MS;
    let retry = 0;
    while (true) {
      try {
        const lease = await this.#lock.acquire(recordPath);
        try {
          lease.assertOwned();
          return lease;
        } catch (error) {
          try {
            await lease.release();
          } catch (releaseError) {
            throw new AggregateError(
              [error, releaseError],
              "Provider credential record lock acquisition was compromised and release failed",
            );
          }
          throw error;
        }
      } catch (error) {
        const remainingMs = deadline - Date.now();
        if (errorCode(error) !== "ELOCKED" || remainingMs <= 0) throw error;
        const delayMs = Math.min(10 * 2 ** retry, 1_000, remainingMs);
        retry += 1;
        await sleep(delayMs);
      }
    }
  }

  async #withPathLock<T>(
    path: string,
    operation: (assertOwned: () => void) => Promise<T>,
  ): Promise<T> {
    const lease = await this.#acquireLock(path);
    let value: T | undefined;
    let operationError: unknown;
    try {
      lease.assertOwned();
      value = await operation(() => lease.assertOwned());
      lease.assertOwned();
    } catch (error) {
      operationError = error;
    }
    let releaseError: unknown;
    try {
      await lease.release();
    } catch (error) {
      releaseError = error;
    }
    if (operationError !== undefined && releaseError !== undefined) {
      throw new AggregateError(
        [operationError, releaseError],
        "Provider credential record operation and lock release both failed",
      );
    }
    if (operationError !== undefined) throw operationError;
    if (releaseError !== undefined) {
      // The operation already completed (and may have atomically published).
      // Report lock degradation out-of-band without lying to the caller that
      // the durable mutation failed.
      try {
        this.#onLockDegraded(releaseError);
      } catch {
        // Diagnostics must not rewrite a committed operation's outcome.
      }
    }
    return value as T;
  }

  async #writeRecord(
    recordPath: string,
    record: PersistedProviderCredentialRecordV1,
    assertOwned: () => void,
  ): Promise<void> {
    const temporaryPath = `${recordPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: PROFILE_FILE_MODE,
      });
      await chmod(temporaryPath, PROFILE_FILE_MODE);
      // Staging may take time. The only ownership check that protects the
      // atomic publication is the one immediately before rename.
      assertOwned();
      await rename(temporaryPath, recordPath);
      await chmod(recordPath, PROFILE_FILE_MODE);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  async listProviderIds(): Promise<readonly string[]> {
    let entries;
    try {
      entries = await readdir(this.#directory, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return Object.freeze([]);
      throw error;
    }
    return Object.freeze(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name.slice(0, -".json".length))
        .filter(isSafeProviderId)
        .sort(),
    );
  }

  read(providerId: string): Promise<PersistedProviderCredentialRecordV1 | undefined> {
    return this.#readRecord(providerId);
  }

  async withSelectionLock<T>(
    providerId: string,
    operation: (
      current: PersistedProviderCredentialRecordV1 | undefined,
      assertOwned: () => void,
    ) => Promise<T>,
  ): Promise<T> {
    await this.#ensureDirectory();
    const recordPath = this.#recordPath(providerId);
    return this.#withPathLock(recordPath, async (assertOwned) =>
      operation(cloneRecord(await this.#readRecord(providerId)), assertOwned),
    );
  }

  async modifyManagement<T>(
    providerId: string,
    expectedRevision: string,
    mutation: (
      current: PersistedProviderCredentialRecordV1 | undefined,
    ) => ManagementMutation<T>,
  ): Promise<ManagementMutationResult<T>> {
    await this.#ensureDirectory();
    const recordPath = this.#recordPath(providerId);
    return this.#withPathLock(recordPath, async (assertOwned) => {
      const current = await this.#readRecord(providerId);
      const actualRevision = current?.revision ?? NO_PROVIDER_RECORD_REVISION;
      if (expectedRevision !== actualRevision) {
        return Object.freeze({ kind: "revision_conflict", record: current });
      }
      const outcome = mutation(cloneRecord(current));
      if (outcome.kind === "unchanged") {
        return Object.freeze({ kind: "unchanged", record: current, value: outcome.value });
      }
      const committed = structuredClone({
        ...outcome.record,
        revision: this.#createRevision(),
      });
      validateRecord(committed, providerId);
      assertOwned();
      await this.#writeRecord(recordPath, committed, assertOwned);
      return Object.freeze({
        kind: "committed",
        record: cloneRecord(committed)!,
        value: outcome.value,
      });
    });
  }

  async modifyCredential(
    providerId: string,
    credentialId: string,
    credentialGeneration: string,
    mutation: (current: Credential) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    await this.#ensureDirectory();
    const recordPath = this.#recordPath(providerId);
    const credentialHash = createHash("sha256")
      .update(credentialId, "utf8")
      .digest("hex");
    const refreshLockPath = join(
      this.#directory,
      `${providerId}.${credentialHash}.refresh`,
    );
    return this.#withPathLock(refreshLockPath, async (assertRefreshOwned) => {
      const before = await this.#withPathLock(recordPath, async () => {
        const record = await this.#readRecord(providerId);
        return record?.profiles.find(
          (profile) =>
            profile.credentialId === credentialId &&
            profile.credentialGeneration === credentialGeneration,
        );
      });
      if (before === undefined) return undefined;

      const next = await mutation(structuredClone(before.credential));
      if (next !== undefined && (!isCredential(next) || next.type !== before.authType)) {
        throw new ProviderCredentialRecordShapeError(
          "Provider credential refresh returned an invalid credential payload",
        );
      }

      assertRefreshOwned();
      return this.#withPathLock(recordPath, async (assertOwned) => {
        const current = await this.#readRecord(providerId);
        const profileIndex = current?.profiles.findIndex(
          (profile) =>
            profile.credentialId === credentialId &&
            profile.credentialGeneration === credentialGeneration,
        ) ?? -1;
        if (current === undefined || profileIndex < 0) return undefined;
        if (next === undefined) {
          return structuredClone(current.profiles[profileIndex]!.credential);
        }
        const profiles = [...current.profiles];
        profiles[profileIndex] = {
          ...profiles[profileIndex]!,
          credential: structuredClone(next),
        };
        const committed = { ...current, profiles };
        validateRecord(committed, providerId);
        assertOwned();
        await this.#writeRecord(recordPath, committed, () => {
          assertRefreshOwned();
          assertOwned();
        });
        return structuredClone(next);
      });
    });
  }

  async modifySelection<T>(
    providerId: string,
    mutation: (
      current: PersistedProviderCredentialRecordV1 | undefined,
    ) => ManagementMutation<T>,
  ): Promise<SelectionMutationResult<T>> {
    await this.#ensureDirectory();
    const recordPath = this.#recordPath(providerId);
    return this.#withPathLock(recordPath, async (assertOwned) => {
      const current = await this.#readRecord(providerId);
      const outcome = mutation(cloneRecord(current));
      if (outcome.kind === "unchanged") {
        return Object.freeze({ kind: "unchanged", record: current, value: outcome.value });
      }
      const committed = structuredClone({
        ...outcome.record,
        revision: this.#createRevision(),
      });
      validateRecord(committed, providerId);
      assertOwned();
      await this.#writeRecord(recordPath, committed, assertOwned);
      return Object.freeze({
        kind: "committed",
        record: cloneRecord(committed)!,
        value: outcome.value,
      });
    });
  }
}

export function createFileProviderCredentialRecordStore(options: {
  readonly piDirectory: string;
  readonly createRevision: () => string;
  readonly lock?: ProviderCredentialRecordLock;
  readonly onLockDegraded?: (error: unknown) => void;
}): ProviderCredentialRecordStore {
  return new FileProviderCredentialRecordStore(options);
}
