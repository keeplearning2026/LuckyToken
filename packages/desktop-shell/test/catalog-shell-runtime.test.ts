import { describe, expect, it } from "vitest";

import {
  createTauriDesktopRuntime,
  type NativeTauriBridge,
} from "../src/tauri-shell-runtime.js";

/**
 * Ticket 11 desktop runtime seam: catalog commands route through the native
 * bridge and their results (one authoritative snapshot + bounded manual
 * refresh report) are decoded strictly on the renderer side.
 */
describe("Tauri catalog runtime commands", () => {
  function snapshotFixture(version: number) {
    return {
      version,
      modelsJsonValid: true,
      providers: [
        {
          providerId: "dynamic-a",
          name: "dynamic-a",
          dynamic: true,
          state: "succeeded",
          refreshedAt: 1_700_000_000_000,
          models: [
            { id: "fresh-model", dynamic: true, availability: "available" },
          ],
        },
      ],
      refreshErrors: [],
    };
  }

  it("routes catalog queries and background/manual refreshes with strict decoding", async () => {
    const calls: Array<{ command: string; args?: unknown }> = [];
    const bridge: NativeTauriBridge = {
      listen: async () => () => undefined,
      invoke: async (command, args) => {
        calls.push({ command, args });
        if (command === "shell_catalog_query") {
          return { outcome: "ok", snapshot: snapshotFixture(2) };
        }
        if (command === "shell_catalog_refresh" && (args as { mode?: string } | undefined)?.mode === "background") {
          return { outcome: "scheduled", snapshot: snapshotFixture(3) };
        }
        return {
          outcome: "ok",
          snapshot: snapshotFixture(4),
          refresh: {
            trigger: "manual",
            startedAt: 1,
            finishedAt: 2,
            providers: [
              { providerId: "dynamic-a", outcome: "succeeded" },
            ],
          },
        };
      },
    };
    const runtime = createTauriDesktopRuntime(bridge);

    const query = await runtime.executeCatalogCommand({ command: "query" });
    expect(query.outcome).toBe("ok");
    expect(query.snapshot.version).toBe(2);
    expect(query.refresh).toBeUndefined();

    const background = await runtime.executeCatalogCommand({
      command: "refresh",
      mode: "background",
    });
    expect(background.outcome).toBe("scheduled");

    const manual = await runtime.executeCatalogCommand({
      command: "refresh",
      mode: "manual",
    });
    expect(manual.outcome).toBe("ok");
    expect(manual.refresh?.providers[0]?.outcome).toBe("succeeded");

    expect(calls.map((call) => call.command)).toEqual([
      "shell_catalog_query",
      "shell_catalog_refresh",
      "shell_catalog_refresh",
    ]);
    expect(calls[1]?.args).toEqual({ mode: "background" });
    expect(calls[2]?.args).toEqual({ mode: "manual" });
  });

  it("rejects a malformed catalog command result", async () => {
    const bridge: NativeTauriBridge = {
      listen: async () => () => undefined,
      invoke: async () => ({
        outcome: "ok",
        snapshot: { version: 1, modelsJsonValid: true, providers: [], refreshErrors: [] },
        refresh: { trigger: "manual", startedAt: 1, finishedAt: 2, providers: [] },
      }),
    };
    // The refresh report is valid here; make the snapshot invalid instead.
    const bridgeInvalid: NativeTauriBridge = {
      ...bridge,
      invoke: async () => ({
        outcome: "ok",
        snapshot: {
          version: "not-a-number",
          modelsJsonValid: true,
          providers: [],
          refreshErrors: [],
        },
      }),
    };
    const runtime = createTauriDesktopRuntime(bridgeInvalid);
    await expect(
      runtime.executeCatalogCommand({ command: "query" }),
    ).rejects.toThrow(/invalid catalog result/u);
  });
});
