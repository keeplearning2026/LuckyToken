/**
 * Deep Diagnostics capture store (Ticket 22) — the bounded SQLite/WAL
 * authority for deliberately captured raw request/response artifacts,
 * modeled on the Runtime Diagnostics store (Ticket 07) and the Request
 * Ledger store (Ticket 18) but with its own versioned database and its own
 * bounded retention policy.
 *
 * One choke point: producers hand untrusted drafts (raw bodies, header
 * maps, timing); every artifact passes the Ticket 07 universal redaction
 * choke point (`redactDiagnostic` / `redactDiagnosticText` plus the
 * attached known-value scrubber) before anything is serialized. JSON
 * bodies are redacted structurally (credential-bearing keys and credential
 * shapes are removed at any nesting); non-JSON text goes through the
 * universal text sanitizer. Only committed sanitized records can be
 * queried or delivered.
 *
 * Retention is bounded by configurable age (measured from the acceptance-
 * time snapshot) and capacity. Eviction deletes capture rows only and
 * writes a tiny tombstone (request id + evicted time + reason), so a
 * request detail projection can truthfully report `expired` instead of
 * `no-capture`. The associated Request Ledger rows and diagnostics records
 * are never touched.
 *
 * Failure policy: appends throw on fault so the observer can retry with
 * the minimal failed-state marker; a capture fault never throws into the
 * handler and never changes a model response.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { DatabaseSync as createDatabaseSync } from "node:sqlite";

import { maxControlPlaneFrameBytes } from "@luckytoken/application-control-plane/control-plane";
import {
  redactDiagnostic,
  redactDiagnosticText,
} from "../runtime-diagnostics/redaction.js";
import {
  assertCaptureState,
  type CaptureDraft,
  type CaptureEvent,
  type CaptureEventFact,
  type CaptureFailureDraft,
  type CapturePersistedState,
  type CaptureQuery,
  type CaptureQueryResult,
  type CaptureRecord,
  type CaptureState,
  type CaptureTimingEntry,
  type DeepCaptureStore,
} from "./contract.js";

const SCHEMA_NAME = "luckytoken_deep_capture";
const SCHEMA_VERSION = 1;
const MAX_TIMING = 64;
const MAX_HEADER_ENTRIES = 128;
const SAFE_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/u;
const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface DeepCaptureStoreOptions {
  readonly configuration: {
    readonly directory: string;
    readonly maxCaptureBytes: number;
    readonly retentionAgeMs: number;
    readonly maxCaptures: number;
  };
  readonly now?: () => number;
  readonly databaseFactory?: {
    open(path: string): DatabaseSync;
  };
  /**
   * Opaque known-value scrubber (Ticket 07 F4): removes arbitrary
   * user-chosen Client tokens / provider credentials from every artifact
   * before commit. Supplied by the credential authorities through
   * composition; pattern redaction is the baseline either way.
   */
  readonly scrub?: (value: string) => string;
}

