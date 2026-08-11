/**
 * LuckyToken-owned persistent implementation of Pi's CredentialStore contract.
 *
 * The contract and lifecycle remain owned by @earendil-works/pi-ai. The file
 * locking pattern is a minimal extraction from pi-coding-agent's AuthStorage;
 * no Pi/Pi Agent source is modified or imported as application code.
 */
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { chmod, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { setTimeout as sleep } from "node:timers/promises";

type CredentialData = Record<string, Credential>;

const AUTH_FILE_MODE = 0o600;
const AUTH_DIRECTORY_MODE = 0o700;
const LOCK_STALE_MS = 30_000;

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
    throw new Error("Invalid credential file: expected valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid credential file: expected an object");
  }
  for (const [providerId, credential] of Object.entries(parsed)) {
    if (providerId.length === 0 || !isCredential(credential)) {
      throw new Error(`Invalid credential for provider ${JSON.stringify(providerId)}`);
    }
  }
  return parsed as CredentialData;
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
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

class FileCredentialStore implements CredentialStore {
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
        await writeFile(this.#authPath, `${JSON.stringify(data, null, 2)}\n`, {
          encoding: "utf8",
          mode: AUTH_FILE_MODE,
          signal: options?.signal,
        });
        await chmod(this.#authPath, AUTH_FILE_MODE);
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
    return this.#withLock(
      async (data) => {
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
      },
      options,
    );
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.#withLock(
      async (data) => {
        if (!(providerId in data)) return { result: undefined, changed: false };
        delete data[providerId];
        return { result: undefined, changed: true };
      },
      options,
    );
  }
}

export function createFileCredentialStore(authPath: string): CredentialStore {
  return new FileCredentialStore(authPath);
}
