/**
 * Wire codecs for the Request Analytics surface (Ticket 21). Strict
 * allowlist decoders: a frame carrying an unknown key (including any
 * monetary field — cost, price, billing, amount — which has no key in the
 * contract) or a value outside the bounded grammar is rejected, never
 * projected. Semantic identities of the aggregation (count partition,
 * participating/excluded split, reasoning subset, aggregate cache quotient)
 * are verified again at this boundary.
 */
import {
  ANALYTICS_CONTRACT_VERSION,
  MAX_ANALYTICS_OPTIONS_VALUES,
  type AnalyticsBucket,
  type AnalyticsGroupBy,
  type AnalyticsGroupRow,
  type AnalyticsOptionsResult,
  type AnalyticsProfileOption,
  type AnalyticsResult,
  type AnalyticsSummary,
  type AnalyticsManagementResult,
} from "./analytics-contract.js";
import { isRecord } from "./wire.js";
import { decodeDiagnosticsUnavailableResult } from "./wire-request-diagnostics.js";

const RESULT_KEYS: ReadonlySet<string> = new Set([
  "version",
  "command",
  "totals",
  "rows",
  "truncated",
  "omittedGroupCount",
  "omittedGroupRequests",
  "buckets",
  "providers",
  "profiles",
  "models",
  "protocols",
  "sessions",
  "outcomes",
]);

const SUMMARY_KEYS: ReadonlySet<string> = new Set([
  "total",
  "success",
  "failed",
  "aborted",
  "other",
  "pending",
  "successRate",
  "failureRate",
  "abortRate",
  "participating",
  "totalRequests",
  "excluded",
  "inputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "outputTokens",
  "outputTokensPerSecond",
  "reasoningTokens",
  "normalizedTokenTotal",
  "cacheHitNumerator",
  "cacheHitDenominator",
  "cacheHitRate",
]);

