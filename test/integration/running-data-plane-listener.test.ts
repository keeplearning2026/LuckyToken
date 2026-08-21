import { createServer } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startRunningDataPlaneListener } from "../../src/running-data-plane-listener.js";
import { createLuckyTokenRuntime } from "../../src/runtime.js";

describe("RunningDataPlaneListener serving transaction", () => {
  const closeListeners: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(closeListeners.splice(0).map((close) => close()));
  });

  it("waits for handler unwind before one shared finalization", async () => {
    let started!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const unwind = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finalize = vi.fn(async () => undefined);
    const listener = await startRunningDataPlaneListener({
      host: "127.0.0.1",
      port: 0,
      shutdownController: new AbortController(),
      dataPlane: {
        runtime: createLuckyTokenRuntime({
          clientProtocols: [
            {
              method: "POST",
              pathname: "/controlled",
              handle: async (request) => {
                started();
                await new Promise<void>((resolve) =>
                  request.signal.addEventListener("abort", () => resolve(), {
                    once: true,
                  }),
                );
                await unwind;
                throw request.signal.reason;
              },
            },
          ],
        }),
        close: finalize,
      },
    });
    closeListeners.push(() => listener.close());
    const request = fetch(`${listener.origin}/controlled`, { method: "POST" });
    await handlerStarted;

    const closes = [listener.close(), listener.close(), listener.close()];
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finalize).not.toHaveBeenCalled();
    release();

    await Promise.all(closes);
    await expect(request).rejects.toThrow();
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it("finalizes an already-created Data Plane when HTTP bind fails", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", resolve);
    });
    closeListeners.push(
      () =>
        new Promise<void>((resolve, reject) =>
          occupied.close((error) => error === undefined ? resolve() : reject(error)),
        ),
    );
    const address = occupied.address();
    if (address === null || typeof address === "string") {
      throw new Error("occupied server has no TCP address");
    }
    const finalize = vi.fn(async () => undefined);

    await expect(
      startRunningDataPlaneListener({
        host: "127.0.0.1",
        port: address.port,
        shutdownController: new AbortController(),
        dataPlane: {
          runtime: createLuckyTokenRuntime({ clientProtocols: [] }),
          close: finalize,
        },
      }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(finalize).toHaveBeenCalledTimes(1);
  });
});
