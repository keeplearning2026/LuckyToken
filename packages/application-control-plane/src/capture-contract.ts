/**
 * Deep Diagnostics capture contract (Ticket 22) — owned by the Control Plane
 * package as the public seam, mirroring the Runtime Diagnostics and Request
 * Ledger contracts.
 *
 * Capture is the deliberate, globally controlled raw-diagnostics surface:
 * while the one global enable state is on, every request accepted by a
 * Client Protocol handler collects its original request body, response body,
 * safe header maps, and ordered event timing. Raw capture is bounded by a
 * per-record byte cap and by configurable age + capacity retention; the
 * associated structured Request Ledger record stays permanent and
 * independent. Every artifact reaches the store already sanitized by the
 * Ticket 07 universal redaction choke point; committed records are immutable
 * and the only records query or events may carry.
 *
 * States are truthful and derived from the persisted facts:
 * - `no-capture` — the request was accepted while capture was disabled (or
 *   no capture row exists and none was ever evicted);
 * - `captured` — full request body + response body + safe headers + ordered
 *   timing were committed;
 * - `partial` — capture began but fewer artifacts than a full capture were
 *   committed (rejected-auth/pre-body failures, aborts, unhandled throws);
 * - `failed` — finalize attempted but the first store write failed; the
 *   failed-state marker row is the only artifact;
 * - `expired` — the raw capture row was evicted by age or capacity; the
 *   eviction tombstone keeps the request distinguishable from no-capture.
 */

export type CapturePersistedState = "captured" | "partial" | "failed";

export type CaptureState = CapturePersistedState | "no-capture" | "expired";

export const CAPTURE_STATES: readonly CaptureState[] = Object.freeze([
  "no-capture",
  "captured",
  "partial",
  "failed",
  "expired",
]);

export function assertCaptureState(value: unknown): CaptureState {
  if (CAPTURE_STATES.includes(value as CaptureState)) {
    return value as CaptureState;
  }
  throw new Error(
    "capture state must be one of: no-capture, captured, partial, failed, expired",
  );
}

/** One ordered event-timing entry of a captured request. */
export interface CaptureTimingEntry {
  readonly stage: string;
  readonly time: number;
}

/**
 * One immutable committed capture record. Bodies and headers are the exact
 * sanitized artifacts the request path produced: structural redaction for
 * JSON bodies, the universal text/header choke point everywhere else, and
 * the known-value scrubber attached by the composition. `acceptedAt` is the
 * acceptance-time snapshot of the global enable decision; `capturedAt` is
 * the finalize commit time. The record never claims socket consumption.
 */
export interface CaptureRecord {
  /** The Ticket 18 Request Ledger request id; never minted here. */
  readonly requestId: string;
  readonly protocolId: string;
  readonly state: CapturePersistedState;
  /** Epoch-ms acceptance time of the immutable enable/disable snapshot. */
  readonly acceptedAt: number;
  /** Epoch-ms finalize commit time. */
  readonly capturedAt: number;
  readonly clientHttpStatus?: number;
  /** Bounded failure classification when capture ended in a failure path
   *  (aborted / unhandled-failure); never fault text. */
  readonly failure?: string;
  readonly requestBody?: string;
  readonly responseBody?: string;
  readonly requestHeaders?: Readonly<Record<string, string>>;
  readonly responseHeaders?: Readonly<Record<string, string>>;
  readonly timing?: readonly CaptureTimingEntry[];
}

/** Untrusted producer draft: the observer hands raw artifacts; the store
 *  applies the one universal redaction choke point before commit. */
export interface CaptureDraft {
  readonly requestId: string;
  readonly protocolId: string;
  readonly acceptedAt: number;
  readonly clientHttpStatus?: number;
  readonly failure?: string;
  readonly requestBody?: string;
  readonly responseBody?: string;
  readonly requestHeaders?: Readonly<Record<string, string>>;
  readonly responseHeaders?: Readonly<Record<string, string>>;
  readonly timing?: readonly CaptureTimingEntry[];
  /** True when both the request body and the response were captured; false
   *  for pre-body failures, aborts, and unhandled throws. */
  readonly complete: boolean;
}

/** Minimal failed-state marker (first write faulted; only the correlation
 *  facts remain). */
export interface CaptureFailureDraft {
  readonly requestId: string;
  readonly protocolId: string;
  readonly acceptedAt: number;
}

