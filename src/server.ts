import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { type Duplex, Readable } from "node:stream";

import { HttpRequestAbortedError } from "./http.js";
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

const WEBSOCKET_FALLBACK_BODY = Buffer.from(
  JSON.stringify({
    error: {
      message:
        "LuckyToken supports HTTP transport only. Retry over HTTP instead of WebSocket.",
      type: "upgrade_required",
      code: "websocket_transport_not_supported",
      param: null,
    },
  }),
  "utf8",
);

function isWebSocketUpgrade(request: IncomingMessage): boolean {
  return request.headers.upgrade?.toLowerCase() === "websocket";
}

function rejectWebSocketUpgrade(socket: Duplex): void {
  const responseHead = [
    "HTTP/1.1 426 Upgrade Required",
    "Content-Type: application/json; charset=utf-8",
    `Content-Length: ${WEBSOCKET_FALLBACK_BODY.byteLength}`,
    "Cache-Control: no-store",
    "Connection: close",
    "",
    "",
  ].join("\r\n");
  socket.end(
    Buffer.concat([
      Buffer.from(responseHead, "ascii"),
      WEBSOCKET_FALLBACK_BODY,
    ]),
  );
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
    readonly completion: Promise<void>;
  }
  const activeRequests = new Set<ActiveRequest>();
  let accepting = true;
  const server = createServer((request, response) => {
    if (!accepting) {
      request.resume();
      response.writeHead(503, { connection: "close" });
      response.end();
      return;
    }
    const controller = new AbortController();
    let settleCompletion: (() => void) | undefined;
    const completion = new Promise<void>((resolve) => {
      settleCompletion = resolve;
    });
    const activeRequest: ActiveRequest = { controller, response, completion };
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
      .catch((error: unknown) => {
        // A live client (not disconnected, not destroyed) still receives a
        // truthful 500 when the request was cancelled or the handler failed
        // unexpectedly. A real accepted request keeps its exact ledger
        // request id through the transport-synthesized response (Ticket 18
        // correlation seam on the aborted-error rejection); a disconnected
        // client cannot receive a response and never gets one.
        if (!controller.signal.aborted && !response.destroyed) {
          const requestId =
            error instanceof HttpRequestAbortedError
              ? error.requestId
              : undefined;
          if (!response.headersSent) {
            response.writeHead(
              500,
              requestId === undefined
                ? undefined
                : { "x-luckytoken-request-id": requestId },
            );
          }
          response.end();
        }
      })
      .finally(() => {
        activeRequests.delete(activeRequest);
        request.off("aborted", onRequestAborted);
        response.off("close", onResponseClose);
        settleCompletion?.();
      });
  });
  server.on("upgrade", (request, socket) => {
    socket.once("error", () => socket.destroy());
    if (!accepting || !isWebSocketUpgrade(request)) {
      socket.destroy();
      return;
    }
    rejectWebSocketUpgrade(socket);
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
  const awaitQuiescence = async (): Promise<void> => {
    await Promise.all([...activeRequests].map((active) => active.completion));
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
      // Admission closes synchronously so the active set is a closed set before
      // its completion promises are captured. Existing connections may still
      // deliver HTTP requests after server.close().
      accepting = false;
      const serverClosed = closeServer(server);
      const timeout = clock.sleep(timeoutMs);
      const quiescent = Promise.all([serverClosed, awaitQuiescence()]);
      draining = Promise.race([
        quiescent.then(() => false),
        timeout.promise.then(() => true),
      ]).then(async (timedOut): Promise<DrainOutcome> => {
        if (timedOut) {
          abortActive();
          server.closeAllConnections();
          await quiescent;
        }
        // An early drain must not leave the timeout timer pending: it would
        // keep the owner process alive past the quit.
        timeout.cancel();
        closed = true;
        return timedOut ? "timed_out" : "drained";
      });
      return draining;
    },
    close(): Promise<void> {
      if (closed) return Promise.resolve();
      if (closing !== undefined) return closing;
      if (draining !== undefined) return draining.then(() => undefined);
      accepting = false;
      const serverClosed = closeServer(server);
      abortActive();
      server.closeAllConnections();
      closing = Promise.all([serverClosed, awaitQuiescence()]).then(() => {
        closed = true;
      });
      return closing;
    },
  });
}
