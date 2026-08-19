import { afterEach, describe, expect, it } from "vitest";

import {
  connectControlPlane,
  createNodePipeTransport,
  nodePipeFallbackAccess,
  startControlPlane,
  type ApplicationCommandResult,
  type ApplicationOwnership,
  type RunningControlPlane,
  type StatusEvent,
} from "@luckytoken/application-control-plane/control-plane";

import {
  createDataPlaneRuntimeSupervisor,
  type RunningDataPlaneListener,
} from "../../src/runtime-supervisor.js";
import { createLuckyTokenRuntime } from "../../src/runtime.js";
import {
  startLuckyTokenHttpServer,
  type DrainClock,
  type RunningLuckyTokenHttpServer,
} from "../../src/server.js";
import {
  createUnsupportedAutoStartRegistrar,
  executeAutoStart,
  type AutoStartRegistrar,
} from "../../src/auto-start.js";

const ownership: ApplicationOwnership = Object.freeze({
  owner: Object.freeze({
    kind: "cli",
    pid: 4242,
    startedAt: "2026-08-15T12:00:00.000Z",
  }),
});

function createFakeClock(): {
  readonly clock: DrainClock;
  readonly pendingSleeps: () => number;
  readonly advance: () => void;
} {
  let now = 0;
  const sleepers: Array<() => void> = [];
  return {
    clock: {
      now: () => now,
      sleep: (ms: number) => {
        now += ms;
        let resolveSleep: (() => void) | undefined;
        const promise = new Promise<void>((resolve) => {
          resolveSleep = resolve;
        });
        const entry = () => resolveSleep?.();
        sleepers.push(entry);
        return {
          promise,
          cancel: () => {
            const index = sleepers.indexOf(entry);
            if (index >= 0) sleepers.splice(index, 1);
          },
        };
      },
    },
    pendingSleeps: () => sleepers.length,
    advance() {
      for (const resolve of sleepers.splice(0)) resolve();
    },
  };
}

function createFakeRegistrar(): {
  readonly registrar: AutoStartRegistrar;
  readonly setEnabled: (enabled: boolean) => void;
  readonly failNext: (error: Error) => void;
} {
  let enabled = false;
  let nextFailure: Error | undefined;
  const registrar: AutoStartRegistrar = {
    async enable() {
      if (nextFailure !== undefined) {
        const failure = nextFailure;
        nextFailure = undefined;
        throw failure;
      }
      enabled = true;
    },
    async disable() {
      if (nextFailure !== undefined) {
        const failure = nextFailure;
        nextFailure = undefined;
        throw failure;
      }
      enabled = false;
    },
    async status() {
      return { enabled };
    },
  };
  return {
    registrar,
    setEnabled: (value) => {
      enabled = value;
    },
    failNext: (error) => {
      nextFailure = error;
    },
  };
}

