import { describe, expect, it } from "vitest";

import {
  createTauriDesktopRuntime,
  type NativeTauriBridge,
} from "../src/tauri-shell-runtime.js";

describe("Tauri settings runtime commands", () => {
  it("routes settings commands to no-argument native commands and projects results", async () => {
    const calls: string[] = [];
    const bridge: NativeTauriBridge = {
      listen: async () => () => undefined,
      invoke: async (command) => {
        calls.push(command);
        return {
          revision: calls.length,
          connection: "connected",
          applicationVersion: "test",
          contractVersion: 1,
          snapshot: {
            sequence: calls.length,
            modelDataPlane: "stopped",
            provider: "unconfigured",
            settings: {
              "protocols.anthropic-messages.enabled": {
                key: "protocols.anthropic-messages.enabled",
                type: "boolean",
                default: true,
                validation: { type: "boolean" },
                sensitivity: "public",
                applyMode: "hot-apply",
                value: command === "shell_settings_set" ? false : true,
              },
            },
          },
        };
      },
    };
    const runtime = createTauriDesktopRuntime(bridge);

    const setState = await runtime.executeSettingsCommand({
      command: "set",
      key: "protocols.anthropic-messages.enabled",
      value: false,
    });
    const queryState = await runtime.executeSettingsCommand({
      command: "query",
      keys: ["protocols.anthropic-messages.enabled"],
    });

    expect(calls).toEqual(["shell_settings_set", "shell_settings_query"]);
    // The settings projection must reach the renderer through the live
    // bridge: the set result applies false, the query result keeps true.
    expect(setState.kind).toBe("connected");
    if (setState.kind !== "connected") return;
    expect(setState.settings?.["protocols.anthropic-messages.enabled"]?.value).toBe(
      false,
    );
    expect(queryState.kind).toBe("connected");
    if (queryState.kind !== "connected") return;
    expect(
      queryState.settings?.["protocols.anthropic-messages.enabled"]?.value,
    ).toBe(true);
  });
});
