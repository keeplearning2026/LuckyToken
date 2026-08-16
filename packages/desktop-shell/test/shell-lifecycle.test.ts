import { describe, expect, it } from "vitest";

import type { ControlPlaneState } from "../src/control-plane-projection.js";

import {
  createWindowsShellHost,
  productPages,
  type DesktopShellRuntime,
} from "../src/shell-lifecycle.js";

describe("Windows desktop shell public lifecycle seam", () => {
  it("runs Dashboard lifecycle actions through the connected runtime", async () => {
    const commands: string[] = [];
    const connected: ControlPlaneState = {
      revision: 1,
      kind: "connected",
      applicationVersion: "test",
      contractVersion: 1,
      sequence: 0,
      modelDataPlane: "stopped",
      provider: "unconfigured",
    };
    const shell = createWindowsShellHost({
      connectControlPlane: async () => connected,
      executeSettingsCommand: async () => connected,
      executeClientTokenCommand: async () => ({ outcome: "ok", revision: 1, scopes: [] }),
      queryDiagnosticsWarnings: async () => [],
      executeModelsCommand: async () => {
        throw new Error("unused models command");
      },
      executeRuntimeCommand: async (command) => {
        commands.push(command);
        return connected;
      },
      getAutoStartStatus: async () => ({ enabled: false }),
      setAutoStartEnabled: async (enabled: boolean) => ({ enabled }),
      subscribeControlPlane: () => () => undefined,
      disconnectControlPlane: async () => undefined,
    });
    await shell.launch();

    await shell.executeRuntimeCommand("start");
    await shell.executeRuntimeCommand("stop");
    await shell.executeRuntimeCommand("restart");

    expect(commands).toEqual(["start", "stop", "restart"]);
    await shell.dispose();
  });

  it("runs models catalog commands through the connected runtime and projects the result", async () => {
    const commands: unknown[] = [];
    const modelsResult = {
      outcome: "ok" as const,
      state: {
        revision: 1,
        path: "C:\\models.json",
        present: true,
        valid: true,
        raw: "{}",
        providers: {},
      },
    };
    const connected: ControlPlaneState = {
      revision: 2,
      kind: "connected",
      applicationVersion: "test",
      contractVersion: 1,
      sequence: 1,
      modelDataPlane: "stopped",
      provider: "unconfigured",
      modelsProjection: { revision: 1, path: "C:\\models.json", present: true, valid: true },
      modelsResult,
    };
    const shell = createWindowsShellHost({
      connectControlPlane: async () => connected,
      executeSettingsCommand: async () => connected,
      executeRuntimeCommand: async () => connected,
      executeClientTokenCommand: async () => ({ outcome: "ok", revision: 1, scopes: [] }),
      queryDiagnosticsWarnings: async () => [],
      executeModelsCommand: async (command) => {
        commands.push(command);
        return connected;
      },
            getAutoStartStatus: async () => ({ enabled: false }),
      setAutoStartEnabled: async (enabled: boolean) => ({ enabled }),
subscribeControlPlane: () => () => undefined,
      disconnectControlPlane: async () => undefined,
    });
    await shell.launch();

    const result = await shell.executeModelsCommand({
      command: "write_raw",
      revision: 1,
      content: "{}\n",
    });

    expect(commands).toEqual([
      { command: "write_raw", revision: 1, content: "{}\n" },
    ]);
    expect(result.connection).toMatchObject({
      modelsResult: { outcome: "ok" },
    });
    await shell.dispose();
  });

  it("launches once on the empty Dashboard", async () => {
    const runtime: DesktopShellRuntime = {
      connectControlPlane: async () => ({
        revision: 1,
        kind: "connected",
        applicationVersion: "0.0.0-test",
        contractVersion: 1,
        sequence: 0,
        modelDataPlane: "running",
        provider: "unconfigured",
      }),
      executeSettingsCommand: async () => {
        throw new Error("unused settings command");
        },
      executeClientTokenCommand: async () => ({ outcome: "ok", revision: 1, scopes: [] }),
      queryDiagnosticsWarnings: async () => [],
      executeModelsCommand: async () => {
        throw new Error("unused models command");
        },
      executeRuntimeCommand: async () => {
        throw new Error("unused runtime command");
      },
      getAutoStartStatus: async () => ({ enabled: false }),
      setAutoStartEnabled: async (enabled: boolean) => ({ enabled }),
      subscribeControlPlane: () => () => undefined,
      disconnectControlPlane: async () => undefined,
    };
    const shell = createWindowsShellHost(runtime);

    const first = await shell.launch();
    const second = await shell.launch();

    expect(first).toMatchObject({
      lifecycle: "open",
      activePage: "dashboard",
      connection: { kind: "connected" },
    });
    expect(second).toEqual(first);
  });

  it("settles runtime resources once when launch fails before disposal", async () => {
    let unsubscribed = 0;
    let disconnected = 0;
    const shell = createWindowsShellHost({
      connectControlPlane: async () => {
        throw new Error("connection rejected");
      },
      executeSettingsCommand: async () => {
        throw new Error("unused settings command");
        },
      executeClientTokenCommand: async () => ({ outcome: "ok", revision: 1, scopes: [] }),
      queryDiagnosticsWarnings: async () => [],
      executeModelsCommand: async () => {
        throw new Error("unused models command");
        },
      executeRuntimeCommand: async () => {
        throw new Error("unused runtime command");
      },
      getAutoStartStatus: async () => ({ enabled: false }),
      setAutoStartEnabled: async (enabled: boolean) => ({ enabled }),
      subscribeControlPlane: () => () => {
        unsubscribed += 1;
      },
      disconnectControlPlane: async () => {
        disconnected += 1;
      },
    });

    await expect(shell.launch()).rejects.toThrow("connection rejected");
    await expect(shell.dispose()).resolves.toBeUndefined();
    await expect(shell.dispose()).resolves.toBeUndefined();

    expect(unsubscribed).toBe(1);
    expect(disconnected).toBe(1);
    expect(shell.snapshot()).toMatchObject({ lifecycle: "closed" });
  });

  it("does not acquire runtime resources when launch follows disposal", async () => {
    let subscribed = 0;
    let connected = 0;
    let disconnected = 0;
    const shell = createWindowsShellHost({
      connectControlPlane: async () => {
        connected += 1;
        throw new Error("must not connect after disposal");
      },
      executeSettingsCommand: async () => {
        throw new Error("unused settings command");
        },
      executeClientTokenCommand: async () => ({ outcome: "ok", revision: 1, scopes: [] }),
      queryDiagnosticsWarnings: async () => [],
      executeModelsCommand: async () => {
        throw new Error("unused models command");
        },
      executeRuntimeCommand: async () => {
        throw new Error("unused runtime command");
      },
      getAutoStartStatus: async () => ({ enabled: false }),
      setAutoStartEnabled: async (enabled: boolean) => ({ enabled }),
      subscribeControlPlane: () => {
        subscribed += 1;
        return () => undefined;
      },
      disconnectControlPlane: async () => {
        disconnected += 1;
      },
    });

    await shell.dispose();
    const afterDisposal = await shell.launch();

    expect(afterDisposal).toMatchObject({ lifecycle: "closed" });
    expect({ subscribed, connected, disconnected }).toEqual({
      subscribed: 0,
      connected: 0,
      disconnected: 1,
    });
  });

  it("closes once while propagating a runtime disconnect failure", async () => {
    let unsubscribed = 0;
    let disconnected = 0;
    const disconnectFailure = new Error("disconnect failed");
    const shell = createWindowsShellHost({
      connectControlPlane: async () => ({
        revision: 1,
        kind: "connected",
        applicationVersion: "0.0.0-test",
        contractVersion: 1,
        sequence: 0,
        modelDataPlane: "running",
        provider: "unconfigured",
      }),
      executeSettingsCommand: async () => {
        throw new Error("unused settings command");
        },
      executeClientTokenCommand: async () => ({ outcome: "ok", revision: 1, scopes: [] }),
      queryDiagnosticsWarnings: async () => [],
      executeModelsCommand: async () => {
        throw new Error("unused models command");
        },
      executeRuntimeCommand: async () => {
        throw new Error("unused runtime command");
      },
      getAutoStartStatus: async () => ({ enabled: false }),
      setAutoStartEnabled: async (enabled: boolean) => ({ enabled }),
      subscribeControlPlane: () => () => {
        unsubscribed += 1;
      },
      disconnectControlPlane: async () => {
        disconnected += 1;
        throw disconnectFailure;
      },
    });
    await shell.launch();

    await expect(shell.dispose()).rejects.toBe(disconnectFailure);
    await expect(shell.dispose()).rejects.toBe(disconnectFailure);

    expect(shell.snapshot()).toMatchObject({ lifecycle: "closed" });
    expect({ unsubscribed, disconnected }).toEqual({
      unsubscribed: 1,
      disconnected: 1,
    });
  });

  it("navigates all eight stable pages while unconfigured and disposes cleanly", async () => {
    let controlPlaneDisconnected = 0;
    const shell = createWindowsShellHost({
      connectControlPlane: async () => ({
        revision: 1,
        kind: "connected",
        applicationVersion: "0.0.0-test",
        contractVersion: 1,
        sequence: 7,
        modelDataPlane: "running",
        provider: "unconfigured",
      }),
      executeSettingsCommand: async () => {
        throw new Error("unused settings command");
        },
      executeClientTokenCommand: async () => ({ outcome: "ok", revision: 1, scopes: [] }),
      queryDiagnosticsWarnings: async () => [],
      executeModelsCommand: async () => {
        throw new Error("unused models command");
        },
      executeRuntimeCommand: async () => {
        throw new Error("unused runtime command");
      },
      getAutoStartStatus: async () => ({ enabled: false }),
      setAutoStartEnabled: async (enabled: boolean) => ({ enabled }),
      subscribeControlPlane: () => () => undefined,
      disconnectControlPlane: async () => {
        controlPlaneDisconnected += 1;
      },
    });
    await shell.launch();

    expect(productPages).toEqual([
      { id: "dashboard", label: "Dashboard" },
      { id: "requests", label: "Requests" },
      { id: "analytics", label: "Analytics" },
      { id: "providers", label: "Providers" },
      { id: "models-aliases", label: "Models & Aliases" },
      { id: "client-tokens", label: "Client Tokens" },
      { id: "diagnostics", label: "Diagnostics" },
      { id: "settings-developer-lab", label: "Settings / Developer Lab" },
    ]);
    for (const page of productPages) {
      expect(shell.navigate(page.id).activePage).toBe(page.id);
    }

    await shell.dispose();
    await shell.dispose();

    expect(shell.snapshot()).toMatchObject({ lifecycle: "closed" });
    expect(controlPlaneDisconnected).toBe(1);
  });

  it("opens without a setup flow and updates actionable connection state", async () => {
    let publish: ((state: ControlPlaneState) => void) | undefined;
    const unavailable = (revision: number) => ({
      revision,
      kind: "error" as const,
      code: "descriptor_missing" as const,
      title: "LuckyToken backend is not available",
      detail: "No active local Control Plane was found.",
      action: "Start LuckyToken, then reconnect.",
    });
    const shell = createWindowsShellHost({
      connectControlPlane: async () => unavailable(1),
      executeSettingsCommand: async () => {
        throw new Error("unused settings command");
        },
      executeClientTokenCommand: async () => ({ outcome: "ok", revision: 1, scopes: [] }),
      queryDiagnosticsWarnings: async () => [],
      executeModelsCommand: async () => {
        throw new Error("unused models command");
        },
      executeRuntimeCommand: async () => {
        throw new Error("unused runtime command");
      },
      getAutoStartStatus: async () => ({ enabled: false }),
      setAutoStartEnabled: async (enabled: boolean) => ({ enabled }),
      subscribeControlPlane: (listener) => {
        publish = listener;
        return () => undefined;
      },
      disconnectControlPlane: async () => undefined,
    });
    const observed: ControlPlaneState[] = [];
    shell.subscribe((snapshot) => observed.push(snapshot.connection));

    const launched = await shell.launch();
    publish?.({
      revision: 2,
      kind: "error",
      code: "transport_lost",
      title: "Connection to LuckyToken was lost",
      detail: "The active local Control Plane disconnected.",
      action: "Restart LuckyToken, then reconnect.",
    });

    expect(launched).toMatchObject({
      lifecycle: "open",
      activePage: "dashboard",
      connection: { code: "descriptor_missing" },
    });
    expect(shell.snapshot()).toMatchObject({
      lifecycle: "open",
      activePage: "dashboard",
      connection: { code: "transport_lost" },
    });
    expect(observed.map((state) => (state.kind === "error" ? state.code : "connected"))).toEqual([
      "descriptor_missing",
      "transport_lost",
    ]);
  });

  it("passes Windows login auto-start queries and changes to the runtime", async () => {
    const actions: Array<boolean | "query"> = [];
    const shell = createWindowsShellHost({
      connectControlPlane: async () => ({
        revision: 1,
        kind: "connected",
        applicationVersion: "0.0.0-test",
        contractVersion: 1,
        sequence: 0,
        modelDataPlane: "stopped",
        provider: "unconfigured",
      }),
      executeSettingsCommand: async () => {
        throw new Error("unused settings command");
      },
      executeRuntimeCommand: async () => {
        throw new Error("unused runtime command");
      },
      getAutoStartStatus: async () => {
        actions.push("query");
        return { enabled: false };
      },
      setAutoStartEnabled: async (enabled) => {
        actions.push(enabled);
        return { enabled };
      },
      executeModelsCommand: async () => {
        throw new Error("unused models command");
      },
      executeClientTokenCommand: async () => {
        throw new Error("unused client token command");
      },
      queryDiagnosticsWarnings: async () => [],
      subscribeControlPlane: () => () => undefined,
      disconnectControlPlane: async () => undefined,
    });
    await shell.launch();

    await expect(shell.getAutoStartStatus()).resolves.toEqual({
      enabled: false,
    });
    await expect(shell.setAutoStartEnabled(true)).resolves.toEqual({
      enabled: true,
    });

    expect(actions).toEqual(["query", true]);
    await shell.dispose();
  });
});