describe("Control Plane ownership and application lifecycle seam", () => {
  const hosts: RunningControlPlane[] = [];
  const httpServers: RunningLuckyTokenHttpServer[] = [];
  let nextPipe = 0;
  let nextRequest = 0;

  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((host) => host.close()));
    await Promise.all(httpServers.splice(0).map((server) => server.close()));
  });

  const transport = createNodePipeTransport();
  const clientDependencies = {
    createRequestId: () => `ownership-request-${++nextRequest}`,
    pipeConnector: transport,
  };

  async function startOwnedHost(options: {
    readonly runtimeCommandHandler?: unknown;
    readonly applicationCommandHandler?: unknown;
    readonly onApplicationCommandResultDelivered?: unknown;
  }) {
    const host = await startControlPlane({
      ...(options.runtimeCommandHandler === undefined
        ? {}
        : {
            runtimeCommandHandler: options
              .runtimeCommandHandler as NonNullable<
              Parameters<typeof startControlPlane>[0]["runtimeCommandHandler"]
            >,
          }),
      ...(options.applicationCommandHandler === undefined
        ? {}
        : {
            applicationCommandHandler: options
              .applicationCommandHandler as NonNullable<
              Parameters<typeof startControlPlane>[0]["applicationCommandHandler"]
            >,
          }),
      ...(options.onApplicationCommandResultDelivered === undefined
        ? {}
        : {
            onApplicationCommandResultDelivered: options
              .onApplicationCommandResultDelivered as NonNullable<
              Parameters<typeof startControlPlane>[0]["onApplicationCommandResultDelivered"]
            >,
          }),
      endpoint: {
        address: `\\\\.\\pipe\\luckytoken-ownership-${process.pid}-${++nextPipe}`,
        capability: "ownership-test-capability-012345678901234567",
      },
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      ownership,
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
    });
    hosts.push(host);
    return host;
  }

  it("projects the owner identity through status snapshots and events", async () => {
    const host = await startOwnedHost({});
    const client = await connectControlPlane(host.endpoint, clientDependencies);
    await client.hello(1);
    const events: StatusEvent[] = [];
    await client.subscribe((event) => events.push(event));

    await expect(client.getStatus()).resolves.toMatchObject({ ownership });
    await host.publishStatus({ modelDataPlane: "running", provider: "configured" });

    expect(events).toHaveLength(1);
    expect(events[0]?.snapshot).toMatchObject({ ownership });
    await client.close();
  });

  it("attach reports the attached role with the live owner snapshot", async () => {
    const commands: unknown[] = [];
    const host = await startOwnedHost({
      applicationCommandHandler: async (command: unknown) => {
        commands.push(command);
        return { outcome: "attached" };
      },
    });
    const client = await connectControlPlane(host.endpoint, clientDependencies);
    await client.hello(1);

    const result = await client.executeApplicationCommand({
      command: "attach",
    });

    expect(result).toMatchObject({
      command: "attach",
      outcome: "attached",
      snapshot: { modelDataPlane: "stopped", ownership },
    });
    expect(commands).toEqual([{ command: "attach" }]);
    await client.close();
  });

  it("round-trips desktop owner lease commands and rejects a stale lease through the typed wire", async () => {
    let activeLease: string | undefined;
    const host = await startOwnedHost({
      applicationCommandHandler: async (command: unknown) => {
        const value = command as {
          readonly command: "desktop_owner";
          readonly action: "claim" | "renew";
          readonly leaseId: string;
        };
        if (value.action === "claim") {
          activeLease = value.leaseId;
          return { outcome: "lease_claimed" };
        }
        return activeLease === value.leaseId
          ? { outcome: "lease_renewed" }
          : {
              outcome: "conflict",
              conflict: {
                code: "desktop_owner_lease_mismatch",
                message: "The desktop ownership lease belongs to a newer LuckyToken shell.",
              },
            };
      },
    });
    const client = await connectControlPlane(host.endpoint, clientDependencies);
    await client.hello(1);

    await expect(
      client.executeApplicationCommand({
        command: "desktop_owner",
        action: "claim",
        leaseId: "shell-a",
      }),
    ).resolves.toMatchObject({
      command: "desktop_owner",
      outcome: "lease_claimed",
    });
    await expect(
      client.executeApplicationCommand({
        command: "desktop_owner",
        action: "claim",
        leaseId: "shell-b",
      }),
    ).resolves.toMatchObject({ outcome: "lease_claimed" });
    await expect(
      client.executeApplicationCommand({
        command: "desktop_owner",
        action: "renew",
        leaseId: "shell-a",
      }),
    ).resolves.toMatchObject({
      outcome: "conflict",
      conflict: { code: "desktop_owner_lease_mismatch" },
    });
    await expect(
      client.executeApplicationCommand({
        command: "desktop_owner",
        action: "renew",
        leaseId: "shell-b",
      }),
    ).resolves.toMatchObject({ outcome: "lease_renewed" });
    await client.close();
  });

  it("refuses a non-owner quit without explicit acknowledgement and keeps serving", async () => {
    let handlerCalls = 0;
    const host = await startOwnedHost({
      applicationCommandHandler: async () => {
        handlerCalls += 1;
        return { outcome: "drained" };
      },
    });
    const client = await connectControlPlane(host.endpoint, clientDependencies);
    await client.hello(1);

    const result = await client.executeApplicationCommand({
      command: "quit",
      acknowledged: false,
    });

    expect(result).toMatchObject({
      command: "quit",
      outcome: "conflict",
      conflict: { code: "quit_requires_explicit_confirmation" },
      snapshot: { modelDataPlane: "stopped" },
    });
    expect(handlerCalls).toBe(0);
    // The owner keeps serving after the refused quit.
    await expect(client.getStatus()).resolves.toMatchObject({
      modelDataPlane: "stopped",
    });
    await client.close();
  });

  it("acknowledged quit drains the active Data Plane set and reports drained", async () => {
    let handlerStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      handlerStarted = resolve;
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = createLuckyTokenRuntime({
      clientProtocols: [
        {
          method: "POST",
          pathname: "/controlled",
          handle: async () => {
            handlerStarted?.();
            await gate;
            return new Response("drained-ok");
          },
        },
      ],
    });
    let activeServer: RunningLuckyTokenHttpServer | undefined;
    const supervisor = createDataPlaneRuntimeSupervisor({
      host: "127.0.0.1",
      port: 0,
      readProvider: () => "unconfigured",
      startListener: async () => {
        activeServer = await startLuckyTokenHttpServer({ runtime, port: 0 });
        httpServers.push(activeServer);
        return {
          close: () => activeServer?.close() ?? Promise.resolve(),
          drain: (timeoutMs) =>
            activeServer?.drain(timeoutMs, { clock: fakeClock.clock }) ??
            Promise.resolve("drained"),
        };
      },
    });
    const fakeClock = createFakeClock();
    const delivered: ApplicationCommandResult[] = [];
    const host = await startOwnedHost({
      runtimeCommandHandler: supervisor.execute,
      applicationCommandHandler: async (
        command: unknown,
        publishStatus: unknown,
      ) => {
        const quit = command as { readonly command: "quit" };
        void quit;
        const outcome = await supervisor.quit({
          timeoutMs: 5_000,
          publishStatus: publishStatus as (status: unknown) => Promise<void>,
        });
        return { outcome };
      },
      onApplicationCommandResultDelivered: async (
        _command: unknown,
        result: unknown,
      ) => {
        delivered.push(result as ApplicationCommandResult);
      },
    });
    const client = await connectControlPlane(host.endpoint, clientDependencies);
    await client.hello(1);
    await client.executeRuntimeCommand("start");
    const origin = activeServer?.origin;
    if (origin === undefined) throw new Error("Data Plane did not start");

    const inFlight = fetch(`${origin}/controlled`, { method: "POST" });
    await started;
    const quit = client.executeApplicationCommand({
      command: "quit",
      acknowledged: true,
    });
    release?.();
    await expect(inFlight).resolves.toMatchObject({ status: 200 });

    await expect(quit).resolves.toMatchObject({
      command: "quit",
      outcome: "drained",
      snapshot: { modelDataPlane: "stopped" },
    });
    await expect.poll(() => delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ command: "quit", outcome: "drained" });
    await client.close();
  });

  it("acknowledged quit aborts the active set after the configured drain timeout", async () => {
    let handlerStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      handlerStarted = resolve;
    });
    const runtime = createLuckyTokenRuntime({
      clientProtocols: [
        {
          method: "POST",
          pathname: "/never",
          handle: async () => {
            handlerStarted?.();
            await new Promise<void>(() => undefined);
            return new Response("never");
          },
        },
      ],
    });
    let activeServer: RunningLuckyTokenHttpServer | undefined;
    const supervisor = createDataPlaneRuntimeSupervisor({
      host: "127.0.0.1",
      port: 0,
      readProvider: () => "unconfigured",
      startListener: async () => {
        activeServer = await startLuckyTokenHttpServer({ runtime, port: 0 });
        httpServers.push(activeServer);
        return {
          close: () => activeServer?.close() ?? Promise.resolve(),
          drain: (timeoutMs) =>
            activeServer?.drain(timeoutMs, { clock: fakeClock.clock }) ??
            Promise.resolve("timed_out"),
        };
      },
    });
    const fakeClock = createFakeClock();
    const delivered: ApplicationCommandResult[] = [];
    const host = await startOwnedHost({
      runtimeCommandHandler: supervisor.execute,
      applicationCommandHandler: async (
        command: unknown,
        publishStatus: unknown,
      ) => {
        const quit = command as { readonly command: "quit" };
        void quit;
        const outcome = await supervisor.quit({
          timeoutMs: 1_000,
          publishStatus: publishStatus as (status: unknown) => Promise<void>,
        });
        return { outcome };
      },
      onApplicationCommandResultDelivered: async (
        _command: unknown,
        result: unknown,
      ) => {
        delivered.push(result as ApplicationCommandResult);
      },
    });
    const client = await connectControlPlane(host.endpoint, clientDependencies);
    await client.hello(1);
    await client.executeRuntimeCommand("start");
    const origin = activeServer?.origin;
    if (origin === undefined) throw new Error("Data Plane did not start");

    const inFlight = fetch(`${origin}/never`, { method: "POST" });
    await started;
    const quit = client.executeApplicationCommand({
      command: "quit",
      acknowledged: true,
    });
    // The drain registers its timeout sleep only after the quit command
    // reaches the owner through the pipe; advance only once it is pending.
    await expect.poll(() => fakeClock.pendingSleeps()).toBeGreaterThan(0);
    fakeClock.advance();

    await expect(inFlight).rejects.toThrow();
    await expect(quit).resolves.toMatchObject({
      command: "quit",
      outcome: "timed_out",
      snapshot: { modelDataPlane: "stopped" },
    });
    await expect.poll(() => delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ command: "quit", outcome: "timed_out" });
    await client.close();
  });

  it("reports the effective Windows login auto-start registration status", async () => {
    const fake = createFakeRegistrar();
    const host = await startOwnedHost({
      applicationCommandHandler: async (command: unknown) => {
        const autoStart = command as { readonly command: "auto_start"; readonly action: "status" | "enable" | "disable" };
        const execution = await executeAutoStart(fake.registrar, autoStart.action);
        return {
          outcome: execution.outcome,
          ...(execution.error === undefined ? {} : { error: execution.error }),
          ...(execution.enabled === undefined
            ? {}
            : { autoStart: { enabled: execution.enabled } }),
        };
      },
    });
    const client = await connectControlPlane(host.endpoint, clientDependencies);
    await client.hello(1);

    await expect(
      client.executeApplicationCommand({
        command: "auto_start",
        action: "status",
      }),
    ).resolves.toMatchObject({
      command: "auto_start",
      outcome: "ok",
      autoStart: { enabled: false },
    });

    await expect(
      client.executeApplicationCommand({
        command: "auto_start",
        action: "enable",
      }),
    ).resolves.toMatchObject({
      command: "auto_start",
      outcome: "ok",
      autoStart: { enabled: true },
    });

    fake.failNext(new Error("registry write refused"));
    await expect(
      client.executeApplicationCommand({
        command: "auto_start",
        action: "disable",
      }),
    ).resolves.toMatchObject({
      command: "auto_start",
      outcome: "failed",
      error: "registry write refused",
    });
    expect(JSON.stringify(await client.getStatus())).not.toContain(
      "registry write refused",
    );

    await client.close();
  });

  it("reports unsupported auto-start on platforms without a registrar", async () => {
    const host = await startOwnedHost({
      applicationCommandHandler: async (command: unknown) => {
        const autoStart = command as { readonly command: "auto_start"; readonly action: "status" | "enable" | "disable" };
        const execution = await executeAutoStart(
          createUnsupportedAutoStartRegistrar(),
          autoStart.action,
        );
        return {
          outcome: execution.outcome,
          ...(execution.error === undefined ? {} : { error: execution.error }),
          ...(execution.enabled === undefined
            ? {}
            : { autoStart: { enabled: execution.enabled } }),
        };
      },
    });
    const client = await connectControlPlane(host.endpoint, clientDependencies);
    await client.hello(1);

    await expect(
      client.executeApplicationCommand({
        command: "auto_start",
        action: "enable",
      }),
    ).resolves.toMatchObject({
      command: "auto_start",
      outcome: "unsupported",
    });
    await client.close();
  });

  it("detaching an attached viewer never stops the headless-owned gateway", async () => {
    const runtime = createLuckyTokenRuntime({
      clientProtocols: [
        {
          method: "POST",
          pathname: "/v1/messages",
          handle: async () => new Response("still-serving"),
        },
      ],
    });
    let activeServer: RunningLuckyTokenHttpServer | undefined;
    const supervisor = createDataPlaneRuntimeSupervisor({
      host: "127.0.0.1",
      port: 0,
      readProvider: () => "unconfigured",
      startListener: async () => {
        activeServer = await startLuckyTokenHttpServer({ runtime, port: 0 });
        httpServers.push(activeServer);
        return activeServer as unknown as RunningDataPlaneListener;
      },
    });
    const host = await startOwnedHost({
      runtimeCommandHandler: supervisor.execute,
      applicationCommandHandler: async () => ({ outcome: "attached" }),
    });
    const client = await connectControlPlane(host.endpoint, clientDependencies);
    await client.hello(1);
    await client.executeApplicationCommand({ command: "attach" });
    await client.executeRuntimeCommand("start");
    const origin = activeServer?.origin;
    if (origin === undefined) throw new Error("Data Plane did not start");

    // The attached viewer detaches; the headless owner keeps the gateway up.
    await client.close();

    const second = await connectControlPlane(host.endpoint, clientDependencies);
    await second.hello(1);
    await expect(second.getStatus()).resolves.toMatchObject({
      modelDataPlane: "running",
    });
    await expect(
      fetch(`${origin}/v1/messages`, { method: "POST" }),
    ).resolves.toMatchObject({ status: 200 });
    await second.close();
  });
});
