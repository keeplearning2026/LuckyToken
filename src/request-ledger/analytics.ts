/**
 * Request Ledger analytics aggregation (Ticket 21) — pure, TypeScript-owned,
 * query-time computation over committed `RequestLedgerRecord` snapshots.
 *
 * This module holds the entire aggregation semantics as a small stateful
 * accumulator so the store can stream ledger rows in bounded pages (never
 * loading history into memory) while the arithmetic lives in one place that
 * tests can pin with independent expected tables:
 *
 *  - every matching request contributes to counts and one outcome bucket
 *    (success | failed | aborted | other | pending) regardless of usage
 *    completeness (AC-4);
 *  - token/cache sums include only requests whose normalized terminal usage
 *    is Complete (AC-5);
 *  - `reasoning` is a subset of `output` and is never added to any total;
 *  - the aggregate cacheHitRate is ΣcacheRead / Σ(input+cacheRead+cacheWrite)
 *    over Complete snapshots — a quotient, never an average (AC-6);
 *  - attribution is by `acceptedAt` (half-open `[from, to)` and bucket
 *    indices derived from `from`), so a request whose completion/usage lands
 *    after a boundary still counts in its acceptedAt bucket (AC-7);
 *  - unresolved facts stay truthful: group rows carry `value: null` and
 *    options list only facts actually present (never the current catalog).
 *
 * No monetary value exists anywhere in the input or the output.
 */
import {
  MAX_ANALYTICS_GROUPS,
  MAX_ANALYTICS_OPTIONS_VALUES,
  type AnalyticsBucket,
  type AnalyticsFilter,
  type AnalyticsGroupBy,
  type AnalyticsGroupRow,
  type AnalyticsOptionsResult,
  type AnalyticsQuery,
  type AnalyticsQueryResult,
  type AnalyticsResult,
  type AnalyticsSummary,
} from "@luckytoken/application-control-plane/control-plane";
import type { RequestLedgerRecord } from "@luckytoken/application-control-plane/control-plane";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** One rolling aggregate. */
interface Accumulator {
  total: number;
  success: number;
  failed: number;
  aborted: number;
  other: number;
  pending: number;
  participating: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  speedOutput: number;
  executionDurationMs: number;
  reasoning: number;
  reasoningReported: boolean;
  normalizedTotal: number;
}

function emptyAccumulator(): Accumulator {
  return {
    total: 0,
    success: 0,
    failed: 0,
    aborted: 0,
    other: 0,
    pending: 0,
    participating: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    speedOutput: 0,
    executionDurationMs: 0,
    reasoning: 0,
    reasoningReported: false,
    normalizedTotal: 0,
  };
}

function accumulate(acc: Accumulator, record: RequestLedgerRecord): void {
  acc.total += 1;
  switch (record.outcome) {
    case "success":
      acc.success += 1;
      break;
    case "failed":
      acc.failed += 1;
      break;
    case "aborted":
      acc.aborted += 1;
      break;
    case "running":
      acc.pending += 1;
      break;
    default:
      // rejected-auth | unknown-alias | unavailable-alias | interrupted
      acc.other += 1;
      break;
  }
  const usage = record.terminalUsage;
  if (usage === undefined || usage.completeness !== "complete") return;
  acc.participating += 1;
  acc.input += usage.input;
  acc.cacheRead += usage.cacheRead;
  acc.cacheWrite += usage.cacheWrite;
  acc.output += usage.output;
  acc.normalizedTotal += usage.normalizedTotal ?? 0;
  if (
    record.executionStartedAt !== undefined &&
    record.terminalAt !== undefined
  ) {
    const durationMs = record.terminalAt - record.executionStartedAt;
    if (durationMs > 0) {
      acc.speedOutput += usage.output;
      acc.executionDurationMs += durationMs;
    }
  }
  if (usage.reasoning !== undefined) {
    acc.reasoning += usage.reasoning;
    acc.reasoningReported = true;
  }
}

