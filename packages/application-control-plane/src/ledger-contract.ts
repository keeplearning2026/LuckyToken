/**
 * Request Lifecycle Ledger contract (Ticket 18) — owned by the Control Plane
 * package as the public seam, mirroring the Runtime Diagnostics contract.
 *
 * The ledger is a permanent, ordered, lifecycle+fact record of every
 * accepted model request. It is deliberately NOT a second semantic request
 * model: it stores lifecycle phases/timestamps, the outcome, a bounded
 * narrow-fact summary (notices/attempts/safe failure/persistence warnings/
 * Pi stop reason), and the captured authority snapshots (alias/provider/
 * real model/client protocol/session/project). Raw protocol payloads never
 * enter the ledger. The handler owns acceptance and terminalization through
 * a handler-local entry; the store is the one SQLite/WAL authority.
 */

export type LedgerPhase =
  | "accepted"
  | "execution"
  | "rendering"
  | "terminal-preparation";

export type LedgerOutcome =
  | "running"
  | "success"
  | "failed"
  | "aborted"
  | "rejected-auth"
  | "unknown-alias"
  | "unavailable-alias"
  | "interrupted";

/** Outcomes a live request can reach through the observer; the remaining
 *  values are store lifecycle states. */
export type LedgerTerminalOutcome = Exclude<
  LedgerOutcome,
  "running" | "interrupted"
>;

export const LEDGER_PHASES: readonly LedgerPhase[] = Object.freeze([
  "accepted",
  "execution",
  "rendering",
  "terminal-preparation",
]);

export const LEDGER_OUTCOMES: readonly LedgerOutcome[] = Object.freeze([
  "running",
  "success",
  "failed",
  "aborted",
  "rejected-auth",
  "unknown-alias",
  "unavailable-alias",
  "interrupted",
]);

export function assertLedgerPhase(value: unknown): LedgerPhase {
  if (LEDGER_PHASES.includes(value as LedgerPhase)) {
    return value as LedgerPhase;
  }
  throw new Error(
    "ledger phase must be one of: accepted, execution, rendering, terminal-preparation",
  );
}

export function assertLedgerOutcome(value: unknown): LedgerOutcome {
  if (LEDGER_OUTCOMES.includes(value as LedgerOutcome)) {
    return value as LedgerOutcome;
  }
  throw new Error(
    "ledger outcome must be one of: running, success, failed, aborted, rejected-auth, unknown-alias, unavailable-alias, interrupted",
  );
}

/** Bounded conversion notice fact (same narrow shape the conversion layers
 *  already own); never the payload the notice describes. */
export interface LedgerNotice {
  readonly adapter: string;
  readonly direction: "request" | "response";
  readonly code: string;
  readonly jsonPath?: string;
  readonly action: "ignore" | "degrade" | "xrepair";
}

/** Bounded invocation attempt fact (safe ids only, never credentials). */
export interface LedgerAttempt {
  readonly attempt: number;
  readonly classification: string;
  readonly stage: string;
  readonly status?: number;
  readonly retryable?: boolean;
  readonly safeIds?: Readonly<Record<string, string>>;
}

/** Safe failure summary: bounded classification/stage plus a hash of the
 *  error message. Raw error text never enters the ledger or the wire. */
export interface LedgerFailureSummary {
  readonly classification: string;
  readonly stage?: string;
  readonly messageHash: string;
}

/** Narrow facts accumulated by one request. Every string is bounded and
 *  passes the universal redaction choke point plus the known-value scrub. */
export interface LedgerFacts {
  readonly notices?: readonly LedgerNotice[];
  readonly attempts?: readonly LedgerAttempt[];
  readonly failure?: LedgerFailureSummary;
  readonly persistenceWarnings?: number;
  readonly piStopReason?: string;
}

/** One immutable committed ledger record. Timestamps are epoch-ms safe
 *  integers: acceptedAt = handler acceptance, executionStartedAt = Pi
 *  invocation start (or upstream dispatch on passthrough), terminalAt = Pi
 *  terminal outcome (or the truthful pre-execution determination moment),
 *  completedAt = terminal response preparation. The record never claims
 *  socket consumption. */
export interface RequestLedgerRecord {
  /** Monotonic row id: the bounded paging cursor. */
  readonly id: number;
  /** Safe unique request id; also the x-luckytoken-request-id header. */
  readonly requestId: string;
  readonly protocolId: string;
  /** Last entered live phase (never a socket-consumption claim). */
  readonly phase: LedgerPhase;
  readonly outcome: LedgerOutcome;
  readonly acceptedAt: number;
  readonly executionStartedAt?: number;
  readonly terminalAt?: number;
  readonly completedAt?: number;
  readonly clientHttpStatus?: number;
  /** Captured snapshot fields. Only facts actually known at the recorded
   *  stage are present; facts unavailable to early failures stay absent. */
  readonly externalAlias?: string;
  readonly providerId?: string;
  readonly realModelId?: string;
  /** Client-supplied session id; never synthesized, never sourced from the
   *  effective identity. */
  readonly clientSessionId?: string;
  /** Internal Pi invocation identity; stored and delivered under its own
   *  labeled field, never substituted for the client id. */
  readonly effectiveSessionId?: string;
  readonly projectDir?: string;
  readonly facts?: Readonly<LedgerFacts>;
}

