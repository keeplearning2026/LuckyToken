import { describe, expect, it } from "vitest";

import {
  decodeAnalyticsResult,
  decodeAnalyticsSummary,
  normalizeAnalyticsQuery,
} from "@luckytoken/application-control-plane/control-plane";

/**
 * Ticket 21 contract unit tests: strict normalization of untrusted queries
 * (version, half-open ranges, bounded filter arrays, group dimensions,
 * series spans) and strict result decode with the aggregation identities
 * re-verified and no monetary key allowed anywhere.
 */

const HOUR = 3_600_000;
const DAY = 86_400_000;
const FROM = 1_700_000_000_000;

function summaryTotals(): Record<string, unknown> {
  return {
    total: 7,
    success: 3,
    failed: 1,
    aborted: 1,
    other: 2,
    pending: 0,
    successRate: 3 / 7,
    failureRate: 1 / 7,
    abortRate: 1 / 7,
    participating: 3,
    totalRequests: 7,
    excluded: 4,
    inputTokens: 13,
    cacheReadTokens: 7,
    cacheWriteTokens: 4,
    outputTokens: 8,
    reasoningTokens: 2,
    normalizedTokenTotal: 32,
    cacheHitNumerator: 7,
    cacheHitDenominator: 20,
    cacheHitRate: 7 / 20,
  };
}

