import { describe, expect, it } from "vitest";

import {
  createTauriDesktopRuntime,
  type NativeTauriBridge,
} from "../src/tauri-shell-runtime.js";
import type { ControlPlaneBridgePayload } from "../src/control-plane-projection.js";

describe("Tauri shell runtime public adapter seam", () => {
  it("listens before snapshot and ignores a stale snapshot revision", async () => {
    const calls: Array<{ readonly command: string; readonly args?: unknown }> = [];
    let listener: ((event: { readonly payload: ControlPlaneBridgePayload }) => void) | undefined;
    let unlistened = 0;
    const bridge: NativeTauriBridge = {
      listen: async (event, next) => {
        expect(event).toBe("luckytoken://shell-state");
        listener = next;
        return () => {
          unlistened += 1;
        };
      },
      invoke: async (command, args) => {
        calls.push({ command, ...(args === undefined ? {} : { args }) });
        listener?.({
          payload: {
            revision: 2,
            connection: "disconnected",
            reason: "transport_lost",
            capability: "event-secret",
          },
        });
        return {
          revision: 1,
          connection: "unavailable",
          reason: "descriptor_missing",
          capability: "snapshot-secret",
        };
      },
    };
    const runtime = createTauriDesktopRuntime(bridge);

    const state = await runtime.connectControlPlane();
    await runtime.disconnectControlPlane();

    expect(state).toMatchObject({
      revision: 2,
      kind: "error",
      code: "transport_lost",
    });
    expect(calls).toEqual([{ command: "shell_snapshot" }]);
    expect(JSON.stringify(state)).not.toMatch(/capability|secret/u);
    expect(unlistened).toBe(1);
  });

  it("maps runtime lifecycle commands to no-argument native commands", async () => {
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
            modelDataPlane:
              command === "shell_stop" ? "stopped" : "running",
            provider: "unconfigured",
            dataPlane: {
              configuredOrigin: "http://127.0.0.1:3000",
              configuredPort: 3000,
            },
          },
        };
      },
    };
    const runtime = createTauriDesktopRuntime(bridge);

    await runtime.executeRuntimeCommand("start");
    await runtime.executeRuntimeCommand("stop");
    await runtime.executeRuntimeCommand("restart");

    expect(calls).toEqual(["shell_start", "shell_stop", "shell_restart"]);
  });
});

describe("Tauri client token commands and Dashboard warnings", () => {
  it("routes client token commands with their args and decodes masked results", async () => {
    const calls: unknown[] = [];
    const bridge: NativeTauriBridge = {
      listen: async () => () => undefined,
      invoke: async (command, args) => {
        calls.push({ command, args });
        if (command === "shell_client_tokens_list") {
          return {
            outcome: "ok",
            revision: 3,
            scopes: [
              { type: "global", maskedToken: "lt_abc1…wxyz" },
              {
                type: "project",
                projectDir: "C:\project",
                maskedToken: "proj-t…oken",
              },
            ],
          };
        }
        if (command === "shell_client_tokens_reveal") {
          return { outcome: "ok", revision: 3, token: "lt_full_secret_value" };
        }
        if (command === "shell_client_tokens_rotate") {
          return {
            outcome: "ok",
            revision: 4,
            scopes: [{ type: "global", maskedToken: "lt_new1…abcd" }],
          };
        }
        if (command === "shell_client_tokens_remove") {
          return { outcome: "ok", revision: 4, scopes: [] };
        }
        return [];
      },
    };
    const runtime = createTauriDesktopRuntime(bridge);

    const listed = await runtime.executeClientTokenCommand({
      command: "list",
      protocolId: "anthropic-messages",
    });
    expect(listed).toEqual({
      outcome: "ok",
      revision: 3,
      scopes: [
        { type: "global", maskedToken: "lt_abc1…wxyz" },
        {
          type: "project",
          projectDir: "C:\project",
          maskedToken: "proj-t…oken",
        },
      ],
    });
    const revealed = await runtime.executeClientTokenCommand({
      command: "reveal",
      protocolId: "anthropic-messages",
    });
    expect(revealed).toEqual({
      outcome: "ok",
      revision: 3,
      token: "lt_full_secret_value",
    });
    const rotated = await runtime.executeClientTokenCommand({
      command: "rotate",
      protocolId: "openai-responses",
      expectedRevision: 3,
      token: "explicit-replacement",
    });
    expect(rotated.outcome).toBe("ok");
    const removed = await runtime.executeClientTokenCommand({
      command: "remove",
      protocolId: "openai-responses",
      expectedRevision: 4,
    });
    expect(removed.outcome).toBe("ok");

    expect(calls).toEqual([
      {
        command: "shell_client_tokens_list",
        args: { protocolId: "anthropic-messages" },
      },
      {
        command: "shell_client_tokens_reveal",
        args: { protocolId: "anthropic-messages" },
      },
      {
        command: "shell_client_tokens_rotate",
        args: {
          protocolId: "openai-responses",
          expectedRevision: 3,
          token: "explicit-replacement",
        },
      },
      {
        command: "shell_client_tokens_remove",
        args: { protocolId: "openai-responses", expectedRevision: 4 },
      },
    ]);
  });

  it("rejects malformed results where a raw token reaches a masked field", async () => {
    const bridge: NativeTauriBridge = {
      listen: async () => () => undefined,
      invoke: async () => ({
        outcome: "ok",
        revision: 1,
        scopes: [{ type: "global", maskedToken: "lt_raw_unmasked_secret" }],
      }),
    };
    const runtime = createTauriDesktopRuntime(bridge);

    await expect(
      runtime.executeClientTokenCommand({
        command: "list",
        protocolId: "anthropic-messages",
      }),
    ).rejects.toThrow("invalid client token result");
  });

  it("queries sanitized Dashboard warnings and decodes only safe fields", async () => {
    const calls: string[] = [];
    const bridge: NativeTauriBridge = {
      listen: async () => () => undefined,
      invoke: async (command) => {
        calls.push(command);
        return [
          {
            id: 12,
            level: "warning",
            time: 1700000000000,
            text: "Anthropic Messages has no active client token",
            details: { raw: "canary-shell-secret-77" },
          },
        ];
      },
    };
    const runtime = createTauriDesktopRuntime(bridge);

    const warnings = await runtime.queryDiagnosticsWarnings();
    expect(calls).toEqual(["shell_diagnostics_warnings"]);
    expect(warnings).toEqual([
      {
        id: 12,
        level: "warning",
        time: 1700000000000,
        text: "Anthropic Messages has no active client token",
      },
    ]);
    expect(JSON.stringify(warnings)).not.toContain("canary-shell-secret-77");
    expect(JSON.stringify(warnings)).not.toContain("details");
  });
});
