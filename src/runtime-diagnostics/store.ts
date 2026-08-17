/**
 * Diagnostics-owned SQLite/WAL store (Ticket 07).
 *
 * The store is the single authoritative destination for sanitized diagnostic
 * records: producers hand it untrusted drafts, the recursive redaction choke
 * point runs before anything is serialized, and only committed records can be
 * queried or delivered. The database is versioned and refuses unknown or
 * foreign schema without mutating the original file. All access is prepared/
 * bound statements inside a synchronous SQLite transaction; the store is
 * intentionally low-frequency and bounded (never in the request hot path).
 */
import {
  createDiagnosticFingerprint,
  redactDiagnostic,
  redactDiagnosticText,
} from "./redaction.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { DatabaseSync as createDatabaseSync } from "node:sqlite";
import {
  assertRuntimeDiagnosticLevel,
  RUNTIME_DIAGNOSTIC_SEVERITY,
  type RuntimeDiagnosticDraft,
  type RuntimeDiagnosticEvent,
  type RuntimeDiagnosticLevel,
  type RuntimeDiagnosticQuery,
  type RuntimeDiagnosticRecord,
  type RuntimeDiagnosticsQueryResult,
  type RuntimeDiagnosticsStore,
} from "./contract.js";

const SCHEMA_NAME = "luckytoken_runtime_diagnostics";
const SCHEMA_VERSION = 1;
const MAX_QUERY_LIMIT = 1_000;
const DEFAULT_QUERY_LIMIT = 100;
const FINGERPRINT_KEY_LENGTH = 32;

/**
 * Correlation-ID grammar (F1): a requestId is untrusted producer input and
 * must never carry authentication capability. Only this narrow safe grammar
 * is stored verbatim; anything else is safely omitted.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/u;

export interface RuntimeDiagnosticsStoreOptions {
  readonly configuration: { readonly directory: string };
  readonly createFingerprintKey?: () => Uint8Array;
  readonly now?: () => number;
  readonly databaseFactory?: {
    open(path: string): DatabaseSync;
  };
  /**
   * Opaque known-value scrubber (F4): removes arbitrary user-chosen Client
   * tokens / provider credentials from every producer value before commit.
   * Supplied by the credential authorities through composition.
   */
  readonly scrub?: (value: string) => string;
}

interface Row {
  readonly id: number;
  readonly level: string;
  readonly severity: number;
  readonly time: number;
  readonly text: string;
  readonly requestId: string | null;
  readonly fingerprint: string | null;
  readonly details: string | null;
  readonly errors: string | null;
}

function randomFingerprintKey(): Uint8Array {
  const key = new Uint8Array(FINGERPRINT_KEY_LENGTH);
  for (let index = 0; index < key.length; index += 1) {
    key[index] = Math.floor(Math.random() * 256);
  }
  return key;
}

/**
 * Versioned schema; refuses unknown or foreign schema without mutation.
 * Must run before any write (including WAL pragmas) so foreign files are
 * never modified.
 */