const GROUP_BY_VALUES: readonly AnalyticsGroupBy[] = Object.freeze([
  "provider",
  "model",
  "protocol",
  "outcome",
]);

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRate(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function boundedText(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    ? value
    : undefined;
}

/**
 * Strict summary decode with the aggregation identities re-verified:
 * the outcome buckets partition `total` exactly, participating/excluded
 * split `total`, reasoning is a subset of output, and a present cacheHitRate
 * is exactly the aggregate numerator/denominator quotient (never an average
 * of per-request rates).
 */
export function decodeAnalyticsSummary(
  value: unknown,
): AnalyticsSummary | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of Object.keys(value)) {
    if (!SUMMARY_KEYS.has(key)) return undefined;
  }
  const {
    total,
    success,
    failed,
    aborted,
    other,
    pending,
    successRate,
    failureRate,
    abortRate,
    participating,
    totalRequests,
    excluded,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    outputTokensPerSecond,
    reasoningTokens,
    normalizedTokenTotal,
    cacheHitNumerator,
    cacheHitDenominator,
    cacheHitRate,
  } = value;
  for (const entry of [
    total,
    success,
    failed,
    aborted,
    other,
    pending,
    participating,
    totalRequests,
    excluded,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    cacheHitNumerator,
    cacheHitDenominator,
  ]) {
    if (!isNonNegativeSafeInteger(entry)) return undefined;
  }
  if (
    !isRate(successRate) ||
    !isRate(failureRate) ||
    !isRate(abortRate) ||
    (reasoningTokens !== undefined &&
      !isNonNegativeSafeInteger(reasoningTokens)) ||
    (normalizedTokenTotal !== undefined &&
      !isNonNegativeSafeInteger(normalizedTokenTotal)) ||
    (outputTokensPerSecond !== undefined &&
      !isNonNegativeFiniteNumber(outputTokensPerSecond)) ||
    (cacheHitRate !== undefined && !isRate(cacheHitRate))
  ) {
    return undefined;
  }
  const totalN = total as number;
  const participatingN = participating as number;
  // Count partition identity: every matching request lands in exactly one
  // outcome bucket.
  if (
    totalN !==
    (success as number) +
      (failed as number) +
      (aborted as number) +
      (other as number) +
      (pending as number)
  ) {
    return undefined;
  }
  // Token-stat count vocabulary.
  if (
    totalRequests !== totalN ||
    excluded !== totalN - participatingN
  ) {
    return undefined;
  }
  // Reasoning is a subset of output; an absent value is never fabricated.
  if (
    reasoningTokens !== undefined &&
    (reasoningTokens as number) > (outputTokens as number)
  ) {
    return undefined;
  }
  if (participatingN === 0) {
    // Sums over an empty participating set are zero; totals that only exist
    // over Complete snapshots are absent.
    if (
      inputTokens !== 0 ||
      cacheReadTokens !== 0 ||
      cacheWriteTokens !== 0 ||
      outputTokens !== 0 ||
      outputTokensPerSecond !== undefined ||
      reasoningTokens !== undefined ||
      normalizedTokenTotal !== undefined
    ) {
      return undefined;
    }
  }
  // The aggregate quotient, never an average.
  const numerator = cacheHitNumerator as number;
  const denominator = cacheHitDenominator as number;
  const expectedDenominator =
    (inputTokens as number) + (cacheReadTokens as number);
  if (
    numerator !== cacheReadTokens ||
    !Number.isSafeInteger(expectedDenominator) ||
    denominator !== expectedDenominator
  ) {
    return undefined;
  }
  if (denominator === 0) {
    if (cacheHitRate !== undefined) return undefined;
  } else if (
    cacheHitRate === undefined ||
    cacheHitRate !== numerator / denominator
  ) {
    return undefined;
  }
  return Object.freeze({
    total: totalN,
    success: success as number,
    failed: failed as number,
    aborted: aborted as number,
    other: other as number,
    pending: pending as number,
    successRate: successRate as number,
    failureRate: failureRate as number,
    abortRate: abortRate as number,
    participating: participatingN,
    totalRequests,
    excluded: excluded as number,
    inputTokens: inputTokens as number,
    cacheReadTokens: cacheReadTokens as number,
    cacheWriteTokens: cacheWriteTokens as number,
    outputTokens: outputTokens as number,
    ...(outputTokensPerSecond === undefined
      ? {}
      : { outputTokensPerSecond }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(normalizedTokenTotal === undefined
      ? {}
      : { normalizedTokenTotal }),
    cacheHitNumerator: numerator,
    cacheHitDenominator: denominator,
    ...(cacheHitRate === undefined ? {} : { cacheHitRate }),
  });
}

function decodeGroupRow(value: unknown): AnalyticsGroupRow | undefined {
  if (!isRecord(value)) return undefined;
  if (
    Object.keys(value).length !== 3 ||
    typeof value.dimension !== "string" ||
    !GROUP_BY_VALUES.includes(value.dimension as AnalyticsGroupBy) ||
    (value.value !== null && boundedText(value.value, 1_024) === undefined)
  ) {
    return undefined;
  }
  const summary = decodeAnalyticsSummary(value.summary);
  if (summary === undefined) return undefined;
  return Object.freeze({
    dimension: value.dimension as AnalyticsGroupBy,
    value: value.value === null ? null : (value.value as string),
    summary,
  });
}

function decodeBucket(value: unknown): AnalyticsBucket | undefined {
  if (!isRecord(value)) return undefined;
  if (
    Object.keys(value).length !== 3 ||
    !isNonNegativeSafeInteger(value.start) ||
    !isNonNegativeSafeInteger(value.end) ||
    (value.end as number) <= (value.start as number)
  ) {
    return undefined;
  }
  const summary = decodeAnalyticsSummary(value.summary);
  if (summary === undefined) return undefined;
  return Object.freeze({
    start: value.start as number,
    end: value.end as number,
    summary,
  });
}

function decodeStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_ANALYTICS_OPTIONS_VALUES) {
    return undefined;
  }
  const output: string[] = [];
  for (const entry of value) {
    const text = boundedText(entry, 1_024);
    if (text === undefined) return undefined;
    output.push(text);
  }
  return Object.freeze(output);
}