/** Sum/quotient rule: every accumulator field only grows by safe integers,
 *  so the derived sums stay safe integers at desktop scale; rates are the
 *  raw 0..1 quotient with an explicit zero-below-total rule. */
function toSummary(acc: Accumulator): AnalyticsSummary {
  const total = acc.total;
  // Product cache Hit is read hits divided by the input that could have
  // been served from cache. Cache writes are activity, not read-hit
  // opportunities, so they never enter this denominator.
  const denominator = acc.input + acc.cacheRead;
  const participating = acc.participating;
  return Object.freeze({
    total,
    success: acc.success,
    failed: acc.failed,
    aborted: acc.aborted,
    other: acc.other,
    pending: acc.pending,
    successRate: total === 0 ? 0 : acc.success / total,
    failureRate: total === 0 ? 0 : acc.failed / total,
    abortRate: total === 0 ? 0 : acc.aborted / total,
    participating,
    totalRequests: total,
    excluded: total - participating,
    inputTokens: acc.input,
    cacheReadTokens: acc.cacheRead,
    cacheWriteTokens: acc.cacheWrite,
    outputTokens: acc.output,
    ...(acc.executionDurationMs > 0
      ? {
          outputTokensPerSecond:
            (acc.speedOutput / acc.executionDurationMs) * 1000,
        }
      : {}),
    ...(participating > 0 && acc.reasoningReported
      ? { reasoningTokens: acc.reasoning }
      : {}),
    ...(participating > 0
      ? { normalizedTokenTotal: acc.normalizedTotal }
      : {}),
    cacheHitNumerator: acc.cacheRead,
    cacheHitDenominator: denominator,
    ...(denominator > 0 ? { cacheHitRate: acc.cacheRead / denominator } : {}),
  });
}

/** A dimension value of a ledger snapshot, or null when the fact was
 *  unavailable at request time (never synthesized). */
function dimensionValue(
  record: RequestLedgerRecord,
  dimension: AnalyticsGroupBy,
): string | null {
  switch (dimension) {
    case "provider":
      return record.providerId ?? null;
    case "model":
      return record.realModelId ?? null;
    case "protocol":
      return record.protocolId;
    case "project":
      return record.projectDir ?? null;
    case "outcome":
      return record.outcome;
  }
}

/** Null-aware filter match: a missing snapshot never matches a filter. */
function matchesFilters(
  record: RequestLedgerRecord,
  filters: AnalyticsFilter | undefined,
): boolean {
  if (filters === undefined) return true;
  if (
    filters.providers !== undefined &&
    (record.providerId === undefined ||
      !filters.providers.includes(record.providerId))
  ) {
    return false;
  }
  if (
    filters.models !== undefined &&
    (record.realModelId === undefined ||
      !filters.models.includes(record.realModelId))
  ) {
    return false;
  }
  if (
    filters.protocols !== undefined &&
    !filters.protocols.includes(record.protocolId)
  ) {
    return false;
  }
  if (
    filters.projects !== undefined &&
    (record.projectDir === undefined ||
      !filters.projects.includes(record.projectDir))
  ) {
    return false;
  }
  if (
    filters.sessions !== undefined &&
    (record.clientSessionId === undefined ||
      !filters.sessions.includes(record.clientSessionId))
  ) {
    return false;
  }
  if (
    filters.outcomes !== undefined &&
    !filters.outcomes.includes(record.outcome)
  ) {
    return false;
  }
  return true;
}

function sortGroupRows(
  rows: readonly AnalyticsGroupRow[],
): readonly AnalyticsGroupRow[] {
  return Object.freeze(
    [...rows].sort((left, right) => {
      const byRequests =
        right.summary.totalRequests - left.summary.totalRequests;
      if (byRequests !== 0) return byRequests;
      // Null group last; then lexicographic ascending for determinism.
      if (left.value === null) return 1;
      if (right.value === null) return -1;
      return left.value < right.value
        ? -1
        : left.value > right.value
          ? 1
          : 0;
    }),
  );
}

