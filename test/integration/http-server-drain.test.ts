import { connect as connectSocket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createTokenRuntime } from "../../src/runtime.js";
import {
  startTokenHttpServer,
  type DrainClock,
  type RunningTokenHttpServer,
} from "../../src/server.js";

/** Deterministic clock: sleep resolves only when the test advances it, so
 *  the drain timeout fires exactly when the test decides. */
function createFakeClock(): {
  readonly clock: DrainClock;
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
    advance() {
      for (const resolve of sleepers.splice(0)) resolve();
    },
  };
}

describe("Data Plane HTTP drain lifecycle", () => {
  const servers: RunningTokenHttpServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("stops accepting, waits for the active set to empty, and reports drained", async () => {
    let handlerStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      handlerStarted = resolve;
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = createTokenRuntime({
      clientProtocols: [
        {
          method: "POST",
          pathname: "/controlled",
          handle: async () => {
            handlerStarted?.();
            await gate;
            return new Response("completed-after-drain");
          },
        },
      ],
    });
    const server = await startTokenHttpServer({ runtime, port: 0 });
    servers.push(server);
    const { clock } = createFakeClock();

    const inFlight = fetch(`${server.origin}/controlled`, { method: "POST" });
    await started;

    const drain = server.drain(5_000, { clock });

    // New requests are refused once the quit drain stops the listener.
    await expect(
      fetch(`${server.origin}/controlled`, { method: "POST" }),
    ).rejects.toThrow();

    release?.();
    await expect(inFlight).resolves.toMatchObject({ status: 200 });
    expect(await (await inFlight).text()).toBe("completed-after-drain");
    await expect(drain).resolves.toBe("drained");
  });

  it("does not change the HTTP reason phrase for an existing Responses route", async () => {
    const runtime = createTokenRuntime({
      clientProtocols: [{
        method: "POST",
        pathname: "/v1/responses",
        handle: async () => new Response("response", {
          status: 299,
          statusText: "Protocol Custom Reason",
        }),
      }],
    });
    const server = await startTokenHttpServer({ runtime, port: 0 });
    servers.push(server);

    const response = await fetch(`${server.origin}/v1/responses`, {
      method: "POST",
    });

    expect(response.status).toBe(299);
    expect(response.statusText).not.toBe("Protocol Custom Reason");
  });

  it("does not admit a second request from an existing keep-alive connection", async () => {
    let firstStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const handledPaths: string[] = [];
    const runtime = createTokenRuntime({
      clientProtocols: [
        {
          method: "GET",
          pathname: "/first",
          handle: async () => {
            handledPaths.push("/first");
            firstStarted?.();
            await firstGate;
            return new Response("first");
          },
        },
        {
          method: "GET",
          pathname: "/second",
          handle: async () => {
            handledPaths.push("/second");
            return new Response("second");
          },
        },
      ],
    });
    const server = await startTokenHttpServer({ runtime, port: 0 });
    servers.push(server);
    const socket = connectSocket(server.port, server.host);
    socket.on("error", () => undefined);
    await new Promise<void>((resolve) => socket.once("connect", resolve));

    socket.write(
      "GET /first HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n",
    );
    await started;

    const drain = server.drain(5_000, { clock: createFakeClock().clock });
    socket.write(
      "GET /second HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    const pathsBeforeRelease = [...handledPaths];
    releaseFirst?.();
    await expect(drain).resolves.toBe("drained");
    socket.destroy();
    expect(pathsBeforeRelease).toEqual(["/first"]);
  });

  it("aborts the remaining active set after the drain timeout and reports timed_out", async () => {
    let handlerStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      handlerStarted = resolve;
    });
    let releaseUnwind: (() => void) | undefined;
    const unwind = new Promise<void>((resolve) => {
      releaseUnwind = resolve;
    });
    let handlerSettled = false;
    const runtime = createTokenRuntime({
      clientProtocols: [
        {
          method: "POST",
          pathname: "/never-completes",
          handle: async (request) => {
            handlerStarted?.();
            await new Promise<void>((resolve) => {
              request.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
            await unwind;
            handlerSettled = true;
            throw request.signal.reason;
          },
        },
      ],
    });
    const server = await startTokenHttpServer({ runtime, port: 0 });
    servers.push(server);
    const fakeClock = createFakeClock();

    const inFlight = fetch(`${server.origin}/never-completes`, {
      method: "POST",
    });
    await started;

    const drain = server.drain(1_000, { clock: fakeClock.clock });
    let settled = false;
    void drain.then(() => {
      settled = true;
    });
    expect(settled).toBe(false);

    fakeClock.advance();

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(handlerSettled).toBe(false);
    releaseUnwind?.();
    await expect(drain).resolves.toBe("timed_out");
    expect(handlerSettled).toBe(true);
    await expect(inFlight).rejects.toThrow();
  });

  it("drains immediately with no active requests and stays idempotent", async () => {
    const runtime = createTokenRuntime({ clientProtocols: [] });
    const server = await startTokenHttpServer({ runtime, port: 0 });
    servers.push(server);

    const first = server.drain(1_000, { clock: createFakeClock().clock });
    const second = server.drain(1_000);

    await expect(first).resolves.toBe("drained");
    await expect(second).resolves.toBe("drained");
    await expect(server.close()).resolves.toBeUndefined();
    await expect(server.drain(1_000)).resolves.toBe("drained");
  });
});
