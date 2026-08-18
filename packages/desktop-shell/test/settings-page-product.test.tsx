// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  await click("Settings");
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  if (setter === undefined) throw new Error("input value setter missing");
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
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

const settingsResult = (port = 3000, effective = 3000) => ({
  outcome: "ok" as const,
  settings: {
    "server.port": {
      key: "server.port",
      type: "number" as const,
      default: 3000,
      validation: { min: 1, max: 65535 },
      sensitivity: "public" as const,
      applyMode: "restart-required" as const,
      value: port,
      effective,
    },
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

const aliasesState = (revision: number) => ({
  revision,
  path: "aliases.json",
  present: true,
  valid: true,
  raw: "{}\n",
  defaultsVersion: 1,
  catalogVersion: 1,
  aliases: { fast: { providerId: "example", modelId: "model-a" } },
  effective: { defaultsVersion: 1, aliases: [], errors: [] },
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

  it("uses registered setting semantics and shows restart-required state", async () => {
    const executeSettings = vi.fn(async (command: any) =>
      command.command === "query"
        ? settingsResult()
        : { ...settingsResult(4000, 3000), outcome: "applied" as const },
    );
    await render(createFakeDesktopApi({ control: { executeSettings } }));
    await click("Network");

    const input = container.querySelector('input[aria-label="Gateway port"]');
    if (!(input instanceof HTMLInputElement)) throw new Error("Gateway port input missing");
    setInputValue(input, "4000");
    await click("Save network");
    expect(executeSettings).toHaveBeenLastCalledWith({
      command: "set",
      key: "server.port",
      value: 4000,
    });
    expect(container.textContent).toContain("Restart required");
  });

  it("keeps routing drafts local and preserves alias/model CAS revisions", async () => {
    const executeAliases = vi
      .fn()
      .mockResolvedValueOnce({ outcome: "ok", state: aliasesState(4) })
      .mockResolvedValueOnce({ outcome: "conflict", state: aliasesState(5) });
    const executeModels = vi
      .fn()
      .mockResolvedValueOnce({ outcome: "ok", state: modelsState(7) })
      .mockResolvedValueOnce({ outcome: "ok", state: modelsState(8) });
    await render(
      createFakeDesktopApi({ control: { executeAliases, executeModels } }),
    );
    await click("Routing");

    const aliasDraft = container.querySelector('textarea[aria-label="Alias mappings"]');
    if (!(aliasDraft instanceof HTMLTextAreaElement)) throw new Error("Alias draft missing");
    setTextareaValue(
      aliasDraft,
      '{"fast":{"providerId":"example","modelId":"model-b"}}',
    );
    await click("Save aliases");
    expect(executeAliases).toHaveBeenLastCalledWith({
      command: "write",
      revision: 4,
      aliases: { fast: { providerId: "example", modelId: "model-b" } },
    });
    expect(container.textContent).toContain("Changed elsewhere");

    const modelDraft = container.querySelector('textarea[aria-label="Raw model configuration"]');
    if (!(modelDraft instanceof HTMLTextAreaElement)) throw new Error("Model draft missing");
    setTextareaValue(modelDraft, '{"providers":{}}');
    await click("Save models");
    expect(executeModels).toHaveBeenLastCalledWith({
      command: "write_raw",
      revision: 7,
      content: '{"providers":{}}',
    });
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

  it("keeps deep diagnostics and diagnostic query behind typed Backend capabilities", async () => {
    const executeSettings = vi.fn(async (command: any) =>
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
