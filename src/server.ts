import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";

import type { LuckyTokenRuntime } from "./runtime.js";

export interface LuckyTokenHttpServerOptions {
  readonly runtime: LuckyTokenRuntime;
  readonly host?: string;
  readonly port?: number;
}

/** Deterministic time adapter for the quit drain (Ticket 05): production uses
 *  the real clock; tests control both elapsed time and wake-ups. Sleeps are
 *  cancellable so an early drain never leaves a timer keeping the process
 *  alive. */
export interface DrainClock {
  now(): number;
  sleep(ms: number): {
    readonly promise: Promise<void>;
    cancel(): void;
  };
}

export type DrainOutcome = "drained" | "timed_out";

export interface ServerDrainOptions {
  /** Deterministic clock/abort adapter; defaults to the real clock. */
  readonly clock?: DrainClock;
}

export interface RunningLuckyTokenHttpServer {
  readonly host: string;
  readonly port: number;
  readonly origin: string;
  /** Graceful quit drain (Ticket 05): stops accepting new requests, waits
   *  for the active set to empty, then aborts the remaining requests when
   *  the timeout elapses. Resolves with the typed outcome before the owner
   *  exits. */
  drain(timeoutMs: number, options?: ServerDrainOptions): Promise<DrainOutcome>;
  close(): Promise<void>;
}

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) headers.append(name, value);
  }
  return headers;
}

function createWebRequest(
  request: IncomingMessage,
  origin: string,
  signal: AbortSignal,
): Request {
  const method = request.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(new URL(request.url ?? "/", origin), {
    method,
    headers: requestHeaders(request),
    ...(hasBody
      ? {
          body: Readable.toWeb(request) as ReadableStream<Uint8Array>,
          duplex: "half" as const,
        }
      : {}),
    signal,
  });
}

async function writeWebResponse(
  target: ServerResponse,
  response: Response,
): Promise<void> {
  const body = Buffer.from(await response.arrayBuffer());
  target.statusCode = response.status;
  for (const [name, value] of response.headers) target.setHeader(name, value);
  target.end(body);
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) reject(error);
      else resolve();
    });
  });
}

export async function startLuckyTokenHttpServer(
  options: LuckyTokenHttpServerOptions,
): Promise<RunningLuckyTokenHttpServer> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 3000;
  let origin = "";
  interface ActiveRequest {
    readonly controller: AbortController;
    readonly response: ServerResponse;
  }
  const activeRequests = new Set<ActiveRequest>();
  const server = createServer((request, response) => {
    const controller = new AbortController();
    const activeRequest: ActiveRequest = { controller, response };
    activeRequests.add(activeRequest);
    const abortRequest = (reason: unknown): void => {
      if (!controller.signal.aborted) controller.abort(reason);
    };
    const onRequestAborted = (): void => {
      abortRequest(new Error("Client request connection was aborted"));
    };
    const onResponseClose = (): void => {
      if (!response.writableFinished) {
        abortRequest(new Error("Client response connection closed early"));
      }
    };
    request.once("aborted", onRequestAborted);
    response.once("close", onResponseClose);
    void options.runtime
      .handle(createWebRequest(request, origin, controller.signal))
      .then(async (result) => {
        if (!controller.signal.aborted && !response.destroyed) {
          await writeWebResponse(response, result);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted && !response.destroyed) {
          if (!response.headersSent) response.writeHead(500);
          response.end();
        }
      })
      .finally(() => {
        activeRequests.delete(activeRequest);
        request.off("aborted", onRequestAborted);
        response.off("close", onResponseClose);
      });
  });

  await listen(server, host, requestedPort);
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("LuckyToken HTTP server did not expose a TCP address");
  }
  const port = address.port;
  origin = `http://${host}:${port}`;
  let closed = false;
  let closing: Promise<void> | undefined;
  let draining: Promise<DrainOutcome> | undefined;
  const shutdownReason = new Error("LuckyToken HTTP server is shutting down");
  const abortActive = (): void => {
    for (const active of activeRequests) {
      if (!active.controller.signal.aborted) {
        active.controller.abort(shutdownReason);
      }
      if (!active.response.destroyed) active.response.destroy(shutdownReason);
    }
  };
  const realClock: DrainClock = {
    now: Date.now,
    sleep: (ms) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const promise = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      });
      return {
        promise,
        cancel: () => {
          if (timer !== undefined) clearTimeout(timer);
        },
      };
    },
  };

  return Object.freeze({
    host,
    port,
    origin,
    drain(timeoutMs: number, options?: ServerDrainOptions): Promise<DrainOutcome> {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
        return Promise.reject(
          new Error("Drain timeout must be a non-negative integer"),
        );
      }
      if (closed) return Promise.resolve("drained");
      if (draining !== undefined) return draining;
      if (closing !== undefined) return closing.then(() => "drained");
      const clock = options?.clock ?? realClock;
      // close() stops accepting and resolves when every connection ended;
      // in-flight requests keep running while the active set drains.
      const serverClosed = closeServer(server);
      const timeout = clock.sleep(timeoutMs);
      const timedOut = timeout.promise.then((): DrainOutcome => {
        abortActive();
        return "timed_out";
      });
      draining = Promise.race([
        serverClosed.then((): DrainOutcome => "drained"),
        timedOut,
      ]).then((outcome) => {
        // An early drain must not leave the timeout timer pending: it would
        // keep the owner process alive past the quit.
        timeout.cancel();
        closed = true;
        return outcome;
      });
      return draining;
    },
    close(): Promise<void> {
      if (closed) return Promise.resolve();
      if (closing !== undefined) return closing;
      if (draining !== undefined) return draining.then(() => undefined);
      const serverClosed = closeServer(server);
      abortActive();
      closing = serverClosed.then(() => {
        closed = true;
      });
      return closing;
    },
  });
}
