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
import type { DesktopBackendState } from "../src/shared/desktop-api.js";
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
    const backendStateListeners = new Set<(state: DesktopBackendState) => void>();
    let runningRecords = [ledgerRecord(1, "running"), ledgerRecord(2, "running")];
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
        getBackendState: async () => ({ revision: 1, kind: "ready", status: runningStatus }),
        onBackendState: (listener) => {
          backendStateListeners.add(listener);
          return () => backendStateListeners.delete(listener);
        },
        executeRuntime,
        getRequestLedger: async (query) => ({
          records: query?.outcome === "running"
            ? runningRecords
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
    expect(container.textContent).toContain("127.0.0.1:4317");
    expect(container.textContent).toContain("Running");
    expect(container.querySelector(".runtime-endpoint svg")).not.toBeNull();
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
      const stop = container.querySelector('button[aria-label="Stop LuckyToken"]');
      if (!(stop instanceof HTMLButtonElement)) throw new Error("Stop control missing");
      stop.click();
    });
    await flush();
    expect(executeRuntime).toHaveBeenCalledWith("stop");
    act(() => {
      for (const listener of backendStateListeners) {
        listener({
          revision: 2,
          kind: "ready",
          status: { ...runningStatus, sequence: 2, modelDataPlane: "stopped" },
        });
      }
    });
    await flush();
    expect(container.textContent).toContain("Stopped");

    act(() => {
      const record = ledgerRecord(3, "running");
      for (const listener of ledgerListeners) listener({ type: "request_ledger", record });
    });
    expect(container.querySelector(".active-request-count")?.textContent).toBe("3");

    act(() => {
      const record = ledgerRecord(3, "success");
      for (const listener of ledgerListeners) listener({ type: "request_ledger", record });
    });
    expect(container.querySelector(".active-request-count")?.textContent).toBe("2");

    act(() => {
      for (const listener of backendStateListeners) {
        listener({ revision: 3, kind: "unavailable" });
      }
    });
    expect(container.textContent).toContain("Unavailable");
    expect(container.querySelector<HTMLButtonElement>(".runtime-toggle")?.disabled).toBe(true);

    runningRecords = [];
    act(() => {
      for (const listener of backendStateListeners) {
        listener({
          revision: 4,
          kind: "ready",
          status: { ...runningStatus, sequence: 0, modelDataPlane: "stopped" },
        });
      }
    });
    await flush();
    expect(container.querySelector(".active-request-count")?.textContent).toBe("0");
  });

  it("keeps Backend observation active across ready status updates", async () => {
    const backendStateListeners = new Set<(state: DesktopBackendState) => void>();
    const getRequestLedger = vi.fn(async () => ({ records: [], hasMore: false }));
    const onRequestLedger = vi.fn(() => () => undefined);
    const getAnalytics = vi.fn(async (query) => query.command === "options"
      ? {
          version: 1 as const,
          command: "options" as const,
          providers: [],
          models: [],
          protocols: [],
          projects: [],
          sessions: [],
          outcomes: [],
        }
      : {
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
        });
    const api = createFakeDesktopApi({
      control: {
        getBackendState: async () => ({ revision: 1, kind: "ready", status: runningStatus }),
        onBackendState: (listener) => {
          backendStateListeners.add(listener);
          return () => backendStateListeners.delete(listener);
        },
        getRequestLedger,
        onRequestLedger,
        getAnalytics,
      },
    });

    await act(async () => root.render(<App api={api} />));
    await flush();
    const ledgerQueries = getRequestLedger.mock.calls.length;
    const ledgerSubscriptions = onRequestLedger.mock.calls.length;
    const analyticsQueries = getAnalytics.mock.calls.length;

    act(() => {
      for (const listener of backendStateListeners) {
        listener({
          revision: 2,
          kind: "ready",
          status: { ...runningStatus, sequence: 2, modelDataPlane: "stopped" },
        });
      }
    });
    await flush();

    expect(getRequestLedger).toHaveBeenCalledTimes(ledgerQueries);
    expect(onRequestLedger).toHaveBeenCalledTimes(ledgerSubscriptions);
    expect(getAnalytics).toHaveBeenCalledTimes(analyticsQueries);
    expect(container.textContent).toContain("Stopped");
  });

  it("edits only the port value and reports when Codex sync needs a restart", async () => {
    let publicState = {
      outcome: "ok" as const,
      state: {
        revision: 3,
        version: 8,
        endpoint: { host: "127.0.0.1", port: 4317 },
        providers: [],
      },
    };
    let codexState = {
      desiredEnabled: true,
      observedState: "managed" as const,
      codexHome: "C:\\Users\\test\\.codex",
      configPath: "C:\\Users\\test\\.codex\\config.toml",
      catalogPath: "C:\\Users\\test\\.codex\\luckytoken-model-catalog.json",
      endpoint: "http://127.0.0.1:4317/v1",
      warnings: [] as string[],
      restartRequired: false,
      desiredGeneration: 8,
      appliedGeneration: 7,
      needsSync: true,
    };
    const executePublicModels = vi.fn(async (command) => {
      if (command.command === "set_port") {
        publicState = {
          ...publicState,
          state: {
            ...publicState.state,
            revision: publicState.state.revision + 1,
            version: publicState.state.version + 1,
            endpoint: { ...publicState.state.endpoint, port: command.port },
          },
        };
        codexState = {
          ...codexState,
          desiredGeneration: publicState.state.version,
          needsSync: true,
        };
      }
      return publicState;
    });
    const executeCodexIntegration = vi.fn(async (command) => {
      if (command.command === "sync") {
        codexState = {
          ...codexState,
          appliedGeneration: codexState.desiredGeneration,
          needsSync: false,
          restartRequired: true,
          warnings: ["A malformed native Codex model entry was skipped."],
        };
      }
      return { state: codexState };
    });
    const api = createFakeDesktopApi({
      control: {
        getBackendState: async () => ({ revision: 1, kind: "ready", status: runningStatus }),
        onBackendState: () => () => undefined,
        executePublicModels,
        executeCodexIntegration,
        getRequestLedger: async () => ({ records: [], hasMore: false }),
        onRequestLedger: () => () => undefined,
        getAnalytics: async (query) =>
          query.command === "options"
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

    const endpoint = container.querySelector('button[aria-label="Edit LuckyToken port"]');
    expect(endpoint?.textContent).toBe("127.0.0.1:4317");
    await act(async () => (endpoint as HTMLButtonElement).click());
    const input = container.querySelector('input[aria-label="LuckyToken port"]');
    if (!(input instanceof HTMLInputElement)) throw new Error("port editor missing");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(input, "5000");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });
    expect(executePublicModels).toHaveBeenCalledWith({
      command: "set_port",
      revision: 3,
      port: 5000,
    });

    const toggle = container.querySelector('button[aria-label="Disable Codex integration"]');
    const sync = container.querySelector('button[aria-label="Sync Codex"]');
    expect(toggle).toBeInstanceOf(HTMLButtonElement);
    expect(sync).toBeInstanceOf(HTMLButtonElement);
    expect(toggle?.getAttribute("role")).toBe("switch");
    expect(container.querySelector(".codex-mark")).toBeInstanceOf(HTMLImageElement);
    expect(sync?.classList.contains("dirty")).toBe(true);
    expect(toggle?.textContent).toBe("");
    expect(sync?.querySelector("svg")).not.toBeNull();

    await act(async () => {
      (sync as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(executeCodexIntegration).toHaveBeenCalledWith({ command: "sync" });
    expect(container.querySelector('button[aria-label="Sync Codex"]')?.classList.contains("dirty")).toBe(false);
    expect(container.textContent).toContain(
      "Codex synced. Restart Codex to load the updated model catalog.",
    );
    expect(container.textContent).toContain(
      "A malformed native Codex model entry was skipped.",
    );
  });

  it("shows a visible failure when the Codex sync request rejects", async () => {
    const codexState = {
      desiredEnabled: true,
      observedState: "managed" as const,
      codexHome: "C:\\Users\\test\\.codex",
      configPath: "C:\\Users\\test\\.codex\\config.toml",
      catalogPath: "C:\\Users\\test\\.codex\\luckytoken-model-catalog.json",
      endpoint: "http://127.0.0.1:4317/v1",
      warnings: [],
      restartRequired: false,
      desiredGeneration: 1,
      appliedGeneration: 1,
      needsSync: false,
    };
    const executeCodexIntegration = vi.fn(async (command) => {
      if (command.command === "sync") throw new Error("transport closed");
      return { state: codexState };
    });
    const api = createFakeDesktopApi({
      control: {
        getBackendState: async () => ({ revision: 1, kind: "ready", status: runningStatus }),
        onBackendState: () => () => undefined,
        executeCodexIntegration,
        getRequestLedger: async () => ({ records: [], hasMore: false }),
        onRequestLedger: () => () => undefined,
      },
    });

    await act(async () => root.render(<App api={api} />));
    await flush();
    const sync = container.querySelector('button[aria-label="Sync Codex"]');
    if (!(sync instanceof HTMLButtonElement)) throw new Error("sync button missing");
    await act(async () => {
      sync.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain(
      "Codex sync failed. No Codex files were changed.",
    );
    expect(sync.disabled).toBe(false);
  });

  it("shows the Codex authority message returned by the initial query", async () => {
    const api = createFakeDesktopApi({
      control: {
        getBackendState: async () => ({ revision: 1, kind: "ready", status: runningStatus }),
        onBackendState: () => () => undefined,
        executeCodexIntegration: async () => ({
          state: {
            desiredEnabled: false,
            observedState: "unavailable",
            codexHome: "C:\\Users\\test\\.codex",
            configPath: "C:\\Users\\test\\.codex\\config.toml",
            catalogPath: "C:\\Users\\test\\.codex\\luckytoken-model-catalog.json",
            endpoint: "http://127.0.0.1:4317/v1",
            warnings: [],
            restartRequired: false,
            desiredGeneration: 1,
            needsSync: false,
            message: "Codex config.toml was not found.",
          },
        }),
        getRequestLedger: async () => ({ records: [], hasMore: false }),
        onRequestLedger: () => () => undefined,
      },
    });

    await act(async () => root.render(<App api={api} />));
    await flush();

    expect(container.textContent).toContain("Codex config.toml was not found.");
  });

  it("reports that Codex must restart after the integration is restored", async () => {
    let codexState = {
      desiredEnabled: true,
      observedState: "managed" as "managed" | "native",
      codexHome: "C:\\Users\\test\\.codex",
      configPath: "C:\\Users\\test\\.codex\\config.toml",
      catalogPath: "C:\\Users\\test\\.codex\\luckytoken-model-catalog.json",
      endpoint: "http://127.0.0.1:4317/v1",
      warnings: [],
      restartRequired: false,
      desiredGeneration: 1,
      appliedGeneration: 1,
      needsSync: false,
    };
    const executeCodexIntegration = vi.fn(async (command) => {
      if (command.command === "set_enabled" && !command.enabled) {
        codexState = {
          ...codexState,
          desiredEnabled: false,
          observedState: "native",
          restartRequired: true,
        };
      }
      return { state: codexState };
    });
    const api = createFakeDesktopApi({
      control: {
        getBackendState: async () => ({ revision: 1, kind: "ready", status: runningStatus }),
        onBackendState: () => () => undefined,
        executeCodexIntegration,
        getRequestLedger: async () => ({ records: [], hasMore: false }),
        onRequestLedger: () => () => undefined,
      },
    });

    await act(async () => root.render(<App api={api} />));
    await flush();
    const toggle = container.querySelector('button[aria-label="Disable Codex integration"]');
    if (!(toggle instanceof HTMLButtonElement)) throw new Error("Codex toggle missing");
    await act(async () => {
      toggle.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain(
      "Codex configuration restored. Restart Codex to apply the change.",
    );
  });
});
