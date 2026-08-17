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

  it("projects the headless owner identity from the live bridge snapshot", async () => {
    const bridge: NativeTauriBridge = {
      listen: async () => () => undefined,
      invoke: async () => ({
        revision: 3,
        connection: "connected",
        applicationVersion: "test",
        contractVersion: 1,
        snapshot: {
          sequence: 3,
          modelDataPlane: "running",
          provider: "unconfigured",
          ownership: {
            owner: {
              kind: "cli",
              pid: 4242,
              startedAt: "2026-08-15T12:00:00.000Z",
            },
          },
        },
      }),
    };
    const runtime = createTauriDesktopRuntime(bridge);

    const state = await runtime.connectControlPlane();

    expect(state).toMatchObject({
      kind: "connected",
      ownership: {
        owner: { kind: "cli", pid: 4242 },
      },
    });
  });

  it("rejects a bridge snapshot with a malformed owner identity", async () => {
    const bridge: NativeTauriBridge = {
      listen: async () => () => undefined,
      invoke: async () => ({
        revision: 4,
        connection: "connected",
        applicationVersion: "test",
        contractVersion: 1,
        snapshot: {
          sequence: 4,
          modelDataPlane: "running",
          provider: "unconfigured",
          ownership: {
            owner: { kind: "cli", pid: -5, startedAt: "nope" },
          },
        },
      }),
    };
    const runtime = createTauriDesktopRuntime(bridge);

    const state = await runtime.connectControlPlane();

    expect(state).toMatchObject({
      kind: "error",
      code: "protocol_error",
    });
  });

  it("queries and changes Windows login auto-start through native commands", async () => {
    const calls: string[] = [];
    const bridge: NativeTauriBridge = {
      listen: async () => () => undefined,
      invoke: async (command) => {
        calls.push(command);
        return { enabled: command !== "shell_auto_start_enable" };
      },
    };
    const runtime = createTauriDesktopRuntime(bridge);

    await expect(runtime.getAutoStartStatus()).resolves.toEqual({
      enabled: true,
    });
    await expect(runtime.setAutoStartEnabled(false)).resolves.toEqual({
      enabled: true,
    });
    await expect(runtime.setAutoStartEnabled(true)).resolves.toEqual({
      enabled: false,
    });

    expect(calls).toEqual([
      "shell_auto_start_status",
      "shell_auto_start_disable",
      "shell_auto_start_enable",
    ]);
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

describe("Tauri directory-scoped client token commands, picker, and request identities (Ticket 17)", () => {
  it("routes create and scope-carrying commands to the native bridge", async () => {
    const calls: Array<{ readonly command: string; readonly args?: unknown }> = [];
    const bridge: NativeTauriBridge = {
      listen: async () => () => undefined,
      invoke: async (command, args) => {
        calls.push({ command, ...(args === undefined ? {} : { args }) });
        if (command === "shell_client_tokens_create") {
          return {
            outcome: "ok",
            revision: 1,
            scopes: [
              {
                type: "project",
                projectDir: "C:\\canonical\\project",
                maskedToken: "canary-d\u2026n-77",
              },
            ],
          };
        }
        if (command === "shell_client_tokens_reveal") {
          return { outcome: "ok", revision: 1, token: "canary-token-1" };
        }
        return {
          outcome: "ok",
          revision: 1,
          scopes: [
            {
              type: "project",
              projectDir: "C:\\canonical\\project",
              maskedToken: "canary-d\u2026n-77",
            },
          ],
        };
      },
    };
    const runtime = createTauriDesktopRuntime(bridge);

    const created = await runtime.executeClientTokenCommand({
      command: "create",
      protocolId: "anthropic-messages",
      scope: { type: "project", projectDir: "C:\\picked\\path" },
      token: "canary-token-1",
    });
    expect(created).toMatchObject({ outcome: "ok" });
    const revealed = await runtime.executeClientTokenCommand({
      command: "reveal",
      protocolId: "anthropic-messages",
      scope: { type: "project", projectDir: "C:\\picked\\path" },
    });
    expect(revealed).toMatchObject({ outcome: "ok", token: "canary-token-1" });
    await runtime.executeClientTokenCommand({
      command: "rotate",
      protocolId: "anthropic-messages",
      expectedRevision: 1,
      scope: { type: "project", projectDir: "C:\\picked\\path" },
    });
    await runtime.executeClientTokenCommand({
      command: "remove",
      protocolId: "anthropic-messages",
      expectedRevision: 1,
      scope: { type: "project", projectDir: "C:\\picked\\path" },
    });

    expect(calls).toEqual([
      {
        command: "shell_client_tokens_create",
        args: {
          protocolId: "anthropic-messages",
          scope: { type: "project", projectDir: "C:\\picked\\path" },
          token: "canary-token-1",
        },
      },
      {
        command: "shell_client_tokens_reveal",
        args: {
          protocolId: "anthropic-messages",
          scope: { type: "project", projectDir: "C:\\picked\\path" },
        },
      },
      {
        command: "shell_client_tokens_rotate",
        args: {
          protocolId: "anthropic-messages",
          expectedRevision: 1,
          scope: { type: "project", projectDir: "C:\\picked\\path" },
        },
      },
      {
        command: "shell_client_tokens_remove",
        args: {
          protocolId: "anthropic-messages",
          expectedRevision: 1,
          scope: { type: "project", projectDir: "C:\\picked\\path" },
        },
      },
    ]);
  });

  it("decodes invalid_directory results with their value-free reason", async () => {
    const bridge: NativeTauriBridge = {
      listen: async () => () => undefined,
      invoke: async () => ({
        outcome: "invalid_directory",
        revision: 3,
        reason: "not_found",
        error: "Selected directory is not usable as a client token scope",
      }),
    };
    const runtime = createTauriDesktopRuntime(bridge);
    const result = await runtime.executeClientTokenCommand({
      command: "create",
      protocolId: "anthropic-messages",
      scope: { type: "project", projectDir: "C:\\missing" },
    });
    expect(result).toEqual({
      outcome: "invalid_directory",
      revision: 3,
      reason: "not_found",
      error: "Selected directory is not usable as a client token scope",
    });
  });

  it("returns the native picker result or undefined on cancel", async () => {
    const calls: string[] = [];
    let pick = 0;
    const bridge: NativeTauriBridge = {
      listen: async () => () => undefined,
      invoke: async (command) => {
        calls.push(command);
        pick += 1;
        return command === "shell_pick_directory" && pick === 1
          ? "C:\\picked\\directory"
          : null;
      },
    };
    const runtime = createTauriDesktopRuntime(bridge);
    await expect(runtime.pickDirectory()).resolves.toBe("C:\\picked\\directory");
    await expect(runtime.pickDirectory()).resolves.toBeUndefined();
    expect(calls).toEqual(["shell_pick_directory", "shell_pick_directory"]);
  });

  it("queries request identities and rejects records carrying the effective session id", async () => {
    let attempt = 0;
    const bridge: NativeTauriBridge = {
      listen: async () => () => undefined,
      invoke: async () => {
        attempt += 1;
        if (attempt === 1) {
          return {
            records: [
              {
                id: 2,
                time: 1700000000000,
                protocolId: "anthropic-messages",
                clientSessionId: "11111111-1111-4111-8111-111111111111",
              },
              {
                id: 1,
                time: 1699999999999,
                protocolId: "openai-responses",
              },
            ],
          };
        }
        return {
          records: [
            {
              id: 3,
              time: 1700000000000,
              protocolId: "anthropic-messages",
              effectiveSessionId: "22222222-2222-4222-8222-222222222222",
            },
          ],
        };
      },
    };
    const runtime = createTauriDesktopRuntime(bridge);
    const identities = await runtime.getRequestIdentities();
    expect(identities.records).toHaveLength(2);
    expect(identities.records[0]!.clientSessionId).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(identities.records[1]!.clientSessionId).toBeUndefined();
    // A record that ever carries the internal effective session identity is
    // rejected at the bridge boundary.
    await expect(runtime.getRequestIdentities()).rejects.toThrow(
      "invalid request identities result",
    );
  });
});

describe("Tauri shell runtime auth seam (Ticket 13)", () => {
  it("queries the Provider login options through the native bridge", async () => {
    const calls: string[] = [];
    const bridge: NativeTauriBridge = {
      listen: async () => () => undefined,
      invoke: async (command) => {
        calls.push(command);
        return {
          outcome: "ok",
          state: {
            revision: 1,
            path: "C:\auth.json",
            present: false,
            valid: false,
            providers: [],
          },
          options: {
            providers: [
              {
                providerId: "anthropic",
                name: "Anthropic",
                account: true,
                subscription: true,
                apiKey: true,
                status: {
                  providerId: "anthropic",
                  stored: false,
                  environment: false,
                  modelsJson: false,
                  commandDerived: false,
                  expired: false,
                  unavailable: true,
                  effectiveSource: "none",
                },
              },
            ],
          },
        };
      },
    };
    const runtime = createTauriDesktopRuntime(bridge);

    const result = await runtime.executeAuthCommand({ command: "query" });

    expect(calls).toEqual(["shell_auth_query"]);
    expect(result.outcome).toBe("ok");
    expect(result.options?.providers[0]).toMatchObject({
      providerId: "anthropic",
      subscription: true,
    });
  });

  it("login listens to the auth-event channel, forwards decoded events and unlistens on the terminal result", async () => {
    const calls: Array<{ readonly command: string; readonly args?: unknown }> = [];
    let authListener:
      | ((event: { readonly payload: unknown }) => void)
      | undefined;
    let unlistened = 0;
    let invokeLogin: (() => void) | undefined;
    const received: unknown[] = [];
    const bridge: NativeTauriBridge = {
      listen: async () => () => undefined,
      listenAuthEvent: async (listener) => {
        authListener = listener;
        return () => {
          unlistened += 1;
        };
      },
      invoke: async (command, args) => {
        calls.push({ command, ...(args === undefined ? {} : { args }) });
        if (command === "shell_auth_login") {
          // Typed events arrive on the auth channel while the login is
          // pending, then the terminal result resolves the invoke.
          authListener?.({
            payload: {
              type: "auth_url",
              url: "https://example.com/authorize",
            },
          });
          authListener?.({
            payload: {
              type: "prompt",
              promptId: "p1",
              kind: "text",
              message: "Enter the code",
            },
          });
          return new Promise((resolve) => {
            invokeLogin = () =>
              resolve({
                outcome: "ok",
                state: {
                  revision: 2,
                  path: "C:\auth.json",
                  present: true,
                  valid: true,
                  providers: [],
                },
              });
          });
        }
        return undefined;
      },
    };
    const runtime = createTauriDesktopRuntime(bridge);

    const pending = runtime.executeAuthCommand(
      { command: "login", providerId: "anthropic", authType: "oauth" },
      (event) => received.push(event),
    );
    // The listener registration resolves, the login invoke starts and the
    // typed events are delivered — then the terminal result resolves it.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    expect(calls[0]).toEqual({
      command: "shell_auth_login",
      args: { providerId: "anthropic", authType: "oauth" },
    });
    // The events were forwarded decoded, in order, before the result.
    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({ type: "auth_url" });
    expect(received[1]).toMatchObject({ type: "prompt", promptId: "p1" });
    invokeLogin?.();
    const result = await pending;
    expect(result.outcome).toBe("ok");
    expect(unlistened).toBe(1);
  });

  it("an undecodable interaction event fails the whole login flow", async () => {
    const bridge: NativeTauriBridge = {
      listen: async () => () => undefined,
      listenAuthEvent: async (listener) => {
        listener({
          payload: { type: "evil", secret: "canary-runtime-secret" },
        });
        return () => undefined;
      },
      invoke: async () => ({
        outcome: "ok",
        state: {
          revision: 2,
          path: "C:\auth.json",
          present: true,
          valid: true,
          providers: [],
        },
      }),
    };
    const runtime = createTauriDesktopRuntime(bridge);

    await expect(
      runtime.executeAuthCommand({
        command: "login",
        providerId: "anthropic",
        authType: "oauth",
      }),
    ).rejects.toThrow("invalid auth interaction event");
  });

  it("rejects a login result that carries the options projection", async () => {
    const bridge: NativeTauriBridge = {
      listen: async () => () => undefined,
      listenAuthEvent: async () => () => undefined,
      invoke: async () => ({
        outcome: "ok",
        state: {
          revision: 2,
          path: "C:\auth.json",
          present: true,
          valid: true,
          providers: [],
        },
        options: { providers: [] },
      }),
    };
    const runtime = createTauriDesktopRuntime(bridge);

    await expect(
      runtime.executeAuthCommand({
        command: "login",
        providerId: "anthropic",
        authType: "oauth",
      }),
    ).rejects.toThrow("invalid auth result");
  });

  it("routes typed responses through the native bridge", async () => {
    const calls: Array<{ readonly command: string; readonly args?: unknown }> = [];
    const bridge: NativeTauriBridge = {
      listen: async () => () => undefined,
      invoke: async (command, args) => {
        calls.push({ command, ...(args === undefined ? {} : { args }) });
        return undefined;
      },
    };
    const runtime = createTauriDesktopRuntime(bridge);

    await runtime.respondAuthInteraction({
      type: "prompt_response",
      promptId: "p1",
      value: "FAKE-CODE",
    });

    expect(calls).toEqual([
      {
        command: "shell_auth_respond",
        args: {
          response: { type: "prompt_response", promptId: "p1", value: "FAKE-CODE" },
        },
      },
    ]);
  });

  it("opens only http(s) URLs through the native shell", async () => {
    const calls: Array<{ readonly command: string; readonly args?: unknown }> = [];
    const bridge: NativeTauriBridge = {
      listen: async () => () => undefined,
      invoke: async (command, args) => {
        calls.push({ command, ...(args === undefined ? {} : { args }) });
        return undefined;
      },
    };
    const runtime = createTauriDesktopRuntime(bridge);

    await runtime.openUrl("https://example.com/authorize");
    await runtime.openUrl("http://127.0.0.1:3000/callback");
    await expect(runtime.openUrl("file:///C:/secret")).rejects.toThrow(
      "non-http(s)",
    );
    await expect(runtime.openUrl("javascript:alert(1)")).rejects.toThrow(
      "non-http(s)",
    );

    expect(calls).toEqual([
      { command: "shell_open_url", args: { url: "https://example.com/authorize" } },
      { command: "shell_open_url", args: { url: "http://127.0.0.1:3000/callback" } },
    ]);
  });
});

