// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AnalyticsQuery,
  AnalyticsSummary,
  StatusSnapshot,
} from "@luckytoken/application-control-plane/control-plane";

import { App } from "../src/renderer/app/App.js";
import { createFakeDesktopApi } from "./support/fake-desktop-api.js";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const status: StatusSnapshot = {
  sequence: 1,
  modelDataPlane: "running",
  provider: "configured",
  dataPlane: { configuredOrigin: "http://127.0.0.1:4317", configuredPort: 4317 },
};

function totals(
  total: number,
  overrides: Partial<AnalyticsSummary> = {},
): AnalyticsSummary {
  const usageRequests = overrides.usageRequests ?? total;
  const speedRequests = overrides.speedRequests ?? 0;
  const inputTokens = overrides.inputTokens ?? 0;
  const cacheReadTokens = overrides.cacheReadTokens ?? 0;
  const outputTokens = overrides.outputTokens ?? 0;
  const denominator = inputTokens + cacheReadTokens;
  return {
    total,
    success: total,
    failed: 0,
    aborted: 0,
    other: 0,
    pending: 0,
    successRate: total === 0 ? 0 : 1,
    failureRate: 0,
    abortRate: 0,
    usageRequests,
    missingUsageRequests: total - usageRequests,
    speedRequests,
    inputTokens,
    cacheReadTokens,
    outputTokens,
    ...(overrides.outputTokensPerSecond === undefined
      ? {}
      : { outputTokensPerSecond: overrides.outputTokensPerSecond }),
    ...(denominator === 0 ? {} : { cacheHitRate: cacheReadTokens / denominator }),
  };
}

