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

const settingsResult = () => ({ outcome: "ok" as const, settings: Object.fromEntries(["modelProvider", "openaiBaseUrl", "modelCatalogJson"].map((field) => { const key = `integrations.codex.preimage.${field}`; return [key, { key, type: "nullable-string" as const, default: null, validation: { type: "nullable-string" }, sensitivity: "public" as const, applyMode: "hot-apply" as const, value: null }]; })) });

describe("Settings product slice", () => {
  it("shows one unified history total", async () => {
    await render(createFakeDesktopApi({ control: { queryHistory: async () => ({ range: "all", counts: { requestJourneys: 2, runtimeEvents: 1 } }) } }));
    await click("Data & privacyHistory and backups");
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
              fullJourneyDirectory: "D:\\TokenData\\state\\request-diagnostics\\full-journeys",
              maxJsonArtifactBytes: 67_108_864,
              maxJourneyArtifactBytes: 536_870_912,
              isolation: "process" as const,
            },
          },
        }),
      },
    }));
    await click("Data & privacyHistory and backups");

    expect(container.textContent).toContain("Full journey capture");
    expect(container.textContent).toContain(
      "D:\\TokenData\\state\\request-diagnostics\\full-journeys",
    );
    expect(container.textContent).toContain("64 MiB per JSON file");
    expect(container.textContent).toContain("Force capture when a request fails");
    expect(container.textContent).toContain("Failures only");
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
    await click("AdvancedCodex and diagnostics");
    expect(container.textContent).toContain("Provider needs attention");
    expect(container.textContent).toContain("provider_attention");
    expect(container.textContent).toContain("Model provider");
    expect(container.textContent).toContain("model_provider");
    expect(container.textContent).not.toContain("deep diagnostics");
    const saveButton = container.querySelector('button[aria-label="Save restore values"]');
    expect(saveButton?.textContent).toBe("");
    expect(saveButton?.querySelector(".lucide-save")).not.toBeNull();
    expect(executeSettings).toHaveBeenCalledWith({ command: "query", keys: ["integrations.codex.preimage.modelProvider", "integrations.codex.preimage.openaiBaseUrl", "integrations.codex.preimage.modelCatalogJson"] });
  });

  it("uses compact, descriptive navigation instead of a duplicate Settings card", async () => {
    await render(createFakeDesktopApi({ platform: { getAutoStart: async () => false } }));

    expect(container.querySelectorAll(".settings-heading")).toHaveLength(0);
    expect(container.querySelectorAll('.settings-tabs [role="tab"]')).toHaveLength(3);
    expect(container.textContent).toContain("Startup behavior");
    expect(container.textContent).toContain("Start Token automatically");
    const autoStart = container.querySelector('.settings-action-row .switch-control[aria-pressed="false"]');
    expect(autoStart?.getAttribute("aria-label")).toBe("Enable auto-start");
    expect(autoStart?.textContent).toBe("");
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
});
