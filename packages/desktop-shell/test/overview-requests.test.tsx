// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AnalyticsQuery,
  RequestLedgerEvent,
  RequestLedgerQuery,
  RequestLedgerRecord,
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

const CLIENT_SESSION = "20000000-0000-4000-8000-000000000041";

function record(
  id: number,
  overrides: Partial<RequestLedgerRecord> = {},
): RequestLedgerRecord {
  const executionStartedAt = new Date(2026, 7, 18, 9, 0, id, 0).getTime();
  return {
    id,
    requestId: `10000000-0000-4000-8000-000000000${String(id).padStart(3, "0")}`,
    protocolId: "anthropic-messages",
    phase: "terminal-preparation",
    outcome: "success",
    acceptedAt: executionStartedAt - 100,
    executionStartedAt,
    terminalAt: executionStartedAt + 2_000,
    completedAt: executionStartedAt + 2_100,
    clientHttpStatus: 200,
    externalAlias: `alias-${id}`,
    providerId: "anthropic",
    realModelId: "claude-sonnet-4-5",
    clientSessionId: CLIENT_SESSION,
    terminalUsage: {
      api: "anthropic",
      input: 20,
      cacheRead: 5,
      cacheWrite: 0,
      output: 100,
      normalizedTotal: 125,
      cacheHitRate: 0.2,
      completeness: "complete",
    },
    ...overrides,
  };
}

function recordWithoutSession(id: number): RequestLedgerRecord {
  const { clientSessionId, ...withoutSession } = record(id);
  void clientSessionId;
  return withoutSession;
}

function analytics(query: AnalyticsQuery) {
  if (query.command === "options") {
    return {
      version: 1 as const,
      command: "options" as const,
      providers: [],
      models: ["claude-sonnet-4-5"],
      protocols: ["anthropic-messages"],
      sessions: [CLIENT_SESSION],
      outcomes: ["success", "failed"],
    };
  }
  return {
    version: 1 as const,
    command: "summary" as const,
    totals: {
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

describe("Overview request table", () => {
  it("renders the 13 projected columns including cache Hit, masks sessions, paginates with afterId, and merges live records", async () => {
    const first = record(10, {
      outcome: "failed",
      clientHttpStatus: 503,
      externalAlias: "external-sonnet",
    });
    const second = recordWithoutSession(9);
    const third = record(8);
    const ledgerQueries: Array<RequestLedgerQuery | undefined> = [];
    const ledgerListeners = new Set<(event: RequestLedgerEvent) => void>();

    const getRequestLedger = vi.fn(async (query?: RequestLedgerQuery) => {
      ledgerQueries.push(query);
      if (query?.outcome === "running") return { records: [], hasMore: false };
      if (query?.afterId === 9) return { records: [third], hasMore: false };
      return { records: [first, second], hasMore: true };
    });

    const api = createFakeDesktopApi({
      control: {
        getStatus: async () => status,
        onStatus: () => () => undefined,
        getAnalytics: async (query) => analytics(query),
        getRequestLedger,
        onRequestLedger: (listener) => {
          ledgerListeners.add(listener);
          return () => ledgerListeners.delete(listener);
        },
      },
    });

    await act(async () => root.render(<App api={api} />));
    await flush();

    expect([...container.querySelectorAll(".overview-request-table thead th")].map((cell) => cell.textContent)).toEqual([
      "Start time",
      "Session",
      "Request ID",
      "Protocol",
      "Input",
      "Cache read",
      "Hit",
      "Output",
      "Token speed",
      "Time",
      "Model",
      "Status",
    ]);

    const row = container.querySelector(`tr[data-request-id="${first.requestId}"]`);
    expect(row?.textContent).toContain("20000000");
    expect(row?.textContent).not.toContain(CLIENT_SESSION);
    expect(row?.querySelector('[title="' + CLIENT_SESSION + '"]')).not.toBeNull();
    expect(row?.textContent).toContain(first.requestId.slice(0, 8));
    expect(row?.textContent).not.toContain(first.requestId);
    expect(row?.querySelector('[title="' + first.requestId + '"]')).not.toBeNull();
    expect(row?.textContent).toContain("anthropic-messages");
    expect(row?.textContent).toContain("20");
    expect(row?.textContent).toContain("5");
    expect(row?.textContent).toContain("20.0%");
    expect(row?.textContent).toContain("100");
    expect(row?.textContent).toContain("50.0 tokens/s");
    expect(row?.textContent).toContain("2.0 s");
    expect(row?.textContent).toContain("external-sonnet");
    expect(row?.textContent).toContain("Server error");
    expect(row?.querySelector("td.overview-col-request-id")?.textContent).toBe(first.requestId.slice(0, 8));
    expect(container.querySelector(`tr[data-request-id="${second.requestId}"]`)?.textContent).toContain("-");

    await act(async () => {
      const loadMore = [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Load more",
      );
      if (!(loadMore instanceof HTMLButtonElement)) throw new Error("Load more missing");
      loadMore.click();
    });
    await flush();
    expect(ledgerQueries.some((query) => query?.afterId === 9)).toBe(true);
    expect(container.querySelector(`tr[data-request-id="${third.requestId}"]`)).not.toBeNull();

    const live = record(11, { externalAlias: "live-model" });
    act(() => {
      for (const listener of ledgerListeners) {
        listener({ type: "request_ledger", record: live });
      }
    });
    expect(container.querySelector(`tr[data-request-id="${live.requestId}"]`)?.textContent).toContain(
      "live-model",
    );
  });

  it('shows "No requests" for an empty filtered result', async () => {
    const api = createFakeDesktopApi({
      control: {
        getStatus: async () => status,
        onStatus: () => () => undefined,
        getAnalytics: async (query) => analytics(query),
        getRequestLedger: async () => ({ records: [], hasMore: false }),
        onRequestLedger: () => () => undefined,
      },
    });

    await act(async () => root.render(<App api={api} />));
    await flush();
    expect(container.textContent).toContain("No requests");
  });
});
