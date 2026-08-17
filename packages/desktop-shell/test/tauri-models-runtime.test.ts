import { describe, expect, it } from "vitest";

import {
  createTauriDesktopRuntime,
  type NativeTauriBridge,
} from "../src/tauri-shell-runtime.js";

/**
 * Ticket 08 desktop runtime seam: models commands route through the native
 * bridge with their revisions and the full result sticks on the state until
 * a newer one arrives.
 */
describe("Tauri models runtime commands", () => {
  const catalogFixture = {
    schemaVersion: "luckytoken-effective-catalog-v1",
    baseline: {
      package: "@earendil-works/pi-coding-agent",
      version: "0.84.1",
      schema: "pi-coding-agent-0.84.1-models-json-schema",
    },
    providers: [],
    compositionErrors: [],
  };

  function connectedPayload(
    revision: number,
    extra: Record<string, unknown> = {},
  ) {
    return {
      revision,
      connection: "connected",
      applicationVersion: "test",
      contractVersion: 1,
      snapshot: {
        sequence: revision,
        modelDataPlane: "stopped",
        provider: "unconfigured",
      },
      ...extra,
    };
  }

  it("routes models commands to native commands with revisions and projects results", async () => {
    const calls: Array<{ command: string; args?: unknown }> = [];
    const bridge: NativeTauriBridge = {
      listen: async () => () => undefined,
      invoke: async (command, args) => {
        calls.push({ command, args });
        const raw = '{ "providers": { "ollama": { "baseUrl": "http://x" } } }';
        return connectedPayload(calls.length, {
          models: {
            outcome: "ok",
            state: {
              revision: calls.length,
              path: "C:\\models.json",
              present: true,
              valid: true,
              raw,
              providers: { ollama: { baseUrl: "http://x" } },
              catalog: catalogFixture,
            },
          },
        });
      },
    };
    const runtime = createTauriDesktopRuntime(bridge);

    const queryState = await runtime.executeModelsCommand({ command: "query" });
    const writeState = await runtime.executeModelsCommand({
      command: "write_raw",
      revision: 1,
      content: '{ "providers": {} }',
    });
    const structuredState = await runtime.executeModelsCommand({
      command: "write_structured",
      revision: 2,
      providers: { ollama: { baseUrl: "http://x" } },
    });

    expect(calls.map((call) => call.command)).toEqual([
      "shell_models_query",
      "shell_models_write_raw",
      "shell_models_write_structured",
    ]);
    expect(calls[1]?.args).toEqual({ revision: 1, content: '{ "providers": {} }' });
    expect(calls[2]?.args).toEqual({
      revision: 2,
      providers: { ollama: { baseUrl: "http://x" } },
    });
    expect(queryState.kind).toBe("connected");
    if (queryState.kind !== "connected") return;
    expect(queryState.modelsResult?.state.revision).toBe(1);
    expect(queryState.modelsResult?.state.providers).toEqual({
      ollama: { baseUrl: "http://x" },
    });
    expect(writeState.kind).toBe("connected");
    if (writeState.kind !== "connected") return;
    expect(writeState.modelsResult?.state.revision).toBe(2);
    expect(structuredState.kind).toBe("connected");
    if (structuredState.kind !== "connected") return;
    expect(structuredState.modelsResult?.state.revision).toBe(3);
  });

  it("keeps the last models result across status events that carry none", async () => {
    const bridge: NativeTauriBridge = {
      listen: async () => () => undefined,
      invoke: async (command) => {
        if (command === "shell_models_query") {
          return connectedPayload(1, {
            models: {
              outcome: "ok",
              state: {
                revision: 0,
                path: "C:\\models.json",
                present: true,
                valid: true,
                raw: "raw-content",
                providers: {},
                catalog: catalogFixture,
              },
            },
          });
        }
        if (command === "shell_retry") {
          // A plain status event stream payload without models.
          return connectedPayload(2);
        }
        return connectedPayload(3);
      },
    };
    const runtime = createTauriDesktopRuntime(bridge);

    const first = await runtime.executeModelsCommand({ command: "query" });
    expect(first.kind).toBe("connected");
    if (first.kind !== "connected") return;
    expect(first.modelsResult?.state.raw).toBe("raw-content");

    // A status-only payload (no models) must not wipe the editors' data.
    const second = await runtime.retryControlPlane();
    expect(second.kind).toBe("connected");
    if (second.kind !== "connected") return;
    expect(second.modelsResult?.state.raw).toBe("raw-content");
    expect(second.modelsProjection).toBeUndefined();
  });
});