interface CaptureRow {
  readonly id: number;
  readonly requestId: string;
  readonly protocolId: string;
  readonly state: string;
  readonly acceptedAt: number;
  readonly capturedAt: number;
  readonly clientHttpStatus: number | null;
  readonly failure: string | null;
  readonly requestBody: string | null;
  readonly responseBody: string | null;
  readonly requestHeaders: string | null;
  readonly responseHeaders: string | null;
  readonly timing: string | null;
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
          ? "deep capture database has no schema name"
          : `deep capture database belongs to a different schema (${name.value})`,
      );
    }
    const versionRow = database
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: number } | undefined;
    if (versionRow === undefined) {
      throw new Error("deep capture database has no schema version");
    }
    if (versionRow.value !== SCHEMA_VERSION) {
      throw new Error(
        `deep capture database schema ${versionRow.value} is not supported (supported: ${SCHEMA_VERSION})`,
      );
    }
    return;
  }
  if (existing.length > 0) {
    throw new Error("deep capture database contains an unknown schema");
  }
  database.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value NOT NULL);
    CREATE TABLE captures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL UNIQUE,
      protocol_id TEXT NOT NULL,
      state TEXT NOT NULL,
      accepted_at INTEGER NOT NULL,
      captured_at INTEGER NOT NULL,
      client_http_status INTEGER,
      failure TEXT,
      request_body TEXT,
      response_body TEXT,
      request_headers TEXT,
      response_headers TEXT,
      timing TEXT
    );
    CREATE INDEX captures_accepted ON captures (accepted_at, id);
    CREATE INDEX captures_captured ON captures (captured_at, id);
    CREATE TABLE evictions (
      request_id TEXT PRIMARY KEY,
      evicted_at INTEGER NOT NULL,
      reason TEXT NOT NULL
    );
    CREATE INDEX evictions_evicted ON evictions (evicted_at);
    INSERT INTO meta (key, value) VALUES ('schema_name', '${SCHEMA_NAME}');
    INSERT INTO meta (key, value) VALUES ('schema_version', ${SCHEMA_VERSION});
  `);
}

function decodeJson(value: string | null): unknown {
  if (value === null) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("deep capture database contains invalid JSON facts");
  }
}

function rowToRecord(row: CaptureRow): CaptureRecord {
  const state = assertCaptureState(row.state);
  if (state === "no-capture" || state === "expired") {
    throw new Error("deep capture database contains an invalid state");
  }
  const requestHeaders = decodeJson(row.requestHeaders) as
    | Readonly<Record<string, string>>
    | undefined;
  const responseHeaders = decodeJson(row.responseHeaders) as
    | Readonly<Record<string, string>>
    | undefined;
  const timing = decodeJson(row.timing) as
    | readonly CaptureTimingEntry[]
    | undefined;
  const record: CaptureRecord = {
    requestId: row.requestId,
    protocolId: row.protocolId,
    state: state as CapturePersistedState,
    acceptedAt: row.acceptedAt,
    capturedAt: row.capturedAt,
    ...(row.clientHttpStatus === null
      ? {}
      : { clientHttpStatus: row.clientHttpStatus }),
    ...(row.failure === null ? {} : { failure: row.failure }),
    ...(row.requestBody === null ? {} : { requestBody: row.requestBody }),
    ...(row.responseBody === null ? {} : { responseBody: row.responseBody }),
    ...(requestHeaders === undefined ? {} : { requestHeaders }),
    ...(responseHeaders === undefined ? {} : { responseHeaders }),
    ...(timing === undefined ? {} : { timing }),
  };
  return Object.freeze(record);
}

function encodeJson(value: unknown): string | null {
  if (value === undefined) return null;
  return JSON.stringify(value);
}

function safeName(value: string, field: string): string {
  if (!SAFE_NAME_PATTERN.test(value)) {
    throw new Error(`${field} must be a bounded safe identifier`);
  }
  return value;
}

function safeRequestId(value: string): string {
  if (!REQUEST_ID_PATTERN.test(value)) {
    throw new Error("requestId must be a UUID-shaped safe ID");
  }
  return value;
}

function safeStatus(
  value: number | undefined,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 100 || value > 599) {
    throw new Error(`${field} must be an HTTP status from 100 to 599`);
  }
  return value;
}

function safeTime(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must return a non-negative safe integer`);
  }
  return value;
}

/**
 * UTF-8 byte length (conservative: a surrogate half counts 3 bytes, so a
 * pair over-counts by 2 — never under-counts, never allocates).
 */
function utf8Bytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else bytes += 3;
  }
  return bytes;
}

/** Longest code-point-aligned prefix within a UTF-8 byte budget; never
 *  splits a surrogate pair. */
function truncateUtf8(value: string, maximumBytes: number): string {
  if (utf8Bytes(value) <= maximumBytes) return value;
  let bytes = 0;
  let end = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const charBytes = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
    if (bytes + charBytes > maximumBytes) break;
    bytes += charBytes;
    end = index + 1;
  }
  // Never split a surrogate pair: back up over a lone high surrogate.
  if (end > 0 && end < value.length) {
    const previous = value.charCodeAt(end - 1);
    const next = value.charCodeAt(end);
    if (
      previous >= 0xd800 &&
      previous <= 0xdbff &&
      next >= 0xdc00 &&
      next <= 0xdfff
    ) {
      end -= 1;
    }
  }
  return value.slice(0, end);
}

/** Explicit truncation marker consistent with the redactor's bounds: an
 *  oversized artifact is never silently dropped. */
const TRUNCATION_MARKER = "…";
const TRUNCATION_MARKER_BYTES = 3;