describe("normalizeAnalyticsQuery (Ticket 21 contract)", () => {
  it("accepts a bounded summary query with filters, groupBy and series", () => {
    const query = normalizeAnalyticsQuery({
      version: 2,
      command: "summary",
      from: FROM,
      to: FROM + 24 * HOUR,
      filters: {
        providers: ["anthropic"],
        profiles: ["profile-anthropic"],
        protocols: ["anthropic-messages"],
        sessions: ["20000000-0000-4000-8000-000000000041"],
        outcomes: ["success", "failed"],
      },
      groupBy: "provider",
      series: { granularity: "hour" },
    });
    expect(query).toEqual({
      version: 2,
      command: "summary",
      from: FROM,
      to: FROM + 24 * HOUR,
      filters: {
        providers: ["anthropic"],
        profiles: ["profile-anthropic"],
        protocols: ["anthropic-messages"],
        sessions: ["20000000-0000-4000-8000-000000000041"],
        outcomes: ["success", "failed"],
      },
      groupBy: "provider",
      series: { granularity: "hour" },
    });
  });

  it("rejects wrong version, unknown keys, and unknown commands", () => {
    expect(normalizeAnalyticsQuery({ version: 1, command: "summary", from: 0, to: 1 })).toBeUndefined();
    expect(normalizeAnalyticsQuery({ version: 2, command: "rollup", from: 0, to: 1 })).toBeUndefined();
    expect(normalizeAnalyticsQuery({ version: 2, command: "summary", from: 0, to: 1, cost: 5 })).toBeUndefined();
    expect(normalizeAnalyticsQuery({ version: 2, command: "summary", from: 0, to: 1, series: { granularity: "day", span: 1 } })).toBeUndefined();
    expect(normalizeAnalyticsQuery("summary")).toBeUndefined();
    expect(normalizeAnalyticsQuery(undefined)).toBeUndefined();
  });

  it("enforces the half-open non-empty range with safe integers", () => {
    expect(normalizeAnalyticsQuery({ version: 2, command: "summary", from: 10, to: 10 })).toBeUndefined();
    expect(normalizeAnalyticsQuery({ version: 2, command: "summary", from: 11, to: 10 })).toBeUndefined();
    expect(normalizeAnalyticsQuery({ version: 2, command: "summary", from: -1, to: 10 })).toBeUndefined();
    expect(normalizeAnalyticsQuery({ version: 2, command: "summary", from: 1.5, to: 10 })).toBeUndefined();
    expect(normalizeAnalyticsQuery({ version: 2, command: "summary", from: 2 ** 53, to: 2 ** 53 + 1 })).toBeUndefined();
    expect(
      normalizeAnalyticsQuery({ version: 2, command: "summary", from: 0, to: 1 }),
    ).toEqual({ version: 2, command: "summary", from: 0, to: 1 });
  });

  it("bounds filter arrays per dimension and rejects unknown filter keys", () => {
    expect(
      normalizeAnalyticsQuery({
        version: 2,
        command: "summary",
        from: 0,
        to: 1,
        filters: { models: [] },
      }),
    ).toBeUndefined();
    const many = Array.from({ length: 33 }, (_, i) => `m${i}`);
    expect(
      normalizeAnalyticsQuery({
        version: 2,
        command: "summary",
        from: 0,
        to: 1,
        filters: { models: many },
      }),
    ).toBeUndefined();
    expect(
      normalizeAnalyticsQuery({
        version: 2,
        command: "summary",
        from: 0,
        to: 1,
        filters: { providers: [""] },
      }),
    ).toBeUndefined();
    expect(
      normalizeAnalyticsQuery({
        version: 2,
        command: "summary",
        from: 0,
        to: 1,
        filters: { projects: ["C:\\project"] },
      }),
    ).toBeUndefined();
    expect(
      normalizeAnalyticsQuery({
        version: 2,
        command: "summary",
        from: 0,
        to: 1,
        filters: { providers: ["anthropic"], provider: ["x"] },
      }),
    ).toBeUndefined();
    expect(
      normalizeAnalyticsQuery({
        version: 2,
        command: "summary",
        from: 0,
        to: 1,
        filters: { providers: ["anthropic"] },
      }),
    ).toEqual({
      version: 2,
      command: "summary",
      from: 0,
      to: 1,
      filters: { providers: ["anthropic"] },
    });
  });

  it("rejects unknown group dimensions and unknown series granularity", () => {
    expect(
      normalizeAnalyticsQuery({ version: 2, command: "summary", from: 0, to: 1, groupBy: "api" }),
    ).toBeUndefined();
    expect(
      normalizeAnalyticsQuery({ version: 2, command: "summary", from: 0, to: 1, groupBy: "project" }),
    ).toBeUndefined();
    expect(
      normalizeAnalyticsQuery({ version: 2, command: "summary", from: 0, to: 1, groupBy: "model" }),
    ).toEqual({ version: 2, command: "summary", from: 0, to: 1, groupBy: "model" });
    expect(
      normalizeAnalyticsQuery({ version: 2, command: "summary", from: 0, to: 1, series: { granularity: "week" } }),
    ).toBeUndefined();
  });

  it("bounds series granularity against the span", () => {
    expect(
      normalizeAnalyticsQuery({
        version: 2,
        command: "summary",
        from: 0,
        to: 32 * DAY,
        series: { granularity: "hour" },
      }),
    ).toBeUndefined();
    expect(
      normalizeAnalyticsQuery({
        version: 2,
        command: "summary",
        from: 0,
        to: 31 * DAY,
        series: { granularity: "hour" },
      }),
    ).toBeDefined();
    expect(
      normalizeAnalyticsQuery({
        version: 2,
        command: "summary",
        from: 0,
        to: 367 * DAY,
        series: { granularity: "day" },
      }),
    ).toBeUndefined();
    expect(
      normalizeAnalyticsQuery({
        version: 2,
        command: "summary",
        from: 0,
        to: 366 * DAY,
        series: { granularity: "day" },
      }),
    ).toBeDefined();
  });

  it("normalizes the options command with optional bounded range", () => {
    expect(normalizeAnalyticsQuery({ version: 2, command: "options" })).toEqual({
      version: 2,
      command: "options",
    });
    expect(
      normalizeAnalyticsQuery({ version: 2, command: "options", from: 5, to: 10 }),
    ).toEqual({ version: 2, command: "options", from: 5, to: 10 });
    expect(
      normalizeAnalyticsQuery({ version: 2, command: "options", from: 10, to: 5 }),
    ).toBeUndefined();
    expect(
      normalizeAnalyticsQuery({ version: 2, command: "options", from: -1 }),
    ).toBeUndefined();
    expect(
      normalizeAnalyticsQuery({ version: 2, command: "options", from: 5, cost: 1 }),
    ).toBeUndefined();
  });
});

