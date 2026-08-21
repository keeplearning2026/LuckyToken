import type { LuckyTokenRuntime } from "./runtime.js";
import {
  startLuckyTokenHttpServer,
  type DrainOutcome,
} from "./server.js";

export interface FinalizableDataPlane {
  readonly runtime: LuckyTokenRuntime;
  close(): Promise<void>;
}

export interface RunningDataPlaneListener {
  readonly origin: string;
  close(): Promise<void>;
  drain(timeoutMs: number): Promise<DrainOutcome>;
}

/**
 * Owns the complete serving shutdown transaction.  The Data Plane finalizer
 * is never invoked until the HTTP boundary has stopped admission and every
 * runtime invocation has settled.
 */
export async function startRunningDataPlaneListener(options: {
  readonly host: string;
  readonly port: number;
  readonly dataPlane: FinalizableDataPlane;
  readonly shutdownController: AbortController;
}): Promise<RunningDataPlaneListener> {
  let server: Awaited<ReturnType<typeof startLuckyTokenHttpServer>>;
  try {
    server = await startLuckyTokenHttpServer({
      runtime: options.dataPlane.runtime,
      host: options.host,
      port: options.port,
    });
  } catch (error) {
    options.shutdownController.abort(
      new Error("LuckyToken model gateway startup failed"),
    );
    try {
      await options.dataPlane.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "LuckyToken model gateway startup failed and its Data Plane could not be finalized",
      );
    }
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  let drainPromise: Promise<DrainOutcome> | undefined;
  return Object.freeze({
    origin: server.origin,
    close(): Promise<void> {
      if (closePromise !== undefined) return closePromise;
      if (drainPromise !== undefined) return drainPromise.then(() => undefined);
      closePromise = (async () => {
        options.shutdownController.abort(
          new Error("LuckyToken model gateway is stopping"),
        );
        await server.close();
        await options.dataPlane.close();
      })();
      return closePromise;
    },
    drain(timeoutMs: number): Promise<DrainOutcome> {
      if (drainPromise !== undefined) return drainPromise;
      if (closePromise !== undefined) return closePromise.then(() => "drained");
      drainPromise = (async () => {
        const outcome = await server.drain(timeoutMs);
        options.shutdownController.abort(
          new Error("LuckyToken model gateway has stopped"),
        );
        await options.dataPlane.close();
        return outcome;
      })();
      return drainPromise;
    },
  });
}