/**
 * One universal body choke point: JSON bodies are redacted structurally
 * (credential keys and credential shapes removed at any nesting while
 * benign text survives); non-JSON text goes through the universal text
 * sanitizer. The redactor's own bounds apply; the total record payload
 * budget is enforced separately over the complete serialized record.
 */
function sanitizeBody(
  value: string,
  scrub: ((value: string) => string) | undefined,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = undefined;
  }
  if (parsed !== undefined) {
    const sanitized = redactDiagnostic("", parsed, undefined, scrub);
    if (sanitized.details !== undefined) {
      return JSON.stringify(sanitized.details);
    }
    return redactDiagnosticText(JSON.stringify(parsed), scrub);
  }
  return redactDiagnosticText(value, scrub);
}

/** Header maps go through the universal header sanitizer: credential
 *  header names (any case) lose their values; benign names keep sanitized
 *  values (the redactor bounds every value). */
function sanitizeHeaderMap(
  value: Readonly<Record<string, string>> | undefined,
  scrub: ((value: string) => string) | undefined,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  const entries = Object.entries(value).slice(0, MAX_HEADER_ENTRIES);
  const wrapped = { headers: Object.fromEntries(entries) };
  const sanitized = redactDiagnostic("", wrapped, undefined, scrub);
  const headers = sanitized.details?.headers;
  if (headers === null || typeof headers !== "object") return undefined;
  const output: Record<string, string> = Object.create(null);
  for (const [name, entry] of Object.entries(
    headers as Record<string, unknown>,
  )) {
    if (typeof entry !== "string") continue;
    output[safeName(name, "header name")] = entry;
  }
  return Object.freeze(output);
}

function sanitizeTiming(
  value: readonly CaptureTimingEntry[] | undefined,
): readonly CaptureTimingEntry[] | undefined {
  if (value === undefined) return undefined;
  const timing: CaptureTimingEntry[] = [];
  for (const entry of value.slice(0, MAX_TIMING)) {
    timing.push(
      Object.freeze({
        stage: safeName(entry.stage, "timing stage"),
        time: safeTime(entry.time, "timing time"),
      }),
    );
  }
  return Object.freeze(timing);
}

/**
 * One UTF-8 byte budget for the COMPLETE persisted capture payload: the
 * serialized committed record (request body + response body + headers +
 * timing + envelope) must always be retrievable through the real framed
 * Control Plane seam, whose frames are bounded by
 * `maxControlPlaneFrameBytes`. The record is therefore budgeted below the
 * frame ceiling with room for the frame envelope; the configured
 * `maxCaptureBytes` caps the budget (per record), never above the
 * frame-safe ceiling — every configuration accepted by the parser
 * produces records the wire can carry.
 */
const FRAME_ENVELOPE_RESERVE_BYTES = 512;
const MAX_RECORD_PAYLOAD_BYTES =
  maxControlPlaneFrameBytes - FRAME_ENVELOPE_RESERVE_BYTES;
const MAX_BUDGET_SHRINK_STEPS = 64;

/** Deterministic shrink steps: bodies halve by UTF-8 bytes (marker
 *  reserved), header/timing lists drop their second half; a part that can
 *  no longer shrink is removed. Fixed input → fixed output. */
function shrinkBody(value: string): string | undefined {
  const half = utf8Bytes(value) >> 1;
  const target = half - TRUNCATION_MARKER_BYTES;
  if (target <= 0) return undefined;
  const truncated = truncateUtf8(value, target);
  if (truncated.length === 0) return undefined;
  return `${truncated}${TRUNCATION_MARKER}`;
}