describe("decodeAnalyticsResult (Ticket 21 wire)", () => {
  it("decodes a bounded summary result with rows and buckets", () => {
    const decoded = decodeAnalyticsResult({
      version: 2,
      command: "summary",
      totals: summaryTotals(),
      rows: [
        {
          dimension: "provider",
          value: "anthropic",
          summary: summaryTotals(),
        },
        { dimension: "provider", value: null, summary: summaryTotals() },
      ],
      truncated: true,
      omittedGroupCount: 3,
      omittedGroupRequests: 12,
      buckets: [
        { start: FROM, end: FROM + HOUR, summary: summaryTotals() },
        { start: FROM + HOUR, end: FROM + 2 * HOUR, summary: summaryTotals() },
      ],
    });
    expect(decoded).toBeDefined();
    expect(decoded?.command).toBe("summary");
    if (decoded === undefined || decoded.command !== "summary") return;
    expect(decoded.totals).toMatchObject({ total: 7, cacheHitRate: 7 / 20 });
    expect(decoded.rows?.length).toBe(2);
    expect(decoded.rows?.[1]?.value).toBeNull();
    expect(decoded.truncated).toBe(true);
    expect(decoded.omittedGroupCount).toBe(3);
    expect(decoded.omittedGroupRequests).toBe(12);
    expect(decoded.buckets?.length).toBe(2);
  });

  it("decodes an options result with bounded distinct values", () => {
    const decoded = decodeAnalyticsResult({
      version: 2,
      command: "options",
      providers: ["anthropic", "openai"],
      profiles: [{
        profileId: "profile-anthropic",
        displayName: "Production",
        providerId: "anthropic",
      }],
      models: ["claude-x"],
      protocols: ["anthropic-messages"],
      sessions: [],
      outcomes: ["success"],
    });
    expect(decoded).toEqual({
      version: 2,
      command: "options",
      providers: ["anthropic", "openai"],
      profiles: [{
        profileId: "profile-anthropic",
        displayName: "Production",
        providerId: "anthropic",
      }],
      models: ["claude-x"],
      protocols: ["anthropic-messages"],
      sessions: [],
      outcomes: ["success"],
    });
  });

  it("rejects unknown keys anywhere, including any monetary field", () => {
    for (const key of ["cost", "price", "billing", "amount", "subscription"]) {
      expect(
        decodeAnalyticsResult({
          version: 2,
          command: "summary",
          totals: summaryTotals(),
          [key]: 5,
        }),
      ).toBeUndefined();
      expect(
        decodeAnalyticsResult({
          version: 2,
          command: "summary",
          totals: { ...summaryTotals(), [key]: 5 },
        }),
      ).toBeUndefined();
      expect(
        decodeAnalyticsResult({
          version: 2,
          command: "options",
          providers: [],
          models: [],
          protocols: [],
          sessions: [],
          outcomes: [],
          [key]: 5,
        }),
      ).toBeUndefined();
    }
    // A summary row or bucket nested deeper is rejected too.
    expect(
      decodeAnalyticsResult({
        version: 2,
        command: "summary",
        totals: summaryTotals(),
        rows: [{ dimension: "provider", value: "x", summary: { ...summaryTotals(), cost: 1 } }],
      }),
    ).toBeUndefined();
    expect(
      decodeAnalyticsResult({
        version: 2,
        command: "summary",
        totals: summaryTotals(),
        buckets: [{ start: 0, end: 1, summary: { ...summaryTotals(), price: 1 } }],
      }),
    ).toBeUndefined();
  });

  it("rejects wrong version, unknown top-level keys, and invalid shapes", () => {
    expect(decodeAnalyticsResult({ version: 1, command: "summary", totals: summaryTotals() })).toBeUndefined();
    expect(decodeAnalyticsResult({ version: 2, command: "rollup", totals: summaryTotals() })).toBeUndefined();
    expect(decodeAnalyticsResult({ version: 2, command: "summary", totals: summaryTotals(), unknown: 1 })).toBeUndefined();
    expect(decodeAnalyticsResult({ version: 2, command: "summary" })).toBeUndefined();
    expect(decodeAnalyticsResult({ version: 2, command: "summary", totals: {} })).toBeUndefined();
    expect(decodeAnalyticsResult(null)).toBeUndefined();
  });

  it("re-verifies the count partition, participating split, and reasoning subset", () => {
    // Buckets no longer partition total.
    expect(
      decodeAnalyticsResult({
        version: 2,
        command: "summary",
        totals: { ...summaryTotals(), success: 4 },
      }),
    ).toBeUndefined();
    // totalRequests must equal total; excluded must equal total - participating.
    expect(
      decodeAnalyticsResult({
        version: 2,
        command: "summary",
        totals: { ...summaryTotals(), totalRequests: 8 },
      }),
    ).toBeUndefined();
    expect(
      decodeAnalyticsResult({
        version: 2,
        command: "summary",
        totals: { ...summaryTotals(), excluded: 5 },
      }),
    ).toBeUndefined();
    // Reasoning is a subset of output.
    expect(
      decodeAnalyticsResult({
        version: 2,
        command: "summary",
        totals: { ...summaryTotals(), reasoningTokens: 9 },
      }),
    ).toBeUndefined();
  });

  it("enforces the aggregate cache quotient and the zero-participant shape", () => {
    // cacheHitRate must be exactly numerator/denominator (never an average).
    expect(
      decodeAnalyticsResult({
        version: 2,
        command: "summary",
        totals: { ...summaryTotals(), cacheHitRate: 0.23 },
      }),
    ).toBeUndefined();
    expect(
      decodeAnalyticsResult({
        version: 2,
        command: "summary",
        totals: {
          ...summaryTotals(),
          cacheHitDenominator: 24,
          cacheHitRate: 7 / 24,
        },
      }),
    ).toBeUndefined();
    // Zero denominator forbids a rate; zero participating forbids sums
    // (a spread of the full totals would wrongly carry reasoningTokens /
    // normalizedTokenTotal, so the empty shape is built explicitly).
    const zero = { ...summaryTotals() } as Record<string, unknown>;
    delete zero.reasoningTokens;
    delete zero.normalizedTokenTotal;
    delete zero.cacheHitRate;
    expect(
      decodeAnalyticsResult({
        version: 2,
        command: "summary",
        totals: {
          ...zero,
          total: 0,
          success: 0,
          failed: 0,
          aborted: 0,
          other: 0,
          pending: 0,
          successRate: 0,
          failureRate: 0,
          abortRate: 0,
          participating: 0,
          totalRequests: 0,
          excluded: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          cacheHitNumerator: 0,
          cacheHitDenominator: 0,
        },
      }),
    ).toBeDefined();
    expect(
      decodeAnalyticsResult({
        version: 2,
        command: "summary",
        totals: {
          ...zero,
          total: 0,
          success: 0,
          failed: 0,
          aborted: 0,
          other: 0,
          pending: 0,
          successRate: 0,
          failureRate: 0,
          abortRate: 0,
          participating: 0,
          totalRequests: 0,
          excluded: 0,
          inputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          cacheHitNumerator: 0,
          cacheHitDenominator: 0,
        },
      }),
    ).toBeUndefined();
  });

  it("rejects malformed rows, buckets, options values, and bounds", () => {
    const base = { version: 2, command: "summary", totals: summaryTotals() };
    expect(
      decodeAnalyticsResult({ ...base, rows: [{ dimension: "provider" }] }),
    ).toBeUndefined();
    expect(
      decodeAnalyticsResult({ ...base, rows: [{ dimension: "api", value: "x", summary: summaryTotals() }] }),
    ).toBeUndefined();
    expect(
      decodeAnalyticsResult({ ...base, rows: [] }),
    ).toBeUndefined();
    expect(
      decodeAnalyticsResult({ ...base, buckets: [{ start: 5, end: 5, summary: summaryTotals() }] }),
    ).toBeUndefined();
    expect(
      decodeAnalyticsResult({ ...base, buckets: [] }),
    ).toBeUndefined();
    expect(
      decodeAnalyticsResult({
        version: 2,
        command: "options",
        providers: ["ok"],
        models: [],
        protocols: [],
        projects: [],
        sessions: [],
        outcomes: [],
        truncated: "yes",
      }),
    ).toBeUndefined();
    expect(
      decodeAnalyticsResult({
        version: 2,
        command: "options",
        providers: [""],
        models: [],
        protocols: [],
        projects: [],
        sessions: [],
        outcomes: [],
      }),
    ).toBeUndefined();
    expect(
      decodeAnalyticsResult({
        version: 2,
        command: "options",
        providers: Array.from({ length: 65 }, (_, i) => `p${i}`),
        models: [],
        protocols: [],
        projects: [],
        sessions: [],
        outcomes: [],
      }),
    ).toBeUndefined();
  });

  it("decodes a non-negative finite token speed without requiring a safe integer", () => {
    expect(
      decodeAnalyticsSummary({ ...summaryTotals(), outputTokensPerSecond: 28.5 }),
    ).toMatchObject({ outputTokensPerSecond: 28.5 });
    expect(
      decodeAnalyticsSummary({ ...summaryTotals(), outputTokensPerSecond: -0.1 }),
    ).toBeUndefined();
    expect(
      decodeAnalyticsSummary({ ...summaryTotals(), outputTokensPerSecond: Number.POSITIVE_INFINITY }),
    ).toBeUndefined();
    expect(
      decodeAnalyticsSummary({ ...summaryTotals(), outputTokensPerSecond: Number.NaN }),
    ).toBeUndefined();
  });

  it("decodeAnalyticsSummary rejects non-safe integers and out-of-range rates", () => {
    expect(decodeAnalyticsSummary({ ...summaryTotals(), total: 2 ** 53 })).toBeUndefined();
    expect(decodeAnalyticsSummary({ ...summaryTotals(), successRate: 1.2 })).toBeUndefined();
    expect(decodeAnalyticsSummary({ ...summaryTotals(), cacheHitNumerator: -1 })).toBeUndefined();
    expect(decodeAnalyticsSummary(summaryTotals())).toBeDefined();
  });
});
