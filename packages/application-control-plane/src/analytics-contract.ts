import type { DiagnosticsUnavailableResult } from "./request-diagnostics-contract.js";

/**
 * Request Analytics contract (Ticket 21) — owned by the Control Plane
 * package as the public seam, mirroring the Diagnostics and Request Ledger
 * contracts.
 *
 * Analytics is a query-time, TypeScript-owned aggregation over the Request
 * Ledger (Ticket 18). It introduces no persistence, no catalog joins, no
 * rollup tables, and no monetary fields: every dimension (real provider,
 * real model, client protocol, canonical project directory, outcome) is a
 * request-time ledger snapshot, and every token fact is read from the
 * canonical Ticket 20 terminal-usage snapshot. All timestamps are epoch-ms
 * `acceptedAt` values; the time range is half-open `[from, to)` so bucket
 * boundaries partition exactly and a request is attributed to the bucket
 * containing its `acceptedAt` even when its completion/usage arrives later.
 *
 * Count semantics (AC-4): every matching request counts, regardless of
 * usage completeness. Token semantics (AC-5/6): only requests whose
 * normalized terminal usage is Complete contribute to token/cache sums;
 * `reasoning` is an output subset and is never added to any total; the
 * aggregate `cacheHitRate` is ΣcacheRead / Σ(input+cacheRead),
 * never an average of per-request rates. No cost, price, subscription, or
 * billing value exists anywhere in this contract (AC-8); the wire decoders
 * reject unknown keys, so such a field can never cross the boundary.
 */

/** One versioned analytics result/query namespace. */
export const ANALYTICS_CONTRACT_VERSION = 2 as const;

/** Single-dimension group-by choices over ledger snapshot columns. */
export type AnalyticsGroupBy =
  | "provider"
  | "model"
  | "protocol"
  | "outcome";

export type AnalyticsSeriesGranularity = "hour" | "day";

/** Per-dimension filter value caps (bounded Control Plane DTOs). */
export const MAX_ANALYTICS_FILTER_VALUES = 32 as const;
/** Maximum group rows in one summary result. */
export const MAX_ANALYTICS_GROUPS = 200 as const;
/** Maximum distinct option values per dimension in an options result. */
export const MAX_ANALYTICS_OPTIONS_VALUES = 64 as const;

const DAY_MS = 86_400_000;
/** Hour series allowed only for spans up to 31 days. */
export const MAX_ANALYTICS_HOUR_SERIES_SPAN_MS = 31 * DAY_MS;
/** Day series allowed only for spans up to 366 days. */
export const MAX_ANALYTICS_DAY_SERIES_SPAN_MS = 366 * DAY_MS;

/**
 * One filter dimension's allowed values, taken from ledger snapshots at
 * request time — never from the current catalog or alias registry.
 * Every array entry is a non-empty bounded string; missing values (e.g. a
 * rejected-auth request has no provider) never match a filter.
 */
export interface AnalyticsFilter {
  /** Real provider ids (ledger `providerId` snapshots). */
  readonly providers?: readonly string[];
  /** Stable request-time statistical Profile ids. */
  readonly profiles?: readonly string[];
  /** Real model ids (ledger `realModelId` snapshots). */
  readonly models?: readonly string[];
  /** Client protocol ids (ledger `protocolId`). */
  readonly protocols?: readonly string[];
  /** Client-supplied session ids (ledger `clientSessionId` snapshots). */
  readonly sessions?: readonly string[];
  /** Ledger outcome strings. */
  readonly outcomes?: readonly string[];
}

export type AnalyticsQuery =
  | {
      readonly version: 2;
      readonly command: "summary";
      /** Inclusive acceptedAt bound (safe integer ≥ 0). */
      readonly from: number;
      /** Exclusive acceptedAt bound (> from). */
      readonly to: number;
      readonly filters?: AnalyticsFilter;
      /** Exactly one dimension; optional. */
      readonly groupBy?: AnalyticsGroupBy;
      /** Optional time series of buckets. */
      readonly series?: { readonly granularity: AnalyticsSeriesGranularity };
    }
  | {
      readonly version: 2;
      readonly command: "options";
      /** Optional acceptedAt lower bound; absent = unbounded. */
      readonly from?: number;
      /** Optional acceptedAt upper bound; absent = unbounded. */
      readonly to?: number;
    };

/**
 * One aggregate over the matching scope. Outcome counts/rates include every
 * matching request regardless of usage completeness; token/cache sums
 * include only Complete terminal-usage snapshots.
 */
