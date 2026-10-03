// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/renderer/app/App.js";
import { createFakeDesktopApi } from "./support/fake-desktop-api.js";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function click(name: string): Promise<void> { await act(async () => { const button = [...container.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === name); if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button: ${name}`); button.click(); }); }
async function clickAria(name: string): Promise<void> { await act(async () => { const button = container.querySelector(`button[aria-label="${name}"]`); if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button: ${name}`); button.click(); }); }
async function render(api: ReturnType<typeof createFakeDesktopApi>): Promise<void> { await act(async () => root.render(<App api={api} />)); await act(async () => { (container.querySelector('button[aria-label="Settings"]') as HTMLButtonElement).click(); }); }

const settingsResult = () => ({
  outcome: "ok" as const,
  settings: {
    "integrations.codex.searchModel": {
      key: "integrations.codex.searchModel",
      type: "string" as const,
      default: "gpt-6-luna",
      validation: { type: "model-name" },
      sensitivity: "public" as const,
      applyMode: "hot-apply" as const,
      value: "gpt-6-luna",
    },
  },
});

describe("Settings product slice", () => {
  it("persists the automatic local login switch and preserves its value on save failure", async () => {
    const key = "credentials.autoLocalOAuth.enabled";
    let enabled = false;
    let fail = false;
    const executeSettings = vi.fn<ReturnType<typeof createFakeDesktopApi>["control"]["executeSettings"]>(async (command) => {
      if (command.command === "set" && command.key === key && !fail) enabled = command.value === true;
      return {
        outcome: command.command === "set" ? (fail ? "storage_failure" : "applied") : "ok",
        settings: { [key]: {
          key, type: "boolean", default: false, value: enabled,
          validation: { type: "boolean" }, sensitivity: "public", applyMode: "hot-apply",
        } },
      };
    });
    await render(createFakeDesktopApi({ control: { executeSettings } }));
    expect(container.textContent).toContain("Automatic local OAuth login");
    await clickAria("Enable automatic local OAuth login");
    expect(executeSettings).toHaveBeenCalledWith({ command: "set", key, value: true });
    expect(container.querySelector('button[aria-label="Disable automatic local OAuth login"]')?.getAttribute("aria-pressed")).toBe("true");
    fail = true;
    await clickAria("Disable automatic local OAuth login");
    expect(container.textContent).toContain("could not be saved");
    expect(container.querySelector('button[aria-label="Disable automatic local OAuth login"]')?.getAttribute("aria-pressed")).toBe("true");
    fail = false;
    await clickAria("Disable automatic local OAuth login");
    expect(container.textContent).toContain("Existing Profiles are kept");
  });
  it("shows one unified history total", async () => {
    await render(createFakeDesktopApi({ control: { queryHistory: async () => ({ range: "all", counts: { requestJourneys: 2, runtimeEvents: 1 } }) } }));
    await click("Diagnostics");
    expect(container.textContent).toContain("3 stored history records");
    expect(container.textContent).not.toContain("captures");
    expect(container.querySelector('.settings-danger-section .settings-status')?.textContent).toBe("3 records");
    const deleteButton = container.querySelector('button[aria-label="Delete history"]');
    expect(deleteButton?.textContent).toBe("");
    expect(deleteButton?.querySelector(".lucide-trash-2")).not.toBeNull();
  });

  it("controls all-request and failed-request capture through registered settings and shows the folder", async () => {
    let enabled = false;
    let failedEnabled = true;
    const executeSettings = vi.fn(async (
      command: Parameters<
        ReturnType<typeof createFakeDesktopApi>["control"]["executeSettings"]
      >[0],
    ) => {
      if (command.command === "set") {
        if (command.key === "diagnostics.fullJourneyCapture.enabled") {
          enabled = command.value === true;
        } else if (command.key === "diagnostics.failedJourneyCapture.enabled") {
          failedEnabled = command.value === true;
        }
      }
      const fullKey = "diagnostics.fullJourneyCapture.enabled";
      const failedKey = "diagnostics.failedJourneyCapture.enabled";
      return {
        outcome: command.command === "set" ? ("applied" as const) : ("ok" as const),
        settings: {
          [fullKey]: {
            key: fullKey,
            type: "boolean" as const,
            default: false,
            validation: { type: "boolean" },
            sensitivity: "public" as const,
            applyMode: "hot-apply" as const,
            value: enabled,
          },
          [failedKey]: {
            key: failedKey,
            type: "boolean" as const,
            default: true,
            validation: { type: "boolean" },
            sensitivity: "public" as const,
            applyMode: "hot-apply" as const,
            value: failedEnabled,
          },
        },
      };
    });
    await render(createFakeDesktopApi({
      control: {
        executeSettings,
        queryHistory: async () => ({ range: "all", counts: { requestJourneys: 0, runtimeEvents: 0 } }),
        getBackendState: async () => ({
          revision: 1,
          kind: "ready" as const,
          status: {
            sequence: 1,
            modelDataPlane: "running" as const,
            provider: "configured" as const,
            diagnostics: {
              available: true,
              fullJourneyDirectory: "D:\\TokenData\\state\\request-diagnostics\\full-journeys-v5",
              maxJsonArtifactBytes: 67_108_864,
              maxJourneyArtifactBytes: 536_870_912,
              isolation: "process" as const,
            },
          },
        }),
      },
    }));
    await click("Diagnostics");

    expect(container.textContent).toContain("Request capture");
    expect(container.textContent).toContain(
      "D:\\TokenData\\state\\request-diagnostics\\full-journeys-v5",
    );
    expect(container.textContent).toContain("64 MiB per artifact");
    expect(container.textContent).toContain("Force capture when a request fails");
    expect(container.textContent).toContain("Failures only");
    expect(container.textContent).toContain("unredacted");
    expect(container.textContent).toContain("credentials");
    expect(container.textContent).toContain("temporary");
    await clickAria("Enable full journey capture");
    expect(executeSettings).toHaveBeenCalledWith({
      command: "set",
      key: "diagnostics.fullJourneyCapture.enabled",
      value: true,
    });
    await clickAria("Disable failed-request capture");
    expect(executeSettings).toHaveBeenCalledWith({
      command: "set",
      key: "diagnostics.failedJourneyCapture.enabled",
      value: false,
    });
  });

  it("removes deep-capture controls and reads typed Runtime Events", async () => {
    const executeSettings = vi.fn(async () => settingsResult());
    await render(createFakeDesktopApi({ control: { executeSettings, queryRuntimeEvents: async () => ({ outcome: "ok", result: { records: [{ kind: "runtime_event", id: 1, runtimeId: "runtime-1", recordId: "event-1", sequence: 1, time: 1, level: "warning", classification: "provider_attention", safeMessage: "Provider needs attention" }], hasMore: false } }) } }));
    await click("Diagnostics");
    expect(container.textContent).toContain("Provider needs attention");
    expect(container.textContent).toContain("provider_attention");
    await click("Advanced");
    await click("Agents");
    expect(container.textContent).toContain("Search request model");
    expect(container.textContent).not.toContain("Restore values");
    expect(container.textContent).not.toContain("model_provider");
    expect(container.textContent).not.toContain("deep diagnostics");
    expect(container.querySelector('button[aria-label="Save restore values"]')).toBeNull();
    expect(executeSettings).toHaveBeenCalledWith({
      command: "query",
      keys: ["integrations.codex.searchModel"],
    });
  });

  it("selects each Claude Code model slot independently from Favorite models", async () => {
    const keys = [
      "integrations.claude.model",
      "integrations.claude.opusModel",
      "integrations.claude.sonnetModel",
      "integrations.claude.haikuModel",
      "integrations.claude.subagentModel",
    ] as const;
    const values: Record<(typeof keys)[number], string | null> = {
      "integrations.claude.model": "provider/favorite-one",
      "integrations.claude.opusModel": "provider/favorite-one",
      "integrations.claude.sonnetModel": "provider/favorite-one",
      "integrations.claude.haikuModel": "provider/favorite-one",
      "integrations.claude.subagentModel": "provider/favorite-one",
    };
    const executeSettings = vi.fn(async (
      command: Parameters<ReturnType<typeof createFakeDesktopApi>["control"]["executeSettings"]>[0],
    ) => {
      if (command.command === "set" && keys.includes(command.key as (typeof keys)[number])) {
        values[command.key as (typeof keys)[number]] =
          typeof command.value === "string" ? command.value : null;
      }
      return {
        outcome: command.command === "set" ? ("applied" as const) : ("ok" as const),
        settings: Object.fromEntries(keys.map((key) => [key, {
          key,
          type: "nullable-string" as const,
          default: null,
          validation: { type: "nullable-string" as const },
          sensitivity: "public" as const,
          applyMode: "hot-apply" as const,
          value: values[key],
        }])),
      };
    });
    const executeAgentIntegrations = vi.fn(async () => ({
      outcome: "ok" as const,
      state: {
        agents: [
          { agentId: "claude" as const, enabled: true, scope: "favorite" as const, modelCount: 1, needsSync: true },
          { agentId: "codex" as const, enabled: false, scope: "favorite" as const, modelCount: 0, needsSync: false },
          { agentId: "pi" as const, enabled: false, scope: "favorite" as const, modelCount: 0, needsSync: false },
        ],
      },
      results: [],
    }));
    const executePublicModels = vi.fn(async () => ({
      outcome: "ok" as const,
      state: {
        revision: 1,
        version: 1,
        endpoint: { host: "127.0.0.1", port: 3000 },
        providers: [{
          providerId: "provider",
          on: true,
          favorite: false,
          models: [
            { alias: "provider/favorite-one", target: "one", on: true, favorite: true },
            { alias: "provider/favorite-two", target: "two", on: true, favorite: true },
            { alias: "provider/not-favorite", target: "three", on: true, favorite: false },
          ],
        }],
      },
    }));

    await render(createFakeDesktopApi({
      control: {
        executeSettings,
        executeAgentIntegrations,
        executePublicModels,
        getBackendState: async () => ({
          revision: 1,
          kind: "ready" as const,
          status: {
            sequence: 1,
            modelDataPlane: "running" as const,
            provider: "configured" as const,
          },
        }),
        onBackendState: () => () => undefined,
      },
    }));
    await click("Advanced");
    await click("Agents");

    const labels = [
      "Claude main model",
      "Claude Opus model",
      "Claude Sonnet model",
      "Claude Haiku model",
      "Claude subagent model",
    ];
    for (const label of labels) {
      const select = container.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
      expect(select).toBeInstanceOf(HTMLSelectElement);
      expect(select.closest(".page-card")?.querySelector("h3")?.textContent).toBe("Claude Code");
      expect([...select.options].map((option) => option.value)).toContain("provider/favorite-two");
      expect([...select.options].map((option) => option.value)).not.toContain("provider/not-favorite");
    }

    const main = container.querySelector('select[aria-label="Claude main model"]') as HTMLSelectElement;
    await act(async () => {
      main.value = "provider/favorite-two";
      main.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(executeSettings).toHaveBeenCalledWith({
      command: "set",
      key: "integrations.claude.model",
      value: "provider/favorite-two",
    });
    expect(executeAgentIntegrations).toHaveBeenCalledWith({ command: "query" });
  });

  it("saves the configured Codex search model from Advanced settings", async () => {
    const executeSettings = vi.fn(async (command: Parameters<ReturnType<typeof createFakeDesktopApi>["control"]["executeSettings"]>[0]) => ({
      outcome: command.command === "set" ? ("applied" as const) : ("ok" as const),
      settings: {
        "integrations.codex.searchModel": {
          key: "integrations.codex.searchModel",
          type: "string" as const,
          default: "gpt-6-luna",
          validation: { type: "model-name" },
          sensitivity: "public" as const,
          applyMode: "hot-apply" as const,
          value: "gpt-5.6-sol",
        },
      },
    }));
    await render(createFakeDesktopApi({ control: { executeSettings } }));
    await click("Advanced");
    await click("Agents");
    expect((container.querySelector('input[aria-label="Codex search model"]') as HTMLInputElement).value).toBe("gpt-5.6-sol");
    const codexCard = container.querySelector('input[aria-label="Codex search model"]')?.closest(".page-card");
    expect(codexCard?.querySelector("h3")?.textContent).toBe("Codex");
    expect(codexCard?.querySelector('select[aria-label="Codex injection scope"]')).not.toBeNull();
    await clickAria("Save Codex search model");
    expect(executeSettings).toHaveBeenCalledWith({
      command: "set",
      key: "integrations.codex.searchModel",
      value: "gpt-5.6-sol",
    });
  });

  it("uses compact, descriptive navigation instead of a duplicate Settings card", async () => {
    await render(createFakeDesktopApi({ platform: { getAutoStart: async () => false } }));

    expect(container.querySelectorAll(".settings-heading")).toHaveLength(0);
    expect(container.querySelectorAll('.settings-tabs [role="tab"]')).toHaveLength(3);
    expect(container.textContent).toContain("Diagnostics");
    expect(container.textContent).toContain("Start Token automatically");
    const autoStart = container.querySelector('.settings-action-row .switch-control[aria-pressed="false"]');
    expect(autoStart?.getAttribute("aria-label")).toBe("Enable auto-start");
    expect(autoStart?.textContent).toBe("");
    const generalTab = container.querySelector('#settings-tab-general') as HTMLButtonElement;
    await act(async () => {
      generalTab.focus();
      generalTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(container.querySelector('#settings-tab-diagnostics')?.getAttribute("aria-selected")).toBe("true");
  });

  it.each([
    ["protocols.openai-responses.requestRepair.toolCallAdjacency.providerNative", "tool-call adjacency reorder"],
    ["protocols.openai-responses.responseRepair.sseLifecycle.providerNative", "SSE lifecycle normalization"],
    ["protocols.openai-responses.responseRepair.functionCallNamespace.providerNative", "function-call namespace repair"],
  ])("toggles only %s in the Responses Provider Native settings", async (settingKey, action) => {
    const executeSettings = vi.fn(async (command: Parameters<ReturnType<typeof createFakeDesktopApi>["control"]["executeSettings"]>[0]) => ({
      outcome: command.command === "set" ? ("applied" as const) : ("ok" as const),
      settings: {
        [settingKey]: {
          key: settingKey,
          type: "boolean" as const,
          default: true,
          validation: { type: "boolean" as const },
          sensitivity: "public" as const,
          applyMode: "hot-apply" as const,
          value: (command.command === "set" ? command.value : true) as boolean,
        },
      },
    }));
    await render(createFakeDesktopApi({ control: { executeSettings } }));

    await click("Advanced");

    const toggle = container.querySelector(`.switch-control[aria-label="Disable ${action}"]`);
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
    expect(toggle?.closest(".page-card")?.querySelector("h3")?.textContent).toBe("Provider Native rewrites");
    expect(toggle?.closest(".page-card")?.querySelectorAll(".switch-control")).toHaveLength(3);

    await clickAria(`Disable ${action}`);

    expect(executeSettings).toHaveBeenCalledWith({
      command: "set",
      key: settingKey,
      value: false,
    });
    expect(container.querySelector(`.switch-control[aria-label="Enable ${action}"]`)?.getAttribute("aria-pressed")).toBe("false");
    expect(toggle?.closest(".page-card")?.querySelectorAll('.switch-control[aria-pressed="true"]')).toHaveLength(2);
  });

  it("keeps both protocol controls in Advanced settings", async () => {
    const values: Record<string, boolean> = {
      "protocols.openai-responses.enabled": true,
      "protocols.anthropic-messages.enabled": true,
    };
    const executeSettings = vi.fn(async (command: Parameters<ReturnType<typeof createFakeDesktopApi>["control"]["executeSettings"]>[0]) => {
      if (command.command === "set") values[command.key] = command.value === true;
      return {
        outcome: command.command === "set" ? ("applied" as const) : ("ok" as const),
        settings: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, {
          key, type: "boolean" as const, default: true,
          validation: { type: "boolean" as const }, sensitivity: "public" as const,
          applyMode: "hot-apply" as const, value,
        }])),
      };
    });
    await render(createFakeDesktopApi({ control: { executeSettings } }));
    await click("Advanced");
    await clickAria("Disable Responses protocol");
    expect(executeSettings).toHaveBeenCalledWith({ command: "set", key: "protocols.openai-responses.enabled", value: false });
    await clickAria("Disable Anthropic Messages protocol");
    expect(executeSettings).toHaveBeenCalledWith({ command: "set", key: "protocols.anthropic-messages.enabled", value: false });
  });

  it("enables Windows auto-start from General settings and reflects the effective state", async () => {
    const setAutoStart = vi.fn(async () => true);
    await render(createFakeDesktopApi({
      platform: {
        getAutoStart: async () => false,
        setAutoStart,
      },
    }));

    await clickAria("Enable auto-start");

    expect(setAutoStart).toHaveBeenCalledWith(true);
    expect(container.querySelector('.settings-action-row .switch-control[aria-pressed="true"]')?.getAttribute("aria-label")).toBe("Disable auto-start");
    expect(container.querySelector('.settings-status')?.textContent).toBe("On");
  });

  it("shows default usage settings and saves changed interval and timeout", async () => {
    const intervalKey = "providerUsage.refreshIntervalMinutes";
    const timeoutKey = "providerUsage.refreshTimeoutSeconds";
    let minutes = 15;
    let timeoutSeconds = 45;
    const executeSettings = vi.fn(async (command: Parameters<ReturnType<typeof createFakeDesktopApi>["control"]["executeSettings"]>[0]) => {
      if (command.command === "set" && command.key === intervalKey) {
        minutes = command.value as number;
      }
      if (command.command === "set" && command.key === timeoutKey) {
        timeoutSeconds = command.value as number;
      }
      return {
        outcome: command.command === "set" ? ("applied" as const) : ("ok" as const),
        settings: {
          [intervalKey]: {
            key: intervalKey,
            type: "number" as const,
            default: 15,
            validation: { type: "integer" as const, minimum: 1, maximum: 1440 },
            sensitivity: "public" as const,
            applyMode: "hot-apply" as const,
            value: minutes,
          },
          [timeoutKey]: {
            key: timeoutKey,
            type: "number" as const,
            default: 45,
            validation: { type: "integer" as const, minimum: 5, maximum: 600 },
            sensitivity: "public" as const,
            applyMode: "hot-apply" as const,
            value: timeoutSeconds,
          },
        },
      };
    });
    await render(createFakeDesktopApi({ control: { executeSettings } }));
    const input = container.querySelector('input[aria-label="Usage refresh interval in minutes"]') as HTMLInputElement;
    const timeoutInput = container.querySelector('input[aria-label="Usage refresh timeout in seconds"]') as HTMLInputElement;
    expect(input.value).toBe("15");
    expect(timeoutInput.value).toBe("45");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "5");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await clickAria("Save usage interval");
    expect(executeSettings).toHaveBeenCalledWith({ command: "set", key: intervalKey, value: 5 });
    expect(input.value).toBe("5");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(timeoutInput, "90");
      timeoutInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await clickAria("Save usage timeout");
    expect(executeSettings).toHaveBeenCalledWith({ command: "set", key: timeoutKey, value: 90 });
    expect(timeoutInput.value).toBe("90");
  });

  it("rejects a usage timeout that is not shorter than the refresh interval", async () => {
    const intervalKey = "providerUsage.refreshIntervalMinutes";
    const timeoutKey = "providerUsage.refreshTimeoutSeconds";
    const executeSettings = vi.fn<ReturnType<typeof createFakeDesktopApi>["control"]["executeSettings"]>(async () => ({
      outcome: "ok" as const,
      settings: {
        [intervalKey]: {
          key: intervalKey,
          type: "number" as const,
          default: 15,
          validation: { type: "integer" as const, minimum: 1, maximum: 1440 },
          sensitivity: "public" as const,
          applyMode: "hot-apply" as const,
          value: 1,
        },
        [timeoutKey]: {
          key: timeoutKey,
          type: "number" as const,
          default: 45,
          validation: { type: "integer" as const, minimum: 5, maximum: 600 },
          sensitivity: "public" as const,
          applyMode: "hot-apply" as const,
          value: 45,
        },
      },
    }));
    await render(createFakeDesktopApi({ control: { executeSettings } }));
    const timeoutInput = container.querySelector('input[aria-label="Usage refresh timeout in seconds"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(timeoutInput, "60");
      timeoutInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await clickAria("Save usage timeout");

    expect(executeSettings.mock.calls.filter(([command]) => command.command === "set")).toHaveLength(0);
    expect(container.textContent).toContain("Timeout must be less than 60 seconds.");
  });
});
