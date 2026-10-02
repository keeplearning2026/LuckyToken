import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import lockfile from "proper-lockfile";

import { isSafeProviderId } from "../providers/provider-id.js";
import type { AcquisitionKind } from "./acquisition.js";
import {
  credentialDocumentRevision,
  isExternalCredentialPath,
  readCredentialDocumentFile,
  type CredentialDocumentReference,
} from "./credential-document.js";

export const PROVIDER_CREDENTIAL_RECORD_SCHEMA_VERSION = 3 as const;
export const DEFAULT_PROVIDER_CREDENTIAL_ORPHAN_GRACE_MS = 10 * 60_000;

export interface PersistedCredentialProfile {
  readonly credentialId: string;
  readonly acquisitionKind: AcquisitionKind;
  readonly reference: CredentialDocumentReference;
  readonly displayName: string;
  readonly note?: string;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface PersistedProviderCredentialRecord {
  readonly schemaVersion: typeof PROVIDER_CREDENTIAL_RECORD_SCHEMA_VERSION;
  readonly providerId: string;
  readonly revision: string;
  readonly selectionGeneration: string;
  readonly activeCredentialId?: string;
  readonly switchPolicy: {
    readonly apiKeyOn429: boolean;
    readonly oauthOn429: boolean;
  };
  readonly profiles: readonly PersistedCredentialProfile[];
}

export interface CredentialPublication {
  readonly credentialId: string;
  readonly reference: CredentialDocumentReference;
  /** Managed document content. External publications must omit it. */
  readonly content?: string;
}

export type ProviderCredentialDocumentRead =
  | {
      readonly state: "ok";
      readonly profile: PersistedCredentialProfile;
      readonly raw: string;
      /** Ephemeral content fingerprint; never persisted in Profile state. */
      readonly contentRevision: string;
    }
  | { readonly state: "missing" | "invalid" | "unreadable" };

export interface CollectProviderCredentialOrphansOptions {
  readonly graceMs?: number;
  readonly now?: () => number;
}

export type ManagementMutation<T> =
  | {
      readonly kind: "commit";
      readonly record: PersistedProviderCredentialRecord;
      readonly value: T;
    }
  | { readonly kind: "unchanged"; readonly value: T };

export type ManagementMutationResult<T> =
  | {
      readonly kind: "committed";
      readonly record: PersistedProviderCredentialRecord;
      readonly value: T;
    }
  | {
      readonly kind: "unchanged";
      readonly record: PersistedProviderCredentialRecord | undefined;
      readonly value: T;
    }
  | {
      readonly kind: "revision_conflict";
      readonly record: PersistedProviderCredentialRecord | undefined;
    };

export type SelectionMutationResult<T> = Exclude<
  ManagementMutationResult<T>,
  { readonly kind: "revision_conflict" }
>;

export interface ProviderCredentialRecordStore {
  listProviderIds(): Promise<readonly string[]>;
  read(providerId: string): Promise<PersistedProviderCredentialRecord | undefined>;

  withSelectionLock<T>(
    providerId: string,
    operation: (
      current: PersistedProviderCredentialRecord | undefined,
      assertOwned: () => void,
    ) => Promise<T>,
  ): Promise<T>;

  modifyManagement<T>(
    providerId: string,
    expectedRevision: string,
    mutation: (
      current: PersistedProviderCredentialRecord | undefined,
    ) => ManagementMutation<T>,
  ): Promise<ManagementMutationResult<T>>;

  /** Acquisition publication. Global management serialization owns user-level
   * concurrency, so this operation intentionally has no expectedRevision. */
  publishCredential<T>(
    providerId: string,
    publication: CredentialPublication,
    mutation: (
      current: PersistedProviderCredentialRecord | undefined,
    ) => ManagementMutation<T>,
  ): Promise<Exclude<ManagementMutationResult<T>, { readonly kind: "revision_conflict" }>>;

  /** Read the current referenced document for one exact existing enabled
   * Profile. No credential parsing is performed here. */
  readCredentialDocument(
    providerId: string,
    credentialId: string,
  ): Promise<ProviderCredentialDocumentRead>;

  /** Serialize on one managed document while allowing Profile management to
   * proceed during the callback. Publication rechecks current Profile state. */
  modifyManagedDocument(
    providerId: string,
    credentialId: string,
    mutation: (currentRaw: string) => Promise<string | undefined>,
  ): Promise<string | undefined>;

  modifySelection<T>(
    providerId: string,
    mutation: (
      current: PersistedProviderCredentialRecord | undefined,
    ) => ManagementMutation<T>,
  ): Promise<SelectionMutationResult<T>>;

