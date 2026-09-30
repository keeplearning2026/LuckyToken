// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusSnapshot } from "@token/application-control-plane/control-plane";

import { App } from "../src/renderer/app/App.js";
import type { DesktopBackendState } from "../src/shared/desktop-api.js";
import { createFakeDesktopApi } from "./support/fake-desktop-api.js";

let container: HTMLDivElement;
let root: Root;

const runningStatus: StatusSnapshot = {
  sequence: 1,
  modelDataPlane: "running",
  provider: "configured",
  activeRequests: 2,
  dataPlane: {
    configuredOrigin: "http://127.0.0.1:4317",
    configuredPort: 4317,
  },
};

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.removeItem("token.desktop.theme");
  window.localStorage.removeItem("token.desktop.hiddenToolbarAgents");
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

async function openAgentSettings(): Promise<void> {
  await act(async () => {
    (container.querySelector('button[aria-label="Settings"]') as HTMLButtonElement).click();
  });
  await act(async () => {
    [...container.querySelectorAll('button[role="tab"]')].find((button) => button.textContent === "Advanced")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    [...container.querySelectorAll('button[role="tab"]')].find((button) => button.textContent === "Agents")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

describe("desktop command-router shell", () => {
  it("selects toolbar Agents in Settings and restores the saved selection on reopen", async () => {
    const executeAgentIntegrations = vi.fn(async () => ({
      outcome: "ok" as const,
      state: { agents: [{ agentId: "codex" as const, enabled: true, scope: "favorite" as const, modelCount: 1, needsSync: false }] },
      results: [],
    }));
    const api = createFakeDesktopApi({ control: {
      getBackendState: async () => ({ revision: 1, kind: "ready", status: runningStatus }),
      onBackendState: () => () => undefined,
      executeAgentIntegrations,
    } });
    await act(async () => root.render(<App api={api} />));
    await flush();
    await openAgentSettings();
    const toolbar = () => container.querySelector('.agent-integration-toolbar');
    const checkbox = () => container.querySelector('input[aria-label="Show Codex in toolbar"]') as HTMLInputElement;
    expect(checkbox().checked).toBe(true);
    expect(toolbar()?.querySelector('button[aria-label="Disable Codex integration"]')).not.toBeNull();
    executeAgentIntegrations.mockClear();

    await act(async () => checkbox().click());
    expect(checkbox().checked).toBe(false);
    expect(toolbar()?.querySelector('button[aria-label="Disable Codex integration"]')).toBeNull();
    expect(container.querySelector('.settings-panel button[aria-label="Disable Codex integration"]')).not.toBeNull();
    expect(container.querySelector('[role="img"][aria-label="Codex integration: On"]')?.classList.contains("on")).toBe(true);
    expect(container.querySelector('[role="img"][aria-label="Codex integration: On"] .agent-codex-mark')).not.toBeNull();
    expect(executeAgentIntegrations).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<App api={api} />));
    await flush();
    expect(toolbar()?.querySelector('button[aria-label="Disable Codex integration"]')).toBeNull();
    expect(toolbar()?.querySelector('button[aria-label="Enable Claude Code integration"]')).not.toBeNull();
    await openAgentSettings();
    expect(checkbox().checked).toBe(false);
    await act(async () => checkbox().click());
    expect(toolbar()?.querySelector('button[aria-label="Disable Codex integration"]')).not.toBeNull();
  });

  it("places Agent injection controls together left of the endpoint", async () => {
    await act(async () => root.render(<App api={createFakeDesktopApi()} />));
    const toolbar = container.querySelector(".runtime-header-status");
    const integrations = toolbar?.firstElementChild;
    expect(integrations?.getAttribute("aria-label")).toBe("Agent integrations");
    expect(integrations?.children).toHaveLength(6);
    expect(integrations?.children[0]?.getAttribute("aria-label")).toBe("Enable Claude Code integration");
    expect(integrations?.children[1]?.getAttribute("aria-label")).toBe("Enable Claude Desktop integration");
    expect(integrations?.children[1]?.querySelector("img.agent-claude-desktop-mark")).not.toBeNull();
    expect(integrations?.children[2]?.getAttribute("aria-label")).toBe("Enable Codex integration");
    expect(integrations?.children[2]?.querySelector("img.agent-codex-mark")).not.toBeNull();
    expect(integrations?.children[3]?.getAttribute("aria-label")).toBe("Enable Pi integration");
    expect(integrations?.children[4]?.getAttribute("aria-label")).toBe("Enable DeepSeek Harness integration");
    expect(integrations?.children[4]?.querySelector("img.agent-dsh-mark")).not.toBeNull();
    expect(integrations?.children[5]?.getAttribute("aria-label")).toBe("Sync Agent integrations");
    expect(toolbar?.children[1]?.classList.contains("favorite-models-toolbar")).toBe(true);
    expect(toolbar?.children[2]?.classList.contains("endpoint-group")).toBe(true);
  });

  it("opens Favorite models as a dialog without leaving the current page", async () => {
    const api = createFakeDesktopApi({
      control: {
        getBackendState: async () => ({ revision: 1, kind: "ready", status: runningStatus }),
        executePublicModels: async () => ({
          outcome: "ok",
          state: {
            revision: 1,
            version: 1,
            endpoint: { host: "127.0.0.1", port: 4317 },
            providers: [{
              providerId: "example",
              on: true,
              favorite: false,
              models: [{ alias: "example/model-a", target: "model-a", on: true, favorite: true }],
            }],
          },
        }),
      },
    });
    await act(async () => root.render(<App api={api} />));
    await flush();
    const favorite = container.querySelector('button[aria-label="Favorite models (1)"]');
    expect(favorite?.closest(".favorite-models-toolbar")).not.toBeNull();
    await act(async () => { (favorite as HTMLButtonElement).click(); });
    await flush();
    expect(container.querySelector("h1")?.textContent).toBe("Overview");
    expect(container.querySelector('[role="dialog"][aria-label="Favorite models"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Overview"]')?.getAttribute("aria-current")).toBe("page");
    await act(async () => {
      (container.querySelector('button[aria-label="Close favorite models"]') as HTMLButtonElement).click();
    });
    expect(container.querySelector("h1")?.textContent).toBe("Overview");
    expect(container.querySelector('[role="dialog"][aria-label="Favorite models"]')).toBeNull();
  });

  it("switches and restores the theme from the rightmost toolbar control", async () => {
    const api = createFakeDesktopApi();
    await act(async () => root.render(<App api={api} />));
    const toolbar = container.querySelector(".runtime-header-status");
    const toggle = toolbar?.lastElementChild;
    expect(toggle?.getAttribute("aria-label")).toBe("Switch to dark theme");
    await act(async () => { (toggle as HTMLButtonElement).click(); });
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem("token.desktop.theme")).toBe("dark");
    expect(toggle?.getAttribute("aria-label")).toBe("Switch to light theme");
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<App api={api} />));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(container.querySelector(".runtime-header-status")?.lastElementChild?.getAttribute("aria-label")).toBe("Switch to light theme");
  });

  it("switches the three color pages and keeps endpoint, runtime state, active count, and start/stop control in the header", async () => {
    const backendStateListeners = new Set<(state: DesktopBackendState) => void>();
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
        queryRequestJourneys: async () => ({
          outcome: "ok",
          result: { records: [], hasMore: false },
        }),
        getAnalytics: async (query) => query.command === "options"
          ? {
              version: 3,
              command: "options",
              providers: [],
              profiles: [],
              models: [],
              protocols: [],
              sessions: [],
              outcomes: [],
            }
          : {
              version: 3,
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
                usageRequests: 0,
                missingUsageRequests: 0,
                speedRequests: 0,
                inputTokens: 0,
                cacheReadTokens: 0,
                outputTokens: 0,
              },
            },
      },
    });

    await act(async () => root.render(<App api={api} />));
    await flush();

    expect(container.querySelectorAll(".color-nav-button")).toHaveLength(3);
    expect(container.querySelector("h1")?.textContent).toBe("Overview");
    expect(container.textContent).toContain("127.0.0.1:4317");
    expect(container.querySelector(".runtime-state-dot.running")).not.toBeNull();
    expect(container.querySelector(".runtime-endpoint svg")).not.toBeNull();
    expect(container.textContent).toContain("2");
    expect(container.querySelector(".runtime-active svg")).toBeNull();

    act(() => {
      for (const listener of backendStateListeners) {
        listener({
          revision: 2,
          kind: "ready",
          status: { ...runningStatus, sequence: 2, activeRequests: 3 },
        });
      }
    });
    expect(container.querySelector(".active-request-count")?.textContent).toBe("3");

    act(() => {
      for (const listener of backendStateListeners) {
        listener({
          revision: 3,
          kind: "ready",
          status: { ...runningStatus, sequence: 3, activeRequests: 2 },
        });
      }
    });
    expect(container.querySelector(".active-request-count")?.textContent).toBe("2");

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
      const stop = container.querySelector('button[aria-label="Stop Token"]');
      if (!(stop instanceof HTMLButtonElement)) throw new Error("Stop control missing");
      stop.click();
    });
    await flush();
    expect(executeRuntime).toHaveBeenCalledWith("stop");
    act(() => {
      for (const listener of backendStateListeners) {
        listener({
          revision: 4,
          kind: "ready",
          status: {
            ...runningStatus,
            sequence: 4,
            modelDataPlane: "stopped",
            activeRequests: 0,
          },
        });
      }
    });
    await flush();
    expect(container.querySelector(".runtime-state-dot.stopped")).not.toBeNull();
    expect(container.querySelector(".runtime-state")?.getAttribute("aria-label")).toBe("Token is stopped");
    expect(container.querySelector(".active-request-count")?.textContent).toBe("0");

    act(() => {
      for (const listener of backendStateListeners) {
        listener({ revision: 5, kind: "unavailable" });
      }
    });
    expect(container.querySelector(".runtime-state-dot.unavailable")).not.toBeNull();
    expect(container.querySelector(".runtime-state")?.getAttribute("aria-label")).toBe("Token is unavailable");
    expect(container.querySelector<HTMLButtonElement>(".runtime-toggle")?.disabled).toBe(true);

    act(() => {
      for (const listener of backendStateListeners) {
        listener({
          revision: 6,
          kind: "ready",
          status: {
            ...runningStatus,
            sequence: 6,
            modelDataPlane: "stopped",
            activeRequests: 0,
          },
        });
      }
    });
    await flush();
    expect(container.querySelector(".active-request-count")?.textContent).toBe("0");
  });

  it("keeps Backend observation active across ready status updates", async () => {
    const backendStateListeners = new Set<(state: DesktopBackendState) => void>();
    const queryRequestJourneys = vi.fn(async () => ({
      outcome: "ok" as const,
      result: { records: [], hasMore: false },
    }));
    const onRequestJourneys = vi.fn(() => () => undefined);
    const getAnalytics = vi.fn(async (query) => query.command === "options"
      ? {
          version: 3 as const,
          command: "options" as const,
          providers: [],
          profiles: [],
          models: [],
          protocols: [],
          sessions: [],
          outcomes: [],
        }
      : {
          version: 3 as const,
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
            usageRequests: 0,
            missingUsageRequests: 0,
            speedRequests: 0,
            inputTokens: 0,
            cacheReadTokens: 0,
            outputTokens: 0,
          },
        });
    const api = createFakeDesktopApi({
      control: {
        getBackendState: async () => ({ revision: 1, kind: "ready", status: runningStatus }),
        onBackendState: (listener) => {
          backendStateListeners.add(listener);
          return () => backendStateListeners.delete(listener);
        },
        queryRequestJourneys,
        onRequestJourneys,
        getAnalytics,
      },
    });

    await act(async () => root.render(<App api={api} />));
    await flush();
    const journeyQueries = queryRequestJourneys.mock.calls.length;
    const journeySubscriptions = onRequestJourneys.mock.calls.length;
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

    expect(queryRequestJourneys).toHaveBeenCalledTimes(journeyQueries);
    expect(onRequestJourneys).toHaveBeenCalledTimes(journeySubscriptions);
    expect(getAnalytics).toHaveBeenCalledTimes(analyticsQueries);
    expect(container.querySelector(".runtime-state-dot.stopped")).not.toBeNull();
  });

  it("edits only the port and provides Agent toggles, scopes, and one shared sync", async () => {
    let publicState = {
      outcome: "ok" as const,
      state: {
        revision: 3,
        version: 8,
        endpoint: { host: "127.0.0.1", port: 4317 },
        providers: [],
      },
    };
    let integrationsState = {
      agents: [
        {
          agentId: "claude" as const,
          enabled: false,
          scope: "favorite" as const,
          modelCount: 0,
          needsSync: false,
        },
        {
          agentId: "claude-desktop" as const,
          enabled: false,
          scope: "favorite" as const,
          modelCount: 0,
          needsSync: false,
        },
        {
          agentId: "codex" as const,
          enabled: true,
          scope: "favorite" as const,
          modelCount: 1,
          needsSync: true,
        },
        {
          agentId: "pi" as const,
          enabled: false,
          scope: "favorite" as const,
          modelCount: 0,
          needsSync: false,
        },
        {
          agentId: "dsh" as const,
          enabled: false,
          scope: "favorite" as const,
          modelCount: 0,
          needsSync: false,
        },
      ],
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
        integrationsState = {
          agents: integrationsState.agents.map((agent) =>
            agent.agentId === "codex" ? { ...agent, needsSync: true } : agent,
          ),
        };
      }
      return publicState;
    });
    const executeAgentIntegrations = vi.fn(async (command) => {
      if (command.command === "set_enabled") {
        integrationsState = {
          agents: integrationsState.agents.map((agent) => agent.agentId === command.agentId
            ? { ...agent, enabled: command.enabled }
            : agent),
        };
      }
      if (command.command === "sync") {
        integrationsState = {
          agents: integrationsState.agents.map((agent) => ({
            ...agent,
            needsSync: false,
          })),
        };
        return {
          outcome: "ok" as const,
          state: integrationsState,
          results: [
            {
              agentId: "codex" as const,
              outcome: "ok" as const,
              effect: {
                observedState: "managed" as const,
                modelCount: 1,
                warnings: ["A malformed native Codex model entry was skipped."],
                changed: true,
                message: "Codex synced. Restart Codex to load the updated model catalog.",
              },
            },
          ],
        };
      }
      return {
        outcome: "ok" as const,
        state: integrationsState,
        results: [],
      };
    });
    const api = createFakeDesktopApi({
      control: {
        getBackendState: async () => ({ revision: 1, kind: "ready", status: runningStatus }),
        onBackendState: () => () => undefined,
        executePublicModels,
        executeAgentIntegrations,
        queryRequestJourneys: async () => ({
          outcome: "ok",
          result: { records: [], hasMore: false },
        }),
        onRequestJourneys: () => () => undefined,
        getAnalytics: async (query) =>
          query.command === "options"
            ? {
                version: 3,
                command: "options",
                providers: [],
                profiles: [],
                models: [],
                protocols: [],
                sessions: [],
                outcomes: [],
              }
            : {
                version: 3,
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
                  usageRequests: 0,
                  missingUsageRequests: 0,
                  speedRequests: 0,
                  inputTokens: 0,
                  cacheReadTokens: 0,
                  outputTokens: 0,
                },
              },
      },
    });

    await act(async () => root.render(<App api={api} />));
    await flush();

    const endpoint = container.querySelector('button[aria-label="Edit Token port"]');
    expect(endpoint?.textContent).toBe("127.0.0.1:4317");
    await act(async () => (endpoint as HTMLButtonElement).click());
    const input = container.querySelector('input[aria-label="Token port"]');
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

    expect(container.querySelector('.agent-integration-toolbar button[aria-label="Enable Claude Code integration"]')).not.toBeNull();
    expect(container.querySelector('.agent-integration-toolbar button[aria-label="Disable Codex integration"]')).not.toBeNull();
    expect(container.querySelector('.settings-panel button[aria-label="Disable Codex integration"]')).toBeNull();
    expect(container.querySelector('select[aria-label="Codex injection scope"]')).toBeNull();
    await openAgentSettings();
    const claudeToggle = container.querySelector('button[aria-label="Enable Claude Code integration"]');
    const desktopToggle = container.querySelector('button[aria-label="Enable Claude Desktop integration"]');
    const codexToggle = container.querySelector('button[aria-label="Disable Codex integration"]');
    const piToggle = container.querySelector('button[aria-label="Enable Pi integration"]');
    const dshToggle = container.querySelector('button[aria-label="Enable DeepSeek Harness integration"]');
    const sync = container.querySelector('button[aria-label="Sync Agent integrations"]');
    expect(claudeToggle).toBeInstanceOf(HTMLButtonElement);
    expect(desktopToggle).toBeInstanceOf(HTMLButtonElement);
    expect(codexToggle).toBeInstanceOf(HTMLButtonElement);
    expect(piToggle).toBeInstanceOf(HTMLButtonElement);
    expect(dshToggle).toBeInstanceOf(HTMLButtonElement);
    expect(sync).toBeInstanceOf(HTMLButtonElement);
    expect(codexToggle?.getAttribute("aria-pressed")).toBe("true");
    expect(piToggle?.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector('select[aria-label="Claude Code injection scope"]')).toBeNull();
    expect(container.querySelector('select[aria-label="Claude Desktop injection scope"]')).toBeInstanceOf(HTMLSelectElement);
    expect(container.querySelector('select[aria-label="Codex injection scope"]')).toBeInstanceOf(HTMLSelectElement);
    expect(container.querySelector('select[aria-label="Pi injection scope"]')).toBeInstanceOf(HTMLSelectElement);
    expect(container.querySelector('select[aria-label="DeepSeek Harness injection scope"]')).toBeInstanceOf(HTMLSelectElement);
    const codexScope = container.querySelector('select[aria-label="Codex injection scope"]') as HTMLSelectElement;
    await act(async () => {
      codexScope.value = "full";
      codexScope.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    expect(executeAgentIntegrations).toHaveBeenCalledWith({ command: "set_scope", agentId: "codex", scope: "full" });
    await act(async () => {
      (claudeToggle as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(executeAgentIntegrations).toHaveBeenCalledWith({ command: "set_enabled", agentId: "claude", enabled: true });
    await act(async () => {
      (desktopToggle as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(executeAgentIntegrations).toHaveBeenCalledWith({ command: "set_enabled", agentId: "claude-desktop", enabled: true });
    await act(async () => {
      (piToggle as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(executeAgentIntegrations).toHaveBeenCalledWith({ command: "set_enabled", agentId: "pi", enabled: true });
    await act(async () => {
      (dshToggle as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(executeAgentIntegrations).toHaveBeenCalledWith({ command: "set_enabled", agentId: "dsh", enabled: true });
    expect(piToggle?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('.settings-panel button[aria-label="Disable Pi integration"]')).not.toBeNull();
    expect(sync?.classList.contains("dirty")).toBe(true);
    expect(sync?.querySelector("svg")).not.toBeNull();

    await act(async () => {
      (sync as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(executeAgentIntegrations).toHaveBeenCalledWith({ command: "sync" });
    expect(container.querySelector('button[aria-label="Sync Agent integrations"]')?.classList.contains("dirty")).toBe(false);
    expect(container.textContent).toContain(
      "Codex synced. Restart Codex to load the updated model catalog.",
    );
    expect(container.textContent).toContain(
      "A malformed native Codex model entry was skipped.",
    );
  });

  it("shows a visible failure when the shared Agent sync request rejects", async () => {
    const integrationsState = {
      agents: [
        {
          agentId: "codex" as const,
          enabled: true,
          scope: "favorite" as const,
          modelCount: 1,
          needsSync: false,
        },
        {
          agentId: "pi" as const,
          enabled: false,
          scope: "favorite" as const,
          modelCount: 0,
          needsSync: false,
        },
      ],
    };
    const executeAgentIntegrations = vi.fn(async (command) => {
      if (command.command === "sync") throw new Error("transport closed");
      return { outcome: "ok" as const, state: integrationsState, results: [] };
    });
    const api = createFakeDesktopApi({
      control: {
        getBackendState: async () => ({ revision: 1, kind: "ready", status: runningStatus }),
        onBackendState: () => () => undefined,
        executeAgentIntegrations,
        queryRequestJourneys: async () => ({
          outcome: "ok",
          result: { records: [], hasMore: false },
        }),
        onRequestJourneys: () => () => undefined,
      },
    });

    await act(async () => root.render(<App api={api} />));
    await flush();
    await openAgentSettings();
    const sync = container.querySelector('button[aria-label="Sync Agent integrations"]');
    if (!(sync instanceof HTMLButtonElement)) throw new Error("sync button missing");
    await act(async () => {
      sync.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain(
      "Agent synchronization failed.",
    );
    expect(container.textContent).not.toContain("Existing Agent files were preserved.");
    expect(sync.disabled).toBe(false);
  });

  it.each(["rejected", "failed-result"] as const)("does not promise preserved files after a %s Agent toggle", async (failure) => {
    let integrationCalls = 0;
    const state = {
      agents: [{ agentId: "claude" as const, enabled: false, scope: "favorite" as const, modelCount: 0, needsSync: false }],
    };
    const api = createFakeDesktopApi({
      control: {
        getBackendState: async () => ({ revision: 1, kind: "ready", status: runningStatus }),
        onBackendState: () => () => undefined,
        executeAgentIntegrations: async (command) => {
          integrationCalls += 1;
          if (command.command !== "set_enabled") return { outcome: "ok", state, results: [] };
          if (failure === "rejected") throw new Error("transport closed after partial update");
          return {
            outcome: "failed",
            state,
            results: [{ agentId: "claude", outcome: "failed", effect: { observedState: "unavailable", modelCount: 0, warnings: ["Current Agent warning"], changed: true } }],
          };
        },
      },
    });
    await act(async () => root.render(<App api={api} />));
    await flush();
    const toggle = container.querySelector('button[aria-label="Enable Claude Code integration"]');
    if (!(toggle instanceof HTMLButtonElement)) throw new Error("Claude toggle missing");
    await act(async () => {
      toggle.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[role="status"]')?.textContent).toContain("integration update failed.");
    expect(container.textContent).not.toContain("Existing Agent files were preserved.");
    expect(toggle.disabled).toBe(false);
    const callsBeforeDismiss = integrationCalls;
    const dismiss = container.querySelector('button[aria-label="Dismiss Agent notification"]');
    if (!(dismiss instanceof HTMLButtonElement)) throw new Error("notice dismiss button missing");
    await act(async () => dismiss.click());
    expect(container.textContent).not.toContain("integration update failed.");
    if (failure === "failed-result") {
      const dismissWarnings = container.querySelector('button[aria-label="Dismiss Agent warnings"]');
      if (!(dismissWarnings instanceof HTMLButtonElement)) throw new Error("warning dismiss button missing");
      await act(async () => dismissWarnings.click());
      expect(container.textContent).not.toContain("Current Agent warning");
    }
    expect(integrationCalls).toBe(callsBeforeDismiss);
    await act(async () => {
      toggle.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[role="status"]')?.textContent).toContain("integration update failed.");
    if (failure === "failed-result") expect(container.textContent).toContain("Current Agent warning");
  });

  it("shows the Agent adapter message returned by a failed icon toggle", async () => {
    const state = {
      agents: [
        {
          agentId: "codex" as const,
          enabled: false,
          scope: "favorite" as const,
          modelCount: 0,
          needsSync: false,
        },
        {
          agentId: "pi" as const,
          enabled: false,
          scope: "favorite" as const,
          modelCount: 0,
          needsSync: false,
        },
      ],
    };
    const api = createFakeDesktopApi({
      control: {
        getBackendState: async () => ({ revision: 1, kind: "ready", status: runningStatus }),
        onBackendState: () => () => undefined,
        executeAgentIntegrations: async (command) =>
          command.command === "set_enabled"
            ? {
                outcome: "failed",
                state,
                results: [
                  {
                    agentId: "codex",
                    outcome: "failed",
                    effect: {
                      observedState: "unavailable",
                      modelCount: 0,
                      warnings: [],
                      changed: false,
                      message: "Codex config.toml was not found.",
                    },
                  },
                ],
              }
            : { outcome: "ok", state, results: [] },
        queryRequestJourneys: async () => ({
          outcome: "ok",
          result: { records: [], hasMore: false },
        }),
        onRequestJourneys: () => () => undefined,
      },
    });

    await act(async () => root.render(<App api={api} />));
    await flush();
    await openAgentSettings();
    const toggle = container.querySelector('button[aria-label="Enable Codex integration"]');
    if (!(toggle instanceof HTMLButtonElement)) throw new Error("Codex icon missing");
    await act(async () => {
      toggle.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Codex config.toml was not found.");
  });

  it("reports that Codex must restart after the integration is restored", async () => {
    let state = {
      agents: [
        {
          agentId: "codex" as const,
          enabled: true,
          scope: "favorite" as const,
          modelCount: 1,
          needsSync: false,
        },
        {
          agentId: "pi" as const,
          enabled: false,
          scope: "favorite" as const,
          modelCount: 0,
          needsSync: false,
        },
      ],
    };
    const executeAgentIntegrations = vi.fn(async (command) => {
      if (command.command === "set_enabled" && !command.enabled) {
        state = {
          agents: state.agents.map((agent) =>
            agent.agentId === "codex"
              ? { ...agent, enabled: false, modelCount: 0 }
              : agent,
          ),
        };
        return {
          outcome: "ok" as const,
          state,
          results: [
            {
              agentId: "codex" as const,
              outcome: "ok" as const,
              effect: {
                observedState: "native" as const,
                modelCount: 0,
                warnings: [],
                changed: true,
                message: "Codex configuration restored. Restart Codex to apply the change.",
              },
            },
          ],
        };
      }
      return { outcome: "ok" as const, state, results: [] };
    });
    const api = createFakeDesktopApi({
      control: {
        getBackendState: async () => ({ revision: 1, kind: "ready", status: runningStatus }),
        onBackendState: () => () => undefined,
        executeAgentIntegrations,
        queryRequestJourneys: async () => ({
          outcome: "ok",
          result: { records: [], hasMore: false },
        }),
        onRequestJourneys: () => () => undefined,
      },
    });

    await act(async () => root.render(<App api={api} />));
    await flush();
    await openAgentSettings();
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