/** Bounded capture query: one request id. */
export interface CaptureQuery {
  readonly requestId: string;
}

/** Ticket 23: bounded oldest-first capture range query with inclusive time
 *  endpoints over `capturedAt` (matching the ledger/diagnostics query
 *  convention); used by the history exporter to stream committed capture
 *  records, never by request-detail lookups. */
export interface CaptureRangeQuery {
  /** Strictly greater than this row id; defaults to 0 (earliest record). */
  readonly afterId?: number;
  /** Inclusive capturedAt range (epoch-ms). */
  readonly from?: number;
  readonly to?: number;
  /** Maximum records; defaults to 100, capped at 1_000. */
  readonly limit?: number;
}

export interface CaptureRangeQueryResult {
  readonly records: readonly CaptureRecord[];
  /** True when more eligible committed records exist after the window. */
  readonly hasMore: boolean;
  /** Row id of the last returned record (the next paging cursor); present
   *  when at least one record was returned. */
  readonly lastRowId?: number;
}

export interface CaptureQueryResult {
  readonly state: CaptureState;
  /** Present only for committed capture rows (captured/partial/failed). */
  readonly record?: CaptureRecord;
  /** Present only for expired results: when the row was evicted and why. */
  readonly evictedAt?: number;
  readonly evictionReason?: "age" | "capacity";
}

/** Narrow committed-state fact delivered to capture subscribers; never
 *  carries bodies, headers, or timing. */
export interface CaptureEventFact {
  readonly requestId: string;
  readonly protocolId: string;
  readonly state: CaptureState;
  readonly acceptedAt: number;
  readonly clientHttpStatus?: number;
}

export interface CaptureEvent {
  readonly type: "capture_state_changed";
  readonly fact: CaptureEventFact;
}

/** Narrow Control Plane ownership (host seam): bounded query plus typed
 *  committed-state updates. Status, diagnostics, and ledger subscribers
 *  never receive capture events. */
export interface ControlPlaneCapture {
  query(query: CaptureQuery): CaptureQueryResult;
  subscribe(
    listener: (event: CaptureEvent) => void,
  ): { readonly unsubscribe: () => void };
}

/** Narrow sanitized persistence-failure fact delivered to the diagnostics
 *  seam. Contains only the request id and a fixed structured code; never
 *  fault text and never a derivative (hash/fingerprint) of it. */
export interface CaptureWriteFailure {
  readonly requestId: string;
  readonly code: "capture-write-failed";
}

/** The bounded SQLite/WAL capture store, which IS the observable surface:
 *  one choke point for every raw artifact, one retention policy, one
 *  committed-record query. */
export interface DeepCaptureStore extends ControlPlaneCapture {
  /** Commits one sanitized capture row (state captured|partial derived from
   *  `complete`) and enforces retention; throws on closed/faulted stores. */
  append(draft: CaptureDraft): CaptureRecord;
  /** Commits the minimal failed-state marker row; the observer retries with
   *  this after a first append fault so the failed state stays observable. */
  appendFailed(draft: CaptureFailureDraft): CaptureRecord;
  /** Ticket 23: bounded oldest-first committed-capture range query (used
   *  only by the history export workflow). */
  queryRange(query: CaptureRangeQuery): CaptureRangeQueryResult;
  /** Ticket 23: deletes committed capture rows whose `capturedAt` falls in
   *  the half-open `[fromMs, toMs)` range (both endpoints optional = all) in
   *  one transaction. Eviction tombstones are retention facts and remain
   *  (a deleted request stays distinguishable from no-capture). */
  deleteRange(
    fromMs?: number,
    toMs?: number,
  ): { readonly deleted: number };
  /** Ticket 23: eligible committed-row count for the same half-open range;
   *  matches deleteRange so previews equal actual deletions. */
  countRange(fromMs?: number, toMs?: number): number;
  /** Store-owned consistent SQLite image for an explicitly confirmed
   * Ticket 24 full-sensitive backup. */
  createBackupSnapshot(signal: AbortSignal): Promise<Uint8Array>;
  /** The versioned schema this store commits (manifest source fact). */
  readonly schemaVersion: number;
  attachScrub(scrub: (value: string) => string): void;
  close(): void;
}

export interface DeepCaptureStoreFactory {
  open(): Promise<DeepCaptureStore>;
}