  collectOrphans(
    providerId: string,
    options?: CollectProviderCredentialOrphansOptions,
  ): Promise<readonly string[]>;
}

export const NO_PROVIDER_RECORD_REVISION = "absent";

const RECORD_DIRECTORY_NAME = "credential-profiles";
const CREDENTIAL_DIRECTORY_NAME = "credentials";
const MANAGED_DOCUMENT_NAME = "credential.auth.json";
const PROFILE_DIRECTORY_MODE = 0o700;
const PROFILE_FILE_MODE = 0o600;
const LOCK_STALE_MS = 30_000;
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const TOLERATED_SYNC_ERROR_CODES = new Set([
  "EACCES",
  "EBADF",
  "EINVAL",
  "EISDIR",
  "ENOSYS",
  "ENOTSUP",
  "EPERM",
]);

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

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
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

function boundedOptionalString(value: unknown, maximumCharacters: number): boolean {
  return value === undefined ||
    boundedString(value, maximumCharacters, { allowEmpty: true });
}

function isSafeSegment(value: string): boolean {
  return SAFE_SEGMENT_PATTERN.test(value) &&
    !value.endsWith(".") &&
    !value.endsWith(" ");
}

function assertSafeSegment(value: string, description: string): void {
  if (!isSafeSegment(value)) {
    throw new ProviderCredentialRecordShapeError(
      `Unsafe Provider credential ${description} ${JSON.stringify(value)}`,
    );
  }
}

function expectedManagedPath(providerId: string, credentialId: string): string {
  return `${providerId}/${credentialId}/${MANAGED_DOCUMENT_NAME}`;
}

export function managedCredentialReference(
  providerId: string,
  credentialId: string,
): CredentialDocumentReference {
  if (!isSafeProviderId(providerId)) {
    throw new ProviderCredentialRecordShapeError(
      `Unsafe Provider ID ${JSON.stringify(providerId)}`,
    );
  }
  assertSafeSegment(credentialId, "credential ID");
  return Object.freeze({
    owner: "managed" as const,
    path: expectedManagedPath(providerId, credentialId),
  });
}

export function externalCredentialReference(path: string): CredentialDocumentReference {
  if (!boundedString(path, 4096, { trimmed: true }) || !isExternalCredentialPath(path)) {
    throw new ProviderCredentialRecordShapeError(
      "External credential references require a non-empty absolute path",
    );
  }
  return Object.freeze({ owner: "external" as const, path });
}

function isCredentialReference(
  value: unknown,
  providerId: string,
  credentialId: string,
  acquisitionKind: AcquisitionKind,
): value is CredentialDocumentReference {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ["owner", "path"]) ||
    (value.owner !== "managed" && value.owner !== "external") ||
    !boundedString(value.path, 4096, { trimmed: true })
  ) {
    return false;
  }
  if (acquisitionKind === "local_oauth") {
    return value.owner === "external" && isExternalCredentialPath(value.path);
  }
  return value.owner === "managed" &&
    value.path === expectedManagedPath(providerId, credentialId);
}

function isProfile(
  value: unknown,
  providerId: string,
): value is PersistedCredentialProfile {
  if (!isObject(value)) return false;
  if (!hasOnlyKeys(value, [
    "credentialId",
    "acquisitionKind",
    "reference",
    "displayName",
    "note",
    "enabled",
    "createdAt",
    "updatedAt",
  ])) {
    return false;
  }
  if (
    !boundedString(value.credentialId, 256) ||
    !isSafeSegment(value.credentialId) ||
    (value.acquisitionKind !== "api_key" &&
      value.acquisitionKind !== "oauth" &&
      value.acquisitionKind !== "local_oauth") ||
    !boundedString(value.displayName, 64, { trimmed: true }) ||
    !boundedOptionalString(value.note, 200) ||
    typeof value.enabled !== "boolean" ||
    typeof value.createdAt !== "number" ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0 ||
    typeof value.updatedAt !== "number" ||
    !Number.isSafeInteger(value.updatedAt) ||
    value.updatedAt < 0
  ) {
    return false;
  }
  return isCredentialReference(
    value.reference,
    providerId,
    value.credentialId,
    value.acquisitionKind,
  );
}

