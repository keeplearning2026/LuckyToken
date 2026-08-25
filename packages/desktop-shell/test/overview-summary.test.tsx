// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsQuery, StatusSnapshot } from "@luckytoken/application-control-plane/control-plane";

import { App } from "../src/renderer/app/App.js";
import { createFakeDesktopApi } from "./support/fake-desktop-api.js";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const status: StatusSnapshot = { sequence: 1, modelDataPlane: "running", provider: "configured", dataPlane: { configuredOrigin: "http://127.0.0.1:4317", configuredPort: 4317 } };

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 7, 18, 13, 30)); (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });

describe("Overview analytics", () => {
  it("shows compact token units, fixed t/s, semantic colors, and all six analytics filters", async () => {
    const analyticsQueries: AnalyticsQuery[] = [];
    const api = createFakeDesktopApi({ control: {
      getBackendState: async () => ({ revision: 1, kind: "ready", status }),
      onBackendState: () => () => undefined,
      queryRequestJourneys: async () => ({ outcome: "ok", result: { records: [], hasMore: false } }),
      getAnalytics: async (query) => {
        analyticsQueries.push(query);
        return query.command === "options"
          ? {
              version: 2,
              command: "options",
              providers: ["commandcode-goat"],
              profiles: [{ profileId: "profile-1", displayName: "Production", providerId: "commandcode-goat" }],
              models: ["deepseek/deepseek-v4-pro"],
              protocols: ["openai-responses"],
              sessions: ["session-1"],
              outcomes: ["success"],
            }
          : {
              version: 2,
              command: "summary",
              totals: {
                total: 304,
                success: 304,
                failed: 0,
                aborted: 0,
                other: 0,
                pending: 0,
                successRate: 1,
                failureRate: 0,
                abortRate: 0,
                participating: 304,
                totalRequests: 304,
                excluded: 0,
                inputTokens: 742_335,
                cacheReadTokens: 19_196_288,
                cacheWriteTokens: 0,
                outputTokens: 70_850,
                outputTokensPerSecond: 37.14,
                cacheHitNumerator: 19_196_288,
                cacheHitDenominator: 19_938_623,
                cacheHitRate: 0.963,
              },
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
    expect(container.querySelectorAll(".overview-stat-card")).toHaveLength(6);

    await act(async () => {
      (container.querySelector('button[aria-label="Show overview filters"]') as HTMLButtonElement).click();
    });
    const selections = [
      ["Provider filter", "commandcode-goat"],
      ["Profile filter", "profile-1"],
      ["Model filter", "deepseek/deepseek-v4-pro"],
      ["Protocol filter", "openai-responses"],
      ["Session filter", "session-1"],
      ["Outcome filter", "success"],
    ] as const;
    for (const [label, value] of selections) {
      const select = container.querySelector(`select[aria-label="${label}"]`);
      if (!(select instanceof HTMLSelectElement)) throw new Error(`${label} missing`);
      await act(async () => {
        select.value = value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        await Promise.resolve();
      });
    }
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const latestSummary = analyticsQueries.findLast((query) => query.command === "summary");
    expect(latestSummary).toMatchObject({
      command: "summary",
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

  it("explains requests excluded from usage totals", async () => {
    const api = createFakeDesktopApi({ control: {
      getBackendState: async () => ({ revision: 1, kind: "ready", status }),
      onBackendState: () => () => undefined,
      queryRequestJourneys: async () => ({ outcome: "ok", result: { records: [], hasMore: false } }),
      getAnalytics: async (query) => query.command === "options"
        ? { version: 2, command: "options", providers: [], profiles: [], models: [], protocols: [], sessions: [], outcomes: [] }
        : { version: 2, command: "summary", totals: { total: 3, success: 3, failed: 0, aborted: 0, other: 0, pending: 0, successRate: 1, failureRate: 0, abortRate: 0, participating: 1, totalRequests: 3, excluded: 2, inputTokens: 11, cacheReadTokens: 3, cacheWriteTokens: 0, outputTokens: 7, normalizedTokenTotal: 21, cacheHitNumerator: 3, cacheHitDenominator: 14, cacheHitRate: 3 / 14 } },
    } });

    await act(async () => root.render(<App api={api} />));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).toContain("2 requests do not have complete terminal usage and were excluded from usage totals.");
  });

  it("keeps analytics and Request Journey queries behind separate Control Plane commands", async () => {
    const analyticsQueries: AnalyticsQuery[] = [];
    const queryRequestJourneys = vi.fn(async () => ({ outcome: "ok" as const, result: { records: [], hasMore: false } }));
    const api = createFakeDesktopApi({ control: {
      getBackendState: async () => ({ revision: 1, kind: "ready", status }),
      onBackendState: () => () => undefined,
      queryRequestJourneys,
      getAnalytics: async (query) => { analyticsQueries.push(query); return query.command === "options" ? { version: 2, command: "options", providers: [], profiles: [], models: [], protocols: [], sessions: [], outcomes: [] } : { version: 2, command: "summary", totals: { total: 0, success: 0, failed: 0, aborted: 0, other: 0, pending: 0, successRate: 0, failureRate: 0, abortRate: 0, participating: 0, totalRequests: 0, excluded: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, normalizedTokenTotal: 0, cacheHitNumerator: 0, cacheHitDenominator: 0 } }; },
    } });
    await act(async () => root.render(<App api={api} />));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(queryRequestJourneys).toHaveBeenCalledWith({ limit: 1_000 });
    expect(analyticsQueries.some((query) => query.command === "summary")).toBe(true);
  });

  it("refreshes Request Journeys, analytics options, and totals from one Overview action", async () => {
    const queryRequestJourneys = vi.fn(async () => ({
      outcome: "ok" as const,
      result: { records: [], hasMore: false },
    }));
    const getAnalytics = vi.fn(async (query: AnalyticsQuery) =>
      query.command === "options"
        ? { version: 2 as const, command: "options" as const, providers: [], profiles: [], models: [], protocols: [], sessions: [], outcomes: [] }
        : { version: 2 as const, command: "summary" as const, totals: { total: 0, success: 0, failed: 0, aborted: 0, other: 0, pending: 0, successRate: 0, failureRate: 0, abortRate: 0, participating: 0, totalRequests: 0, excluded: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, normalizedTokenTotal: 0, cacheHitNumerator: 0, cacheHitDenominator: 0 } },
    );
    const api = createFakeDesktopApi({ control: {
      getBackendState: async () => ({ revision: 1, kind: "ready", status }),
      onBackendState: () => () => undefined,
      queryRequestJourneys,
      getAnalytics,
    } });

    await act(async () => root.render(<App api={api} />));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(queryRequestJourneys).toHaveBeenCalledTimes(1);
    expect(getAnalytics).toHaveBeenCalledTimes(2);

    const refresh = container.querySelector('button[aria-label="Refresh overview"]');
    expect(refresh).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      (refresh as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(queryRequestJourneys).toHaveBeenCalledTimes(2);
    expect(getAnalytics).toHaveBeenCalledTimes(4);
  });

  it("reconciles analytics after a live request reaches its terminal state", async () => {
    const listeners = new Set<(record: import("@luckytoken/application-control-plane/control-plane").RequestJourneySummary) => void>();
    let totalRequests = 0;
    const getAnalytics = vi.fn(async (query: AnalyticsQuery) =>
      query.command === "options"
        ? { version: 2 as const, command: "options" as const, providers: [], profiles: [], models: [], protocols: [], sessions: [], outcomes: [] }
        : { version: 2 as const, command: "summary" as const, totals: { total: totalRequests, success: totalRequests, failed: 0, aborted: 0, other: 0, pending: 0, successRate: totalRequests === 0 ? 0 : 1, failureRate: 0, abortRate: 0, participating: totalRequests, totalRequests, excluded: 0, inputTokens: totalRequests * 10, cacheReadTokens: totalRequests * 2, cacheWriteTokens: 0, outputTokens: totalRequests * 4, normalizedTokenTotal: totalRequests * 16, cacheHitNumerator: totalRequests * 2, cacheHitDenominator: totalRequests * 12 } },
    );
    const api = createFakeDesktopApi({ control: {
      getBackendState: async () => ({ revision: 1, kind: "ready", status }),
      onBackendState: () => () => undefined,
      queryRequestJourneys: async () => ({ outcome: "ok", result: { records: [], hasMore: false } }),
      onRequestJourneys: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getAnalytics,
    } });

    await act(async () => root.render(<App api={api} />));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector(".overview-stat-requests strong")?.textContent).toBe("0");

    totalRequests = 1;
    await act(async () => {
      for (const listener of listeners) listener({
        id: 1,
        runtimeId: "runtime-1",
        requestId: "live-terminal-request",
        operation: "model_generation",
        protocol: "openai-responses",
        lane: "semantic_conversion",
        outcome: "success",
        completeness: "complete",
        createdAt: Date.now(),
        closedAt: Date.now() + 100,
        requestedModel: "commandcode-goat/deepseek-v4-flash",
        providerId: "commandcode-goat",
        realModelId: "deepseek/deepseek-v4-flash",
        httpStatus: 200,
        usage: {
          completeness: "complete",
          inputTokens: 10,
          cacheReadTokens: 2,
          outputTokens: 4,
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector(".overview-stat-requests strong")?.textContent).toBe("1");
    expect(getAnalytics.mock.calls.filter(([query]) => query.command === "summary")).toHaveLength(2);
  });
});