interface SummaryState {
  readonly query: Extract<AnalyticsQuery, { readonly command: "summary" }>;
  totals: Accumulator;
  groups: Map<string | null, Accumulator>;
  /** Exact distinct group values beyond the cap, with their request counts
   *  (memory bounded by the ledger's value variety, not its history). */
  omittedGroups: Map<string, number>;
  /** Zero-filled series buckets; undefined when no series was requested. */
  buckets: Accumulator[] | undefined;
}

function createSummaryState(
  query: Extract<AnalyticsQuery, { readonly command: "summary" }>,
): SummaryState {
  let buckets: Accumulator[] | undefined;
  const series = query.series;
  if (series !== undefined) {
    const bucketMs = series.granularity === "hour" ? HOUR_MS : DAY_MS;
    const count = Math.ceil((query.to - query.from) / bucketMs);
    buckets = Array.from({ length: count }, () => emptyAccumulator());
  }
  return {
    query,
    totals: emptyAccumulator(),
    groups: new Map(),
    omittedGroups: new Map(),
    buckets,
  };
}

function addToSummaryState(state: SummaryState, record: RequestLedgerRecord): void {
  const { query } = state;
  if (record.acceptedAt < query.from || record.acceptedAt >= query.to) return;
  if (!matchesFilters(record, query.filters)) return;
  accumulate(state.totals, record);
  const buckets = state.buckets;
  const series = query.series;
  if (buckets !== undefined && series !== undefined) {
    const bucketMs = series.granularity === "hour" ? HOUR_MS : DAY_MS;
    const index = Math.floor((record.acceptedAt - query.from) / bucketMs);
    if (index >= 0 && index < buckets.length) {
      const target = buckets[index];
      if (target !== undefined) accumulate(target, record);
    }
  }
  if (query.groupBy === undefined) return;
  const value = dimensionValue(record, query.groupBy);
  let acc = state.groups.get(value);
  if (acc !== undefined) {
    accumulate(acc, record);
    return;
  }
  if (state.groups.size < MAX_ANALYTICS_GROUPS) {
    acc = emptyAccumulator();
    state.groups.set(value, acc);
    accumulate(acc, record);
    return;
  }
  // Group cap reached: count the group honestly without inventing labels.
  const key = value ?? "";
  state.omittedGroups.set(key, (state.omittedGroups.get(key) ?? 0) + 1);
}

function finishSummaryState(state: SummaryState): AnalyticsResult {
  const totals = toSummary(state.totals);
  let rows: readonly AnalyticsGroupRow[] | undefined;
  let truncated: boolean | undefined;
  let omittedGroupCount: number | undefined;
  let omittedGroupRequests: number | undefined;
  if (state.query.groupBy !== undefined) {
    const computed: AnalyticsGroupRow[] = [];
    for (const [value, acc] of state.groups) {
      computed.push(
        Object.freeze({
          dimension: state.query.groupBy,
          value,
          summary: toSummary(acc),
        }),
      );
    }
    if (computed.length > 0) {
      rows = sortGroupRows(computed);
      if (state.omittedGroups.size > 0) {
        truncated = true;
        omittedGroupCount = state.omittedGroups.size;
        omittedGroupRequests = [...state.omittedGroups.values()].reduce(
          (sum, count) => sum + count,
          0,
        );
      }
    }
  }
  let buckets: readonly AnalyticsBucket[] | undefined;
  const series = state.query.series;
  if (state.buckets !== undefined && series !== undefined) {
    const bucketMs = series.granularity === "hour" ? HOUR_MS : DAY_MS;
    buckets = Object.freeze(
      state.buckets.map((acc, index) => {
        const start = state.query.from + index * bucketMs;
        const end = Math.min(start + bucketMs, state.query.to);
        return Object.freeze({ start, end, summary: toSummary(acc) });
      }),
    );
  }
  return Object.freeze({
    version: 1 as const,
    command: "summary" as const,
    totals,
    ...(rows === undefined ? {} : { rows }),
    ...(truncated === undefined ? {} : { truncated }),
    ...(omittedGroupCount === undefined ? {} : { omittedGroupCount }),
    ...(omittedGroupRequests === undefined ? {} : { omittedGroupRequests }),
    ...(buckets === undefined ? {} : { buckets }),
  });
}