function decodeProfileOptions(
  value: unknown,
): readonly AnalyticsProfileOption[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_ANALYTICS_OPTIONS_VALUES) {
    return undefined;
  }
  const output: AnalyticsProfileOption[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).length !== 3 ||
      boundedText(entry.profileId, 256) === undefined ||
      boundedText(entry.displayName, 256) === undefined ||
      boundedText(entry.providerId, 256) === undefined
    ) {
      return undefined;
    }
    output.push(Object.freeze({
      profileId: entry.profileId as string,
      displayName: entry.displayName as string,
      providerId: entry.providerId as string,
    }));
  }
  return Object.freeze(output);
}

/**
 * Strict decode of an `analytics_result` frame payload: the allowed key set
 * is exact (a monetary key can never appear), the version is fixed, nested
 * summaries are validated with their identities, and arrays are bounded.
 */
export function decodeAnalyticsResult(
  value: unknown,
): AnalyticsResult | AnalyticsOptionsResult | undefined {
  if (
    !isRecord(value) ||
    value.version !== ANALYTICS_CONTRACT_VERSION ||
    typeof value.command !== "string"
  ) {
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (!RESULT_KEYS.has(key)) return undefined;
  }
  if (value.command === "summary") {
    const totals = decodeAnalyticsSummary(value.totals);
    if (totals === undefined) return undefined;
    let rows: readonly AnalyticsGroupRow[] | undefined;
    if (value.rows !== undefined) {
      if (!Array.isArray(value.rows) || value.rows.length === 0) {
        return undefined;
      }
      const decoded = value.rows.map(decodeGroupRow);
      if (decoded.some((entry) => entry === undefined)) return undefined;
      rows = Object.freeze(
        decoded.filter(
          (entry): entry is AnalyticsGroupRow => entry !== undefined,
        ),
      );
    }
    let buckets: readonly AnalyticsBucket[] | undefined;
    if (value.buckets !== undefined) {
      if (!Array.isArray(value.buckets) || value.buckets.length === 0) {
        return undefined;
      }
      const decoded = value.buckets.map(decodeBucket);
      if (decoded.some((entry) => entry === undefined)) return undefined;
      buckets = Object.freeze(
        decoded.filter(
          (entry): entry is AnalyticsBucket => entry !== undefined,
        ),
      );
    }
    if (
      (value.truncated !== undefined && typeof value.truncated !== "boolean") ||
      (value.omittedGroupCount !== undefined &&
        !isNonNegativeSafeInteger(value.omittedGroupCount)) ||
      (value.omittedGroupRequests !== undefined &&
        !isNonNegativeSafeInteger(value.omittedGroupRequests))
    ) {
      return undefined;
    }
    return Object.freeze({
      version: ANALYTICS_CONTRACT_VERSION,
      command: "summary" as const,
      totals,
      ...(rows === undefined ? {} : { rows }),
      ...(value.truncated === undefined ? {} : { truncated: value.truncated }),
      ...(value.omittedGroupCount === undefined
        ? {}
        : { omittedGroupCount: value.omittedGroupCount as number }),
      ...(value.omittedGroupRequests === undefined
        ? {}
        : { omittedGroupRequests: value.omittedGroupRequests as number }),
      ...(buckets === undefined ? {} : { buckets }),
    });
  }
  if (value.command === "options") {
    const providers = decodeStringArray(value.providers);
    const profiles = decodeProfileOptions(value.profiles);
    const models = decodeStringArray(value.models);
    const protocols = decodeStringArray(value.protocols);
    const sessions = decodeStringArray(value.sessions);
    const outcomes = decodeStringArray(value.outcomes);
    if (
      providers === undefined ||
      profiles === undefined ||
      models === undefined ||
      protocols === undefined ||
      sessions === undefined ||
      outcomes === undefined ||
      (value.truncated !== undefined && typeof value.truncated !== "boolean")
    ) {
      return undefined;
    }
    return Object.freeze({
      version: ANALYTICS_CONTRACT_VERSION,
      command: "options" as const,
      providers,
      profiles,
      models,
      protocols,
      sessions,
      outcomes,
      ...(value.truncated === undefined ? {} : { truncated: value.truncated }),
    });
  }
  return undefined;
}

export function decodeAnalyticsManagementResult(
  value: unknown,
): AnalyticsManagementResult | undefined {
  return decodeDiagnosticsUnavailableResult(value) ?? decodeAnalyticsResult(value);
}
