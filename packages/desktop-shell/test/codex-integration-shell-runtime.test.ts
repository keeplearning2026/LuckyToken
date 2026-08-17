import { describe, expect, it } from "vitest";

import {
  createTauriDesktopRuntime,
  type NativeTauriBridge,
} from "../src/tauri-shell-runtime.js";

describe("Tauri Codex integration runtime", () => {
  it("queries the managed Codex integration through the native bridge", async () => {
    const calls: string[] = [];
    const bridge: NativeTauriBridge = {
      listen: async () => () => undefined,
      invoke: async (command) => {
        calls.push(command);
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
    };
    const runtime = createTauriDesktopRuntime(bridge);

    const result = await runtime.executeCodexIntegrationCommand({ command: "query" });

    expect(calls).toEqual(["shell_codex_integration_query"]);
    expect(result.state).toMatchObject({
      desiredEnabled: false,
      observedState: "native",
      endpoint: "http://127.0.0.1:3000/v1",
      modelCount: 8,
    });
  });

  it("sets the desired Codex integration state through the native bridge", async () => {
    const calls: Array<{ command: string; args?: unknown }> = [];
    const bridge: NativeTauriBridge = {
      listen: async () => () => undefined,
      invoke: async (command, args) => {
        calls.push({ command, args });
        return {
          state: {
            desiredEnabled: true,
            observedState: "managed",
            codexHome: "C:\\Users\\user\\.codex",
            configPath: "C:\\Users\\user\\.codex\\config.toml",
            catalogPath: "C:\\Users\\user\\.luckytoken\\integrations\\codex\\model-catalog.json",
            endpoint: "http://127.0.0.1:3000/v1",
            modelCount: 8,
            warnings: [],
            restartRequired: true,
          },
        };
      },
    };
    const runtime = createTauriDesktopRuntime(bridge);

    const result = await runtime.executeCodexIntegrationCommand({
      command: "set_enabled",
      enabled: true,
    });

    expect(calls).toEqual([
      {
        command: "shell_codex_integration_set_enabled",
        args: { enabled: true },
      },
    ]);
    expect(result.state).toMatchObject({
      desiredEnabled: true,
      observedState: "managed",
      restartRequired: true,
    });
  });

  it("syncs the managed Codex model catalog through the native bridge", async () => {
    const calls: string[] = [];
    const bridge: NativeTauriBridge = {
      listen: async () => () => undefined,
      invoke: async (command) => {
        calls.push(command);
        return {
          state: {
            desiredEnabled: true,
            observedState: "managed",
            codexHome: "C:\\Users\\user\\.codex",
            configPath: "C:\\Users\\user\\.codex\\config.toml",
            catalogPath: "C:\\Users\\user\\.luckytoken\\integrations\\codex\\model-catalog.json",
            endpoint: "http://127.0.0.1:3000/v1",
            modelCount: 11,
            warnings: [],
            restartRequired: true,
          },
        };
      },
    };
    const runtime = createTauriDesktopRuntime(bridge);

    const result = await runtime.executeCodexIntegrationCommand({
      command: "sync_catalog",
    });

    expect(calls).toEqual(["shell_codex_integration_sync_catalog"]);
    expect(result.state.modelCount).toBe(11);
    expect(result.state.restartRequired).toBe(true);
  });
});
