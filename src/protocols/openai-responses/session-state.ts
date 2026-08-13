/**
 * Durable session state for the OpenAI Responses Client Protocol.
 *
 * Codex clients send incremental requests: each request carries only the new
 * input items plus a `previous_response_id` reference. The upstream Provider
 * is stateless with respect to Responses semantics, so this adapter owns the
 * history: it remembers each saved response's input + output items and
 * expands `previous_response_id` into the full input before Pi IR
 * conversion.
 *
 * This module is Responses-owned. It exposes only the small expand/remember/
 * flush interface. Wire-item storage, bearer-ID generation, TTL/capacity
 * bounds, commit scheduling, persistence, corruption handling, and admission
 * rules are hidden behind it; callers never receive its Map or snapshot
 * schema.
 *
 * A response ID is a bearer capability: it is high entropy, non-enumerable,
 * bounded by TTL and capacity, and never bound to an auth/project scope.
 *
 * The first response does not wait for the memory/session commit before
 * returning. The contract documents the resulting race: an immediately
 * following previous_response_id request may temporarily fail to resolve.
 *
 * State loading/writing have mutually compatible total-size and entry
 * limits: the module never writes a snapshot that the next process refuses
 * to load. Writes are serialized, use a same-directory temporary file plus
 * atomic rename, and graceful flush is supported. Corrupt state is
 * quarantined without silently treating a specifically referenced ID as
 * valid empty history.
 */

import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

export const MAX_RESPONSE_STATE_ENTRIES = 1000;
export const MAX_SNAPSHOT_FILE_BYTES = 32 * 1024 * 1024;
/** Per-entry byte budget so the aggregate can never exceed the snapshot cap. */
export const MAX_ENTRY_ITEMS = 1_000;
export const MAX_ENTRY_BYTES = 256 * 1024;
export const ENTRY_TTL_MS = 24 * 60 * 60 * 1_000;
export const SNAPSHOT_DEBOUNCE_MS = 2_000;
const SNAPSHOT_SCHEMA_VERSION = 3;
const STALE_TEMP_GRACE_MS = 15 * 60 * 1_000;
const TEMP_NAME_PATTERN = /^(.+)\.(\d+)\.(\d+)\.tmp$/u;

export type StoreFalsePolicy = "honor" | "memory" | "persist";

/** A previous_response_id that the local store cannot resolve. */
export class ResponseStateConversionFailure extends Error {
  readonly kind = "ResponseStateConversionFailure";

  constructor(message: string) {
    super(message);
    this.name = "ResponseStateConversionFailure";
  }
}

export interface ResponseStateEntry {
  readonly createdAt: number;
  readonly items: readonly unknown[];
}

export interface ResponseSessionState {
  /**
   * Save a completed (or max_output_tokens-incomplete) response for replay.
   * `store:false` on the request follows the configured `storeFalsePolicy`.
   * When the policy persists despite caller false, `notice` is invoked with
   * the Responses-local notice code.
   */
  readonly remember: (
    request: unknown,
    response: unknown,
    notice?: (code: string) => void,
  ) => Promise<void>;
  /**
   * Expand `previous_response_id` into the full input. An unknown, expired,
   * evicted, corrupt, or unresolvable ID is a typed conversion error; there
   * is no fail-open assumption that the client resent complete history.
   */
  readonly expand: (body: unknown) => Promise<unknown>;
  /** Flush any pending debounced snapshot write (shutdown / tests). */
  readonly flush: () => Promise<void>;
  readonly size: () => number;
}

export interface ResponseSessionStateOptions {
  readonly stateFile: string;
  readonly maxEntries?: number;
  readonly ttlMs?: number;
  readonly storeFalsePolicy?: StoreFalsePolicy;
  readonly now?: () => number;
}

/**
 * Normalize a Responses `input` field into an item array.
 *
 * `undefined` → `[]`; an array is preserved; a string becomes a single user
 * message item. This mirrors opencodex's `inputItems`.
 */
export function responseInputItems(input: unknown): readonly unknown[] {
  if (input === undefined) return [];
  if (Array.isArray(input)) return input;
  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }
  return [input];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function cloneStoredItems(items: readonly unknown[]): unknown[] {
  const clone = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map((entry) => clone(entry));
    if (isRecord(value)) {
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        result[key] = clone(entry);
      }
      return result;
    }
    return value;
  };
  return items.map((item) => clone(item));
}

function approximateBytes(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean") return 8;
  if (Array.isArray(value)) {
    let total = 0;
    for (const entry of value) total += approximateBytes(entry);
    return total;
  }
  if (typeof value === "object") {
    let total = 0;
    for (const [key, entry] of Object.entries(value)) {
      total += key.length + approximateBytes(entry);
    }
    return total;
  }
  return 8;
}