const emptyOptions = {
  version: 3 as const,
  command: "options" as const,
  providers: [],
  profiles: [],
  models: [],
  protocols: [],
  sessions: [],
  outcomes: [],
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 7, 18, 13, 30));
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("Overview analytics", () => {
  it("shows compact units, t/s, and all analytics filters", async () => {
    const analyticsQueries: AnalyticsQuery[] = [];
    const api = createFakeDesktopApi({ control: {
      getBackendState: async () => ({ revision: 1, kind: "ready", status }),
      onBackendState: () => () => undefined,
      queryRequestJourneys: async () => ({ outcome: "ok", result: { records: [], hasMore: false } }),
      getAnalytics: async (query) => {
        analyticsQueries.push(query);
        return query.command === "options"
          ? {
              ...emptyOptions,
              providers: ["commandcode-goat"],
              profiles: [{ profileId: "profile-1", displayName: "Production", providerId: "commandcode-goat" }],
              models: ["deepseek/deepseek-v4-pro"],
              protocols: ["openai-responses"],
              sessions: ["session-1"],
              outcomes: ["success"],
            }
          : {
              version: 3,
              command: "summary",
              totals: totals(304, {
                usageRequests: 304,
                speedRequests: 304,
                inputTokens: 742_335,
                cacheReadTokens: 19_196_288,
                outputTokens: 70_850,
                outputTokensPerSecond: 37.14,
              }),
            };
      },
    } });

    await act(async () => root.render(<App api={api} />));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(container.querySelector(".overview-stat-input strong")?.textContent).toBe("742.3K");
    expect(container.querySelector(".overview-stat-input strong")?.getAttribute("title")).toBe("742,335");
    expect(container.querySelector(".overview-stat-cache-read strong")?.textContent).toBe("19.2M");
    expect(container.querySelector(".overview-stat-output strong")?.textContent).toBe("70.9K");
    expect(container.querySelector(".overview-stat-token-speed strong")?.textContent).toBe("37.1 t/s");

    await act(async () => {
      (container.querySelector('button[aria-label="Show overview filters"]') as HTMLButtonElement).click();
    });
    for (const [label, value] of [
      ["Provider filter", "commandcode-goat"],
      ["Profile filter", "profile-1"],
      ["Model filter", "deepseek/deepseek-v4-pro"],
      ["Protocol filter", "openai-responses"],
      ["Session filter", "session-1"],
      ["Outcome filter", "success"],
    ] as const) {
      const select = container.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
      await act(async () => {
        select.value = value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        await Promise.resolve();
      });
    }
    expect(analyticsQueries.findLast((query) => query.command === "summary")).toMatchObject({
      filters: {
        providers: ["commandcode-goat"],
        profiles: ["profile-1"],
        models: ["deepseek/deepseek-v4-pro"],
        protocols: ["openai-responses"],
        sessions: ["session-1"],
        outcomes: ["success"],
      },
    });
  });

  it("shows per-card coverage only when usage or speed coverage is incomplete", async () => {
    const api = createFakeDesktopApi({ control: {
      getBackendState: async () => ({ revision: 1, kind: "ready", status }),
      onBackendState: () => () => undefined,
      queryRequestJourneys: async () => ({ outcome: "ok", result: { records: [], hasMore: false } }),
      getAnalytics: async (query) => query.command === "options"
        ? emptyOptions
        : { version: 3, command: "summary", totals: totals(3, { usageRequests: 2, speedRequests: 1, inputTokens: 11, cacheReadTokens: 3, outputTokens: 7, outputTokensPerSecond: 7 }) },
    } });
    await act(async () => root.render(<App api={api} />));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(container.querySelector(".overview-stat-input small")?.textContent).toBe("2/3 requests");
    expect(container.querySelector(".overview-stat-token-speed small")?.textContent).toBe("1/3 requests");
    expect(container.querySelector(".overview-stat-requests small")).toBeNull();
  });

  it("refreshes Request Journeys, options, and totals from one action", async () => {
    const queryRequestJourneys = vi.fn(async () => ({ outcome: "ok" as const, result: { records: [], hasMore: false } }));
    const getAnalytics = vi.fn(async (query: AnalyticsQuery) => query.command === "options"
      ? emptyOptions
      : { version: 3 as const, command: "summary" as const, totals: totals(0) });
    const api = createFakeDesktopApi({ control: {
      getBackendState: async () => ({ revision: 1, kind: "ready", status }),
      onBackendState: () => () => undefined,
      queryRequestJourneys,
      getAnalytics,
    } });
    await act(async () => root.render(<App api={api} />));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => {
      (container.querySelector('button[aria-label="Refresh overview"]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(queryRequestJourneys).toHaveBeenCalledTimes(2);
    expect(getAnalytics).toHaveBeenCalledTimes(4);
  });

  it("reconciles totals when a live request terminates", async () => {
    const listeners = new Set<(record: import("@luckytoken/application-control-plane/control-plane").RequestJourneySummary) => void>();
    let count = 0;
    const getAnalytics = vi.fn(async (query: AnalyticsQuery) => query.command === "options"
      ? emptyOptions
      : { version: 3 as const, command: "summary" as const, totals: totals(count) });
    const api = createFakeDesktopApi({ control: {
      getBackendState: async () => ({ revision: 1, kind: "ready", status }),
      onBackendState: () => () => undefined,
      queryRequestJourneys: async () => ({ outcome: "ok", result: { records: [], hasMore: false } }),
      onRequestJourneys: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      getAnalytics,
    } });
    await act(async () => root.render(<App api={api} />));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    count = 1;
    await act(async () => {
      for (const listener of listeners) listener({
        id: 1,
        runtimeId: "runtime-1",
        requestId: "request-1",
        operation: "model_generation",
        outcome: "success",
        completeness: "complete",
        createdAt: Date.now(),
        closedAt: Date.now() + 100,
        usage: { terminalClass: "done", inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector(".overview-stat-requests strong")?.textContent).toBe("1");
    expect(getAnalytics.mock.calls.filter(([query]) => query.command === "summary")).toHaveLength(2);
  });
});
