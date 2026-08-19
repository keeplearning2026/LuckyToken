// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RequestLedgerEvent,
  RequestLedgerRecord,
  StatusSnapshot,
} from "@luckytoken/application-control-plane/control-plane";

import { App } from "../src/renderer/app/App.js";
import { createFakeDesktopApi } from "./support/fake-desktop-api.js";

let container: HTMLDivElement;
let root: Root;

const runningStatus: StatusSnapshot = {
  sequence: 1,
  modelDataPlane: "running",
  provider: "configured",
  dataPlane: {
    configuredOrigin: "http://127.0.0.1:4317",
    configuredPort: 4317,
  },
};

function ledgerRecord(id: number, outcome: RequestLedgerRecord["outcome"]): RequestLedgerRecord {
  return {
    id,
    requestId: `10000000-0000-4000-8000-000000000${String(id).padStart(3, "0")}`,
    protocolId: "anthropic-messages",
    phase: outcome === "running" ? "execution" : "terminal-preparation",
    outcome,
    acceptedAt: 1_700_000_000_000 + id,
  };
}

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

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("desktop command-router shell", () => {
  it("switches the three color pages and keeps endpoint, runtime state, active count, and start/stop control in the header", async () => {
    const ledgerListeners = new Set<(event: RequestLedgerEvent) => void>();
    const executeRuntime = vi.fn(async (command: "start" | "stop" | "restart") => ({
      command,
      outcome: "completed" as const,
      snapshot: {
        ...runningStatus,
        sequence: 2,
        modelDataPlane: command === "stop" ? "stopped" as const : "running" as const,
      },
    }));
    const api = createFakeDesktopApi({
      control: {
        getStatus: async () => runningStatus,
        onStatus: () => () => undefined,
        executeRuntime,
        getRequestLedger: async (query) => ({
          records: query?.outcome === "running"
            ? [ledgerRecord(1, "running"), ledgerRecord(2, "running")]
            : [],
          hasMore: false,
        }),
        onRequestLedger: (listener) => {
          ledgerListeners.add(listener);
          return () => ledgerListeners.delete(listener);
        },
        getAnalytics: async (query) => query.command === "options"
          ? {
              version: 1,
              command: "options",
              providers: [],
              models: [],
              protocols: [],
              projects: [],
              sessions: [],
              outcomes: [],
            }
          : {
              version: 1,
              command: "summary",
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
            },
      },
    });

    await act(async () => root.render(<App api={api} />));
    await flush();

    expect(container.querySelectorAll(".color-nav-button")).toHaveLength(3);
    expect(container.querySelector("h1")?.textContent).toBe("Overview");
    expect(container.textContent).toContain("http://127.0.0.1:4317");
    expect(container.textContent).toContain("Router running");
    expect(container.textContent).toContain("Active requests");
    expect(container.textContent).toContain("2");

    await act(async () => {
      const providers = container.querySelector('button[aria-label="Providers"]');
      if (!(providers instanceof HTMLButtonElement)) throw new Error("Providers color bar missing");
      providers.click();
    });
    expect(container.querySelector("h1")?.textContent).toBe("Providers");

    await act(async () => {
      const settings = container.querySelector('button[aria-label="Settings"]');
      if (!(settings instanceof HTMLButtonElement)) throw new Error("Settings color bar missing");
      settings.click();
    });
    expect(container.querySelector("h1")?.textContent).toBe("Settings");

    await act(async () => {
      const overview = container.querySelector('button[aria-label="Overview"]');
      if (!(overview instanceof HTMLButtonElement)) throw new Error("Overview color bar missing");
      overview.click();
    });
    expect(container.querySelector("h1")?.textContent).toBe("Overview");

    await act(async () => {
      const stop = [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Stop",
      );
      if (!(stop instanceof HTMLButtonElement)) throw new Error("Stop control missing");
      stop.click();
    });
    await flush();
    expect(executeRuntime).toHaveBeenCalledWith("stop");
    expect(container.textContent).toContain("Router stopped");

    act(() => {
      const record = ledgerRecord(3, "running");
      for (const listener of ledgerListeners) listener({ type: "request_ledger", record });
    });
    expect(container.textContent).toContain("Active requests");
    expect(container.querySelector(".active-request-count")?.textContent).toBe("3");

    act(() => {
      const record = ledgerRecord(3, "success");
      for (const listener of ledgerListeners) listener({ type: "request_ledger", record });
    });
    expect(container.querySelector(".active-request-count")?.textContent).toBe("2");
  });
});
