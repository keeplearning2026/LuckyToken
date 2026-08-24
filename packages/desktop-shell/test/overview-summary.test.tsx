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
});
