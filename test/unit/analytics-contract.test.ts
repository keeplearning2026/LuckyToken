import { describe, expect, it } from "vitest";

import {
  decodeAnalyticsResult,
  decodeAnalyticsSummary,
  normalizeAnalyticsQuery,
} from "@luckytoken/application-control-plane/control-plane";

const HOUR = 3_600_000;
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
    usageRequests: 3,
    missingUsageRequests: 4,
    speedRequests: 2,
    inputTokens: 13,
    cacheReadTokens: 7,
    outputTokens: 8,
    outputTokensPerSecond: 2.5,
    cacheHitRate: 7 / 20,
  };
}

describe("Analytics v3 query contract", () => {
  it("accepts the bounded v3 summary and options queries", () => {
    expect(normalizeAnalyticsQuery({
      version: 3,
      command: "summary",
      from: FROM,
      to: FROM + HOUR,
      filters: { providers: ["anthropic"], profiles: ["profile-a"] },
      groupBy: "provider",
      series: { granularity: "hour" },
    })).toEqual({
      version: 3,
      command: "summary",
      from: FROM,
      to: FROM + HOUR,
      filters: { providers: ["anthropic"], profiles: ["profile-a"] },
      groupBy: "provider",
      series: { granularity: "hour" },
    });
    expect(normalizeAnalyticsQuery({ version: 3, command: "options" })).toEqual({
      version: 3,
      command: "options",
    });
  });

  it("rejects v2, invalid ranges, unknown fields, and unbounded filters", () => {
    expect(normalizeAnalyticsQuery({ version: 2, command: "summary", from: 0, to: 1 })).toBeUndefined();
    expect(normalizeAnalyticsQuery({ version: 3, command: "summary", from: 1, to: 1 })).toBeUndefined();
    expect(normalizeAnalyticsQuery({ version: 3, command: "summary", from: 0, to: 1, cost: 1 })).toBeUndefined();
    expect(normalizeAnalyticsQuery({
      version: 3,
      command: "summary",
      from: 0,
      to: 1,
      filters: { models: Array.from({ length: 33 }, (_, index) => `m${index}`) },
    })).toBeUndefined();
  });
});

describe("Analytics v3 wire contract", () => {
  it("decodes the three-metric summary, rows, buckets, and options", () => {
    const result = decodeAnalyticsResult({
      version: 3,
      command: "summary",
      totals: summaryTotals(),
      rows: [{ dimension: "provider", value: "anthropic", summary: summaryTotals() }],
      buckets: [{ start: FROM, end: FROM + HOUR, summary: summaryTotals() }],
    });
    expect(result).toBeDefined();
    expect(result?.command).toBe("summary");

    expect(decodeAnalyticsResult({
      version: 3,
      command: "options",
      providers: ["anthropic"],
      profiles: [{ profileId: "profile-a", displayName: "A", providerId: "anthropic" }],
      models: ["claude"],
      protocols: ["anthropic-messages"],
      sessions: [],
      outcomes: ["success"],
    })).toBeDefined();
  });

  it("accepts all-zero usage but leaves undefined derived metrics absent", () => {
    expect(decodeAnalyticsSummary({
      total: 1,
      success: 1,
      failed: 0,
      aborted: 0,
      other: 0,
      pending: 0,
      successRate: 1,
      failureRate: 0,
      abortRate: 0,
      usageRequests: 1,
      missingUsageRequests: 0,
      speedRequests: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
    })).toBeDefined();
  });

  it("enforces coverage, speed, and aggregate cache-hit identities", () => {
    expect(decodeAnalyticsSummary({ ...summaryTotals(), missingUsageRequests: 3 })).toBeUndefined();
    expect(decodeAnalyticsSummary({ ...summaryTotals(), speedRequests: 4 })).toBeUndefined();
    expect(decodeAnalyticsSummary({ ...summaryTotals(), speedRequests: 0 })).toBeUndefined();
    expect(decodeAnalyticsSummary({ ...summaryTotals(), cacheHitRate: 0.1 })).toBeUndefined();
  });

  it("rejects removed and monetary fields", () => {
    for (const key of [
      "cost",
      "cacheWriteTokens",
      "reasoningTokens",
      "normalizedTokenTotal",
      "participating",
      "excluded",
    ]) {
      expect(decodeAnalyticsSummary({ ...summaryTotals(), [key]: 1 })).toBeUndefined();
    }
    expect(decodeAnalyticsResult({ version: 2, command: "summary", totals: summaryTotals() })).toBeUndefined();
  });
});
