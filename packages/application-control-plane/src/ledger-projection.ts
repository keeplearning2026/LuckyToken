/**
 * Request Ledger display projections (Ticket 19, reconciled with Ticket
 * 20). Pure functions shared by the host package and the renderer:
 * deterministic primary-status derivation, the exact average-output-speed
 * formula with unavailable rules, the canonical terminal-usage display
 * contract, and the list/detail projections.
 *
 * The projections read ONLY stored ledger fields — never provider wire,
 * never the current catalog or alias registry. Request-time snapshots are
 * rendered verbatim; `clientSessionId`/`projectDir`/`externalAlias` render
 * `-` when absent, and the internal `effectiveSessionId` exists only in the
 * detail projection under its own labeled field.
 *
 * Terminal usage (Ticket 20) is the authoritative top-level
 * `RequestLedgerRecord.terminalUsage` snapshot. Its components are always
 * shown as recorded — never replaced by `-` and never recomputed;
 * `normalizedTotal` and `cacheHitRate` render only when the normalizer
 * validated and present them.
 */
import type {
  LedgerAttempt,
  LedgerFailureSummary,
  LedgerNotice,
  LedgerOutcome,
  LedgerPhase,
  RequestLedgerRecord,
} from "./ledger-contract.js";
import type { NormalizedTerminalUsage } from "@luckytoken/provider-contract/usage";

/** Deterministic primary Status derived from stored facts only. */
export type PrimaryStatus =
  | "Running"
  | "Success"
  | "Client error"
  | "Server error"
  | "Failed"
  | "Aborted"
  | "Auth rejected"
  | "Unknown model"
  | "Model unavailable"
  | "Interrupted";

/**
 * Primary Status derivation (documented precedence, checked top-down, first
 * match wins):
 *
 *  1. outcome `running`            → Running      (live; phase label shown beside it)
 *  2. outcome `success`            → Success
 *  3. outcome `failed` + 4xx       → Client error
 *  4. outcome `failed` + 5xx       → Server error
 *  5. outcome `failed` + no status → Failed       (never a guessed code)
 *  6. outcome `aborted`            → Aborted
 *  7. outcome `rejected-auth`      → Auth rejected
 *  8. outcome `unknown-alias`      → Unknown model
 *  9. outcome `unavailable-alias`  → Model unavailable
 * 10. outcome `interrupted`        → Interrupted  (crash recovery)
 *
 * Raw facts (phase, outcome, clientHttpStatus, piStopReason) are never
 * folded into or dropped from the primary status; they render under their
 * own labels.
 */
export function deriveRequestStatus(record: RequestLedgerRecord): PrimaryStatus {
  switch (record.outcome) {
    case "running":
      return "Running";
    case "success":
      return "Success";
    case "failed": {
      const status = record.clientHttpStatus;
      if (status !== undefined && status >= 400 && status <= 499) {
        return "Client error";
      }
      if (status !== undefined && status >= 500 && status <= 599) {
        return "Server error";
      }
      return "Failed";
    }
    case "aborted":
      return "Aborted";
    case "rejected-auth":
      return "Auth rejected";
    case "unknown-alias":
      return "Unknown model";
    case "unavailable-alias":
      return "Model unavailable";
    case "interrupted":
      return "Interrupted";
  }
}

/** Human label for a live phase (secondary line of a Running row). */
export function ledgerPhaseLabel(phase: LedgerPhase): string {
  switch (phase) {
    case "accepted":
      return "Accepted";
    case "execution":
      return "Executing";
    case "rendering":
      return "Rendering";
    case "terminal-preparation":
      return "Terminal prep";
  }
}

const PROTOCOL_NAMES: Readonly<Record<string, string>> = Object.freeze({
  "anthropic-messages": "Anthropic Messages",
  "openai-responses": "OpenAI Responses",
});

/** Display name for a client protocol id; unknown ids render raw. */
export function protocolDisplayName(protocolId: string): string {
  return PROTOCOL_NAMES[protocolId] ?? protocolId;
}

