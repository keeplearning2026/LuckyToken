// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/renderer/app/App.js";
import { createFakeDesktopApi } from "./support/fake-desktop-api.js";

let container: HTMLDivElement;
let root: Root;

const status = (overrides: Record<string, unknown> = {}) => ({
  sequence: 1,
  modelDataPlane: "running" as const,
  provider: "configured" as const,
  ...overrides,
});

const codexState = (overrides: Record<string, unknown> = {}) => ({
  desiredEnabled: false,
  observedState: "native" as const,
  codexHome: "C:/Users/test/.codex",
  configPath: "C:/Users/test/.codex/config.toml",
  catalogPath: "C:/Users/test/.luckytoken/model-catalog.json",
  endpoint: "http://127.0.0.1:3000/v1",
  modelCount: 2,
  warnings: [] as readonly string[],
  restartRequired: false,
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
  await click("Connect");
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

describe("Connect product slice", () => {
  it("routes an unconfigured user to Providers instead of exposing integration internals", async () => {
    await render(
      createFakeDesktopApi({
        control: {
          getStatus: async () => status({ provider: "unconfigured" }),
          executeCodexIntegration: async () => ({ state: codexState() }),
        },
      }),
    );

    expect(container.textContent).toContain("Connect a provider first");
    expect(container.textContent).not.toContain("config.toml");
    await click("Open Providers");
    expect(container.querySelector("h1")?.textContent).toBe("Providers");
  });

  it("configures and synchronizes Codex through typed integration operations", async () => {
    const executeCodexIntegration = vi.fn(async (command: { command: string }) => {
      if (command.command === "query") return { state: codexState() };
      if (command.command === "set_enabled") {
        return {
          state: codexState({
            desiredEnabled: true,
            observedState: "managed",
            restartRequired: true,
          }),
        };
      }
      return {
        state: codexState({
          desiredEnabled: true,
          observedState: "managed",
          modelCount: 3,
          restartRequired: true,
        }),
      };
    });
    await render(
      createFakeDesktopApi({
        control: {
          getStatus: async () => status(),
          executeCodexIntegration,
        },
      }),
    );

    await click("Configure Codex");
    expect(executeCodexIntegration).toHaveBeenNthCalledWith(2, {
      command: "set_enabled",
      enabled: true,
    });
    expect(executeCodexIntegration).toHaveBeenNthCalledWith(3, {
      command: "sync_catalog",
    });
    expect(container.textContent).toContain("Codex is ready");
    expect(container.textContent).toContain("3 models");
    expect(container.textContent).toContain("Restart Codex");
  });

  it("shows authoritative conflicts and succeeds after a retry", async () => {
    let queryCount = 0;
    const executeCodexIntegration = vi.fn(async (command: { command: string }) => {
      if (command.command === "query") {
        queryCount += 1;
        return {
          state:
            queryCount === 1
              ? codexState({
                  observedState: "conflict",
                  message: "Codex already owns its routing configuration.",
                })
              : codexState({
                  desiredEnabled: true,
                  observedState: "managed",
                  restartRequired: false,
                }),
        };
      }
      return {
        state: codexState({
          desiredEnabled: true,
          observedState: "managed",
          restartRequired: false,
        }),
      };
    });
    await render(
      createFakeDesktopApi({
        control: {
          getStatus: async () => status(),
          executeCodexIntegration,
        },
      }),
    );

    expect(container.textContent).toContain("Codex already owns its routing configuration.");
    await click("Verify again");
    expect(container.textContent).toContain("Codex is ready");
  });

  it("keeps an unavailable configuration failure actionable and retryable", async () => {
    const executeCodexIntegration = vi.fn(async (command: { command: string }) => {
      if (command.command === "query") return { state: codexState() };
      return {
        state: codexState({
          observedState: "unavailable",
          message: "Local Codex authentication is unavailable; LuckyToken did not change Codex configuration.",
        }),
      };
    });
    await render(
      createFakeDesktopApi({
        control: {
          getStatus: async () => status(),
          executeCodexIntegration,
        },
      }),
    );

    await click("Configure Codex");
    expect(container.textContent).toContain("Local Codex authentication is unavailable");
    expect(container.textContent).toContain("Configure Codex");
  });
});