function parseRecord(
  content: string,
  expectedProviderId: string,
): PersistedProviderCredentialRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw new ProviderCredentialRecordSyntaxError();
  }
  if (
    !isObject(parsed) ||
    !hasOnlyKeys(parsed, [
      "schemaVersion",
      "providerId",
      "revision",
      "selectionGeneration",
      "activeCredentialId",
      "switchPolicy",
      "profiles",
    ]) ||
    parsed.schemaVersion !== PROVIDER_CREDENTIAL_RECORD_SCHEMA_VERSION ||
    parsed.providerId !== expectedProviderId ||
    !boundedString(parsed.revision, 256) ||
    !boundedString(parsed.selectionGeneration, 256) ||
    !(parsed.activeCredentialId === undefined ||
      boundedString(parsed.activeCredentialId, 256)) ||
    !isObject(parsed.switchPolicy) ||
    !hasOnlyKeys(parsed.switchPolicy, ["apiKeyOn429", "oauthOn429"]) ||
    typeof parsed.switchPolicy.apiKeyOn429 !== "boolean" ||
    typeof parsed.switchPolicy.oauthOn429 !== "boolean" ||
    !Array.isArray(parsed.profiles) ||
    !parsed.profiles.every((profile) => isProfile(profile, expectedProviderId))
  ) {
    throw new ProviderCredentialRecordShapeError(
      `Invalid Provider credential record for ${JSON.stringify(expectedProviderId)}`,
    );
  }

  const record = parsed as unknown as PersistedProviderCredentialRecord;
  const credentialIds = new Set<string>();
  const displayNames = new Set<string>();
  let localOAuthCount = 0;
  for (const profile of record.profiles) {
    if (profile.acquisitionKind === "local_oauth") localOAuthCount += 1;
    const displayName = profile.displayName.toLocaleLowerCase();
    if (credentialIds.has(profile.credentialId) || displayNames.has(displayName)) {
      throw new ProviderCredentialRecordShapeError(
        `Invalid duplicate Provider credential Profile identity for ${JSON.stringify(expectedProviderId)}`,
      );
    }
    credentialIds.add(profile.credentialId);
    displayNames.add(displayName);
  }
  if (localOAuthCount > 1) {
    throw new ProviderCredentialRecordShapeError(
      "A Provider may have at most one local_oauth Profile",
    );
  }
  if (
    record.activeCredentialId !== undefined &&
    !record.profiles.some(
      (profile) =>
        profile.credentialId === record.activeCredentialId &&
        profile.enabled,
    )
  ) {
    throw new ProviderCredentialRecordShapeError(
      `Invalid active Provider credential Profile for ${JSON.stringify(expectedProviderId)}`,
    );
  }
  return structuredClone(record);
}

function validateRecord(
  record: PersistedProviderCredentialRecord,
  expectedProviderId: string,
): void {
  parseRecord(JSON.stringify(record), expectedProviderId);
}

export function parseProviderCredentialRecord(
  content: string,
  expectedProviderId: string,
): PersistedProviderCredentialRecord {
  return parseRecord(content, expectedProviderId);
}

function cloneRecord(
  record: PersistedProviderCredentialRecord | undefined,
): PersistedProviderCredentialRecord | undefined {
  return record === undefined ? undefined : structuredClone(record);
}

function publicationProfile(
  record: PersistedProviderCredentialRecord,
  publication: CredentialPublication,
): PersistedCredentialProfile {
  const profile = record.profiles.find(
    (candidate) => candidate.credentialId === publication.credentialId,
  );
  if (
    profile === undefined ||
    profile.reference.owner !== publication.reference.owner ||
    profile.reference.path !== publication.reference.path
  ) {
    throw new ProviderCredentialRecordShapeError(
      "Committed Provider credential record does not reference the published document",
    );
  }
  return profile;
}

function validatePublication(
  providerId: string,
  publication: CredentialPublication,
): void {
  if (!isSafeProviderId(providerId)) {
    throw new ProviderCredentialRecordShapeError(
      `Unsafe Provider ID ${JSON.stringify(providerId)}`,
    );
  }
  assertSafeSegment(publication.credentialId, "credential ID");

  if (publication.reference.owner === "managed") {
    if (
      publication.reference.path !==
        expectedManagedPath(providerId, publication.credentialId) ||
      publication.content === undefined
    ) {
      throw new ProviderCredentialRecordShapeError(
        "Invalid managed Provider credential publication",
      );
    }
  } else if (
    publication.content !== undefined ||
    !isExternalCredentialPath(publication.reference.path)
  ) {
    throw new ProviderCredentialRecordShapeError(
      "Invalid external Provider credential publication",
    );
  }
}

function isToleratedSyncFailure(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && TOLERATED_SYNC_ERROR_CODES.has(code);
}

async function syncFileHandle(handle: FileHandle): Promise<void> {
  try {
    await handle.sync();
  } catch (error) {
    if (!isToleratedSyncFailure(error)) throw error;
  }
}

async function syncDirectoryPath(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    await syncFileHandle(handle);
  } catch (error) {
    if (!isToleratedSyncFailure(error)) throw error;
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
  }
}