/** Bounded ledger query: newest-first by id. `afterId` is the strictly-older
 *  cursor (records with id < afterId); filters narrow the eligible set and
 *  hasMore is computed over eligible rows only. */
export interface RequestLedgerQuery {
  readonly afterId?: number;
  /** Maximum records; defaults to 100, capped at 1_000. */
  readonly limit?: number;
  readonly protocolId?: string;
  readonly providerId?: string;
  readonly realModelId?: string;
  readonly projectDir?: string;
  readonly outcome?: LedgerOutcome;
  /** Inclusive acceptedAt range (epoch-ms). */
  readonly from?: number;
  readonly to?: number;
}

export interface RequestLedgerQueryResult {
  readonly records: readonly RequestLedgerRecord[];
  /** True when more eligible committed records exist after the window. */
  readonly hasMore: boolean;
}

/** One committed record update delivered to a subscriber. */
export interface RequestLedgerEvent {
  readonly type: "request_ledger";
  readonly record: RequestLedgerRecord;
}

/** Session/project facts captured from the auth authority after a
 *  successful authorization. The effective identity is always present; the
 *  client identity only when the client supplied a valid one. */
export interface LedgerAuthFacts {
  readonly effectiveSessionId: string;
  readonly clientSessionId?: string;
  readonly projectDir?: string;
}

/** Immutable alias/provider/real-model snapshot captured at model
 *  resolution (Ticket 15). */
export interface LedgerModelSnapshot {
  readonly externalAlias: string;
  readonly providerId: string;
  readonly realModelId: string;
}

/** The client-visible selector as received. Known before resolution, so
 *  unknown/unavailable records can preserve it without any canonical
 *  target facts. */
export interface LedgerAliasFact {
  readonly externalAlias: string;
}

export interface LedgerTerminalFacts {
  readonly clientHttpStatus?: number;
  readonly piStopReason?: string;
}

export interface LedgerFailureInput {
  readonly classification: string;
  readonly stage?: string;
  readonly error?: unknown;
}

/** Handler-local observer handle: one per accepted request. Every transition
 *  is an explicit ordered lifecycle update owned by the handler, never by
 *  provider or conversion modules. Persistence faults never throw into the
 *  handler (fail-open); the entry continues in memory and counts warnings. */
export interface RequestLedgerEntry {
  readonly requestId: string;
  authorized(facts: LedgerAuthFacts): void;
  /** Records the external client-visible alias/selector before resolution
   *  (unknown/unavailable outcomes preserve it; the canonical target is
   *  never inferred). */
  aliasCaptured(fact: LedgerAliasFact): void;
  modelResolved(snapshot: LedgerModelSnapshot): void;
  executing(): void;
  rendering(): void;
  /** Records the terminal outcome at its determination moment. */
  terminal(
    outcome: LedgerTerminalOutcome,
    facts?: LedgerTerminalFacts,
  ): void;
  notice(notice: LedgerNotice): void;
  attempt(attempt: LedgerAttempt): void;
  fail(input: LedgerFailureInput): void;
  /** Terminal response preparation: phase terminal-preparation, completedAt,
   *  and the final client HTTP status. */
  completed(status: number): void;
}

/** The request-lifecycle observer the model handlers drive. */
export interface RequestLedger {
  /** Assembles a handler-local entry: assigns the safe unique request id and
   *  persists the accepted record before model execution begins (or counts
   *  a persistence warning when the store faults). */
  begin(protocolId: string): RequestLedgerEntry;
  query(query: RequestLedgerQuery | undefined): RequestLedgerQueryResult;
  subscribe(
    listener: (event: RequestLedgerEvent) => void,
  ): { readonly unsubscribe: () => void };
}

/** The permanent SQLite/WAL store, which IS the observer. Appends never fail
 *  closed before a scrub is attached (documented audit-surface policy:
 *  pattern redaction is the baseline; the composition attaches the known-
 *  value scrubber from the credential owners before any request can run). */
export interface RequestLedgerStore extends RequestLedger {
  attachScrub(scrub: (value: string) => string): void;
  close(): void;
}

export interface RequestLedgerStoreFactory {
  open(): Promise<RequestLedgerStore>;
}

/** Narrow sanitized persistence-failure fact delivered to the diagnostics
 *  seam. Contains only the request id and a hash; never fault text. */
export interface LedgerPersistenceFailure {
  readonly requestId: string;
  readonly messageHash: string;
}

/** Narrow Control Plane ownership (host seam): bounded query plus typed
 *  committed-record updates. Status subscribers never receive ledger events. */
export interface ControlPlaneRequestLedger {
  query(query: RequestLedgerQuery | undefined): RequestLedgerQueryResult;
  subscribe(
    listener: (event: RequestLedgerEvent) => void,
  ): { readonly unsubscribe: () => void };
}