describe("WindowsShellHost client token commands", () => {
  it("delegates client token commands and Dashboard warning queries to the runtime", async () => {
    const tokenResults: string[] = [];
    const runtime: DesktopShellRuntime = {
      connectControlPlane: async () => ({
        revision: 1,
        kind: "connected",
        applicationVersion: "0.0.0-test",
        contractVersion: 1,
        sequence: 0,
        modelDataPlane: "running",
        provider: "unconfigured",
      }),
      executeClientTokenCommand: async (command) => {
        tokenResults.push(command.command);
        return {
          outcome: "ok",
          revision: 1,
          scopes: [{ type: "global", maskedToken: "canary-m…sked" }],
        };
      },
      queryDiagnosticsWarnings: async () => [
        {
          id: 1,
          level: "warning",
          time: 1700000000000,
          text: "sanitized warning",
        },
      ],
      getAutoStartStatus: async () => ({ enabled: false }),
      setAutoStartEnabled: async (enabled: boolean) => ({ enabled }),
      executeModelsCommand: async () => {
        throw new Error("unused models command");
      },
      executeSettingsCommand: async () => {
        throw new Error("unused");
      },
      executeRuntimeCommand: async () => {
        throw new Error("unused");
      },
      subscribeControlPlane: () => () => undefined,
      disconnectControlPlane: async () => undefined,
    };
    const shell = createWindowsShellHost(runtime);
    await shell.launch();

    const listed = await shell.executeClientTokenCommand({
      command: "list",
      protocolId: "anthropic-messages",
    });
    expect(listed).toMatchObject({ outcome: "ok" });
    expect(tokenResults).toEqual(["list"]);
    await expect(
      shell.executeClientTokenCommand({
        command: "reveal",
        protocolId: "anthropic-messages",
      }),
    ).resolves.toMatchObject({ outcome: "ok" });

    const warnings = await shell.queryDiagnosticsWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.text).toBe("sanitized warning");

    await shell.dispose();
  });

  it("rejects client token commands while the shell is closed", async () => {
    const shell = createWindowsShellHost({
      connectControlPlane: async () => {
        throw new Error("unused");
      },
      executeClientTokenCommand: async () => {
        throw new Error("unused");
      },
      queryDiagnosticsWarnings: async () => [],
      getAutoStartStatus: async () => ({ enabled: false }),
      setAutoStartEnabled: async (enabled: boolean) => ({ enabled }),
      executeModelsCommand: async () => {
        throw new Error("unused models command");
      },
      executeSettingsCommand: async () => {
        throw new Error("unused");
      },
      executeRuntimeCommand: async () => {
        throw new Error("unused");
      },
      subscribeControlPlane: () => () => undefined,
      disconnectControlPlane: async () => undefined,
    });

    await expect(
      shell.executeClientTokenCommand({
        command: "list",
        protocolId: "anthropic-messages",
      }),
    ).rejects.toThrow("not open");
    await expect(shell.queryDiagnosticsWarnings()).rejects.toThrow("not open");
  });
});