async function writeDurableFile(options: {
  readonly path: string;
  readonly content: string;
  readonly assertOwned?: () => void;
  readonly validatePath?: () => Promise<void>;
}): Promise<void> {
  await options.validatePath?.();
  await mkdir(dirname(options.path), {
    recursive: true,
    mode: PROFILE_DIRECTORY_MODE,
  });
  const temporaryPath =
    `${options.path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const handle = await open(temporaryPath, "wx", PROFILE_FILE_MODE);
    try {
      await handle.writeFile(options.content, "utf8");
      await syncFileHandle(handle);
    } finally {
      await handle.close().catch(() => undefined);
    }
    await chmod(temporaryPath, PROFILE_FILE_MODE).catch(() => undefined);
    for (let attempt = 0; ; attempt += 1) {
      options.assertOwned?.();
      await options.validatePath?.();
      try {
        await rename(temporaryPath, options.path);
        break;
      } catch (error) {
        if (
          process.platform !== "win32" ||
          attempt >= 5 ||
          !["EPERM", "EACCES", "EBUSY"].includes(errorCode(error) ?? "")
        ) {
          throw error;
        }
        await sleep(15 * (attempt + 1));
      }
    }
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  await chmod(options.path, PROFILE_FILE_MODE).catch(() => undefined);
  await syncDirectoryPath(dirname(options.path));
}

interface InMemoryDocument {
  readonly raw: string;
  readonly publishedAt: number;
}

export function createInMemoryProviderCredentialRecordStore(options: {
  readonly createRevision: () => string;
  readonly now?: () => number;
}): ProviderCredentialRecordStore {
  const records = new Map<string, PersistedProviderCredentialRecord>();
  const documents = new Map<string, Map<string, InMemoryDocument>>();
  const providerTails = new Map<string, Promise<void>>();
  const credentialTails = new Map<string, Promise<void>>();
  const now = options.now ?? Date.now;

  const serializedIn = async <T>(
    tails: Map<string, Promise<void>>,
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveCurrent) => {
      release = resolveCurrent;
    });
    const tail = previous.then(() => current);
    tails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };

  const serializedProvider = <T>(
    providerId: string,
    operation: () => Promise<T>,
  ): Promise<T> => serializedIn(providerTails, providerId, operation);

  const credentialKey = (providerId: string, credentialId: string): string =>
    `${providerId}\u0000${credentialId}`;

  const store: ProviderCredentialRecordStore = {
    async listProviderIds() {
      return Object.freeze([...records.keys()].sort());
    },

    async read(providerId) {
      return cloneRecord(records.get(providerId));
    },

    async withSelectionLock(providerId, operation) {
      return serializedProvider(providerId, () =>
        operation(cloneRecord(records.get(providerId)), () => undefined),
      );
    },

    async modifyManagement(providerId, expectedRevision, mutation) {
      return serializedProvider(providerId, async () => {
        const current = cloneRecord(records.get(providerId));
        if ((current?.revision ?? NO_PROVIDER_RECORD_REVISION) !== expectedRevision) {
          return Object.freeze({ kind: "revision_conflict" as const, record: current });
        }
        const outcome = mutation(current);
        if (outcome.kind === "unchanged") {
          return Object.freeze({
            kind: "unchanged" as const,
            record: current,
            value: outcome.value,
          });
        }
        const committed = structuredClone({
          ...outcome.record,
          revision: options.createRevision(),
        });
        validateRecord(committed, providerId);
        records.set(providerId, committed);
        return Object.freeze({
          kind: "committed" as const,
          record: cloneRecord(committed)!,
          value: outcome.value,
        });
      });
    },

    async publishCredential(providerId, publication, mutation) {
      validatePublication(providerId, publication);
      return serializedIn(
        credentialTails,
        credentialKey(providerId, publication.credentialId),
        () => serializedProvider(providerId, async () => {
          const current = cloneRecord(records.get(providerId));
          const outcome = mutation(current);
          if (outcome.kind === "unchanged") {
            return Object.freeze({
              kind: "unchanged" as const,
              record: current,
              value: outcome.value,
            });
          }
          const committed = structuredClone({
            ...outcome.record,
            revision: options.createRevision(),
          });
          validateRecord(committed, providerId);
          const profile = publicationProfile(committed, publication);
          if (profile.reference.owner === "managed") {
            const providerDocuments =
              documents.get(providerId) ?? new Map<string, InMemoryDocument>();
            providerDocuments.set(profile.reference.path, {
              raw: publication.content!,
              publishedAt: now(),
            });
            documents.set(providerId, providerDocuments);
          }
          records.set(providerId, committed);
          return Object.freeze({
            kind: "committed" as const,
            record: cloneRecord(committed)!,
            value: outcome.value,
          });
        }),
      );
    },

    async readCredentialDocument(providerId, credentialId) {
      const record = records.get(providerId);
      const profile = record?.profiles.find(
        (candidate) => candidate.credentialId === credentialId,
      );
      if (profile === undefined || !profile.enabled) {
        return Object.freeze({ state: "missing" as const });
      }
      let raw: string;
      if (profile.reference.owner === "managed") {
        const entry = documents.get(providerId)?.get(profile.reference.path);
        if (entry === undefined) return Object.freeze({ state: "missing" as const });
        raw = entry.raw;
      } else {
        const document = await readCredentialDocumentFile(profile.reference.path);
        if (document.state !== "ok") return Object.freeze({ state: document.state });
        raw = document.raw;
      }
      return Object.freeze({
        state: "ok" as const,
        profile: structuredClone(profile),
        raw,
        contentRevision: credentialDocumentRevision(raw),
      });
    },

    async modifyManagedDocument(providerId, credentialId, mutation) {
      return serializedIn(
        credentialTails,
        credentialKey(providerId, credentialId),
        async () => {
          const before = await serializedProvider(providerId, async () => {
            const record = records.get(providerId);
            const profile = record?.profiles.find(
              (candidate) =>
                candidate.credentialId === credentialId &&
                candidate.enabled &&
                candidate.reference.owner === "managed",
            );
            if (profile === undefined) return undefined;
            const entry = documents.get(providerId)?.get(profile.reference.path);
            if (entry === undefined) return undefined;
            return {
              profile: structuredClone(profile),
              raw: entry.raw,
            };
          });
          if (before === undefined) return undefined;

          const nextRaw = await mutation(before.raw);

          return serializedProvider(providerId, async () => {
            const current = records.get(providerId);
            const profile = current?.profiles.find(
              (candidate) => candidate.credentialId === credentialId,
            );
            if (
              profile === undefined ||
              !profile.enabled ||
              profile.reference.owner !== "managed" ||
              profile.reference.path !== before.profile.reference.path
            ) {
              return undefined;
            }
            const entry = documents.get(providerId)?.get(profile.reference.path);
            if (entry === undefined) return undefined;
            if (nextRaw === undefined) return entry.raw;
            documents.get(providerId)!.set(profile.reference.path, {
              raw: nextRaw,
              publishedAt: entry.publishedAt,
            });
            return nextRaw;
          });
        },
      );
    },

    async modifySelection(providerId, mutation) {
      return serializedProvider(providerId, async () => {
        const current = cloneRecord(records.get(providerId));
        const outcome = mutation(current);
        if (outcome.kind === "unchanged") {
          return Object.freeze({
            kind: "unchanged" as const,
            record: current,
            value: outcome.value,
          });
        }
        const committed = structuredClone({
          ...outcome.record,
          revision: options.createRevision(),
        });
        validateRecord(committed, providerId);
        records.set(providerId, committed);
        return Object.freeze({
          kind: "committed" as const,
          record: cloneRecord(committed)!,
          value: outcome.value,
        });
      });
    },

    async collectOrphans(providerId, collectOptions = {}) {
      const graceMs = Math.max(
        0,
        collectOptions.graceMs ?? DEFAULT_PROVIDER_CREDENTIAL_ORPHAN_GRACE_MS,
      );
      const clock = collectOptions.now ?? now;
      const providerDocuments = documents.get(providerId);
      if (providerDocuments === undefined) return Object.freeze([]);

      const deleted: string[] = [];
      for (const [path, entry] of [...providerDocuments.entries()]) {
        await serializedIn(
          credentialTails,
          credentialKey(providerId, path.split("/")[1] ?? path),
          () => serializedProvider(providerId, async () => {
            const referenced =
              records.get(providerId)?.profiles.some(
                (profile) =>
                  profile.reference.owner === "managed" &&
                  profile.reference.path === path,
              ) === true;
            if (referenced || clock() - entry.publishedAt < graceMs) return;
            providerDocuments.delete(path);
            deleted.push(path);
          }),
        );
      }
      return Object.freeze(deleted.sort());
    },
  };
  return Object.freeze(store);
}

class FileProviderCredentialRecordStore implements ProviderCredentialRecordStore {
  readonly #directory: string;
  readonly #credentialDirectory: string;
  readonly #createRevision: () => string;
  readonly #lock: ProviderCredentialRecordLock;
  readonly #onLockDegraded: (error: unknown) => void;

  constructor(options: {
    readonly piDirectory: string;
    readonly createRevision: () => string;
    readonly lock?: ProviderCredentialRecordLock;
    readonly onLockDegraded?: (error: unknown) => void;
  }) {
    this.#directory = resolve(options.piDirectory, RECORD_DIRECTORY_NAME);
    this.#credentialDirectory = resolve(options.piDirectory, CREDENTIAL_DIRECTORY_NAME);
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

  #credentialLockPath(providerId: string, credentialId: string): string {
    const digest = createHash("sha256")
      .update(credentialId, "utf8")
      .digest("hex")
      .slice(0, 32);
    return join(this.#directory, `${providerId}.${digest}.credential`);
  }

  #resolveManagedPath(relativePath: string): string | undefined {
    const segments = relativePath.split("/");
    if (
      segments.length !== 3 ||
      segments[2] !== MANAGED_DOCUMENT_NAME ||
      segments.some(
        (segment) =>
          segment.length === 0 ||
          segment === "." ||
          segment === ".." ||
          segment.includes("\\") ||
          !isSafeSegment(segment),
      )
    ) {
      return undefined;
    }
    const root = resolve(this.#credentialDirectory);
    const candidate = resolve(root, ...segments);
    const pathRelative = relative(root, candidate);
    if (
      pathRelative === "" ||
      pathRelative.startsWith("..") ||
      isAbsolute(pathRelative)
    ) {
      return undefined;
    }
    return candidate;
  }

  async #ensureRecordDirectory(): Promise<void> {
    const base = dirname(this.#directory);
    await mkdir(base, { recursive: true, mode: PROFILE_DIRECTORY_MODE });
    try {
      await mkdir(this.#directory, { mode: PROFILE_DIRECTORY_MODE });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    const info = await lstat(this.#directory);
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      relative(
        join(await realpath(base), RECORD_DIRECTORY_NAME),
        await realpath(this.#directory),
      ) !== ""
    ) {
      throw new ProviderCredentialRecordShapeError(
        "Unsafe Provider credential record directory",
      );
    }
    await chmod(this.#directory, PROFILE_DIRECTORY_MODE);
  }

  async #readRecord(
    providerId: string,
  ): Promise<PersistedProviderCredentialRecord | undefined> {
    try {
      return parseRecord(
        await readFile(this.#recordPath(providerId), "utf8"),
        providerId,
      );
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
  }

  async #acquireLock(path: string): Promise<ProviderCredentialRecordLockLease> {
    const deadline = Date.now() + LOCK_STALE_MS;
    let retry = 0;
    while (true) {
      try {
        const lease = await this.#lock.acquire(path);
        try {
          lease.assertOwned();
          return lease;
        } catch (error) {
          await lease.release().catch(() => undefined);
          throw error;
        }
      } catch (error) {
        const remainingMs = deadline - Date.now();
        if (errorCode(error) !== "ELOCKED" || remainingMs <= 0) throw error;
        await sleep(Math.min(10 * 2 ** retry, 1_000, remainingMs));
        retry += 1;
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
        "Provider credential operation and lock release both failed",
      );
    }
    if (operationError !== undefined) throw operationError;
    if (releaseError !== undefined) {
      try {
        this.#onLockDegraded(releaseError);
      } catch {
        // Observation only.
      }
    }
    return value as T;
  }

  async #writeRecord(
    record: PersistedProviderCredentialRecord,
    assertOwned: () => void,
  ): Promise<void> {
    await writeDurableFile({
      path: this.#recordPath(record.providerId),
      content: `${JSON.stringify(record, null, 2)}\n`,
      assertOwned,
      validatePath: () => this.#ensureRecordDirectory(),
    });
  }

  async #checkManagedAncestors(target: string, create: boolean): Promise<void> {
    const base = dirname(this.#credentialDirectory);
    await mkdir(base, { recursive: true, mode: PROFILE_DIRECTORY_MODE });
    const canonicalBase = await realpath(base);
    const segments = relative(base, dirname(target)).split(/[\\/]/u);
    let path = base;
    let canonical = canonicalBase;
    for (const segment of segments) {
      path = join(path, segment);
      canonical = join(canonical, segment);
      if (create) {
        try {
          await mkdir(path, { mode: PROFILE_DIRECTORY_MODE });
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw error;
        }
      }
      const info = await lstat(path);
      if (
        info.isSymbolicLink() ||
        !info.isDirectory() ||
        relative(canonical, await realpath(path)) !== ""
      ) {
        throw new ProviderCredentialRecordShapeError(
          "Unsafe Provider credential directory",
        );
      }
    }
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new ProviderCredentialRecordShapeError(
          "Unsafe Provider credential file",
        );
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }

  async #writeManagedDocument(
    relativePath: string,
    raw: string,
    assertOwned: () => void,
  ): Promise<void> {
    const target = this.#resolveManagedPath(relativePath);
    if (target === undefined) {
      throw new ProviderCredentialRecordShapeError(
        `Invalid Provider credential document path ${JSON.stringify(relativePath)}`,
      );
    }
    await this.#checkManagedAncestors(target, true);
    await chmod(this.#credentialDirectory, PROFILE_DIRECTORY_MODE).catch(
      () => undefined,
    );
    await chmod(dirname(target), PROFILE_DIRECTORY_MODE).catch(() => undefined);
    await writeDurableFile({
      path: target,
      content: raw,
      assertOwned,
      validatePath: () => this.#checkManagedAncestors(target, false),
    });
  }

  async #readReference(
    profile: PersistedCredentialProfile,
  ): Promise<ProviderCredentialDocumentRead> {
    let target: string;
    if (profile.reference.owner === "managed") {
      const managed = this.#resolveManagedPath(profile.reference.path);
      if (managed === undefined) return Object.freeze({ state: "invalid" as const });
      target = managed;
      try {
        await this.#checkManagedAncestors(target, false);
      } catch (error) {
        return Object.freeze({
          state:
            error instanceof ProviderCredentialRecordShapeError
              ? ("invalid" as const)
              : errorCode(error) === "ENOENT"
                ? ("missing" as const)
                : ("unreadable" as const),
        });
      }
    } else {
      target = profile.reference.path;
    }

    const document = await readCredentialDocumentFile(target);
    if (document.state !== "ok") return Object.freeze({ state: document.state });
    return Object.freeze({
      state: "ok" as const,
      profile: structuredClone(profile),
      raw: document.raw,
      contentRevision: document.revision,
    });
  }

  async listProviderIds(): Promise<readonly string[]> {
    try {
      return Object.freeze(
        (await readdir(this.#directory, { withFileTypes: true }))
          .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
          .map((entry) => entry.name.slice(0, -5))
          .filter(isSafeProviderId)
          .sort(),
      );
    } catch (error) {
      if (errorCode(error) === "ENOENT") return Object.freeze([]);
      throw error;
    }
  }

  read(providerId: string) {
    return this.#readRecord(providerId);
  }

  async withSelectionLock<T>(
    providerId: string,
    operation: (
      current: PersistedProviderCredentialRecord | undefined,
      assertOwned: () => void,
    ) => Promise<T>,
  ): Promise<T> {
    await this.#ensureRecordDirectory();
    return this.#withPathLock(this.#recordPath(providerId), async (assertOwned) =>
      operation(cloneRecord(await this.#readRecord(providerId)), assertOwned),
    );
  }

  async modifyManagement<T>(
    providerId: string,
    expectedRevision: string,
    mutation: (
      current: PersistedProviderCredentialRecord | undefined,
    ) => ManagementMutation<T>,
  ): Promise<ManagementMutationResult<T>> {
    await this.#ensureRecordDirectory();
    return this.#withPathLock(this.#recordPath(providerId), async (assertOwned) => {
      const current = await this.#readRecord(providerId);
      if ((current?.revision ?? NO_PROVIDER_RECORD_REVISION) !== expectedRevision) {
        return Object.freeze({
          kind: "revision_conflict" as const,
          record: current,
        });
      }
      const outcome = mutation(cloneRecord(current));
      if (outcome.kind === "unchanged") {
        return Object.freeze({
          kind: "unchanged" as const,
          record: current,
          value: outcome.value,
        });
      }
      const committed = structuredClone({
        ...outcome.record,
        revision: this.#createRevision(),
      });
      validateRecord(committed, providerId);
      assertOwned();
      await this.#writeRecord(committed, assertOwned);
      return Object.freeze({
        kind: "committed" as const,
        record: cloneRecord(committed)!,
        value: outcome.value,
      });
    });
  }

  async publishCredential<T>(
    providerId: string,
    publication: CredentialPublication,
    mutation: (
      current: PersistedProviderCredentialRecord | undefined,
    ) => ManagementMutation<T>,
  ): Promise<Exclude<
    ManagementMutationResult<T>,
    { readonly kind: "revision_conflict" }
  >> {
    validatePublication(providerId, publication);
    await this.#ensureRecordDirectory();
    return this.#withPathLock(
      this.#credentialLockPath(providerId, publication.credentialId),
      async (assertCredentialOwned) =>
        this.#withPathLock(this.#recordPath(providerId), async (assertRecordOwned) => {
          const assertOwned = (): void => {
            assertCredentialOwned();
            assertRecordOwned();
          };
          const current = await this.#readRecord(providerId);
          const outcome = mutation(cloneRecord(current));
          if (outcome.kind === "unchanged") {
            return Object.freeze({
              kind: "unchanged" as const,
              record: current,
              value: outcome.value,
            });
          }
          const committed = structuredClone({
            ...outcome.record,
            revision: this.#createRevision(),
          });
          validateRecord(committed, providerId);
          const profile = publicationProfile(committed, publication);
          assertOwned();
          if (profile.reference.owner === "managed") {
            await this.#writeManagedDocument(
              profile.reference.path,
              publication.content!,
              assertOwned,
            );
          }
          assertOwned();
          await this.#writeRecord(committed, assertOwned);
          return Object.freeze({
            kind: "committed" as const,
            record: cloneRecord(committed)!,
            value: outcome.value,
          });
        }),
    );
  }

  async readCredentialDocument(
    providerId: string,
    credentialId: string,
  ): Promise<ProviderCredentialDocumentRead> {
    const record = await this.#readRecord(providerId);
    const profile = record?.profiles.find(
      (candidate) =>
        candidate.credentialId === credentialId &&
        candidate.enabled,
    );
    if (profile === undefined) return Object.freeze({ state: "missing" });
    return this.#readReference(profile);
  }

  async modifyManagedDocument(
    providerId: string,
    credentialId: string,
    mutation: (currentRaw: string) => Promise<string | undefined>,
  ): Promise<string | undefined> {
    assertSafeSegment(credentialId, "credential ID");
    await this.#ensureRecordDirectory();
    return this.#withPathLock(
      this.#credentialLockPath(providerId, credentialId),
      async (assertCredentialOwned) => {
        const before = await this.#withPathLock(
          this.#recordPath(providerId),
          async () => {
            const record = await this.#readRecord(providerId);
            const profile = record?.profiles.find(
              (candidate) =>
                candidate.credentialId === credentialId &&
                candidate.enabled &&
                candidate.reference.owner === "managed",
            );
            if (profile === undefined) return undefined;
            const read = await this.#readReference(profile);
            return read.state === "ok"
              ? { profile: read.profile, raw: read.raw }
              : undefined;
          },
        );
        if (before === undefined) return undefined;

        const nextRaw = await mutation(before.raw);

        return this.#withPathLock(
          this.#recordPath(providerId),
          async (assertRecordOwned) => {
            const assertOwned = (): void => {
              assertCredentialOwned();
              assertRecordOwned();
            };
            const current = await this.#readRecord(providerId);
            const profile = current?.profiles.find(
              (candidate) => candidate.credentialId === credentialId,
            );
            if (
              profile === undefined ||
              !profile.enabled ||
              profile.reference.owner !== "managed" ||
              profile.reference.path !== before.profile.reference.path
            ) {
              return undefined;
            }
            if (nextRaw === undefined) return before.raw;
            assertOwned();
            await this.#writeManagedDocument(
              profile.reference.path,
              nextRaw,
              assertOwned,
            );
            return nextRaw;
          },
        );
      },
    );
  }

  async modifySelection<T>(
    providerId: string,
    mutation: (
      current: PersistedProviderCredentialRecord | undefined,
    ) => ManagementMutation<T>,
  ): Promise<SelectionMutationResult<T>> {
    await this.#ensureRecordDirectory();
    return this.#withPathLock(this.#recordPath(providerId), async (assertOwned) => {
      const current = await this.#readRecord(providerId);
      const outcome = mutation(cloneRecord(current));
      if (outcome.kind === "unchanged") {
        return Object.freeze({
          kind: "unchanged" as const,
          record: current,
          value: outcome.value,
        });
      }
      const committed = structuredClone({
        ...outcome.record,
        revision: this.#createRevision(),
      });
      validateRecord(committed, providerId);
      assertOwned();
      await this.#writeRecord(committed, assertOwned);
      return Object.freeze({
        kind: "committed" as const,
        record: cloneRecord(committed)!,
        value: outcome.value,
      });
    });
  }

  async collectOrphans(
    providerId: string,
    options: CollectProviderCredentialOrphansOptions = {},
  ): Promise<readonly string[]> {
    if (!isSafeProviderId(providerId)) {
      throw new Error(`Unsafe Provider ID ${JSON.stringify(providerId)}`);
    }
    const graceMs = Math.max(
      0,
      options.graceMs ?? DEFAULT_PROVIDER_CREDENTIAL_ORPHAN_GRACE_MS,
    );
    const now = options.now ?? Date.now;
    const providerDirectory = join(this.#credentialDirectory, providerId);
    let credentialEntries;
    try {
      credentialEntries = await readdir(providerDirectory, {
        withFileTypes: true,
      });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return Object.freeze([]);
      throw error;
    }

    const deleted: string[] = [];
    for (const entry of credentialEntries) {
      if (!entry.isDirectory() || !isSafeSegment(entry.name)) continue;
      const credentialId = entry.name;
      const relativePath = expectedManagedPath(providerId, credentialId);
      const target = this.#resolveManagedPath(relativePath);
      if (target === undefined) continue;
      await this.#withPathLock(
        this.#credentialLockPath(providerId, credentialId),
        async (assertCredentialOwned) => {
          let info;
          try {
            info = await lstat(target);
          } catch (error) {
            if (errorCode(error) === "ENOENT") return;
            throw error;
          }
          if (
            info.isSymbolicLink() ||
            !info.isFile() ||
            now() - info.mtimeMs < graceMs
          ) {
            return;
          }
          await this.#withPathLock(
            this.#recordPath(providerId),
            async (assertRecordOwned) => {
              const record = await this.#readRecord(providerId);
              const referenced =
                record?.profiles.some(
                  (profile) =>
                    profile.reference.owner === "managed" &&
                    profile.reference.path === relativePath,
                ) === true;
              if (referenced) return;
              assertCredentialOwned();
              assertRecordOwned();
              await unlink(target);
              deleted.push(relativePath);
            },
          );
        },
      );
    }
    return Object.freeze(deleted.sort());
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