function initializeSchema(database: DatabaseSync): void {
  const existing = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'",
    )
    .all() as Array<{ name: string }>;
  const hasMeta = existing.some((entry) => entry.name === "meta");
  if (hasMeta) {
    const meta = database.prepare(
      "SELECT value FROM meta WHERE key = 'schema_name'",
    );
    const name = meta.get() as { value: string } | undefined;
    if (name === undefined || name.value !== SCHEMA_NAME) {
      throw new Error(
        name === undefined
          ? "diagnostics database has no schema name"
          : `diagnostics database belongs to a different schema (${name.value})`,
      );
    }
    const versionRow = database
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: number } | undefined;
    if (versionRow === undefined) {
      throw new Error("diagnostics database has no schema version");
    }
    if (versionRow.value !== SCHEMA_VERSION) {
      throw new Error(
        `diagnostics database schema ${versionRow.value} is not supported (supported: ${SCHEMA_VERSION})`,
      );
    }
    return;
  }
  if (existing.length > 0) {
    throw new Error("diagnostics database contains an unknown schema");
  }
  database.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value NOT NULL);
    CREATE TABLE diagnostics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL,
      severity INTEGER NOT NULL,
      time INTEGER NOT NULL,
      text TEXT NOT NULL,
      request_id TEXT,
      fingerprint TEXT,
      details TEXT,
      errors TEXT
    );
    CREATE INDEX diagnostics_time_id ON diagnostics (time, id);
    CREATE INDEX diagnostics_severity_id ON diagnostics (severity, id);
    INSERT INTO meta (key, value) VALUES ('schema_name', '${SCHEMA_NAME}');
    INSERT INTO meta (key, value) VALUES ('schema_version', ${SCHEMA_VERSION});
  `);
}

/**
 * Reads the persistent keyed-fingerprint key, creating it on first use. The
 * key lives in the diagnostics database so fingerprints stay stable across
 * restarts and are never raw hashes of low-entropy secrets.
 */
function loadFingerprintKey(
  database: DatabaseSync,
  createKey: () => Uint8Array,
): Uint8Array {
  const row = database
    .prepare("SELECT value FROM meta WHERE key = 'fingerprint_key'")
    .get() as { value: string } | undefined;
  if (row !== undefined) {
    const hex = row.value;
    if (!/^[0-9a-f]{64}$/u.test(hex)) {
      throw new Error("diagnostics database has an invalid fingerprint key");
    }
    const key = new Uint8Array(32);
    for (let index = 0; index < 32; index += 1) {
      key[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    return key;
  }
  const key = createKey();
  if (!(key instanceof Uint8Array) || key.length < 16) {
    throw new Error("createFingerprintKey must return a Uint8Array of at least 16 bytes");
  }
  const hex = Array.from(key, (byte) => byte.toString(16).padStart(2, "0")).join("");
  database
    .prepare("INSERT INTO meta (key, value) VALUES ('fingerprint_key', ?)")
    .run(hex);
  return key;
}

function decodeLevel(value: string): RuntimeDiagnosticLevel {
  try {
    return assertRuntimeDiagnosticLevel(value);
  } catch {
    throw new Error("diagnostics database contains an invalid level");
  }
}

function decodeJson(value: string | null): unknown {
  if (value === null) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("diagnostics database contains invalid JSON facts");
  }
}

function rowToRecord(row: Row): RuntimeDiagnosticRecord {
  const details = decodeJson(row.details);
  const errors = decodeJson(row.errors);
  const record: RuntimeDiagnosticRecord = {
    id: row.id,
    level: decodeLevel(row.level),
    time: row.time,
    text: row.text,
    ...(row.requestId === null ? {} : { requestId: row.requestId }),
    ...(row.fingerprint === null ? {} : { fingerprint: row.fingerprint }),
    ...(details === undefined
      ? {}
      : { details: details as Readonly<Record<string, unknown>> }),
    ...(errors === undefined
      ? {}
      : { errors: errors as readonly Readonly<Record<string, unknown>>[] }),
  };
  return Object.freeze(record);
}

function encodeJson(value: unknown): string | null {
  if (value === undefined) return null;
  return JSON.stringify(value);
}

export function createRuntimeDiagnosticsStoreFactory(
  options: RuntimeDiagnosticsStoreOptions,
): { open(): Promise<RuntimeDiagnosticsStore> } {
  const createKey = options.createFingerprintKey ?? randomFingerprintKey;
  const now = options.now ?? Date.now;
  const databaseFactory = options.databaseFactory ?? {
    open: (path: string) => new createDatabaseSync(path),
  };
  const directory = options.configuration.directory;
  const scrub = options.scrub;

  return {
    async open(): Promise<RuntimeDiagnosticsStore> {
      const directoryExists = await mkdir(directory, { recursive: true });
      void directoryExists;
      const path = join(directory, "diagnostics.sqlite3");
      const database = databaseFactory.open(path);
      let closed = false;
      try {
        initializeSchema(database);
        database.exec("PRAGMA journal_mode = WAL");
        database.exec("PRAGMA synchronous = NORMAL");
      } catch (error) {
        database.close();
        throw error;
      }
      const insert = database.prepare(
        `INSERT INTO diagnostics (level, severity, time, text, request_id, fingerprint, details, errors)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const fingerprintKey = loadFingerprintKey(database, createKey);
      const eventListeners = new Set<(event: RuntimeDiagnosticEvent) => void>();
      let attachedScrub: ((value: string) => string) | undefined = scrub;
      // F5: no append-before-ready window. The definitive composed scrub
      // capability must be installed before any append is accepted; until
      // then appends fail closed (they cannot be pattern-safely downgraded
      // for the same raw value).
      let scrubReady = scrub !== undefined;

      /** Ticket 23: shared half-open time-range validation used by
       *  deleteRange/countRange (eligible ⇔ time >= from && time < to). */
      const validateRange = (
        fromMs: number | undefined,
        toMs: number | undefined,
      ): void => {
        if (
          (fromMs !== undefined &&
            (!Number.isSafeInteger(fromMs) || fromMs < 0)) ||
          (toMs !== undefined && (!Number.isSafeInteger(toMs) || toMs < 0)) ||
          (fromMs !== undefined &&
            toMs !== undefined &&
            fromMs > toMs)
        ) {
          throw new Error(
            "diagnostics history range must be valid (fromMs <= toMs)",
          );
        }
      };
      const store: RuntimeDiagnosticsStore = {
        subscribe(
          listener: (event: RuntimeDiagnosticEvent) => void,
        ): { readonly unsubscribe: () => void } {
          eventListeners.add(listener);
          return {
            unsubscribe: () => {
              eventListeners.delete(listener);
            },
          };
        },
        attachScrub(next: (value: string) => string): void {
          if (!scrubReady) {
            attachedScrub = next;
            scrubReady = true;
            return;
          }
          // F5 invariant: no append before the first attached scrubber. A
          // later attach may REPLACE the scrubber: a Data Plane restart
          // rebuilds the credential authorities (e.g. after a live Client
          // Token rotate), and the store must scrub the current values, not
          // the previous composition's stale ones.
          attachedScrub = next;
        },
        append(draft: RuntimeDiagnosticDraft): RuntimeDiagnosticRecord {
          if (closed) throw new Error("Runtime Diagnostics store is closed");
          if (!scrubReady) {
            throw new Error(
              "Runtime Diagnostics store is not ready: the credential scrubber must be installed before appends",
            );
          }
          const level = assertRuntimeDiagnosticLevel(draft.level);
          if (typeof draft.text !== "string" || draft.text.length === 0) {
            throw new Error("runtime diagnostic text must be a non-empty string");
          }
          // F1: a credential-shaped requestId must never reach records, CP,
          // or persisted bytes. Only the narrow correlation-ID grammar is
          // stored verbatim; anything else is safely omitted.
          const requestId =
            typeof draft.requestId === "string" &&
            draft.requestId.length > 0 &&
            SAFE_REQUEST_ID.test(draft.requestId)
              ? draft.requestId
              : undefined;
          const sanitized = redactDiagnostic(
            draft.text,
            draft.details,
            draft.error,
            attachedScrub,
          );
          const fingerprint = createDiagnosticFingerprint(
            sanitized.text,
            fingerprintKey,
          );
          const time = now();
          if (!Number.isSafeInteger(time) || time < 0) {
            throw new Error("runtime diagnostic clock must return a non-negative integer");
          }
          database.exec("BEGIN IMMEDIATE");
          let id: number;
          try {
            const result = insert.run(
              level,
              RUNTIME_DIAGNOSTIC_SEVERITY[level],
              time,
              sanitized.text,
              requestId ?? null,
              fingerprint,
              encodeJson(sanitized.details),
              encodeJson(sanitized.errors),
            );
            id = Number(result.lastInsertRowid);
            database.exec("COMMIT");
          } catch (error) {
            database.exec("ROLLBACK");
            throw error;
          }
          const record: RuntimeDiagnosticRecord = {
            id,
            level,
            time,
            text: sanitized.text,
            fingerprint,
            ...(requestId === undefined ? {} : { requestId }),
            ...(sanitized.details === undefined
              ? {}
              : { details: sanitized.details }),
            ...(sanitized.errors === undefined
              ? {}
              : { errors: sanitized.errors }),
          };
          const committed = Object.freeze(record);
          for (const listener of eventListeners) {
            listener({ type: "diagnostic", record: committed });
          }
          return committed;
        },
        query(
          query: RuntimeDiagnosticQuery | undefined,
        ): RuntimeDiagnosticsQueryResult {
          if (closed) throw new Error("Runtime Diagnostics store is closed");
          const afterId =
            query?.afterId === undefined || !Number.isSafeInteger(query.afterId) || query.afterId < 0
              ? 0
              : query.afterId;
          const limit =
            query?.limit === undefined
              ? DEFAULT_QUERY_LIMIT
              : Math.min(Math.max(Number.isSafeInteger(query.limit) ? query.limit : DEFAULT_QUERY_LIMIT, 1), MAX_QUERY_LIMIT);
          // Bounded dynamic filters (Ticket 23 additive time range): the
          // prepared-per-call statement mirrors the ledger store's query
          // pattern; without time filters the SQL is byte-identical to the
          // historical path.
          const conditions: string[] = ["id > ?"];
          const params: Array<number> = [afterId];
          if (query?.minimumLevel !== undefined) {
            // F7: severity-filtered pagination must compute cursor/hasMore
            // over eligible rows only, so an empty page never claims hasMore.
            const minimum = assertRuntimeDiagnosticLevel(query.minimumLevel);
            const severity = RUNTIME_DIAGNOSTIC_SEVERITY[minimum];
            conditions.push("severity >= ?");
            params.push(severity);
          }
          if (query?.from !== undefined) {
            if (!Number.isSafeInteger(query.from) || query.from < 0) {
              throw new Error(
                "diagnostic query from must be a non-negative safe integer",
              );
            }
            conditions.push("time >= ?");
            params.push(query.from);
          }
          if (query?.to !== undefined) {
            if (!Number.isSafeInteger(query.to) || query.to < 0) {
              throw new Error(
                "diagnostic query to must be a non-negative safe integer",
              );
            }
            conditions.push("time <= ?");
            params.push(query.to);
          }
          if (
            query?.from !== undefined &&
            query?.to !== undefined &&
            query.from > query.to
          ) {
            throw new Error("diagnostic query from must not exceed to");
          }
          const rows = database
            .prepare(
              `SELECT id, level, time, text, request_id AS requestId, fingerprint, details, errors
               FROM diagnostics WHERE ${conditions.join(
                 " AND ",
               )} ORDER BY id LIMIT ?`,
            )
            .all(...params, limit + 1) as unknown as Row[];
          const hasMore = rows.length > limit;
          const visible = rows.slice(0, limit);
          return Object.freeze({
            records: Object.freeze(visible.map(rowToRecord)),
            hasMore,
          });
        },
        deleteRange(
          fromMs?: number,
          toMs?: number,
        ): { readonly deleted: number } {
          if (closed) throw new Error("Runtime Diagnostics store is closed");
          validateRange(fromMs, toMs);
          const conditions: string[] = [];
          const params: Array<number> = [];
          if (fromMs !== undefined) {
            conditions.push("time >= ?");
            params.push(fromMs);
          }
          if (toMs !== undefined) {
            conditions.push("time < ?");
            params.push(toMs);
          }
          database.exec("BEGIN IMMEDIATE");
          try {
            const sql =
              conditions.length === 0
                ? "DELETE FROM diagnostics"
                : `DELETE FROM diagnostics WHERE ${conditions.join(" AND ")}`;
            const result = database.prepare(sql).run(...params);
            database.exec("COMMIT");
            return Object.freeze({ deleted: Number(result.changes) });
          } catch (error) {
            database.exec("ROLLBACK");
            throw error;
          }
        },
        countRange(fromMs?: number, toMs?: number): number {
          if (closed) throw new Error("Runtime Diagnostics store is closed");
          validateRange(fromMs, toMs);
          const conditions: string[] = [];
          const params: Array<number> = [];
          if (fromMs !== undefined) {
            conditions.push("time >= ?");
            params.push(fromMs);
          }
          if (toMs !== undefined) {
            conditions.push("time < ?");
            params.push(toMs);
          }
          const sql =
            conditions.length === 0
              ? "SELECT COUNT(*) AS count FROM diagnostics"
              : `SELECT COUNT(*) AS count FROM diagnostics WHERE ${conditions.join(" AND ")}`;
          const row = database.prepare(sql).get(...params) as {
            count: number;
          };
          return Number(row.count);
        },
        schemaVersion: SCHEMA_VERSION,
        close(): void {
          if (closed) return;
          closed = true;
          eventListeners.clear();
          try {
            // Finalize prepared statements and merge WAL frames so no
            // -wal/-shm files keep the database locked after close.
            database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          } catch {
            // Best effort; the database is still closed below.
          }
          database.close();
        },
      };
      return store;
    },
  };
}

export function redactDiagnosticTextValue(
  text: string,
  scrub?: (value: string) => string,
): string {
  return redactDiagnosticText(text, scrub);
}