describe("Tauri shell runtime auth conflict seam (Ticket 13 repair)", () => {
  it("surfaces the value-free conflict rejection of a refused concurrent login", async () => {
    const bridge: NativeTauriBridge = {
      listen: async () => () => undefined,
      listenAuthEvent: async () => () => undefined,
      invoke: async () => {
        throw new Error(
          "Another sign-in is already in progress. Wait for it to finish, then try again.",
        );
      },
    };
    const runtime = createTauriDesktopRuntime(bridge);

    await expect(
      runtime.executeAuthCommand({
        command: "login",
        providerId: "anthropic",
        authType: "oauth",
      }),
    ).rejects.toThrow("Another sign-in is already in progress.");
  });

  it("surfaces the stale-response rejection of the active flow", async () => {
    const bridge: NativeTauriBridge = {
      listen: async () => () => undefined,
      invoke: async () => {
        throw new Error(
          "The sign-in is no longer waiting for that response. Continue the current sign-in or cancel it.",
        );
      },
    };
    const runtime = createTauriDesktopRuntime(bridge);

    await expect(
      runtime.respondAuthInteraction({
        type: "prompt_response",
        promptId: "stale-prompt",
        value: "FAKE-CODE",
      }),
    ).rejects.toThrow("The sign-in is no longer waiting for that response.");
  });
});

