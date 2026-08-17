/**
 * LuckyToken-owned persistent implementation of Pi's CredentialStore contract.
 *
 * The contract and lifecycle remain owned by @earendil-works/pi-ai. The file
 * locking pattern is a minimal extraction from pi-coding-agent's AuthStorage;
 * no Pi/Pi Agent source is modified or imported as application code.
 *
 * Ticket 12: this store is also the one persistence path of the serialized
 * Credential Authority. `casWrite` is the single mutation primitive for
 * confirmed replacement, logout and Provider-by-Provider import (every write
 * is a compare-and-swap on the slot the client was served), `snapshot` is the
 * raw read used for revision tracking and status, and every write is atomic
 * (temporary file + rename) with restrictive local permissions.
 */
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { setTimeout as sleep } from "node:timers/promises";

type CredentialData = Record<string, Credential>;

const AUTH_FILE_MODE = 0o600;
const AUTH_DIRECTORY_MODE = 0o700;
const LOCK_STALE_MS = 30_000;

/** The auth.json slot the client was served has changed (Ticket 12 CAS). */
export class CredentialStaleSlotError extends Error {
  readonly code = "STALE_CREDENTIAL_SLOT" as const;

  constructor() {
    super("The stored credential changed since it was read");
    this.name = "CredentialStaleSlotError";
  }
}

/** Value-free auth.json syntax failure (kind "parse"). */
export class CredentialFileSyntaxError extends Error {
  readonly code = "CREDENTIAL_FILE_SYNTAX" as const;
  readonly kind = "parse" as const;

  constructor(message: string) {
    super(message);
    this.name = "CredentialFileSyntaxError";
  }
}

/** Value-free auth.json shape failure (kind "invalid"). */
export class CredentialFileShapeError extends Error {
  readonly code = "CREDENTIAL_FILE_SHAPE" as const;
  readonly kind = "invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "CredentialFileShapeError";
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function cloneCredential(
  credential: Credential | undefined,
): Credential | undefined {
  return credential === undefined ? undefined : structuredClone(credential);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function isCredential(value: unknown): value is Credential {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "api_key") {
    return (
      (candidate.key === undefined || typeof candidate.key === "string") &&
      (candidate.env === undefined || isStringRecord(candidate.env))
    );
  }
  return (
    candidate.type === "oauth" &&
    typeof candidate.access === "string" &&
    typeof candidate.refresh === "string" &&
    typeof candidate.expires === "number" &&
    Number.isFinite(candidate.expires)
  );
}

function parseCredentialData(content: string): CredentialData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw new CredentialFileSyntaxError(
      "Invalid credential file: expected valid JSON",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CredentialFileShapeError(
      "Invalid credential file: expected an object",
    );
  }
  for (const [providerId, credential] of Object.entries(parsed)) {
    if (providerId.length === 0 || !isCredential(credential)) {
      throw new CredentialFileShapeError(
        `Invalid credential for provider ${JSON.stringify(providerId)}`,
      );
    }
  }
  return parsed as CredentialData;
}

/**
 * Strict Pi-compatible auth.json parse (Ticket 12): validates the exact
 * shape Pi's AuthStorage accepts (one type-tagged credential per Provider)
 * and throws typed value-free errors. Import validation and the authority's
 * file facts share this single parser.
 */
export function parseCredentialFile(content: string): CredentialData {
  return parseCredentialData(content);
}

function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return operation;
  signal.throwIfAborted();
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = () => rejectPromise(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        rejectPromise(error);
      },
    );
  });
}

/** The store handle returned by the factory: the Pi contract plus the
 *  Ticket 12 authority primitives (raw snapshot + per-slot CAS). */
export interface FileCredentialStoreHandle extends CredentialStore {
  snapshot(): Promise<{
    readonly raw: string;
    readonly data: Readonly<Record<string, Credential>>;
    readonly present: boolean;
  }>;
  casWrite(
    providerId: string,
    expected: Credential | undefined,
    next: Credential | undefined,
  ): Promise<void>;
}

class FileCredentialStore implements FileCredentialStoreHandle {
  readonly #authPath: string;

  constructor(authPath: string) {
    this.#authPath = resolve(authPath);
  }