/**
 * Storage hygiene for saved history: drop `function_call_output` items whose
 * `call_id` has no preceding `function_call` in the same batch. Codex real
 * clients send tool-result increments that may reference a call from an
 * earlier response; retaining the orphan would poison the chain for later
 * expansion (the converter tolerates orphans, but the store should not
 * persist them).
 */
function sanitizeStoredItems(items: readonly unknown[]): unknown[] {
  const seenCallIds = new Set<string>();
  const sanitized: unknown[] = [];
  for (const item of items) {
    if (!isRecord(item)) {
      sanitized.push(item);
      continue;
    }
    const type = item.type;
    const callId = item.call_id;
    if (
      (type === "function_call_output" || type === "custom_tool_call_output") &&
      typeof callId === "string" &&
      !seenCallIds.has(callId)
    ) {
      continue;
    }
    if (
      (type === "function_call" || type === "custom_tool_call") &&
      typeof callId === "string"
    ) {
      seenCallIds.add(callId);
    }
    sanitized.push(item);
  }
  return sanitized;
}

async function cleanupOrphanTemps(stateFile: string): Promise<void> {
  const directory = dirname(stateFile);
  const baseName = stateFile.split(/[\\/]/u).at(-1) ?? stateFile;
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  for (const name of names) {
    const match = TEMP_NAME_PATTERN.exec(name);
    if (match === null) continue;
    if (match[1] !== baseName) continue;
    const pid = Number(match[2]);
    const sequence = Number(match[3]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    if (!Number.isSafeInteger(sequence) || sequence <= 0) continue;
    if (processIsAlive(pid)) continue;
    const path = join(directory, name);
    try {
      const fileStat = await stat(path);
      if (Date.now() - fileStat.mtimeMs < STALE_TEMP_GRACE_MS) continue;
      await unlink(path);
    } catch {
      // Best-effort cleanup; snapshot loading must remain independent.
    }
  }
}

/**
 * Create the session state store. One store instance is owned by one handler
 * instance, so concurrent requests to the same handler share history while
 * separate composition roots stay isolated.
 */
export function createResponseSessionState(
  options: ResponseSessionStateOptions,
): ResponseSessionState {
  const maxEntries = options.maxEntries ?? MAX_RESPONSE_STATE_ENTRIES;
  const ttlMs = options.ttlMs ?? ENTRY_TTL_MS;
  const storeFalsePolicy = options.storeFalsePolicy ?? "honor";
  const now = options.now ?? Date.now;
  const stateFile = options.stateFile;
  const states = new Map<string, ResponseStateEntry>();
  let loaded = false;
  let loadPromise: Promise<void> | undefined;
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  let persistGate: Promise<void> | undefined;
  let stateRevision = 0;

  const evictIfNeeded = (): void => {
    while (states.size > maxEntries && states.size > 0) {
      let oldestId: string | undefined;
      let oldestCreatedAt = Number.POSITIVE_INFINITY;
      for (const [id, entry] of states) {
        if (entry.createdAt < oldestCreatedAt) {
          oldestCreatedAt = entry.createdAt;
          oldestId = id;
        }
      }
      if (oldestId === undefined) break;
      states.delete(oldestId);
    }
  };

  const loadSnapshot = async (): Promise<void> => {
    await cleanupOrphanTemps(stateFile);
    try {
      if (!(await fileExists(stateFile))) return;
      const fileStat = await stat(stateFile);
      if (fileStat.size > MAX_SNAPSHOT_FILE_BYTES) {
        // Oversized snapshot: quarantine it and start empty, mirroring the
        // corrupt path. A later snapshot is written from scratch.
        await rename(stateFile, `${stateFile}.corrupt`).catch(() => undefined);
        return;
      }
      const raw: unknown = JSON.parse(await readFile(stateFile, "utf8"));
      if (!isRecord(raw) || raw.version !== SNAPSHOT_SCHEMA_VERSION) return;
      const entries = raw.states;
      if (!Array.isArray(entries)) return;
      for (const entry of entries) {
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        const [id, value] = entry;
        if (typeof id !== "string" || !isRecord(value)) continue;
        const createdAt = value.createdAt;
        const items = value.items;
        if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) continue;
        if (!Array.isArray(items)) continue;
        // Load-time self-healing: sanitize orphan tool outputs even when they
        // come from disk (e.g. written by an older version or a crashed
        // writer). If anything changed, the snapshot is rewritten with the
        // clean data on the next persist.
        const sanitized = sanitizeStoredItems(items);
        states.set(id, { createdAt, items: sanitized });
        if (sanitized.length !== items.length) {
          stateRevision += 1;
        }
      }
      evictIfNeeded();
      if (stateRevision > 0) {
        schedulePersist();
      }
    } catch {
      // Corrupt snapshot: back it up and start empty. Never crash the server.
      try {
        await rename(stateFile, `${stateFile}.corrupt`);
      } catch {
        // Backup failure is best-effort; the snapshot is a cache.
      }
    }
  };

  const ensureLoaded = (): Promise<void> => {
    if (loaded) return Promise.resolve();
    loadPromise ??= loadSnapshot().then(() => {
      loaded = true;
    });
    return loadPromise;
  };

  const snapshotEntries = (): Array<[string, ResponseStateEntry]> => {
    const entries: Array<[string, ResponseStateEntry]> = [];
    for (const [id, entry] of states) {
      entries.push([id, { createdAt: entry.createdAt, items: [...entry.items] }]);
    }
    return entries;
  };

  const writeSnapshot = async (): Promise<void> => {
    const previous = persistGate;
    let release!: () => void;
    persistGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const revision = stateRevision;
      const body = JSON.stringify({
        version: SNAPSHOT_SCHEMA_VERSION,
        states: snapshotEntries(),
      });
      if (body.length > MAX_SNAPSHOT_FILE_BYTES) {
        // Closed contract: never write a snapshot the next load refuses.
        // The admission rules keep normal entries far below this bound; this
        // guard only prevents pathological input from breaking the invariant.
        return;
      }
      await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
      const tmp = `${stateFile}.${process.pid}.${stateRevision}.tmp`;
      await writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
      await rename(tmp, stateFile);
      if (revision === stateRevision) return;
      // A mutation landed while writing; schedule a follow-up persist.
      schedulePersist();
    } catch {
      // Disk failures are swallowed: the snapshot is a cache, not a source
      // of truth. Durability is not silently claimed.
    } finally {
      release();
    }
  };

  const schedulePersist = (): void => {
    if (persistTimer !== undefined) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = undefined;
      void writeSnapshot();
    }, SNAPSHOT_DEBOUNCE_MS);
    persistTimer.unref?.();
  };

  return Object.freeze({
    async remember(
      request: unknown,
      response: unknown,
      notice?: (code: string) => void,
    ): Promise<void> {
      await ensureLoaded();
      if (!isRecord(request) || !isRecord(response)) return;
      const id = response.id;
      if (typeof id !== "string" || id.length === 0) return;
      const output = response.output;
      if (!Array.isArray(output)) return;
      const status = response.status;
      if (status === "incomplete") {
        const details = response.incomplete_details;
        const reason =
          isRecord(details) && typeof details.reason === "string"
            ? details.reason
            : undefined;
        if (reason !== "max_output_tokens") return;
      } else if (status !== undefined && status !== "completed") {
        return;
      }
      // Anti-poisoning: a request whose own previous_response_id failed to
      // expand carries a naked increment. Saving it would replay a truncated
      // conversation, so skip it.
      const previousId = request.previous_response_id;
      if (
        typeof previousId === "string" &&
        previousId.length > 0 &&
        !states.has(previousId)
      ) {
        return;
      }
      // store:false follows the configured policy. honor stores nothing;
      // memory keeps only a process-local entry; persist stores despite the
      // caller's false and reports a notice.
      if (request.store === false) {
        if (storeFalsePolicy === "honor") return;
        if (storeFalsePolicy === "persist") {
          notice?.("openai-responses_store_false_persisted");
        }
      }
      const items = sanitizeStoredItems([
        ...responseInputItems(request.input),
        ...output,
      ]);
      if (items.length === 0) return;
      let itemsBytes = 0;
      for (const item of items) {
        itemsBytes += approximateBytes(item);
      }
      if (itemsBytes > MAX_ENTRY_BYTES) return;
      states.set(id, {
        createdAt: now(),
        items: items.slice(0, MAX_ENTRY_ITEMS),
      });
      stateRevision += 1;
      evictIfNeeded();
      schedulePersist();
    },

    async expand(body: unknown): Promise<unknown> {
      await ensureLoaded();
      if (!isRecord(body)) return body;
      const previousId = body.previous_response_id;
      if (typeof previousId !== "string" || previousId.length === 0) {
        return body;
      }
      const previous = states.get(previousId);
      if (previous === undefined) {
        throw new ResponseStateConversionFailure(
          `previous_response_id is not a known local response: ${previousId}`,
        );
      }
      if (now() - previous.createdAt > ttlMs) {
        states.delete(previousId);
        throw new ResponseStateConversionFailure(
          `previous_response_id has expired: ${previousId}`,
        );
      }
      return {
        ...body,
        // Deep-copy the stored items so a returned expansion can never alias
        // or mutate the store's owned entries.
        input: [
          ...cloneStoredItems(previous.items),
          ...cloneStoredItems(responseInputItems(body.input)),
        ],
      };
    },

    async flush(): Promise<void> {
      if (persistTimer !== undefined) {
        clearTimeout(persistTimer);
        persistTimer = undefined;
        await writeSnapshot();
        return;
      }
      await persistGate;
    },

    size(): number {
      return states.size;
    },
  });
}
