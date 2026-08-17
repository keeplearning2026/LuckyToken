// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { afterEach, describe, expect, it } from "vitest";

import { App } from "../src/App.js";
import type { ControlPlaneState } from "../src/control-plane-projection.js";
import type {
  DesktopShellSnapshot,
  WindowsShellHost,
} from "../src/shell-lifecycle.js";

function connected(): ControlPlaneState {
  return {
    revision: 1,
    kind: "connected",
    applicationVersion: "test",
    contractVersion: 1,
    sequence: 1,
    modelDataPlane: "running",
    provider: "configured",
    modelsResult: {
      outcome: "ok",
      state: {
        revision: 0,
        path: "C:\\models.json",
        present: false,
        valid: false,
        raw: "",
      },
    },
  };
}

describe("Codex integration on Models & Aliases", () => {
  let container: HTMLElement;
  let root: Root;

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("queries and renders the local Codex integration when the page opens", async () => {
    const codexCommands: unknown[] = [];
    let snapshot: DesktopShellSnapshot = {
      lifecycle: "open",
      activePage: "models-aliases",
      connection: connected(),
    };
    const shell = {
      snapshot: () => snapshot,
      launch: async () => snapshot,
      subscribe: () => () => undefined,
      dispose: async () => undefined,
      navigate: (page: DesktopShellSnapshot["activePage"]) => {
        snapshot = { ...snapshot, activePage: page };
        return snapshot;
      },
      getAutoStartStatus: async () => ({ enabled: false }),
      executeCodexIntegrationCommand: async (command: unknown) => {
        codexCommands.push(command);
        return {
          state: {
            desiredEnabled: false,
            observedState: "native",
            codexHome: "C:\\Users\\user\\.codex",
            configPath: "C:\\Users\\user\\.codex\\config.toml",
            catalogPath: "C:\\Users\\user\\.luckytoken\\integrations\\codex\\model-catalog.json",
            endpoint: "http://127.0.0.1:3000/v1",
            modelCount: 8,
            warnings: [],
            restartRequired: false,
          },
        };
      },
      executeModelsCommand: async () => snapshot,
      executeCatalogCommand: async () => ({
        outcome: "ok",
        snapshot: {
          version: 1,
          modelsJsonValid: true,
          providers: [],
          refreshErrors: [],
        },
      }),
      executeAliasCommand: async () => ({
        outcome: "ok",
        state: {
          revision: 0,
          path: "C:\\model-aliases.json",
          present: false,
          valid: false,
          raw: "",
          defaultsVersion: 1,
          catalogVersion: 1,
          effective: { defaultsVersion: 1, aliases: [], errors: [] },
        },
      }),
    } as unknown as WindowsShellHost;

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<App shell={shell} retryConnection={async () => connected()} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(codexCommands).toEqual([{ command: "query" }]);
    expect(container.textContent).toContain("Native Codex request support");
    expect(container.textContent).toContain("Route local Codex through LuckyToken");
  });

  it("applies the authoritative managed state returned after the user enables routing", async () => {
    const codexCommands: unknown[] = [];
    let snapshot: DesktopShellSnapshot = {
      lifecycle: "open",
      activePage: "models-aliases",
      connection: connected(),
    };
    const nativeState = {
      desiredEnabled: false,
      observedState: "native" as const,
      codexHome: "C:\\Users\\user\\.codex",
      configPath: "C:\\Users\\user\\.codex\\config.toml",
      catalogPath: "C:\\Users\\user\\.luckytoken\\integrations\\codex\\model-catalog.json",
      endpoint: "http://127.0.0.1:3000/v1",
      modelCount: 8,
      warnings: [],
      restartRequired: false,
    };
    const managedState = {
      ...nativeState,
      desiredEnabled: true,
      observedState: "managed" as const,
      restartRequired: true,
    };
    const shell = {
      snapshot: () => snapshot,
      launch: async () => snapshot,
      subscribe: () => () => undefined,
      dispose: async () => undefined,
      navigate: (page: DesktopShellSnapshot["activePage"]) => {
        snapshot = { ...snapshot, activePage: page };
        return snapshot;
      },
      getAutoStartStatus: async () => ({ enabled: false }),
      executeCodexIntegrationCommand: async (command: { command: string }) => {
        codexCommands.push(command);
        return { state: command.command === "query" ? nativeState : managedState };
      },
      executeModelsCommand: async () => snapshot,
      executeCatalogCommand: async () => ({
        outcome: "ok",
        snapshot: { version: 1, modelsJsonValid: true, providers: [], refreshErrors: [] },
      }),
      executeAliasCommand: async () => ({
        outcome: "ok",
        state: {
          revision: 0,
          path: "C:\\model-aliases.json",
          present: false,
          valid: false,
          raw: "",
          defaultsVersion: 1,
          catalogVersion: 1,
          effective: { defaultsVersion: 1, aliases: [], errors: [] },
        },
      }),
    } as unknown as WindowsShellHost;

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<App shell={shell} retryConnection={async () => connected()} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const toggle = container.querySelector<HTMLInputElement>("input[type=checkbox]");
    if (toggle === null) throw new Error("Codex integration toggle not found");

    await act(async () => {
      toggle.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(codexCommands).toEqual([
      { command: "query" },
      { command: "set_enabled", enabled: true },
    ]);
    expect(toggle.checked).toBe(true);
    expect(container.textContent).toContain("Managed by LuckyToken");
  });

  it("applies the authoritative catalog state returned after Sync Models", async () => {
    const codexCommands: unknown[] = [];
    let snapshot: DesktopShellSnapshot = {
      lifecycle: "open",
      activePage: "models-aliases",
      connection: connected(),
    };
    const managed = {
      desiredEnabled: true,
      observedState: "managed" as const,
      codexHome: "C:\\Users\\user\\.codex",
      configPath: "C:\\Users\\user\\.codex\\config.toml",
      catalogPath: "C:\\Users\\user\\.luckytoken\\integrations\\codex\\model-catalog.json",
      endpoint: "http://127.0.0.1:3000/v1",
      modelCount: 8,
      warnings: [],
      restartRequired: false,
    };
    const synced = {
      ...managed,
      modelCount: 12,
      restartRequired: true,
    };
    const shell = {
      snapshot: () => snapshot,
      launch: async () => snapshot,
      subscribe: () => () => undefined,
      dispose: async () => undefined,
      navigate: (page: DesktopShellSnapshot["activePage"]) => {
        snapshot = { ...snapshot, activePage: page };
        return snapshot;
      },
      getAutoStartStatus: async () => ({ enabled: false }),
      executeCodexIntegrationCommand: async (command: { command: string }) => {
        codexCommands.push(command);
        return { state: command.command === "sync_catalog" ? synced : managed };
      },
      executeModelsCommand: async () => snapshot,
      executeCatalogCommand: async () => ({
        outcome: "ok",
        snapshot: { version: 1, modelsJsonValid: true, providers: [], refreshErrors: [] },
      }),
      executeAliasCommand: async () => ({
        outcome: "ok",
        state: {
          revision: 0,
          path: "C:\\model-aliases.json",
          present: false,
          valid: false,
          raw: "",
          defaultsVersion: 1,
          catalogVersion: 1,
          effective: { defaultsVersion: 1, aliases: [], errors: [] },
        },
      }),
    } as unknown as WindowsShellHost;

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<App shell={shell} retryConnection={async () => connected()} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const sync = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Sync Models",
    );
    if (sync === undefined) throw new Error("Sync Models action not found");

    await act(async () => {
      sync.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(codexCommands).toEqual([
      { command: "query" },
      { command: "sync_catalog" },
    ]);
    expect(container.textContent).toContain("12");
  });
});
