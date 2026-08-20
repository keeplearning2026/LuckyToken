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

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  if (setter === undefined) throw new Error("textarea value setter missing");
  act(() => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
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
  },
});

const modelsState = (revision: number) => ({
  revision,
  path: "models.json",
  present: true,
  valid: true,
  raw: "{\n  \"providers\": {}\n}\n",
  providers: {},
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

  it("keeps models.json as a startup-only routing draft with no raw Alias editor", async () => {
    const executeModels = vi
      .fn()
      .mockResolvedValueOnce({ outcome: "ok", state: modelsState(7) })
      .mockResolvedValueOnce({ outcome: "ok", state: modelsState(8) });
    await render(createFakeDesktopApi({ control: { executeModels } }));
    await click("Routing");

    expect(container.querySelector('textarea[aria-label="Alias mappings"]')).toBeNull();
    expect(container.textContent).toContain("models.json is read when the Backend starts");

    const modelDraft = container.querySelector('textarea[aria-label="Raw model configuration"]');
    if (!(modelDraft instanceof HTMLTextAreaElement)) throw new Error("Model draft missing");
    setTextareaValue(modelDraft, '{"providers":{}}');
    await click("Save models");
    expect(executeModels).toHaveBeenLastCalledWith({
      command: "write_raw",
      revision: 7,
      content: '{"providers":{}}',
    });
    expect(container.textContent).toContain("Restart LuckyToken to apply");
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
});