export interface AnalyticsSummary {
  /** Every matching request, including `running` rows. */
  readonly total: number;
  readonly success: number;
  readonly failed: number;
  readonly aborted: number;
  /** rejected-auth | unknown-alias | unavailable-alias | interrupted. */
  readonly other: number;
  /** outcome `running`. */
  readonly pending: number;
  /** Raw 0..1 fractions over `total` (0 when total is 0). */
  readonly successRate: number;
  readonly failureRate: number;
  readonly abortRate: number;
  /** Requests whose normalized terminal usage is Complete. */
  readonly participating: number;
  /** Identical to `total`; explicit for the UI. */
  readonly totalRequests: number;
  /** total − participating (Partial/Unavailable usage or none). */
  readonly excluded: number;
  /** Σ input over participating snapshots. */
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  /** Σoutput / Σ(execution duration) × 1000 over Complete usage snapshots
   * with executionStartedAt/terminalAt and a positive duration. */
  readonly outputTokensPerSecond?: number;
  /** Σ reasoning over participating snapshots that reported it; present
   *  only when at least one did. A subset of output; never added to any
   *  total. */
  readonly reasoningTokens?: number;
  /** Σ (input+cacheRead+cacheWrite+output) over participating snapshots;
   *  present when participating > 0. */
  readonly normalizedTokenTotal?: number;
  /** Σ cacheRead over participating snapshots (aggregate numerator). */
  readonly cacheHitNumerator: number;
  /** Σ (input+cacheRead) over participating snapshots. Cache writes are
   *  excluded from the product read-hit denominator. */
  readonly cacheHitDenominator: number;
  /** numerator / denominator; present only when participating > 0 and the
   *  denominator > 0 — never 0 when undefined (Ticket 20 rule). */
  readonly cacheHitRate?: number;
}

export interface AnalyticsGroupRow {
  readonly dimension: AnalyticsGroupBy;
  /** The snapshot value, or null for requests lacking the fact (e.g.
   *  rejected-auth has no provider). */
  readonly value: string | null;
  readonly summary: AnalyticsSummary;
}

export interface AnalyticsBucket {
  /** from + i × bucketMs; the final bucket is truncated at `to`. */
  readonly start: number;
  readonly end: number;
  /** Zero-filled when the bucket has no requests. */
  readonly summary: AnalyticsSummary;
}

export interface AnalyticsResult {
  readonly version: 2;
  readonly command: "summary";
  /** Full-scope aggregate, independent of rows/buckets. */
  readonly totals: AnalyticsSummary;
  /** groupBy rows, stable order: totalRequests DESC, null last, value ASC. */
  readonly rows?: readonly AnalyticsGroupRow[];
  /** Rows were capped at MAX_ANALYTICS_GROUPS. */
  readonly truncated?: boolean;
  /** Distinct group values beyond the cap (never invented labels). */
  readonly omittedGroupCount?: number;
  /** Their totalRequests sum. */
  readonly omittedGroupRequests?: number;
  /** Ascending time buckets; zero-filled. */
  readonly buckets?: readonly AnalyticsBucket[];
}

export interface AnalyticsProfileOption {
  readonly profileId: string;
  readonly displayName: string;
  readonly providerId: string;
}

export interface AnalyticsOptionsResult {
  readonly version: 2;
  readonly command: "options";
  /** Distinct ledger facts within the range, ascending; never the catalog. */
  readonly providers: readonly string[];
  readonly profiles: readonly AnalyticsProfileOption[];
  readonly models: readonly string[];
  readonly protocols: readonly string[];
  readonly sessions: readonly string[];
  readonly outcomes: readonly string[];
  /** True when any dimension was capped at MAX_ANALYTICS_OPTIONS_VALUES. */
  readonly truncated?: boolean;
}

export type AnalyticsQueryResult = AnalyticsResult | AnalyticsOptionsResult;
export type AnalyticsManagementResult =
  | AnalyticsQueryResult
  | DiagnosticsUnavailableResult;

/** One narrow host handle: the Control Plane serves analytics results from
 *  the ledger store's aggregation; it performs no business logic. */
export type AnalyticsQueryHandler = (
  query: AnalyticsQuery,
) => AnalyticsQueryResult | Promise<AnalyticsQueryResult>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

const GROUP_BY_VALUES: readonly AnalyticsGroupBy[] = Object.freeze([
  "provider",
  "model",
  "protocol",
  "outcome",
]);

const FILTER_KEYS: ReadonlySet<string> = new Set([
  "providers",
  "profiles",
  "models",
  "protocols",
  "sessions",
  "outcomes",
]);

const SUMMARY_KEYS: ReadonlySet<string> = new Set([
  "version",
  "command",
  "from",
  "to",
  "filters",
  "groupBy",
  "series",
]);

const OPTIONS_KEYS: ReadonlySet<string> = new Set([
  "version",
  "command",
  "from",
  "to",
]);

function decodeFilterArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length === 0 || value.length > MAX_ANALYTICS_FILTER_VALUES) {
    return undefined;
  }
  const output: string[] = [];
  for (const entry of value) {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > 1_024
    ) {
      return undefined;
    }
    output.push(entry);
  }
  return Object.freeze(output);
}