  async #ensureFile(options?: AuthOperationOptions): Promise<void> {
    options?.signal?.throwIfAborted();
    await mkdir(dirname(this.#authPath), {
      recursive: true,
      mode: AUTH_DIRECTORY_MODE,
    });
    let handle;
    try {
      handle = await open(this.#authPath, "wx", AUTH_FILE_MODE);
      await handle.writeFile("{}\n", { encoding: "utf8" });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    } finally {
      await handle?.close();
    }
    await chmod(this.#authPath, AUTH_FILE_MODE);
    options?.signal?.throwIfAborted();
  }

  async #acquireLock(
    signal: AbortSignal | undefined,
    onCompromised: (error: Error) => void,
  ): Promise<() => Promise<void>> {
    const deadline = Date.now() + LOCK_STALE_MS;
    let retry = 0;
    while (true) {
      signal?.throwIfAborted();
      try {
        return await lockfile.lock(this.#authPath, {
          realpath: false,
          retries: 0,
          stale: LOCK_STALE_MS,
          onCompromised,
        });
      } catch (error) {
        signal?.throwIfAborted();
        const remainingMs = deadline - Date.now();
        if (errorCode(error) !== "ELOCKED" || remainingMs <= 0) throw error;
        const delayMs = Math.min(10 * 2 ** retry, 1_000, remainingMs);
        retry += 1;
        await sleep(delayMs, undefined, { signal });
      }
    }
  }

  async #withLock<T>(
    operation: (data: CredentialData) => Promise<{
      result: T;
      changed: boolean;
    }>,
    options?: AuthOperationOptions,
  ): Promise<T> {
    await this.#ensureFile(options);
    let compromised: Error | undefined;
    const release = await this.#acquireLock(options?.signal, (error) => {
      compromised = error;
    });
    const throwIfCompromised = (): void => {
      if (compromised !== undefined) {
        throw new Error("Credential file lock was compromised", {
          cause: compromised,
        });
      }
    };
    try {
      throwIfCompromised();
      options?.signal?.throwIfAborted();
      const content = await readFile(this.#authPath, {
        encoding: "utf8",
        signal: options?.signal,
      });
      const data = parseCredentialData(content);
      const { result, changed } = await abortable(
        operation(data),
        options?.signal,
      );
      throwIfCompromised();
      options?.signal?.throwIfAborted();
      if (changed) {
        // Atomic replacement (Ticket 12): write a restrictive temporary
        // sibling, chmod, then rename over auth.json. Readers outside the
        // lock observe either the old or the new bytes, never a torn file.
        const temporaryPath = `${this.#authPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
        try {
          await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, {
            encoding: "utf8",
            flag: "wx",
            mode: AUTH_FILE_MODE,
            signal: options?.signal,
          });
          await chmod(temporaryPath, AUTH_FILE_MODE);
          await rename(temporaryPath, this.#authPath);
          await chmod(this.#authPath, AUTH_FILE_MODE);
        } finally {
          await rm(temporaryPath, { force: true }).catch(() => undefined);
        }
      }
      throwIfCompromised();
      return result;
    } finally {
      try {
        await release();
      } catch {
        // A compromised lock already invalidates the operation above. There is
        // no useful recovery action for an unlock failure at this boundary.
      }
    }
  }

  read(
    providerId: string,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.#withLock(
      async (data) => ({
        result: cloneCredential(data[providerId]),
        changed: false,
      }),
      options,
    );
  }

  list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    return this.#withLock(
      async (data) => ({
        result: Object.entries(data).map(([providerId, credential]) => ({
          providerId,
          type: credential.type,
        })),
        changed: false,
      }),
      options,
    );
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.#withLock(async (data) => {
      const current = cloneCredential(data[providerId]);
      const next = await fn(current);
      if (next === undefined) {
        return { result: current, changed: false };
      }
      if (!isCredential(next)) {
        throw new Error(
          `Invalid credential for provider ${JSON.stringify(providerId)}`,
        );
      }
      data[providerId] = structuredClone(next);
      return { result: cloneCredential(next), changed: true };
    }, options);
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.#withLock(async (data) => {
      if (!(providerId in data)) return { result: undefined, changed: false };
      delete data[providerId];
      return { result: undefined, changed: true };
    }, options);
  }

  /**
   * Ticket 12: raw snapshot for the authority's revision tracking and status.
   * Lock-free by design — writers always replace the file atomically, so a
   * concurrent reader sees either the old or the new bytes and a torn read is
   * impossible. Never creates the file, so `present` is honest. Parse
   * failures throw typed value-free errors.
   */
  async snapshot(): Promise<{
    readonly raw: string;
    readonly data: CredentialData;
    readonly present: boolean;
  }> {
    let raw: string;
    let present = true;
    try {
      raw = await readFile(this.#authPath, { encoding: "utf8" });
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        raw = "";
        present = false;
      } else {
        throw error;
      }
    }
    return {
      raw,
      data: present ? parseCredentialData(raw) : {},
      present,
    };
  }

  /**
   * Ticket 12: the single serialized compare-and-swap mutation of one
   * Provider slot, used by confirmed replacement (login), logout and
   * Provider-by-Provider import. Runs inside the same lock as every other
   * mutation; when the slot's current credential differs from `expected`
   * (the value the client was served), rejects with
   * `CredentialStaleSlotError` and nothing is written. `next === undefined`
   * removes the slot (logout).
   */
  async casWrite(
    providerId: string,
    expected: Credential | undefined,
    next: Credential | undefined,
    options?: AuthOperationOptions,
  ): Promise<void> {
    await this.#withLock(async (data) => {
      const current = cloneCredential(data[providerId]);
      if (!credentialsEqual(current, expected)) {
        throw new CredentialStaleSlotError();
      }
      if (next === undefined) {
        if (!(providerId in data)) return { result: undefined, changed: false };
        delete data[providerId];
        return { result: undefined, changed: true };
      }
      if (!isCredential(next)) {
        throw new CredentialFileShapeError(
          `Invalid credential for provider ${JSON.stringify(providerId)}`,
        );
      }
      data[providerId] = structuredClone(next);
      return { result: undefined, changed: true };
    }, options);
  }
}

/**
 * Structural equality of the two Pi credential shapes (key order does not
 * matter: external auth.json files may use any property order).
 */
export function credentialsEqual(
  left: Credential | undefined,
  right: Credential | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.type !== right.type) return false;
  if (left.type === "api_key" && right.type === "api_key") {
    return left.key === right.key && recordsEqual(left.env, right.env);
  }
  if (left.type === "oauth" && right.type === "oauth") {
    return (
      left.access === right.access &&
      left.refresh === right.refresh &&
      left.expires === right.expires
    );
  }
  return false;
}

function recordsEqual(
  left: Readonly<Record<string, string>> | undefined,
  right: Readonly<Record<string, string>> | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => left[key] === right[key]);
}

export function createFileCredentialStore(
  authPath: string,
): FileCredentialStoreHandle {
  return new FileCredentialStore(authPath);
}
