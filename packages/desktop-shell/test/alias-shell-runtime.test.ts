import { describe, expect, it } from "vitest";

import {
  createTauriDesktopRuntime,
  type NativeTauriBridge,
} from "../src/tauri-shell-runtime.js";

/**
 * Ticket 14 desktop runtime seam: alias commands route through the native
 * bridge (thin allowlisted transport) and their results (the authoritative
 * model-aliases.json state + effective registry) are decoded strictly on
 * the renderer side; malformed results are rejected.
 */
describe("Tauri alias runtime commands", () => {
  function stateFixture(revision: number) {
    return {
      revision,
      path: "C:\\model-aliases.json",
      present: true,
      valid: true,
      raw: "{}\n",
      defaultsVersion: 1,
      catalogVersion: 3,
      aliases: { "my-gpt": { provider: "openai", model: "gpt-4o" } },
      effective: {
        defaultsVersion: 1,
        aliases: [
          {
            alias: "my-gpt",
            target: { provider: "openai", model: "gpt-4o" },
            layer: "user",
          },
          {
            alias: "gpt-4o",
            target: { provider: "openai", model: "gpt-4o-mini" },
            layer: "default",
          },
        ],
        errors: [],
      },
    };
  }

  it("routes alias queries and writes with strict decoding", async () => {
    const calls: Array<{ command: string; args?: unknown }> = [];
    const bridge: NativeTauriBridge = {
      listen: async () => () => undefined,
      invoke: async (command, args) => {
        calls.push({ command, args });
        if (command === "shell_aliases_query") {
          return { outcome: "ok", state: stateFixture(2) };
        }
        return { outcome: "ok", state: stateFixture(3) };
      },
    };
    const runtime = createTauriDesktopRuntime(bridge);

    const query = await runtime.executeAliasCommand({ command: "query" });
    expect(query.outcome).toBe("ok");
    expect(query.state.revision).toBe(2);
    expect(query.state.effective?.aliases[0]).toMatchObject({
      alias: "my-gpt",
      layer: "user",
    });

    const write = await runtime.executeAliasCommand({
      command: "write",
      revision: 2,
      aliases: { "my-gpt": { provider: "openai", model: "gpt-4o" } },
    });
    expect(write.outcome).toBe("ok");
    expect(write.state.revision).toBe(3);

    expect(calls.map((call) => call.command)).toEqual([
      "shell_aliases_query",
      "shell_aliases_write",
    ]);
    expect(calls[1]?.args).toEqual({
      revision: 2,
      aliases: { "my-gpt": { provider: "openai", model: "gpt-4o" } },
    });
  });

  it("rejects a malformed alias command result", async () => {
    const bridge: NativeTauriBridge = {
      listen: async () => () => undefined,
      invoke: async () => ({
        outcome: "ok",
        state: {
          revision: "not-a-number",
          path: "C:\\model-aliases.json",
          present: true,
          valid: true,
          raw: "",
          defaultsVersion: 1,
          catalogVersion: 3,
          aliases: {},
          effective: { defaultsVersion: 1, aliases: [], errors: [] },
        },
      }),
    };
    const runtime = createTauriDesktopRuntime(bridge);
    await expect(
      runtime.executeAliasCommand({ command: "query" }),
    ).rejects.toThrow(/invalid alias result/u);
  });

  it("rejects an alias result missing the effective registry", async () => {
    const bridge: NativeTauriBridge = {
      listen: async () => () => undefined,
      invoke: async () => ({
        outcome: "ok",
        state: {
          revision: 1,
          path: "C:\\model-aliases.json",
          present: false,
          valid: false,
          raw: "",
          defaultsVersion: 1,
          catalogVersion: 3,
        },
      }),
    };
    const runtime = createTauriDesktopRuntime(bridge);
    await expect(
      runtime.executeAliasCommand({ command: "query" }),
    ).rejects.toThrow(/invalid alias result/u);
  });

  it("forwards the sanitized aliases projection from status snapshots", async () => {
    const bridge: NativeTauriBridge = {
      listen: async () => () => undefined,
      invoke: async () => ({
        revision: 1,
        connection: "connected",
        applicationVersion: "0.0.0-test",
        contractVersion: 1,
        snapshot: {
          sequence: 0,
          modelDataPlane: "stopped",
          provider: "unconfigured",
          aliases: {
            revision: 2,
            path: "C:\\model-aliases.json",
            present: true,
            valid: true,
            defaultsVersion: 1,
          },
        },
      }),
    };
    const runtime = createTauriDesktopRuntime(bridge);
    const state = await runtime.connectControlPlane();
    expect(state.kind).toBe("connected");
    if (state.kind !== "connected") return;
    expect(state.aliasesProjection?.revision).toBe(2);
    expect(state.aliasesProjection?.defaultsVersion).toBe(1);
  });
});