function decodeFilters(value: unknown): AnalyticsFilter | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of Object.keys(value)) {
    if (!FILTER_KEYS.has(key)) return undefined;
  }
  if (Object.keys(value).length === 0) return undefined;
  const providers =
    value.providers === undefined ? undefined : decodeFilterArray(value.providers);
  const profiles =
    value.profiles === undefined ? undefined : decodeFilterArray(value.profiles);
  const models =
    value.models === undefined ? undefined : decodeFilterArray(value.models);
  const protocols =
    value.protocols === undefined
      ? undefined
      : decodeFilterArray(value.protocols);
  const sessions =
    value.sessions === undefined ? undefined : decodeFilterArray(value.sessions);
  const outcomes =
    value.outcomes === undefined ? undefined : decodeFilterArray(value.outcomes);
  if (
    (value.providers !== undefined && providers === undefined) ||
    (value.profiles !== undefined && profiles === undefined) ||
    (value.models !== undefined && models === undefined) ||
    (value.protocols !== undefined && protocols === undefined) ||
    (value.sessions !== undefined && sessions === undefined) ||
    (value.outcomes !== undefined && outcomes === undefined)
  ) {
    return undefined;
  }
  return Object.freeze({
    ...(providers === undefined ? {} : { providers }),
    ...(profiles === undefined ? {} : { profiles }),
    ...(models === undefined ? {} : { models }),
    ...(protocols === undefined ? {} : { protocols }),
    ...(sessions === undefined ? {} : { sessions }),
    ...(outcomes === undefined ? {} : { outcomes }),
  });
}

/**
 * Strict normalization of an untrusted analytics query (the wire decoder
 * and the host both use this one validator). Unknown keys, wrong version,
 * invalid ranges, unbounded filter arrays, unknown group dimensions, and
 * series spans beyond the granularity bounds are all rejected (undefined),
 * never silently coarsened.
 */
export function normalizeAnalyticsQuery(
  value: unknown,
): AnalyticsQuery | undefined {
  if (
    !isRecord(value) ||
    value.version !== ANALYTICS_CONTRACT_VERSION ||
    typeof value.command !== "string"
  ) {
    return undefined;
  }
  if (value.command === "summary") {
    for (const key of Object.keys(value)) {
      if (!SUMMARY_KEYS.has(key)) return undefined;
    }
    const { from, to } = value;
    if (!isNonNegativeSafeInteger(from) || !isNonNegativeSafeInteger(to)) {
      return undefined;
    }
    if ((from as number) >= (to as number)) return undefined;
    let filters: AnalyticsFilter | undefined;
    if (value.filters !== undefined) {
      filters = decodeFilters(value.filters);
      if (filters === undefined) return undefined;
    }
    const groupBy = value.groupBy;
    if (
      groupBy !== undefined &&
      (typeof groupBy !== "string" ||
        !GROUP_BY_VALUES.includes(groupBy as AnalyticsGroupBy))
    ) {
      return undefined;
    }
    let series: { readonly granularity: AnalyticsSeriesGranularity } | undefined;
    if (value.series !== undefined) {
      if (!isRecord(value.series)) return undefined;
      for (const key of Object.keys(value.series)) {
        if (key !== "granularity") return undefined;
      }
      const granularity = value.series.granularity;
      if (granularity !== "hour" && granularity !== "day") return undefined;
      const span = (to as number) - (from as number);
      if (
        granularity === "hour"
          ? span > MAX_ANALYTICS_HOUR_SERIES_SPAN_MS
          : span > MAX_ANALYTICS_DAY_SERIES_SPAN_MS
      ) {
        return undefined;
      }
      series = { granularity };
    }
    return Object.freeze({
      version: ANALYTICS_CONTRACT_VERSION,
      command: "summary" as const,
      from: from as number,
      to: to as number,
      ...(filters === undefined ? {} : { filters }),
      ...(groupBy === undefined ? {} : { groupBy: groupBy as AnalyticsGroupBy }),
      ...(series === undefined ? {} : { series }),
    });
  }
  if (value.command === "options") {
    for (const key of Object.keys(value)) {
      if (!OPTIONS_KEYS.has(key)) return undefined;
    }
    const from = value.from;
    const to = value.to;
    if (
      (from !== undefined && !isNonNegativeSafeInteger(from)) ||
      (to !== undefined && !isNonNegativeSafeInteger(to)) ||
      (from !== undefined &&
        to !== undefined &&
        (from as number) > (to as number))
    ) {
      return undefined;
    }
    return Object.freeze({
      version: ANALYTICS_CONTRACT_VERSION,
      command: "options" as const,
      ...(from === undefined ? {} : { from: from as number }),
      ...(to === undefined ? {} : { to: to as number }),
    });
  }
  return undefined;
}
