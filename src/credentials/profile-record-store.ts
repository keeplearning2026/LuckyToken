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

import type { Credential } from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";

import { isSafeProviderId } from "../providers/provider-id.js";

export const PROVIDER_CREDENTIAL_RECORD_SCHEMA_VERSION = 2 as const;

/** Backstop delay before an unreferenced incarnation document may be
 * collected. Grace alone never proves a writer stopped; orphan collection
 * shares the per-credential lock with publication. */
export const DEFAULT_PROVIDER_CREDENTIAL_ORPHAN_GRACE_MS = 10 * 60_000;

/**
 * Explicit reference from a persisted Profile to its committed credential
 * incarnation document. `relativePath` is POSIX-style and relative to the
 * credential root (`<pi directory>/credentials`); `tokenRevision` is the
 * SHA-256 content hash of the referenced document bytes.
 */
export interface CredentialIncarnationReference {
  readonly relativePath: string;
  readonly tokenRevision: string;
}

/** Persisted Profile metadata. Token material lives only in the referenced
 * incarnation document; the record is the authority for identity, selection,
 * generations, and the active incarnation path. */
export interface PersistedCredentialProfileV2 {
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
  readonly incarnation: CredentialIncarnationReference;
}

export interface PersistedProviderCredentialRecordV2 {
  readonly schemaVersion: typeof PROVIDER_CREDENTIAL_RECORD_SCHEMA_VERSION;
  readonly providerId: string;
  readonly revision: string;
  readonly selectionGeneration: string;
  readonly activeCredentialId?: string;
  readonly switchPolicy: {
    readonly apiKeyOn429: boolean;
    readonly oauthOn429: boolean;
  };
  readonly profiles: readonly PersistedCredentialProfileV2[];
}

/** One new logical incarnation to publish before the record commit that
 * makes it visible. */
export interface CredentialIncarnationPublication {
  readonly credentialId: string;
  readonly credentialGeneration: string;
  readonly credential: Credential;
}

/** Result of reading the credential document referenced by the record. The
 * record is always the authority: only the referenced path is read, and a
 * missing or invalid document marks the credential unavailable. */
export type ProviderCredentialIncarnationRead =
  | {
      readonly state: "ok";
      readonly credential: Credential;
      readonly tokenRevision: string;
    }
  | { readonly state: "missing" }
  | { readonly state: "invalid" }
  | { readonly state: "unreadable" };

export interface CollectProviderCredentialOrphansOptions {
  readonly graceMs?: number;
  readonly now?: () => number;
}

/** Fault-injection points for the commit protocol. Production callers never
 * supply hooks; they exist so tests can pause a publication exactly between
 * the durable document write and the record commit. */
export interface ProviderCredentialRecordStoreHooks {
  readonly afterIncarnationPublication?: () => Promise<void> | void;
  readonly afterIncarnationRotation?: () => Promise<void> | void;
}

export type ManagementMutation<T> =
  | {
      readonly kind: "commit";
      readonly record: PersistedProviderCredentialRecordV2;
      readonly value: T;
    }
  | { readonly kind: "unchanged"; readonly value: T };

export type ManagementMutationResult<T> =
  | {
      readonly kind: "committed";
      readonly record: PersistedProviderCredentialRecordV2;
      readonly value: T;
    }
  | {
      readonly kind: "unchanged";
      readonly record: PersistedProviderCredentialRecordV2 | undefined;
      readonly value: T;
    }
  | {
      readonly kind: "revision_conflict";
      readonly record: PersistedProviderCredentialRecordV2 | undefined;
    };

export type SelectionMutationResult<T> = Exclude<
  ManagementMutationResult<T>,
  { readonly kind: "revision_conflict" }
>;

