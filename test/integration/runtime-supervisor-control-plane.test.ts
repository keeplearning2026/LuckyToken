import { afterEach, describe, expect, it } from "vitest";

import {
  connectControlPlane,
  createNodePipeTransport,
  nodePipeFallbackAccess,
  startControlPlane,
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
  type RunningLuckyTokenHttpServer,
} from "../../src/server.js";

describe("Runtime Supervisor through the Control Plane seam", () => {
  const hosts: RunningControlPlane[] = [];
  const httpServers: RunningLuckyTokenHttpServer[] = [];
  let nextPipe = 0;
  let nextRequest = 0;

  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((host) => host.close()));
    await Promise.all(httpServers.splice(0).map((server) => server.close()));
  });

  it("starts one configured listener and publishes stopped, starting, then running", async () => {
    let starts = 0;
    const listener: RunningDataPlaneListener = {
      close: async () => undefined,
    };
    const supervisor = createDataPlaneRuntimeSupervisor({
      host: "127.0.0.1",
      port: 48765,
      readProvider: () => "unconfigured",
      startListener: async () => {
        starts += 1;
        return listener;
      },
    });
    const transport = createNodePipeTransport();
    const host = await startControlPlane({
      endpoint: {
        address: `\\\\.\\pipe\\luckytoken-runtime-${process.pid}-${++nextPipe}`,
        capability: "runtime-test-capability-012345678901234567890",
      },
      application: { id: "luckytoken", version: "test" },
      initialStatus: supervisor.initialStatus,
      runtimeCommandHandler: supervisor.execute,
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
    });
    hosts.push(host);
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `runtime-request-${++nextRequest}`,
      pipeConnector: transport,
    });
    await client.hello(2);
    const events: StatusEvent[] = [];
    await client.subscribe((event) => events.push(event));

    await expect(client.getStatus()).resolves.toEqual({
      sequence: 0,
      modelDataPlane: "stopped",
      provider: "unconfigured",
      dataPlane: {
        configuredOrigin: "http://127.0.0.1:48765",
        configuredPort: 48765,
      },
    });
    await expect(client.executeRuntimeCommand("start")).resolves.toEqual({
      command: "start",
      outcome: "completed",
      snapshot: {
        sequence: 2,
        modelDataPlane: "running",
        provider: "unconfigured",
        dataPlane: {
          configuredOrigin: "http://127.0.0.1:48765",
          configuredPort: 48765,
        },
      },
    });

    expect(starts).toBe(1);
    expect(events.map((event) => event.snapshot.modelDataPlane)).toEqual([
      "starting",
      "running",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    await client.close();
  });

  it("serializes concurrent commands with idempotent repeats and no listener overlap", async () => {
    let releaseStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let activeListeners = 0;
    let maximumActiveListeners = 0;
    const supervisor = createDataPlaneRuntimeSupervisor({
      host: "127.0.0.1",
      port: 48767,
      readProvider: () => "configured",
      startListener: async () => {
        await startGate;
        activeListeners += 1;
        maximumActiveListeners = Math.max(maximumActiveListeners, activeListeners);
        return {
          close: async () => {
            activeListeners -= 1;
          },
        };
      },
    });
    const transport = createNodePipeTransport();
    const host = await startControlPlane({
      endpoint: {
        address: `\\\\.\\pipe\\luckytoken-runtime-${process.pid}-${++nextPipe}`,
        capability: "runtime-test-capability-012345678901234567890",
      },
      application: { id: "luckytoken", version: "test" },
      initialStatus: supervisor.initialStatus,
      runtimeCommandHandler: supervisor.execute,
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
    });
    hosts.push(host);
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `runtime-request-${++nextRequest}`,
      pipeConnector: transport,
    });
    await client.hello(2);
    const states: string[] = [];
    await client.subscribe((event) => states.push(event.snapshot.modelDataPlane));

    const firstStart = client.executeRuntimeCommand("start");
    const repeatedStart = client.executeRuntimeCommand("start");
    const stop = client.executeRuntimeCommand("stop");
    releaseStart?.();

    await expect(firstStart).resolves.toMatchObject({ outcome: "completed" });
    await expect(repeatedStart).resolves.toMatchObject({ outcome: "unchanged" });
    await expect(stop).resolves.toMatchObject({
      outcome: "completed",
      snapshot: { modelDataPlane: "stopped" },
    });
    expect(states).toEqual(["starting", "running", "stopping", "stopped"]);
    expect({ activeListeners, maximumActiveListeners }).toEqual({
      activeListeners: 0,
      maximumActiveListeners: 1,
    });
    await client.close();
  });

  it("closes the old listener before restart and rejects restart while stopped", async () => {
    const lifecycle: string[] = [];
    let listenerId = 0;
    const supervisor = createDataPlaneRuntimeSupervisor({
      host: "127.0.0.1",
      port: 48768,
      readProvider: () => "unconfigured",
      startListener: async () => {
        const id = ++listenerId;
        lifecycle.push(`start-${id}`);
        return {
          close: async () => {
            lifecycle.push(`stop-${id}`);
          },
        };
      },
    });
    const transport = createNodePipeTransport();
    const host = await startControlPlane({
      endpoint: {
        address: `\\\\.\\pipe\\luckytoken-runtime-${process.pid}-${++nextPipe}`,
        capability: "runtime-test-capability-012345678901234567890",
      },
      application: { id: "luckytoken", version: "test" },
      initialStatus: supervisor.initialStatus,
      runtimeCommandHandler: supervisor.execute,
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
    });
    hosts.push(host);
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `runtime-request-${++nextRequest}`,
      pipeConnector: transport,
    });
    await client.hello(2);

    await expect(client.executeRuntimeCommand("restart")).resolves.toMatchObject({
      outcome: "conflict",
      conflict: {
        code: "restart_requires_running",
        message: "Start the model gateway before restarting it.",
      },
      snapshot: { modelDataPlane: "stopped" },
    });
    await client.executeRuntimeCommand("start");
    await client.executeRuntimeCommand("restart");

    expect(lifecycle).toEqual(["start-1", "stop-1", "start-2"]);
    await client.executeRuntimeCommand("stop");
    await client.close();
  });

  it("keeps a fixed occupied port and exposes only a closed actionable failure", async () => {
    const rawSecret = "raw-listen-secret";
    const supervisor = createDataPlaneRuntimeSupervisor({
      host: "127.0.0.1",
      port: 48769,
      readProvider: () => "unconfigured",
      startListener: async () => {
        throw Object.assign(new Error(rawSecret), { code: "EADDRINUSE" });
      },
    });
    const transport = createNodePipeTransport();
    const host = await startControlPlane({
      endpoint: {
        address: `\\\\.\\pipe\\luckytoken-runtime-${process.pid}-${++nextPipe}`,
        capability: "runtime-test-capability-012345678901234567890",
      },
      application: { id: "luckytoken", version: "test" },
      initialStatus: supervisor.initialStatus,
      runtimeCommandHandler: supervisor.execute,
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
    });
    hosts.push(host);
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `runtime-request-${++nextRequest}`,
      pipeConnector: transport,
    });
    await client.hello(2);

    const result = await client.executeRuntimeCommand("start");

    expect(result).toMatchObject({
      outcome: "failed",
      snapshot: {
        modelDataPlane: "failed",
        dataPlane: {
          configuredOrigin: "http://127.0.0.1:48769",
          configuredPort: 48769,
          failure: {
            code: "port_in_use",
            message:
              "The configured port is already in use. Stop the other application or choose a different port.",
          },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(rawSecret);
    await client.close();
  });

  it("refuses to create a replacement after the old listener fails to close", async () => {
    let starts = 0;
    const supervisor = createDataPlaneRuntimeSupervisor({
      host: "127.0.0.1",
      port: 48770,
      readProvider: () => "unconfigured",
      startListener: async () => {
        starts += 1;
        return {
          close: async () => {
            throw new Error("uncertain close state");
          },
        };
      },
    });
    const transport = createNodePipeTransport();
    const host = await startControlPlane({
      endpoint: {
        address: `\\\\.\\pipe\\luckytoken-runtime-${process.pid}-${++nextPipe}`,
        capability: "runtime-test-capability-012345678901234567890",
      },
      application: { id: "luckytoken", version: "test" },
      initialStatus: supervisor.initialStatus,
      runtimeCommandHandler: supervisor.execute,
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
    });
    hosts.push(host);
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `runtime-request-${++nextRequest}`,
      pipeConnector: transport,
    });
    await client.hello(2);
    await client.executeRuntimeCommand("start");
    await expect(client.executeRuntimeCommand("stop")).resolves.toMatchObject({
      outcome: "failed",
      snapshot: {
        modelDataPlane: "failed",
        dataPlane: { failure: { code: "stop_failed" } },
      },
    });
    await expect(client.executeRuntimeCommand("stop")).resolves.toMatchObject({
      outcome: "unchanged",
      snapshot: {
        modelDataPlane: "failed",
        dataPlane: { failure: { code: "stop_failed" } },
      },
    });

    await expect(client.executeRuntimeCommand("start")).resolves.toMatchObject({
      outcome: "conflict",
      conflict: {
        code: "application_restart_required",
        message: "Restart LuckyToken before starting the model gateway again.",
      },
    });
    expect(starts).toBe(1);
    await client.close();
  });

  it("makes real HTTP routes reachable only while running and leaves Control Plane queries alive", async () => {
    const runtime = createLuckyTokenRuntime({
      clientProtocols: [
        {
          method: "POST",
          pathname: "/v1/messages",
          handle: async () => new Response("anthropic"),
        },
        {
          method: "POST",
          pathname: "/v1/responses",
          handle: async () => new Response("responses"),
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
        return activeServer;
      },
    });
    const transport = createNodePipeTransport();
    const host = await startControlPlane({
      endpoint: {
        address: `\\\\.\\pipe\\luckytoken-runtime-${process.pid}-${++nextPipe}`,
        capability: "runtime-test-capability-012345678901234567890",
      },
      application: { id: "luckytoken", version: "test" },
      initialStatus: supervisor.initialStatus,
      runtimeCommandHandler: supervisor.execute,
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
    });
    hosts.push(host);
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `runtime-request-${++nextRequest}`,
      pipeConnector: transport,
    });
    await client.hello(2);

    await client.executeRuntimeCommand("start");
    const origin = activeServer?.origin;
    if (origin === undefined) throw new Error("HTTP listener did not start");
    const [anthropic, responses] = await Promise.all([
      fetch(`${origin}/v1/messages`, { method: "POST" }),
      fetch(`${origin}/v1/responses`, { method: "POST" }),
    ]);
    expect(await anthropic.text()).toBe("anthropic");
    expect(await responses.text()).toBe("responses");

    await client.executeRuntimeCommand("stop");
    await expect(fetch(`${origin}/v1/messages`, { method: "POST" })).rejects.toThrow();
    await expect(client.getStatus()).resolves.toMatchObject({
      modelDataPlane: "stopped",
    });
    await client.close();
  });
});
