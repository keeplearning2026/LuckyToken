/**
 * Runtime Diagnostics contract (Ticket 07) — owned by the Control Plane
 * package as the public seam.
 *
 * Diagnostics are permanent application-level ordered info/warning/error/
 * critical events. An optional requestId is correlation-only and never makes
 * a diagnostic part of the Request Ledger. Every record that reaches a
 * consumer (Control Plane query/typed event, CLI, desktop, fallback) is the
 * immutable sanitized committed record produced by the store; producers only
 * ever hand the store untrusted drafts.
 */

export type RuntimeDiagnosticLevel = "info" | "warning" | "error" | "critical";

export const RUNTIME_DIAGNOSTIC_LEVELS: readonly RuntimeDiagnosticLevel[] = [
  "info",
  "warning",
  "error",
  "critical",
];

/** Level ordering, most severe first; used for severity-filtered queries. */
export const RUNTIME_DIAGNOSTIC_SEVERITY: Readonly<
  Record<RuntimeDiagnosticLevel, number>
> = Object.freeze({
  info: 0,
  warning: 1,
  error: 2,
  critical: 3,
});

export interface RuntimeDiagnosticMessage {
  readonly text: string;
  /** Optional correlation only; never a Request Ledger fact. */
  readonly requestId?: string;
}

export interface RuntimeDiagnosticDraft extends RuntimeDiagnosticMessage {
  readonly level: RuntimeDiagnosticLevel;
  /** Untrusted structured facts; every value passes the redaction choke point. */
  readonly details?: unknown;
  /** Untrusted error/cause chain; sanitized recursively. */
  readonly error?: unknown;
}

export interface RuntimeDiagnosticRecord extends RuntimeDiagnosticMessage {
  readonly id: number;
  readonly level: RuntimeDiagnosticLevel;
  readonly time: number;
  /** Non-reversible keyed fingerprint of the sanitized text, when present. */
  readonly fingerprint?: string;
  /** Immutable sanitized facts, when the producer supplied any. */
  readonly details?: Readonly<Record<string, unknown>>;
  /** Sanitized error chain entries (name, safe text, safe id, cause). */
  readonly errors?: readonly Readonly<Record<string, unknown>>[];
}

export interface RuntimeDiagnosticQuery {
  /** Inclusive minimum severity; defaults to info (all levels). */
  readonly minimumLevel?: RuntimeDiagnosticLevel;
  /** Strictly greater than this record id; defaults to 0 (earliest record). */
  readonly afterId?: number;
  /** Maximum records; defaults to 100, capped at 1_000. */
  readonly limit?: number;
  /** Inclusive time range (epoch-ms); both endpoints valid when present. */
  readonly from?: number;
  readonly to?: number;
}

export interface RuntimeDiagnosticsQueryResult {
  readonly records: readonly RuntimeDiagnosticRecord[];
  /** True when more committed records exist after the returned window. */
  readonly hasMore: boolean;
}

/** Single committed record delivered to a Control Plane subscriber. */
export interface RuntimeDiagnosticEvent {
  readonly type: "diagnostic";
  readonly record: RuntimeDiagnosticRecord;
}

export interface RuntimeDiagnosticsStore {
  /** Records are permanent; never aged out. */
  readonly append: (draft: RuntimeDiagnosticDraft) => RuntimeDiagnosticRecord;
  readonly query: (
    query: RuntimeDiagnosticQuery | undefined,
  ) => RuntimeDiagnosticsQueryResult;
  /** Typed committed-record events for Control Plane fan-out. */
  readonly subscribe: (
    listener: (event: RuntimeDiagnosticEvent) => void,
  ) => { readonly unsubscribe: () => void };
  /**
   * Attaches the credential-owner known-value scrubber (F4). Called once by
   * the application owner after composition resolves the credential
   * authorities; appends before attachment are still pattern-redacted.
   */
  readonly attachScrub: (scrub: (value: string) => string) => void;
  /** Closes the store; further appends/query fail with a clear error. */
  readonly close: () => void;
  /** Ticket 23: deletes committed diagnostic records whose `time` falls in
   *  the half-open `[fromMs, toMs)` range (both endpoints optional = all) in
   *  one transaction. `meta` (schema name/version/fingerprint key) and all
   *  other tables are never touched. */
  readonly deleteRange: (
    fromMs?: number,
    toMs?: number,
  ) => { readonly deleted: number };
  /** Ticket 23: eligible committed-record count for the same half-open
   *  range; matches deleteRange so previews equal actual deletions. */
  readonly countRange: (fromMs?: number, toMs?: number) => number;
  /** Store-owned consistent SQLite image for an explicitly confirmed
   * Ticket 24 full-sensitive backup. */
  readonly createBackupSnapshot: (signal: AbortSignal) => Promise<Uint8Array>;
  /** The versioned schema this store commits (manifest source fact). */
  readonly schemaVersion: number;
}

export interface RuntimeDiagnosticsStoreFactory {
  /** Opens (creating on first use) the versioned diagnostics database. */
  readonly open: () => Promise<RuntimeDiagnosticsStore>;
}

export function assertRuntimeDiagnosticLevel(
  value: unknown,
): RuntimeDiagnosticLevel {
  if (
    value === "info" ||
    value === "warning" ||
    value === "error" ||
    value === "critical"
  ) {
    return value;
  }
  throw new Error(
    "runtime diagnostic level must be one of: info, warning, error, critical",
  );
}

export function severityAtLeast(
  level: RuntimeDiagnosticLevel,
  minimum: RuntimeDiagnosticLevel,
): boolean {
  return RUNTIME_DIAGNOSTIC_SEVERITY[level] >= RUNTIME_DIAGNOSTIC_SEVERITY[minimum];
}

/**
 * Explicit diagnostics ownership (Ticket 07): the Control Plane serves
 * bounded diagnostics queries and typed diagnostic events through this
 * interface. Status subscribers never receive diagnostic events.
 */
export interface ControlPlaneDiagnostics {
  query(
    query: RuntimeDiagnosticQuery | undefined,
  ): RuntimeDiagnosticsQueryResult;
  subscribe(
    listener: (event: RuntimeDiagnosticEvent) => void,
  ): { readonly unsubscribe: () => void };
}

export function normalizeDiagnosticQuery(
  value: RuntimeDiagnosticQuery | undefined,
): RuntimeDiagnosticQuery | undefined {
  if (value === undefined) return undefined;
  const afterId =
    value.afterId === undefined || !Number.isSafeInteger(value.afterId) || value.afterId < 0
      ? 0
      : value.afterId;
  const limit =
    value.limit === undefined
      ? 100
      : Math.min(
          Math.max(Number.isSafeInteger(value.limit) ? value.limit : 100, 1),
          1_000,
        );
  const minimumLevel =
    value.minimumLevel === undefined
      ? undefined
      : assertRuntimeDiagnosticLevel(value.minimumLevel);
  // Ticket 23: the wire decoder already validated the inclusive range; the
  // normalizer forwards it unchanged (store.query validates defensively).
  return {
    ...(minimumLevel === undefined ? {} : { minimumLevel }),
    ...(afterId === 0 ? {} : { afterId }),
    ...(limit === 100 ? {} : { limit }),
    ...(value.from === undefined ? {} : { from: value.from }),
    ...(value.to === undefined ? {} : { to: value.to }),
  };
}