describe("Tauri shell runtime analytics seam (Ticket 21)", () => {
  it("forwards the versioned query to the native command and strict-decodes the result", async () => {
    const calls: Array<{ readonly command: string; readonly args?: unknown }> = [];
    const bridge: NativeTauriBridge = {
      listen: async () => () => undefined,
      invoke: async (command, args) => {
        calls.push({ command, ...(args === undefined ? {} : { args }) });
        return {
          version: 1,
          command: "summary",
          totals: {
            total: 2,
            success: 1,
            failed: 1,
            aborted: 0,
            other: 0,
            pending: 0,
            successRate: 0.5,
            failureRate: 0.5,
            abortRate: 0,
            participating: 1,
            totalRequests: 2,
            excluded: 1,
            inputTokens: 5,
            cacheReadTokens: 3,
            cacheWriteTokens: 2,
            outputTokens: 2,
            reasoningTokens: 1,
            normalizedTokenTotal: 12,
            cacheHitNumerator: 3,
            cacheHitDenominator: 10,
            cacheHitRate: 0.3,
          },
        };
      },
    };
    const runtime = createTauriDesktopRuntime(bridge);
    const result = await runtime.getAnalytics({
      version: 1,
      command: "summary",
      from: 1_700_000_000_000,
      to: 1_700_003_600_000,
    });
    expect(result.command).toBe("summary");
    if (result.command !== "summary") return;
    expect(result.totals.cacheHitRate).toBe(0.3);
    expect(calls).toEqual([
      {
        command: "shell_analytics_query",
        args: {
          query: {
            version: 1,
            command: "summary",
            from: 1_700_000_000_000,
            to: 1_700_003_600_000,
          },
        },
      },
    ]);
  });

  it("rejects a native result carrying a monetary key at the runtime boundary", async () => {
    const bridge: NativeTauriBridge = {
      listen: async () => () => undefined,
      invoke: async () => ({
        version: 1,
        command: "summary",
        totals: {
          total: 0,
          success: 0,
          failed: 0,
          aborted: 0,
          other: 0,
          pending: 0,
          successRate: 0,
          failureRate: 0,
          abortRate: 0,
          participating: 0,
          totalRequests: 0,
          excluded: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          cacheHitNumerator: 0,
          cacheHitDenominator: 0,
          cost: 5,
        },
      }),
    };
    const runtime = createTauriDesktopRuntime(bridge);
    await expect(
      runtime.getAnalytics({ version: 1, command: "summary", from: 0, to: 1 }),
    ).rejects.toThrow("invalid analytics result");
  });
});
