// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsCommand } from "@luckytoken/application-control-plane/control-plane";

import { App } from "../src/renderer/app/App.js";
import { createFakeDesktopApi } from "./support/fake-desktop-api.js";

let container: HTMLDivElement;
let root: Root;

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

async function click(name: string): Promise<void> {
  await act(async () => {
    const button = [...container.querySelectorAll("button")].find(
      (entry) => entry.textContent?.trim() === name,
    );
    if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button: ${name}`);
    button.click();
  });
}

async function render(api: ReturnType<typeof createFakeDesktopApi>): Promise<void> {
  await act(async () => root.render(<App api={api} />));
  await act(async () => {
    const button = container.querySelector('button[aria-label="Settings"]');
    if (!(button instanceof HTMLButtonElement)) throw new Error("Settings color bar missing");
    button.click();
  });
}

const settingsResult = () => ({
  outcome: "ok" as const,
  settings: {
    "diagnostics.deepCapture.enabled": {
      key: "diagnostics.deepCapture.enabled",
      type: "boolean" as const,
      default: false,
      validation: {},
      sensitivity: "public" as const,
      applyMode: "hot-apply" as const,
      value: false,
    },
    ...Object.fromEntries(
      ["modelProvider", "openaiBaseUrl", "modelCatalogJson"].map((field) => {
        const key = `integrations.codex.preimage.${field}`;
        return [
          key,
          {
            key,
            type: "nullable-string" as const,
            default: null,
            validation: { type: "nullable-string" },
            sensitivity: "public" as const,
            applyMode: "hot-apply" as const,
            value: null,
          },
        ];
      }),
    ),
  },
});

describe("Settings product slice", () => {
  it("does not expose Client Token management in General settings", async () => {
    await render(
      createFakeDesktopApi({
        platform: { getAutoStart: async () => false },
      }),
    );

    expect(container.textContent).not.toContain("Client Access");
    expect(container.textContent).not.toContain("Rotate token");
    expect(container.querySelector(".client-token-row")).toBeNull();
  });

  it("keeps desktop auto-start in the platform namespace", async () => {
    const setAutoStart = vi.fn(async () => true);
    await render(
      createFakeDesktopApi({
        platform: { getAutoStart: async () => false, setAutoStart },
      }),
    );

    await click("Enable auto-start");
    expect(setAutoStart).toHaveBeenCalledWith(true);
    expect(container.textContent).toContain("Starts at sign-in");
  });

  it("keeps endpoint port out of Settings because PublicModelAuthority owns it", async () => {
    const executeSettings = vi.fn(async () => settingsResult());
    await render(createFakeDesktopApi({ control: { executeSettings } }));

    expect([...container.querySelectorAll("button")].some(
      (entry) => entry.textContent?.trim() === "Network",
    )).toBe(false);
    expect(container.querySelector('input[aria-label="Gateway port"]')).toBeNull();
  });

  it("does not expose raw models.json editing in Settings", async () => {
    const executeModels = vi.fn();
    await render(createFakeDesktopApi({ control: { executeModels } }));

    expect([...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
      "General",
      "Data",
      "Advanced",
    ]);
    expect(container.textContent).not.toContain("Routing");
    expect(container.querySelector('textarea[aria-label="Raw model configuration"]')).toBeNull();
    expect(executeModels).not.toHaveBeenCalled();
  });

  it("keeps irreversible data actions behind Backend confirmation gates", async () => {
    const confirmHistoryDelete = vi.fn(async () => ({
      outcome: "completed" as const,
      deleted: { requestLedger: 2, diagnostics: 1, capture: 0 },
    }));
    const confirmBackup = vi.fn(async () => ({
      outcome: "ok" as const,
      destinationPath: "C:/backup.zip",
    }));
    await render(
      createFakeDesktopApi({
        control: {
          queryHistory: async () => ({
            range: "all",
            counts: { requestLedger: 2, diagnostics: 1, capture: 0 },
          }),
          executeHistoryDelete: async () => ({
            outcome: "confirmation_required",
            actionId: "delete-1",
            confirmationMessage: "Delete 3 records permanently?",
            preview: {
              range: "all",
              counts: { requestLedger: 2, diagnostics: 1, capture: 0 },
            },
          }),
          confirmHistoryDelete,
          executeBackup: async () => ({
            outcome: "confirmation_required",
            actionId: "backup-1",
            confirmationMessage: "Include sensitive capture data?",
          }),
          confirmBackup,
        },
        platform: {
          pickSaveFile: async () => "C:/backup.zip",
        },
      }),
    );
    await click("Data");
    expect(container.textContent).toContain("3 stored records");

    await click("Delete all history");
    expect(container.textContent).toContain("Delete 3 records permanently?");
    await click("Confirm delete");
    expect(confirmHistoryDelete).toHaveBeenCalledWith("delete-1");

    await click("Create full backup");
    expect(container.textContent).toContain("Include sensitive capture data?");
    await click("Confirm backup");
    expect(confirmBackup).toHaveBeenCalledWith("backup-1");
  });

  it("does not let a diagnostics query failure block the independent deep-capture setting", async () => {
    await render(
      createFakeDesktopApi({
        control: {
          executeSettings: async () => ({
            outcome: "ok",
            settings: {
              ...settingsResult().settings,
              "diagnostics.deepCapture.enabled": {
                ...settingsResult().settings["diagnostics.deepCapture.enabled"],
                value: true,
              },
            },
          }),
          getDiagnostics: async () => {
            throw new Error("diagnostics unavailable");
          },
        },
      }),
    );
    await click("Advanced");

    expect(container.textContent).toContain("Recent diagnostics are temporarily unavailable.");
    expect(container.textContent).toContain("Disable deep diagnostics");
  });

  it("shows blank Codex restore inputs with the delete-on-empty contract", async () => {
    await render(
      createFakeDesktopApi({
        control: {
          executeSettings: async () => settingsResult(),
          getDiagnostics: async () => ({ records: [], hasMore: false }),
        },
      }),
    );
    await click("Advanced");

    const labels = ["model_provider", "openai_base_url", "model_catalog_json"];
    for (const label of labels) {
      const input = container.querySelector(`input[aria-label="${label} restore value"]`);
      expect(input).toBeInstanceOf(HTMLInputElement);
      expect((input as HTMLInputElement).value).toBe("");
    }
    expect(container.textContent).toContain(
      "Leave a field blank to remove it from Codex config.toml when the integration is turned off.",
    );
    expect(container.textContent).toContain(
      "While enabled, LuckyToken replaces these three root fields in Codex config.toml.",
    );
  });

  it("saves blank Codex restore inputs as null and trims configured values", async () => {
    const executeSettings = vi.fn(async () => ({
      ...settingsResult(),
      outcome: "applied" as const,
    }));
    await render(
      createFakeDesktopApi({
        control: {
          executeSettings,
          getDiagnostics: async () => ({ records: [], hasMore: false }),
        },
      }),
    );
    await click("Advanced");
    const catalog = container.querySelector(
      'input[aria-label="model_catalog_json restore value"]',
    );
    if (!(catalog instanceof HTMLInputElement)) throw new Error("catalog restore input missing");
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      if (setValue === undefined) throw new Error("native input setter missing");
      setValue.call(catalog, "  C:/restore/catalog.json  ");
      catalog.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await click("Save Codex restore values");

    expect(executeSettings).toHaveBeenCalledWith({
      command: "set",
      key: "integrations.codex.preimage.modelProvider",
      value: null,
    });
    expect(executeSettings).toHaveBeenCalledWith({
      command: "set",
      key: "integrations.codex.preimage.openaiBaseUrl",
      value: null,
    });
    expect(executeSettings).toHaveBeenCalledWith({
      command: "set",
      key: "integrations.codex.preimage.modelCatalogJson",
      value: "C:/restore/catalog.json",
    });
  });

  it("keeps deep diagnostics and diagnostic query behind typed Backend capabilities", async () => {
    const executeSettings = vi.fn(async (command: SettingsCommand) =>
      command.command === "query"
        ? settingsResult()
        : {
            outcome: "applied" as const,
            settings: {
              ...settingsResult().settings,
              "diagnostics.deepCapture.enabled": {
                ...settingsResult().settings["diagnostics.deepCapture.enabled"],
                value: true,
              },
            },
          },
    );
    const getDiagnostics = vi.fn(async () => ({
      records: [
        { id: 1, level: "warning" as const, time: 1, text: "Provider needs attention" },
      ],
      hasMore: false,
    }));
    await render(
      createFakeDesktopApi({ control: { executeSettings, getDiagnostics } }),
    );
    await click("Advanced");

    expect(container.textContent).toContain("Provider needs attention");
    await click("Enable deep diagnostics");
    expect(executeSettings).toHaveBeenLastCalledWith({
      command: "set",
      key: "diagnostics.deepCapture.enabled",
      value: true,
    });
    expect(container.textContent).toContain("Applies immediately");
  });

  it("shows the typed settings storage failure without changing the effective toggle", async () => {
    const baseline = settingsResult();
    await render(
      createFakeDesktopApi({
        control: {
          executeSettings: async (command) =>
            command.command === "query"
              ? baseline
              : {
                  outcome: "storage_failure",
                  error: "Settings could not be saved",
                  settings: baseline.settings,
                },
          getDiagnostics: async () => ({ records: [], hasMore: false }),
        },
      }),
    );
    await click("Advanced");
    await click("Enable deep diagnostics");

    expect(container.textContent).toContain("Settings could not be saved");
    expect(container.textContent).toContain("Enable deep diagnostics");
  });
});
