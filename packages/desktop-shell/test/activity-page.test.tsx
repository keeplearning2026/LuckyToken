// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/renderer/app/App.js";
import { createFakeDesktopApi } from "./support/fake-desktop-api.js";

let container: HTMLDivElement;
let root: Root;

const record = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  requestId: `req-${id}`,
  protocolId: "openai-responses",
  phase: "terminal-preparation" as const,
  outcome: "success" as const,
  acceptedAt: 1_000 * id,
  executionStartedAt: 1_000 * id + 10,
  terminalAt: 1_000 * id + 100,
  completedAt: 1_000 * id + 120,
  clientHttpStatus: 200,
  externalAlias: "deepseek",
  providerId: "example",
  realModelId: "model-a",
  terminalUsage: {
    api: "test",
    input: 100,
    cacheRead: 20,
    cacheWrite: 0,
    output: 40,
    normalizedTotal: 160,
    completeness: "complete" as const,
  },
  ...overrides,
});

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(api: ReturnType<typeof createFakeDesktopApi>): Promise<void> {
  await act(async () => root.render(<App api={api} />));
  await click("Activity");
}

async function click(name: string): Promise<void> {
  await act(async () => {
    const button = [...container.querySelectorAll("button")].find(
      (entry) => entry.textContent?.trim() === name,
    );
    if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button: ${name}`);
    button.click();
  });
}

describe("Activity product slice", () => {
  it("shows bounded request facts and live commits without duplicates", async () => {
    let live: ((event: any) => void) | undefined;
    const getRequestLedger = vi.fn(async () => ({
      records: [record(3), record(2, { outcome: "failed", clientHttpStatus: 502 })],
      hasMore: false,
    }));
    await render(
      createFakeDesktopApi({
        control: {
          getRequestLedger,
          onRequestLedger: (listener) => {
            live = listener;
            return () => undefined;
          },
        },
      }),
    );

    expect(container.textContent).toContain("model-a");
    expect(container.textContent).toContain("Example");
    expect(container.textContent).toContain("120 ms");
    expect(container.textContent).toContain("160 tokens");

    await act(async () => {
      live?.({ type: "request_ledger", record: record(4) });
      live?.({ type: "request_ledger", record: record(4) });
    });
    expect(container.querySelectorAll('[data-request-id="req-4"]')).toHaveLength(1);
  });

  it("applies Backend filters and loads older pages with the bounded cursor", async () => {
    const getRequestLedger = vi
      .fn()
      .mockResolvedValueOnce({ records: [record(5), record(4)], hasMore: true })
      .mockResolvedValueOnce({ records: [record(3)], hasMore: false })
      .mockResolvedValueOnce({ records: [record(2, { outcome: "failed" })], hasMore: false });
    await render(
      createFakeDesktopApi({
        control: {
          getRequestLedger,
          onRequestLedger: () => () => undefined,
        },
      }),
    );

    await click("Load older");
    expect(getRequestLedger).toHaveBeenNthCalledWith(2, {
      limit: 50,
      afterId: 4,
    });
    expect(container.textContent).toContain("req-3");

    const select = container.querySelector('select[aria-label="Outcome filter"]');
    if (!(select instanceof HTMLSelectElement)) throw new Error("Outcome filter missing");
    await act(async () => {
      select.value = "failed";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(getRequestLedger).toHaveBeenLastCalledWith({ limit: 50, outcome: "failed" });
    expect(container.textContent).toContain("req-2");
  });

  it("renders Backend-computed analytics without reaggregating request rows", async () => {
    const getAnalytics = vi.fn(async (query: any) => ({
      version: 1 as const,
      command: "summary" as const,
      totals: {
        total: 10,
        success: 8,
        failed: 1,
        aborted: 1,
        other: 0,
        pending: 0,
        successRate: 0.8,
        failureRate: 0.1,
        abortRate: 0.1,
        participating: 9,
        totalRequests: 10,
        excluded: 1,
        inputTokens: 1000,
        cacheReadTokens: 500,
        cacheWriteTokens: 0,
        outputTokens: 300,
        normalizedTokenTotal: 1800,
        cacheHitNumerator: 500,
        cacheHitDenominator: 1500,
        cacheHitRate: 1 / 3,
      },
    }));
    await render(
      createFakeDesktopApi({
        control: {
          getRequestLedger: async () => ({ records: [], hasMore: false }),
          onRequestLedger: () => () => undefined,
          getAnalytics,
        },
      }),
    );

    await click("Analytics");
    expect(getAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({ version: 1, command: "summary" }),
    );
    expect(container.textContent).toContain("10 requests");
    expect(container.textContent).toContain("80.0% success");
    expect(container.textContent).toContain("1,800 tokens");
    expect(container.textContent).toContain("33.3% cache hit");
  });

  it("resyncs the bounded head after a live connection gap", async () => {
    const stop = vi.fn();
    const getRequestLedger = vi
      .fn()
      .mockResolvedValueOnce({ records: [record(2)], hasMore: false })
      .mockResolvedValueOnce({ records: [record(3), record(2)], hasMore: false });
    await render(
      createFakeDesktopApi({
        control: {
          getRequestLedger,
          onRequestLedger: () => stop,
        },
      }),
    );

    await click("Refresh");
    expect(getRequestLedger).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("req-3");
  });
});