function shrinkHeaderMap(
  value: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> | undefined {
  const entries = Object.entries(value);
  if (entries.length <= 1) return undefined;
  const half = Math.ceil(entries.length / 2);
  return Object.freeze(Object.fromEntries(entries.slice(0, half)));
}

function shrinkTiming(
  value: readonly CaptureTimingEntry[],
): readonly CaptureTimingEntry[] | undefined {
  if (value.length <= 1) return undefined;
  const half = Math.ceil(value.length / 2);
  return Object.freeze(value.slice(0, half));
}

/**
 * Enforces the total payload budget over the complete serialized record:
 * deterministic alternating halving of bodies then header/timing lists
 * until the serialized UTF-8 bytes fit the budget. Oversized artifacts
 * always carry the explicit truncation marker; the envelope alone always
 * fits for every configuration the parser accepts.
 */
function enforcePayloadBudget(
  parts: {
    requestBody: string | undefined;
    responseBody: string | undefined;
    requestHeaders: Readonly<Record<string, string>> | undefined;
    responseHeaders: Readonly<Record<string, string>> | undefined;
    timing: readonly CaptureTimingEntry[] | undefined;
  },
  serialize: () => string,
  budget: number,
): void {
  // Fair deterministic rotation: each step shrinks the next shrinkable part
  // (bodies alternate, then header lists, then timing), so no single part
  // is sacrificed entirely while others stay large.
  const steps: Array<() => boolean> = [
    () => {
      if (parts.requestBody === undefined) return false;
      const next = shrinkBody(parts.requestBody);
      parts.requestBody = next;
      return true;
    },
    () => {
      if (parts.responseBody === undefined) return false;
      const next = shrinkBody(parts.responseBody);
      parts.responseBody = next;
      return true;
    },
    () => {
      if (parts.requestHeaders === undefined) return false;
      const next = shrinkHeaderMap(parts.requestHeaders);
      parts.requestHeaders = next;
      return true;
    },
    () => {
      if (parts.responseHeaders === undefined) return false;
      const next = shrinkHeaderMap(parts.responseHeaders);
      parts.responseHeaders = next;
      return true;
    },
    () => {
      if (parts.timing === undefined) return false;
      const next = shrinkTiming(parts.timing);
      parts.timing = next;
      return true;
    },
  ];
  let cursor = 0;
  let iterations = 0;
  while (utf8Bytes(serialize()) > budget && iterations < MAX_BUDGET_SHRINK_STEPS) {
    iterations += 1;
    let shrank = false;
    for (let index = 0; index < steps.length; index += 1) {
      const step = (cursor + index) % steps.length;
      if (steps[step]!()) {
        cursor = step + 1;
        shrank = true;
        break;
      }
    }
    if (!shrank) break;
  }
}

export function createDeepCaptureStoreFactory(
  options: DeepCaptureStoreOptions,
): { open(): Promise<DeepCaptureStore> } {
  const now = options.now ?? Date.now;
  const databaseFactory = options.databaseFactory ?? {
    open: (path: string) => new createDatabaseSync(path),
  };
  const directory = options.configuration.directory;
  const maximumCaptureBytes = options.configuration.maxCaptureBytes;
  const retentionAgeMs = options.configuration.retentionAgeMs;
  const maxCaptures = options.configuration.maxCaptures;
  const scrub = options.scrub;

  return {
    async open(): Promise<DeepCaptureStore> {
      await mkdir(directory, { recursive: true });
      const path = join(directory, "capture.sqlite3");
      const database = databaseFactory.open(path);
      let closed = false;

      /** Age + capacity retention on capture rows only; every evicted row
       *  leaves a tombstone so the request stays distinguishable from
       *  no-capture. Runs inside the caller's transaction. */
      const runRetention = (sweepTime: number): void => {
        const ageCutoff = sweepTime - retentionAgeMs;
        database
          .prepare(
            "INSERT INTO evictions (request_id, evicted_at, reason) SELECT request_id, ?, 'age' FROM captures WHERE accepted_at < ?",
          )
          .run(sweepTime, ageCutoff);
        database
          .prepare("DELETE FROM captures WHERE accepted_at < ?")
          .run(ageCutoff);
        const count = (
          database
            .prepare("SELECT COUNT(*) AS count FROM captures")
            .get() as { count: number }
        ).count;
        const overflow = count - maxCaptures;
        if (overflow > 0) {
          database
            .prepare(
              "INSERT INTO evictions (request_id, evicted_at, reason) SELECT request_id, ?, 'capacity' FROM captures ORDER BY id LIMIT ?",
            )
            .run(sweepTime, overflow);
          database
            .prepare(
              "DELETE FROM captures WHERE id IN (SELECT id FROM captures ORDER BY id LIMIT ?)",
            )
            .run(overflow);
        }
      };

      try {
        initializeSchema(database);
        database.exec("PRAGMA journal_mode = WAL");
        database.exec("PRAGMA synchronous = NORMAL");
        // Open-time retention sweep: rows whose retention expired while the
        // application was down are cleaned (capture rows only; tombstones
        // keep the expired state observable). A throwing injected clock must
        // not prevent the store from opening.
        let sweepTime: number;
        try {
          sweepTime = safeTime(now(), "deep capture clock");
        } catch {
          sweepTime = Date.now();
        }
        database.exec("BEGIN IMMEDIATE");
        try {
          runRetention(sweepTime);
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      } catch (error) {
        database.close();
        throw error;
      }
      const insert = database.prepare(
        `INSERT INTO captures (
           request_id, protocol_id, state, accepted_at, captured_at,
           client_http_status, failure, request_body, response_body,
           request_headers, response_headers, timing
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const selectByRequestId = database.prepare(
        `SELECT
           id, request_id AS requestId, protocol_id AS protocolId, state,
           accepted_at AS acceptedAt, captured_at AS capturedAt,
           client_http_status AS clientHttpStatus, failure,
           request_body AS requestBody, response_body AS responseBody,
           request_headers AS requestHeaders, response_headers AS responseHeaders,
           timing
         FROM captures WHERE request_id = ?`,
      );
      const selectEviction = database.prepare(
        "SELECT evicted_at AS evictedAt, reason FROM evictions WHERE request_id = ?",
      );
      const eventListeners = new Set<(event: CaptureEvent) => void>();
      let attachedScrub: ((value: string) => string) | undefined = scrub;
      // F5: no append-before-ready window. The definitive composed scrub
      // capability must be installed before any append is accepted; until
      // then appends fail closed (raw bodies must never reach disk under a
      // pattern-only downgrade).
      let scrubReady = scrub !== undefined;

      const commitRecord = (row: CaptureRow): CaptureRecord => {
        const record = rowToRecord(row);
        const eventFact: CaptureEventFact = Object.freeze({
          requestId: record.requestId,
          protocolId: record.protocolId,
          state: record.state,
          acceptedAt: record.acceptedAt,
          ...(record.clientHttpStatus === undefined
            ? {}
            : { clientHttpStatus: record.clientHttpStatus }),
        });
        for (const listener of eventListeners) {
          listener({ type: "capture_state_changed", fact: eventFact });
        }
        return record;
      };

      const store: DeepCaptureStore = {
        subscribe(
          listener: (event: CaptureEvent) => void,
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
          // rebuilds the credential authorities, and the store must scrub
          // the current values, not the previous composition's stale ones.
          attachedScrub = next;
        },
        append(draft: CaptureDraft): CaptureRecord {
          if (closed) throw new Error("Deep Diagnostics capture store is closed");
          if (!scrubReady) {
            throw new Error(
              "Deep Diagnostics capture store is not ready: the credential scrubber must be installed before appends",
            );
          }
          const requestId = safeRequestId(draft.requestId);
          const protocolId = safeName(draft.protocolId, "protocolId");
          const acceptedAt = safeTime(draft.acceptedAt, "deep capture clock");
          const capturedAt = safeTime(now(), "deep capture clock");
          const clientHttpStatus = safeStatus(
            draft.clientHttpStatus,
            "clientHttpStatus",
          );
          const failure =
            draft.failure === undefined
              ? undefined
              : safeName(draft.failure, "failure");
          const state: CapturePersistedState = draft.complete
            ? "captured"
            : "partial";
          const parts: {
            requestBody: string | undefined;
            responseBody: string | undefined;
            requestHeaders: Readonly<Record<string, string>> | undefined;
            responseHeaders: Readonly<Record<string, string>> | undefined;
            timing: readonly CaptureTimingEntry[] | undefined;
          } = {
            requestBody:
              draft.requestBody === undefined
                ? undefined
                : sanitizeBody(draft.requestBody, attachedScrub),
            responseBody:
              draft.responseBody === undefined
                ? undefined
                : sanitizeBody(draft.responseBody, attachedScrub),
            requestHeaders: sanitizeHeaderMap(
              draft.requestHeaders,
              attachedScrub,
            ),
            responseHeaders: sanitizeHeaderMap(
              draft.responseHeaders,
              attachedScrub,
            ),
            timing: sanitizeTiming(draft.timing),
          };
          // One UTF-8 byte budget for the complete serialized record: the
          // committed row must always be retrievable through the real
          // framed Control Plane seam. Deterministic halving applies the
          // marker to any oversized artifact.
          const payloadBudget = Math.min(
            maximumCaptureBytes,
            MAX_RECORD_PAYLOAD_BYTES,
          );
          enforcePayloadBudget(
            parts,
            () =>
              JSON.stringify({
                requestId,
                protocolId,
                state,
                acceptedAt,
                capturedAt,
                ...(clientHttpStatus === undefined
                  ? {}
                  : { clientHttpStatus }),
                ...(failure === undefined ? {} : { failure }),
                ...parts,
              }),
            payloadBudget,
          );
          const { requestBody, responseBody, requestHeaders, responseHeaders, timing } = parts;
          database.exec("BEGIN IMMEDIATE");
          let row: CaptureRow;
          try {
            // Insert first, then enforce retention: the sweep sees the new
            // row, so the committed table stays at or under maxCaptures.
            const result = insert.run(
              requestId,
              protocolId,
              state,
              acceptedAt,
              capturedAt,
              clientHttpStatus ?? null,
              failure ?? null,
              requestBody ?? null,
              responseBody ?? null,
              encodeJson(requestHeaders),
              encodeJson(responseHeaders),
              encodeJson(timing),
            );
            runRetention(capturedAt);
            const id = Number(result.lastInsertRowid);
            row = {
              id,
              requestId,
              protocolId,
              state,
              acceptedAt,
              capturedAt,
              clientHttpStatus: clientHttpStatus ?? null,
              failure: failure ?? null,
              requestBody: requestBody ?? null,
              responseBody: responseBody ?? null,
              requestHeaders: encodeJson(requestHeaders),
              responseHeaders: encodeJson(responseHeaders),
              timing: encodeJson(timing),
            };
            database.exec("COMMIT");
          } catch (error) {
            database.exec("ROLLBACK");
            throw error;
          }
          return commitRecord(row);
        },
        appendFailed(draft: CaptureFailureDraft): CaptureRecord {
          if (closed) throw new Error("Deep Diagnostics capture store is closed");
          if (!scrubReady) {
            throw new Error(
              "Deep Diagnostics capture store is not ready: the credential scrubber must be installed before appends",
            );
          }
          const requestId = safeRequestId(draft.requestId);
          const protocolId = safeName(draft.protocolId, "protocolId");
          const acceptedAt = safeTime(draft.acceptedAt, "deep capture clock");
          const capturedAt = safeTime(now(), "deep capture clock");
          database.exec("BEGIN IMMEDIATE");
          let row: CaptureRow;
          try {
            // Insert first, then enforce retention (same ordering as the
            // full append: the sweep sees the new row).
            const result = insert.run(
              requestId,
              protocolId,
              "failed",
              acceptedAt,
              capturedAt,
              null,
              null,
              null,
              null,
              null,
              null,
              null,
            );
            runRetention(capturedAt);
            const id = Number(result.lastInsertRowid);
            row = {
              id,
              requestId,
              protocolId,
              state: "failed",
              acceptedAt,
              capturedAt,
              clientHttpStatus: null,
              failure: null,
              requestBody: null,
              responseBody: null,
              requestHeaders: null,
              responseHeaders: null,
              timing: null,
            };
            database.exec("COMMIT");
          } catch (error) {
            database.exec("ROLLBACK");
            throw error;
          }
          return commitRecord(row);
        },
        query(query: CaptureQuery): CaptureQueryResult {
          if (closed) throw new Error("Deep Diagnostics capture store is closed");
          const requestId = safeRequestId(query.requestId);
          const row = selectByRequestId.get(requestId) as CaptureRow | undefined;
          if (row !== undefined) {
            return Object.freeze({
              state: row.state as CaptureState,
              record: rowToRecord(row),
            });
          }
          const eviction = selectEviction.get(requestId) as
            | { evictedAt: number; reason: "age" | "capacity" }
            | undefined;
          if (eviction !== undefined) {
            return Object.freeze({
              state: "expired",
              evictedAt: eviction.evictedAt,
              evictionReason: eviction.reason,
            });
          }
          return Object.freeze({ state: "no-capture" });
        },
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