interface OptionsState {
  readonly query: Extract<AnalyticsQuery, { readonly command: "options" }>;
  providers: Set<string>;
  models: Set<string>;
  protocols: Set<string>;
  projects: Set<string>;
  sessions: Set<string>;
  outcomes: Set<string>;
}

function createOptionsState(
  query: Extract<AnalyticsQuery, { readonly command: "options" }>,
): OptionsState {
  return {
    query,
    providers: new Set(),
    models: new Set(),
    protocols: new Set(),
    projects: new Set(),
    sessions: new Set(),
    outcomes: new Set(),
  };
}

function addToOptionsState(state: OptionsState, record: RequestLedgerRecord): void {
  const { query } = state;
  if (query.from !== undefined && record.acceptedAt < query.from) return;
  if (query.to !== undefined && record.acceptedAt >= query.to) return;
  if (record.providerId !== undefined) state.providers.add(record.providerId);
  if (record.realModelId !== undefined) state.models.add(record.realModelId);
  state.protocols.add(record.protocolId);
  if (record.projectDir !== undefined) state.projects.add(record.projectDir);
  if (record.clientSessionId !== undefined) state.sessions.add(record.clientSessionId);
  state.outcomes.add(record.outcome);
}

function finishOptionsState(state: OptionsState): AnalyticsOptionsResult {
  const cap = MAX_ANALYTICS_OPTIONS_VALUES;
  const sorted = (values: ReadonlySet<string>): readonly string[] =>
    Object.freeze([...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  const providers = sorted(state.providers);
  const models = sorted(state.models);
  const protocols = sorted(state.protocols);
  const projects = sorted(state.projects);
  const sessions = sorted(state.sessions);
  const outcomes = sorted(state.outcomes);
  const truncated =
    state.providers.size > cap ||
    state.models.size > cap ||
    state.protocols.size > cap ||
    state.projects.size > cap ||
    state.sessions.size > cap ||
    state.outcomes.size > cap;
  return Object.freeze({
    version: 1 as const,
    command: "options" as const,
    providers: Object.freeze(providers.slice(0, cap)),
    models: Object.freeze(models.slice(0, cap)),
    protocols: Object.freeze(protocols.slice(0, cap)),
    projects: Object.freeze(projects.slice(0, cap)),
    sessions: Object.freeze(sessions.slice(0, cap)),
    outcomes: Object.freeze(outcomes.slice(0, cap)),
    ...(truncated ? { truncated: true } : {}),
  });
}

/**
 * One streaming accumulator for a validated analytics query; `add` is
 * called once per committed row (in any order — attribution comes from the
 * `acceptedAt` snapshot, never from arrival order) and `finish` returns the
 * versioned result. The store feeds it in bounded pages, so history is
 * never loaded into memory.
 */
export interface LedgerAnalyticsAccumulator {
  add(record: RequestLedgerRecord): void;
  finish(): AnalyticsQueryResult;
}

export function createLedgerAnalyticsAccumulator(
  query: AnalyticsQuery,
): LedgerAnalyticsAccumulator {
  if (query.command === "options") {
    const state = createOptionsState(query);
    return Object.freeze({
      add: (record: RequestLedgerRecord) => addToOptionsState(state, record),
      finish: () => finishOptionsState(state),
    });
  }
  const state = createSummaryState(query);
  return Object.freeze({
    add: (record: RequestLedgerRecord) => addToSummaryState(state, record),
    finish: () => finishSummaryState(state),
  });
}