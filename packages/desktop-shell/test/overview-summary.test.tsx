// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AnalyticsQuery,
  AnalyticsQueryResult,
  RequestLedgerQuery,
  StatusSnapshot,
} from "@luckytoken/application-control-plane/control-plane";

import { App } from "../src/renderer/app/App.js";
import { createFakeDesktopApi } from "./support/fake-desktop-api.js";

let container: HTMLDivElement;
let root: Root;

const status: StatusSnapshot = {
  sequence: 1,
  modelDataPlane: "running",
  provider: "configured",
  dataPlane: {
    configuredOrigin: "http://127.0.0.1:4317",
    configuredPort: 4317,
  },
};

function analyticsResult(query: AnalyticsQuery): AnalyticsQueryResult {
  if (query.command === "options") {
    return {
      version: 2,
      command: "options",
      providers: ["anthropic", "codex-local"],
      profiles: [
        {
          profileId: "profile-anthropic",
          displayName: "Production",
          providerId: "anthropic",
        },
        {
          profileId: "codex-local:account-digest",
          displayName: "Codex …a83f2c",
          providerId: "codex-local",
        },
      ],
      models: ["claude-sonnet-4-5"],
      protocols: ["anthropic-messages"],
      sessions: ["20000000-0000-4000-8000-000000000041"],
      outcomes: ["success"],
    };
  }
  return {
    version: 2,
    command: "summary",
    totals: {
      total: 12,
      success: 9,
      failed: 2,
      aborted: 1,
      other: 0,
      pending: 0,
      successRate: 0.75,
      failureRate: 2 / 12,
      abortRate: 1 / 12,
      participating: 12,
      totalRequests: 12,
      excluded: 0,
      inputTokens: 1_200,
      cacheReadTokens: 340,
      cacheWriteTokens: 60,
      outputTokens: 560,
      outputTokensPerSecond: 28.5,
      normalizedTokenTotal: 2_160,
      cacheHitNumerator: 340,
      cacheHitDenominator: 1_540,
      cacheHitRate: 340 / 1_540,
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 7, 18, 13, 30, 0, 0));
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("Overview analytics", () => {
  it("renders six summary cards, defaults to the local today range, and re-queries when filters change", async () => {
    const analyticsQueries: AnalyticsQuery[] = [];
    const ledgerQueries: Array<RequestLedgerQuery | undefined> = [];
    const getAnalytics = vi.fn(async (query: AnalyticsQuery) => {
      analyticsQueries.push(query);
      return analyticsResult(query);
    });
    const api = createFakeDesktopApi({
      control: {
        getBackendState: async () => ({ revision: 1, kind: "ready", status }),
        onBackendState: () => () => undefined,
        getAnalytics,
        getRequestLedger: async (query) => {
          ledgerQueries.push(query);
          return { records: [], hasMore: false };
        },
        onRequestLedger: () => () => undefined,
      },
    });

    await act(async () => root.render(<App api={api} />));
    await flush();

    const cards = [...container.querySelectorAll(".overview-stat-card")].map((card) =>
      card.textContent?.replace(/\s+/gu, " ").trim(),
    );
    expect(cards).toEqual([
      "Requests12",
      "Input1.2K",
      "Cache read340",
      "Output560",
      "Token speed28.5 t/s",
      "Cache hit22.1%",
    ]);

    await act(async () => {
      const filters = container.querySelector('button[aria-label="Show overview filters"]');
      if (!(filters instanceof HTMLButtonElement)) throw new Error("overview filter control missing");
      filters.click();
    });

    const from = container.querySelector('input[aria-label="From time"]');
    const to = container.querySelector('input[aria-label="To time"]');
    expect(from).toBeInstanceOf(HTMLInputElement);
    expect(to).toBeInstanceOf(HTMLInputElement);
    expect((from as HTMLInputElement).value).toBe("2026-08-18T00:00");
    expect((to as HTMLInputElement).value).toBe("2026-08-19T00:00");

    expect(container.querySelector('select[aria-label="Project filter"]')).toBeNull();
    expect(container.querySelector('select[aria-label="Protocol filter"]')?.textContent).toContain(
      "anthropic-messages",
    );
    expect(container.querySelector('select[aria-label="Session filter"]')?.textContent).toContain(
      "20000000-0000-4000-8000-000000000041",
    );
    expect(container.querySelector('select[aria-label="Model filter"]')?.textContent).toContain(
      "claude-sonnet-4-5",
    );
    expect(container.querySelector('select[aria-label="Provider filter"]')?.textContent).toContain(
      "Codex Local",
    );
    expect(container.querySelector('select[aria-label="Profile filter"]')?.textContent).toContain(
      "Production",
    );

    await act(async () => {
      const provider = container.querySelector('select[aria-label="Provider filter"]');
      if (!(provider instanceof HTMLSelectElement)) throw new Error("Provider filter missing");
      provider.value = "anthropic";
      provider.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();

    await act(async () => {
      const profile = container.querySelector('select[aria-label="Profile filter"]');
      if (!(profile instanceof HTMLSelectElement)) throw new Error("Profile filter missing");
      profile.value = "profile-anthropic";
      profile.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();

    const summaries = analyticsQueries.filter(
      (query): query is Extract<AnalyticsQuery, { command: "summary" }> => query.command === "summary",
    );
    expect(summaries.length).toBeGreaterThanOrEqual(2);
    expect(summaries.at(-1)?.filters).toEqual({
      providers: ["anthropic"],
      profiles: ["profile-anthropic"],
    });
    expect(ledgerQueries.at(-1)).toMatchObject({
      providerId: "anthropic",
      profileId: "profile-anthropic",
    });

    await act(async () => {
      const provider = container.querySelector('select[aria-label="Provider filter"]');
      if (!(provider instanceof HTMLSelectElement)) throw new Error("Provider filter missing");
      provider.value = "codex-local";
      provider.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect((container.querySelector('select[aria-label="Profile filter"]') as HTMLSelectElement).value).toBe("");
    expect(analyticsQueries.filter((query) => query.command === "summary").at(-1)).toMatchObject({
      filters: { providers: ["codex-local"] },
    });
    expect(ledgerQueries.at(-1)).toMatchObject({ providerId: "codex-local" });
    expect(ledgerQueries.at(-1)).not.toHaveProperty("profileId");
  });
});