/** Deterministic absolute local timestamp "YYYY-MM-DD HH:MM:SS". */
export function formatTimestamp(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Duration in seconds with one decimal; never rounded away to zero. */
export function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** A validated speed renders honestly, including a zero numerator. */
export function formatTokensPerSecond(tokensPerSecond: number): string {
  if (tokensPerSecond === 0) return "0 tokens/s";
  return `${tokensPerSecond.toFixed(1)} tokens/s`;
}

/**
 * Cache Hit is a rate, not a boolean: the authoritative Ticket 20
 * `cacheHitRate` (cacheRead / (input + cacheRead + cacheWrite)), rendered
 * as a human percentage. The UI never recomputes it; a present validated
 * rate formats here, an absent/unvalidated one renders `-`.
 */
export function formatCacheHitRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/** Display projection of the authoritative terminal usage snapshot. */
export interface RequestUsageProjection {
  /** True when a terminal-usage snapshot exists for the request. */
  readonly present: boolean;
  readonly completeness: "Complete" | "Partial" | "Unavailable";
  /** Ticket 20 completeness reason; present for partial/unavailable. */
  readonly reason?: string;
  /** Known components render as recorded numbers whenever a snapshot
   *  exists — never `-`, never recomputed or invented. */
  readonly input: string;
  readonly cacheRead: string;
  readonly cacheWrite: string;
  readonly output: string;
  readonly reasoning?: string;
  /** Only present when the normalizer validated them (Complete). */
  readonly normalizedTotal?: string;
  /** Formatted percentage (e.g. "30.0%") only when the normalizer
   *  validated a rate; absent/unvalidated render `-`. Partial usage never
   *  infers a hit from cacheRead alone. */
  readonly cacheHitRate?: string;
}

const NO_TERMINAL_USAGE_REASON =
  "No terminal usage recorded for this request";

/**
 * Display rules (Ticket 19/Ticket 20 contract):
 *  - absent snapshot → every token field `-`, Unavailable;
 *  - present snapshot → input/cacheRead/cacheWrite/output (and reasoning
 *    when recorded) always render as numbers, for every completeness
 *    state; only `normalizedTotal`/`cacheHitRate` are gated on being
 *    validated/present (Complete); the completeness reason renders beside
 *    the label.
 */
export function projectRequestUsage(
  usage: NormalizedTerminalUsage | undefined,
): RequestUsageProjection {
  if (usage === undefined) {
    return Object.freeze({
      present: false,
      completeness: "Unavailable",
      reason: NO_TERMINAL_USAGE_REASON,
      input: "-",
      cacheRead: "-",
      cacheWrite: "-",
      output: "-",
    });
  }
  return Object.freeze({
    present: true,
    completeness:
      usage.completeness === "complete" ? "Complete" : usage.completeness === "partial" ? "Partial" : "Unavailable",
    ...(usage.reason === undefined ? {} : { reason: usage.reason }),
    input: String(usage.input),
    cacheRead: String(usage.cacheRead),
    cacheWrite: String(usage.cacheWrite),
    output: String(usage.output),
    ...(usage.reasoning === undefined
      ? {}
      : { reasoning: String(usage.reasoning) }),
    ...(usage.normalizedTotal === undefined
      ? {}
      : { normalizedTotal: String(usage.normalizedTotal) }),
    ...(usage.cacheHitRate === undefined
      ? {}
      : { cacheHitRate: formatCacheHitRate(usage.cacheHitRate) }),
  });
}

/**
 * Exact average output speed (Ticket 19/Ticket 20 contract):
 * known output / ((terminalAt − executionStartedAt) / 1000) tokens/s.
 * The numerator is the canonical `output` component of a present
 * terminal-usage snapshot whose output is a known safe count — Complete
 * AND Partial snapshots qualify (a snapshot can be Partial solely because
 * input/cache semantics are incomplete while its output component is
 * still trustworthy). Absent or Unavailable usage (no trustworthy
 * terminal output) and missing/non-positive durations never produce a
 * speed. This is a single-request display fact, not token analytics
 * aggregation.
 */
export function projectAverageOutputTokensPerSecond(
  record: RequestLedgerRecord,
): number | undefined {
  const usage = record.terminalUsage;
  if (usage === undefined || usage.completeness === "unavailable") {
    return undefined;
  }
  const { terminalAt, executionStartedAt } = record;
  if (terminalAt === undefined || executionStartedAt === undefined) {
    return undefined;
  }
  const durationMs = terminalAt - executionStartedAt;
  if (durationMs <= 0) return undefined;
  return usage.output / (durationMs / 1000);
}

/** Why the speed cell shows `-` (title text); undefined when valid. */
export function averageOutputSpeedUnavailableReason(
  record: RequestLedgerRecord,
): string | undefined {
  const usage = record.terminalUsage;
  if (usage === undefined) return NO_TERMINAL_USAGE_REASON;
  if (usage.completeness === "unavailable") {
    return usage.reason ?? "Usage unavailable";
  }
  if (record.terminalAt === undefined || record.executionStartedAt === undefined) {
    return "Timestamps missing";
  }
  if (record.terminalAt - record.executionStartedAt <= 0) {
    return "Invalid duration";
  }
  return undefined;
}

function countFacts(record: RequestLedgerRecord): {
  readonly attemptCount: number;
  readonly noticeCount: number;
  readonly persistenceWarnings: number;
} {
  return {
    attemptCount: record.facts?.attempts?.length ?? 0,
    noticeCount: record.facts?.notices?.length ?? 0,
    persistenceWarnings: record.facts?.persistenceWarnings ?? 0,
  };
}

/** One row of the Requests list. Missing client-scope values render `-`;
 *  the effective session identity has no field here. */
export interface RequestLedgerListProjection {
  readonly id: number;
  readonly requestId: string;
  readonly protocolId: string;
  readonly protocolName: string;
  readonly alias: string;
  readonly providerId: string;
  readonly realModelId: string;
  readonly status: PrimaryStatus;
  readonly clientHttpStatus?: number;
  readonly phase: LedgerPhase;
  readonly phaseLabel: string;
  readonly outcome: LedgerOutcome;
  readonly acceptedAt: number;
  readonly completedAt?: number;
  readonly clientSessionId: string;
  readonly projectDir: string;
  readonly speed: string;
  readonly speedUnavailableReason?: string;
  readonly usage: RequestUsageProjection;
  readonly attemptCount: number;
  readonly noticeCount: number;
  readonly persistenceWarnings: number;
}

export function projectRequestLedger(
  record: RequestLedgerRecord,
): RequestLedgerListProjection {
  const counts = countFacts(record);
  const speed = projectAverageOutputTokensPerSecond(record);
  const speedUnavailableReason = averageOutputSpeedUnavailableReason(record);
  return Object.freeze({
    id: record.id,
    requestId: record.requestId,
    protocolId: record.protocolId,
    protocolName: protocolDisplayName(record.protocolId),
    alias: record.externalAlias ?? "-",
    providerId: record.providerId ?? "-",
    realModelId: record.realModelId ?? "-",
    status: deriveRequestStatus(record),
    ...(record.clientHttpStatus === undefined
      ? {}
      : { clientHttpStatus: record.clientHttpStatus }),
    phase: record.phase,
    phaseLabel: ledgerPhaseLabel(record.phase),
    outcome: record.outcome,
    acceptedAt: record.acceptedAt,
    ...(record.completedAt === undefined
      ? {}
      : { completedAt: record.completedAt }),
    clientSessionId: record.clientSessionId ?? "-",
    projectDir: record.projectDir ?? "-",
    speed: speed === undefined ? "-" : formatTokensPerSecond(speed),
    ...(speedUnavailableReason === undefined
      ? {}
      : { speedUnavailableReason }),
    usage: projectRequestUsage(record.terminalUsage),
    attemptCount: counts.attemptCount,
    noticeCount: counts.noticeCount,
    persistenceWarnings: counts.persistenceWarnings,
  });
}

/** Full detail projection: the list fields plus every raw fact preserved
 *  under its own labeled field, including the separately labeled effective
 *  session identity. */
export interface RequestLedgerDetailProjection extends RequestLedgerListProjection {
  readonly executionStartedAt?: number;
  readonly terminalAt?: number;
  readonly effectiveSessionId?: string;
  /** terminalAt − executionStartedAt when both exist (0 is displayable). */
  readonly executionDurationMs?: number;
  /** completedAt − acceptedAt when both exist (0 is displayable). */
  readonly totalDurationMs?: number;
  readonly piStopReason?: string;
  readonly failure?: Readonly<LedgerFailureSummary>;
  readonly notices: readonly LedgerNotice[];
  readonly attempts: readonly LedgerAttempt[];
}

export function projectRequestLedgerDetail(
  record: RequestLedgerRecord,
): RequestLedgerDetailProjection {
  const list = projectRequestLedger(record);
  return Object.freeze({
    ...list,
    ...(record.executionStartedAt === undefined
      ? {}
      : { executionStartedAt: record.executionStartedAt }),
    ...(record.terminalAt === undefined
      ? {}
      : { terminalAt: record.terminalAt }),
    ...(record.effectiveSessionId === undefined
      ? {}
      : { effectiveSessionId: record.effectiveSessionId }),
    ...(record.executionStartedAt !== undefined && record.terminalAt !== undefined
      ? { executionDurationMs: record.terminalAt - record.executionStartedAt }
      : {}),
    ...(record.completedAt !== undefined
      ? { totalDurationMs: record.completedAt - record.acceptedAt }
      : {}),
    ...(record.facts?.piStopReason === undefined
      ? {}
      : { piStopReason: record.facts.piStopReason }),
    ...(record.facts?.failure === undefined
      ? {}
      : { failure: record.facts.failure }),
    notices: record.facts?.notices ?? Object.freeze([]),
    attempts: record.facts?.attempts ?? Object.freeze([]),
  });
}