export interface ProviderCredentialRecordStore {
  listProviderIds(): Promise<readonly string[]>;
  read(providerId: string): Promise<PersistedProviderCredentialRecordV2 | undefined>;
  /** Hold the Provider selection lock without mutating the record. Used to
   * publish derived state only while its captured binding is still current. */
  withSelectionLock<T>(
    providerId: string,
    operation: (
      current: PersistedProviderCredentialRecordV2 | undefined,
      assertOwned: () => void,
    ) => Promise<T>,
  ): Promise<T>;
  modifyManagement<T>(
    providerId: string,
    expectedRevision: string,
    mutation: (
      current: PersistedProviderCredentialRecordV2 | undefined,
    ) => ManagementMutation<T>,
  ): Promise<ManagementMutationResult<T>>;
  /** Add/reconnect/replace commit protocol. Holds the per-credential lock,
   * writes the new incarnation document at its unique path first, then
   * switches the record reference and credentialGeneration in one record
   * commit. That commit is the visibility point; a crash before it leaves the
   * document unreferenced, and recovery never adopts it by hash. */
  publishIncarnation<T>(
    providerId: string,
    expectedRevision: string,
    publication: CredentialIncarnationPublication,
    mutation: (
      current: PersistedProviderCredentialRecordV2 | undefined,
    ) => ManagementMutation<T>,
  ): Promise<ManagementMutationResult<T>>;
  /** Normal rotation inside one incarnation: writes the referenced document
   * via tmp+rename+fsync, then commits the record tokenRevision. */
  modifyCredential(
    providerId: string,
    credentialId: string,
    credentialGeneration: string,
    mutation: (current: Credential) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined>;
  /** Read only the incarnation path the record references. */
  readCredential(
    providerId: string,
    credentialId: string,
    credentialGeneration: string,
  ): Promise<ProviderCredentialIncarnationRead>;
  modifySelection<T>(
    providerId: string,
    mutation: (
      current: PersistedProviderCredentialRecordV2 | undefined,
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
const INCARNATION_FILE_SUFFIX = ".auth.json";
const PROFILE_DIRECTORY_MODE = 0o700;
const PROFILE_FILE_MODE = 0o600;
const LOCK_STALE_MS = 30_000;
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const TOKEN_REVISION_PATTERN = /^[0-9a-f]{64}$/u;
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

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function serializeCredentialDocument(credential: Credential): string {
  return `${JSON.stringify(credential, null, 2)}\n`;
}

/** Path segments that become directory or file names under the credential
 * root. Rejects separators, traversal, and Windows-hostile trailing dots or
 * spaces. */
function isSafeIncarnationSegment(value: string): boolean {
  if (!SAFE_SEGMENT_PATTERN.test(value)) return false;
  return !value.endsWith(".") && !value.endsWith(" ");
}

function assertSafeIncarnationSegment(value: string, description: string): void {
  if (!isSafeIncarnationSegment(value)) {
    throw new ProviderCredentialRecordShapeError(
      `Unsafe Provider credential ${description} ${JSON.stringify(value)}`,
    );
  }
}

function incarnationRelativePath(
  providerId: string,
  credentialId: string,
  credentialGeneration: string,
): string {
  return `${providerId}/${credentialId}/${credentialGeneration}${INCARNATION_FILE_SUFFIX}`;
}

/**
 * Canonical reference for one committed incarnation document. Callers that
 * construct a record commit must use this helper so the stored path and
 * content hash always match the document the store writes.
 */
export function credentialIncarnationReference(
  providerId: string,
  credentialId: string,
  credentialGeneration: string,
  credential: Credential,
): CredentialIncarnationReference {
  if (!isSafeProviderId(providerId)) {
    throw new ProviderCredentialRecordShapeError(
      `Unsafe Provider ID ${JSON.stringify(providerId)}`,
    );
  }
  assertSafeIncarnationSegment(credentialId, "credential ID");
  assertSafeIncarnationSegment(credentialGeneration, "credential generation");
  if (!isCredential(credential)) {
    throw new ProviderCredentialRecordShapeError(
      "Provider credential incarnation must be a valid credential payload",
    );
  }
  return Object.freeze({
    relativePath: incarnationRelativePath(providerId, credentialId, credentialGeneration),
    tokenRevision: sha256Hex(serializeCredentialDocument(credential)),
  });
}

function isIncarnationReference(
  value: unknown,
  providerId: string,
  credentialId: string,
  credentialGeneration: string,
): value is CredentialIncarnationReference {
  if (
    !isObject(value) ||
    !boundedString(value.relativePath, 512) ||
    !boundedString(value.tokenRevision, 64, { trimmed: true }) ||
    !TOKEN_REVISION_PATTERN.test(value.tokenRevision)
  ) {
    return false;
  }
  if (
    !isSafeProviderId(providerId) ||
    !isSafeIncarnationSegment(credentialId) ||
    !isSafeIncarnationSegment(credentialGeneration)
  ) {
    return false;
  }
  return value.relativePath === incarnationRelativePath(
    providerId,
    credentialId,
    credentialGeneration,
  );
}

function isProfile(
  value: unknown,
  providerId: string,
): value is PersistedCredentialProfileV2 {
  if (!isObject(value)) return false;
  return (
    boundedString(value.credentialId, 256) &&
    isSafeIncarnationSegment(value.credentialId) &&
    boundedString(value.credentialGeneration, 256) &&
    isSafeIncarnationSegment(value.credentialGeneration) &&
    (value.authType === "api_key" || value.authType === "oauth") &&
    boundedString(value.authMethodLabel, 128, { trimmed: true }) &&
    boundedString(value.displayName, 64, { trimmed: true }) &&
    boundedOptionalString(value.note, 200) &&
    boundedOptionalString(value.identityHint, 64) &&
    typeof value.enabled === "boolean" &&
    typeof value.priority === "number" &&
    Number.isSafeInteger(value.priority) &&
    typeof value.createdAt === "number" &&
    Number.isSafeInteger(value.createdAt) &&
    value.createdAt >= 0 &&
    typeof value.updatedAt === "number" &&
    Number.isSafeInteger(value.updatedAt) &&
    value.updatedAt >= 0 &&
    isIncarnationReference(
      value.incarnation,
      providerId,
      value.credentialId,
      value.credentialGeneration,
    )
  );
}

function parseRecord(
  content: string,
  expectedProviderId: string,
): PersistedProviderCredentialRecordV2 {
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
    !parsed.profiles.every((profile) => isProfile(profile, expectedProviderId))
  ) {
    throw new ProviderCredentialRecordShapeError(
      `Invalid Provider credential record for ${JSON.stringify(expectedProviderId)}`,
    );
  }
  const record = parsed as unknown as PersistedProviderCredentialRecordV2;
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
  record: PersistedProviderCredentialRecordV2,
  expectedProviderId: string,
): void {
  parseRecord(JSON.stringify(record), expectedProviderId);
}

/** Parse and validate a persisted Provider record document. Throws the
 * existing syntax/shape errors for stale formats; no migration or dual
 * reader exists. */
export function parseProviderCredentialRecord(
  content: string,
  expectedProviderId: string,
): PersistedProviderCredentialRecordV2 {
  return parseRecord(content, expectedProviderId);
}

function cloneRecord(
  record: PersistedProviderCredentialRecordV2 | undefined,
): PersistedProviderCredentialRecordV2 | undefined {
  return record === undefined ? undefined : structuredClone(record);
}

function isToleratedSyncFailure(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && TOLERATED_SYNC_ERROR_CODES.has(code);
}

/** fd-based flush where the platform supports it. Platforms that reject
 * fsync on regular files or directories are tolerated; the write ordering
 * (temporary file → flush → rename → record commit) is never weakened. */
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

/** One durable publication: stage a temporary file in the target directory,
 * flush it, re-check ownership, rename it into place, then flush the
 * directory entry where the platform supports it. */
async function writeDurableFile(options: {
  readonly path: string;
  readonly content: string;
  readonly assertOwned?: () => void;
}): Promise<void> {
  await mkdir(dirname(options.path), { recursive: true, mode: PROFILE_DIRECTORY_MODE });
  const temporaryPath = `${options.path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const handle = await open(temporaryPath, "wx", PROFILE_FILE_MODE);
    try {
      await handle.writeFile(options.content, "utf8");
      await syncFileHandle(handle);
    } finally {
      await handle.close().catch(() => undefined);
    }
    await chmod(temporaryPath, PROFILE_FILE_MODE).catch(() => undefined);
    options.assertOwned?.();
    await rename(temporaryPath, options.path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  await chmod(options.path, PROFILE_FILE_MODE).catch(() => undefined);
  await syncDirectoryPath(dirname(options.path));
}

interface InMemoryIncarnation {
  readonly credential: Credential;
  readonly tokenRevision: string;
  readonly publishedAt: number;
}

function validatePublication(
  providerId: string,
  publication: CredentialIncarnationPublication,
): CredentialIncarnationReference {
  if (!isSafeProviderId(providerId)) {
    throw new ProviderCredentialRecordShapeError(
      `Unsafe Provider ID ${JSON.stringify(providerId)}`,
    );
  }
  return credentialIncarnationReference(
    providerId,
    publication.credentialId,
    publication.credentialGeneration,
    publication.credential,
  );
}

function assertCommittedPublication(
  record: PersistedProviderCredentialRecordV2,
  publication: CredentialIncarnationPublication,
  reference: CredentialIncarnationReference,
): void {
  const profile = record.profiles.find(
    (candidate) => candidate.credentialId === publication.credentialId,
  );
  if (
    profile === undefined ||
    profile.credentialGeneration !== publication.credentialGeneration ||
    profile.authType !== publication.credential.type ||
    profile.incarnation.relativePath !== reference.relativePath ||
    profile.incarnation.tokenRevision !== reference.tokenRevision
  ) {
    throw new ProviderCredentialRecordShapeError(
      "Committed Provider credential record does not reference the published incarnation",
    );
  }
}

export function createInMemoryProviderCredentialRecordStore(options: {
  readonly createRevision: () => string;
  readonly now?: () => number;
  readonly hooks?: ProviderCredentialRecordStoreHooks;
}): ProviderCredentialRecordStore {
  const records = new Map<string, PersistedProviderCredentialRecordV2>();
  const incarnations = new Map<string, Map<string, InMemoryIncarnation>>();
  const tails = new Map<string, Promise<void>>();
  const credentialTails = new Map<string, Promise<void>>();
  const now = options.now ?? Date.now;

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

    async read(providerId: string): Promise<PersistedProviderCredentialRecordV2 | undefined> {
      return cloneRecord(records.get(providerId));
    },

    async withSelectionLock<T>(
      providerId: string,
      operation: (
        current: PersistedProviderCredentialRecordV2 | undefined,
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
        current: PersistedProviderCredentialRecordV2 | undefined,
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

    async publishIncarnation<T>(
      providerId: string,
      expectedRevision: string,
      publication: CredentialIncarnationPublication,
      mutation: (
        current: PersistedProviderCredentialRecordV2 | undefined,
      ) => ManagementMutation<T>,
    ): Promise<ManagementMutationResult<T>> {
      const reference = validatePublication(providerId, publication);
      const credentialKey = `${providerId}\u0000${publication.credentialId}`;
      return serializedIn(credentialTails, credentialKey, () =>
        serialized(providerId, async () => {
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
          assertCommittedPublication(committed, publication, reference);
          const providerIncarnations =
            incarnations.get(providerId) ?? new Map<string, InMemoryIncarnation>();
          providerIncarnations.set(reference.relativePath, {
            credential: structuredClone(publication.credential),
            tokenRevision: reference.tokenRevision,
            publishedAt: now(),
          });
          incarnations.set(providerId, providerIncarnations);
          await options.hooks?.afterIncarnationPublication?.();
          records.set(providerId, committed);
          return Object.freeze({
            kind: "committed",
            record: cloneRecord(committed)!,
            value: outcome.value,
          });
        }),
      );
    },

    async modifyCredential(
      providerId: string,
      credentialId: string,
      credentialGeneration: string,
      mutation: (current: Credential) => Promise<Credential | undefined>,
    ): Promise<Credential | undefined> {
      const credentialKey = `${providerId}\u0000${credentialId}`;
      return serializedIn(credentialTails, credentialKey, async () => {
        const before = records.get(providerId)?.profiles.find(
          (profile) =>
            profile.credentialId === credentialId &&
            profile.credentialGeneration === credentialGeneration,
        );
        if (before === undefined) return undefined;
        const entry = incarnations
          .get(providerId)
          ?.get(before.incarnation.relativePath);
        if (entry === undefined || entry.credential.type !== before.authType) {
          return undefined;
        }
        const next = await mutation(structuredClone(entry.credential));
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
          const profile = current.profiles[profileIndex]!;
          const currentEntry = incarnations
            .get(providerId)
            ?.get(profile.incarnation.relativePath);
          if (
            currentEntry === undefined ||
            profile.incarnation.relativePath !== before.incarnation.relativePath
          ) {
            return undefined;
          }
          if (next === undefined) {
            return structuredClone(currentEntry.credential);
          }
          const tokenRevision = sha256Hex(serializeCredentialDocument(next));
          incarnations.get(providerId)!.set(profile.incarnation.relativePath, {
            credential: structuredClone(next),
            tokenRevision,
            publishedAt: currentEntry.publishedAt,
          });
          await options.hooks?.afterIncarnationRotation?.();
          const profiles = [...current.profiles];
          profiles[profileIndex] = {
            ...profile,
            incarnation: {
              relativePath: profile.incarnation.relativePath,
              tokenRevision,
            },
          };
          records.set(providerId, { ...current, profiles });
          return structuredClone(next);
        });
      });
    },

    async readCredential(
      providerId: string,
      credentialId: string,
      credentialGeneration: string,
    ): Promise<ProviderCredentialIncarnationRead> {
      const profile = records.get(providerId)?.profiles.find(
        (candidate) =>
          candidate.credentialId === credentialId &&
          candidate.credentialGeneration === credentialGeneration,
      );
      if (profile === undefined) return Object.freeze({ state: "missing" });
      const entry = incarnations
        .get(providerId)
        ?.get(profile.incarnation.relativePath);
      if (entry === undefined) return Object.freeze({ state: "missing" });
      if (entry.credential.type !== profile.authType) {
        return Object.freeze({ state: "invalid" });
      }
      return Object.freeze({
        state: "ok",
        credential: structuredClone(entry.credential),
        tokenRevision: entry.tokenRevision,
      });
    },

    async modifySelection<T>(
      providerId: string,
      mutation: (
        current: PersistedProviderCredentialRecordV2 | undefined,
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

    async collectOrphans(
      providerId: string,
      collectOptions: CollectProviderCredentialOrphansOptions = {},
    ): Promise<readonly string[]> {
      const graceMs = Math.max(
        0,
        collectOptions.graceMs ?? DEFAULT_PROVIDER_CREDENTIAL_ORPHAN_GRACE_MS,
      );
      const clock = collectOptions.now ?? now;
      return serialized(providerId, async () => {
        const providerIncarnations = incarnations.get(providerId);
        if (providerIncarnations === undefined) return Object.freeze([]);
        const referenced = new Set(
          records.get(providerId)?.profiles.map(
            (profile) => profile.incarnation.relativePath,
          ) ?? [],
        );
        const deleted: string[] = [];
        for (const [relativePath, entry] of providerIncarnations) {
          if (referenced.has(relativePath)) continue;
          if (clock() - entry.publishedAt < graceMs) continue;
          providerIncarnations.delete(relativePath);
          deleted.push(relativePath);
        }
        return Object.freeze(deleted.sort());
      });
    },
  });
}

class FileProviderCredentialRecordStore implements ProviderCredentialRecordStore {
  readonly #directory: string;
  readonly #credentialDirectory: string;
  readonly #createRevision: () => string;
  readonly #lock: ProviderCredentialRecordLock;
  readonly #onLockDegraded: (error: unknown) => void;
  readonly #hooks: ProviderCredentialRecordStoreHooks;

  constructor(options: {
    readonly piDirectory: string;
    readonly createRevision: () => string;
    readonly lock?: ProviderCredentialRecordLock;
    readonly onLockDegraded?: (error: unknown) => void;
    readonly hooks?: ProviderCredentialRecordStoreHooks;
  }) {
    this.#directory = resolve(options.piDirectory, RECORD_DIRECTORY_NAME);
    this.#credentialDirectory = resolve(options.piDirectory, CREDENTIAL_DIRECTORY_NAME);
    this.#createRevision = options.createRevision;
    this.#lock = options.lock ?? createNodeProviderCredentialRecordLock();
    this.#onLockDegraded = options.onLockDegraded ?? (() => undefined);
    this.#hooks = options.hooks ?? {};
  }

  #recordPath(providerId: string): string {
    if (!isSafeProviderId(providerId)) {
      throw new Error(`Unsafe Provider ID ${JSON.stringify(providerId)}`);
    }
    return join(this.#directory, `${providerId}.json`);
  }

  /** Per-credential publication lock. Publication, rotation, and orphan
   * collection all serialize on this path, and the lock order is always
   * credential lock → record lock. */
  #credentialLockPath(providerId: string, credentialId: string): string {
    const digest = createHash("sha256")
      .update(credentialId, "utf8")
      .digest("hex")
      .slice(0, 32);
    return join(this.#directory, `${providerId}.${digest}.incarnation`);
  }

  #resolveRelativePath(relativePath: string): string | undefined {
    const segments = relativePath.split("/");
    if (
      segments.length !== 3 ||
      segments.some(
        (segment) =>
          segment.length === 0 ||
          segment === "." ||
          segment === ".." ||
          segment.includes("\\") ||
          !isSafeIncarnationSegment(segment),
      )
    ) {
      return undefined;
    }
    const root = resolve(this.#credentialDirectory);
    const candidate = resolve(root, ...segments);
    const pathRelative = relative(root, candidate);
    if (pathRelative === "" || pathRelative.startsWith("..") || isAbsolute(pathRelative)) {
      return undefined;
    }
    return candidate;
  }

  async #ensureDirectory(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: PROFILE_DIRECTORY_MODE });
    await chmod(this.#directory, PROFILE_DIRECTORY_MODE);
  }

  async #readRecord(
    providerId: string,
  ): Promise<PersistedProviderCredentialRecordV2 | undefined> {
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
    record: PersistedProviderCredentialRecordV2,
    assertOwned: () => void,
  ): Promise<void> {
    await writeDurableFile({
      path: recordPath,
      content: `${JSON.stringify(record, null, 2)}\n`,
      assertOwned,
    });
  }

  async #writeIncarnation(
    relativePath: string,
    credential: Credential,
    assertOwned: () => void,
  ): Promise<string> {
    const target = this.#resolveRelativePath(relativePath);
    if (target === undefined) {
      throw new ProviderCredentialRecordShapeError(
        `Invalid Provider credential incarnation path ${JSON.stringify(relativePath)}`,
      );
    }
    const credentialDirectory = dirname(target);
    await mkdir(credentialDirectory, { recursive: true, mode: PROFILE_DIRECTORY_MODE });
    await chmod(this.#credentialDirectory, PROFILE_DIRECTORY_MODE).catch(() => undefined);
    await chmod(credentialDirectory, PROFILE_DIRECTORY_MODE).catch(() => undefined);
    await writeDurableFile({
      path: target,
      content: serializeCredentialDocument(credential),
      assertOwned,
    });
    return sha256Hex(serializeCredentialDocument(credential));
  }

  async #readIncarnation(
    reference: CredentialIncarnationReference,
    authType: Credential["type"],
  ): Promise<ProviderCredentialIncarnationRead> {
    const target = this.#resolveRelativePath(reference.relativePath);
    if (target === undefined) return Object.freeze({ state: "invalid" });
    let bytes: Buffer;
    try {
      bytes = await readFile(target);
    } catch (error) {
      return Object.freeze({
        state: errorCode(error) === "ENOENT" ? "missing" : "unreadable",
      });
    }
    let info;
    try {
      info = await lstat(target);
    } catch (error) {
      return Object.freeze({
        state: errorCode(error) === "ENOENT" ? "missing" : "unreadable",
      });
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      return Object.freeze({ state: "invalid" });
    }
    try {
      const [realRoot, realTarget] = await Promise.all([
        realpath(this.#credentialDirectory),
        realpath(target),
      ]);
      const realRelative = relative(resolve(realRoot), resolve(realTarget));
      if (realRelative === "" || realRelative.startsWith("..") || isAbsolute(realRelative)) {
        return Object.freeze({ state: "invalid" });
      }
    } catch (error) {
      return Object.freeze({
        state: errorCode(error) === "ENOENT" ? "missing" : "unreadable",
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      return Object.freeze({ state: "invalid" });
    }
    if (!isCredential(parsed) || parsed.type !== authType) {
      return Object.freeze({ state: "invalid" });
    }
    return Object.freeze({
      state: "ok",
      credential: structuredClone(parsed),
      tokenRevision: sha256Hex(bytes),
    });
  }

  /** Canonical-path deletion used only by orphan collection. Refuses
   * symlinks/reparse points, non-files, and anything that resolves outside
   * the credential directory. */
  async #deleteIncarnation(relativePath: string): Promise<boolean> {
    const target = this.#resolveRelativePath(relativePath);
    if (target === undefined) return false;
    let info;
    try {
      info = await lstat(target);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) return false;
    try {
      const [realRoot, realTarget] = await Promise.all([
        realpath(this.#credentialDirectory),
        realpath(target),
      ]);
      const realRelative = relative(resolve(realRoot), resolve(realTarget));
      if (realRelative === "" || realRelative.startsWith("..") || isAbsolute(realRelative)) {
        return false;
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }
    await unlink(target);
    return true;
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

  read(providerId: string): Promise<PersistedProviderCredentialRecordV2 | undefined> {
    return this.#readRecord(providerId);
  }

  async withSelectionLock<T>(
    providerId: string,
    operation: (
      current: PersistedProviderCredentialRecordV2 | undefined,
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
      current: PersistedProviderCredentialRecordV2 | undefined,
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

  async publishIncarnation<T>(
    providerId: string,
    expectedRevision: string,
    publication: CredentialIncarnationPublication,
    mutation: (
      current: PersistedProviderCredentialRecordV2 | undefined,
    ) => ManagementMutation<T>,
  ): Promise<ManagementMutationResult<T>> {
    const reference = validatePublication(providerId, publication);
    await this.#ensureDirectory();
    const recordPath = this.#recordPath(providerId);
    const credentialLockPath = this.#credentialLockPath(
      providerId,
      publication.credentialId,
    );
    return this.#withPathLock(credentialLockPath, async (assertCredentialOwned) =>
      this.#withPathLock(recordPath, async (assertRecordOwned) => {
        const assertOwned = (): void => {
          assertCredentialOwned();
          assertRecordOwned();
        };
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
        assertCommittedPublication(committed, publication, reference);
        assertOwned();
        const tokenRevision = await this.#writeIncarnation(
          reference.relativePath,
          publication.credential,
          assertOwned,
        );
        if (tokenRevision !== reference.tokenRevision) {
          throw new ProviderCredentialRecordShapeError(
            "Provider credential incarnation hash changed during publication",
          );
        }
        await this.#hooks.afterIncarnationPublication?.();
        assertOwned();
        await this.#writeRecord(recordPath, committed, assertOwned);
        return Object.freeze({
          kind: "committed",
          record: cloneRecord(committed)!,
          value: outcome.value,
        });
      }),
    );
  }

  async modifyCredential(
    providerId: string,
    credentialId: string,
    credentialGeneration: string,
    mutation: (current: Credential) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    assertSafeIncarnationSegment(credentialId, "credential ID");
    assertSafeIncarnationSegment(credentialGeneration, "credential generation");
    await this.#ensureDirectory();
    const recordPath = this.#recordPath(providerId);
    const credentialLockPath = this.#credentialLockPath(providerId, credentialId);
    return this.#withPathLock(credentialLockPath, async (assertCredentialOwned) => {
      const before = await this.#withPathLock(recordPath, async () => {
        const record = await this.#readRecord(providerId);
        const profile = record?.profiles.find(
          (candidate) =>
            candidate.credentialId === credentialId &&
            candidate.credentialGeneration === credentialGeneration,
        );
        if (profile === undefined) return undefined;
        const read = await this.#readIncarnation(profile.incarnation, profile.authType);
        return { profile, read };
      });
      if (before === undefined) return undefined;
      if (before.read.state !== "ok") {
        // The referenced incarnation is missing or invalid: the credential is
        // unavailable and no other file is ever consulted.
        return undefined;
      }
      const currentCredential = before.read.credential;

      const next = await mutation(structuredClone(currentCredential));
      if (next !== undefined && (!isCredential(next) || next.type !== before.profile.authType)) {
        throw new ProviderCredentialRecordShapeError(
          "Provider credential refresh returned an invalid credential payload",
        );
      }

      assertCredentialOwned();
      return this.#withPathLock(recordPath, async (assertRecordOwned) => {
        const assertOwned = (): void => {
          assertCredentialOwned();
          assertRecordOwned();
        };
        const current = await this.#readRecord(providerId);
        const profileIndex = current?.profiles.findIndex(
          (profile) =>
            profile.credentialId === credentialId &&
            profile.credentialGeneration === credentialGeneration,
        ) ?? -1;
        if (current === undefined || profileIndex < 0) return undefined;
        const profile = current.profiles[profileIndex]!;
        if (profile.incarnation.relativePath !== before.profile.incarnation.relativePath) {
          // The referenced incarnation changed while the rotation was in
          // flight; an old capture never publishes into a new grant.
          return undefined;
        }
        if (next === undefined) {
          return structuredClone(currentCredential);
        }
        assertOwned();
        const tokenRevision = await this.#writeIncarnation(
          profile.incarnation.relativePath,
          next,
          assertOwned,
        );
        await this.#hooks.afterIncarnationRotation?.();
        const profiles = [...current.profiles];
        profiles[profileIndex] = {
          ...profile,
          incarnation: {
            relativePath: profile.incarnation.relativePath,
            tokenRevision,
          },
        };
        const committed = { ...current, profiles };
        validateRecord(committed, providerId);
        assertOwned();
        await this.#writeRecord(recordPath, committed, assertOwned);
        return structuredClone(next);
      });
    });
  }

  async readCredential(
    providerId: string,
    credentialId: string,
    credentialGeneration: string,
  ): Promise<ProviderCredentialIncarnationRead> {
    const record = await this.#readRecord(providerId);
    const profile = record?.profiles.find(
      (candidate) =>
        candidate.credentialId === credentialId &&
        candidate.credentialGeneration === credentialGeneration,
    );
    if (profile === undefined) return Object.freeze({ state: "missing" });
    return this.#readIncarnation(profile.incarnation, profile.authType);
  }

  async modifySelection<T>(
    providerId: string,
    mutation: (
      current: PersistedProviderCredentialRecordV2 | undefined,
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
    let credentialDirectories;
    try {
      credentialDirectories = await readdir(providerDirectory, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return Object.freeze([]);
      throw error;
    }
    await this.#ensureDirectory();
    const recordPath = this.#recordPath(providerId);
    const deleted: string[] = [];
    for (const credentialEntry of [...credentialDirectories].sort((left, right) =>
      left.name.localeCompare(right.name))) {
      if (!credentialEntry.isDirectory() || !isSafeIncarnationSegment(credentialEntry.name)) {
        continue;
      }
      const credentialDirectory = join(providerDirectory, credentialEntry.name);
      const credentialLockPath = this.#credentialLockPath(providerId, credentialEntry.name);
      await this.#withPathLock(credentialLockPath, async (assertCredentialOwned) => {
        let files;
        try {
          files = await readdir(credentialDirectory, { withFileTypes: true });
        } catch (error) {
          if (errorCode(error) === "ENOENT") return;
          throw error;
        }
        for (const file of [...files].sort((left, right) =>
          left.name.localeCompare(right.name))) {
          if (!file.isFile() || !file.name.endsWith(INCARNATION_FILE_SUFFIX)) continue;
          const generation = file.name.slice(0, -INCARNATION_FILE_SUFFIX.length);
          if (!isSafeIncarnationSegment(generation)) continue;
          const fullRelativePath =
            `${providerId}/${credentialEntry.name}/${file.name}`;
          const target = this.#resolveRelativePath(fullRelativePath);
          if (target === undefined) continue;
          let info;
          try {
            info = await lstat(target);
          } catch (error) {
            if (errorCode(error) === "ENOENT") continue;
            throw error;
          }
          if (info.isSymbolicLink() || !info.isFile()) continue;
          if (now() - info.mtimeMs < graceMs) continue;
          await this.#withPathLock(recordPath, async (assertRecordOwned) => {
            const record = await this.#readRecord(providerId);
            const stillReferenced =
              record?.profiles.some(
                (profile) => profile.incarnation.relativePath === fullRelativePath,
              ) === true;
            if (stillReferenced) return;
            assertCredentialOwned();
            assertRecordOwned();
            if (await this.#deleteIncarnation(fullRelativePath)) {
              deleted.push(fullRelativePath);
            }
          });
        }
      });
    }
    return Object.freeze(deleted.sort());
  }
}

export function createFileProviderCredentialRecordStore(options: {
  readonly piDirectory: string;
  readonly createRevision: () => string;
  readonly lock?: ProviderCredentialRecordLock;
  readonly onLockDegraded?: (error: unknown) => void;
  readonly hooks?: ProviderCredentialRecordStoreHooks;
}): ProviderCredentialRecordStore {
  return new FileProviderCredentialRecordStore(options);
}
