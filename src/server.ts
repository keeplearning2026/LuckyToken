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

export interface RunningLuckyTokenHttpServer {
  readonly host: string;
  readonly port: number;
  readonly origin: string;
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

  return Object.freeze({
    host,
    port,
    origin,
    close(): Promise<void> {
      if (closed) return Promise.resolve();
      if (closing !== undefined) return closing;
      const shutdownReason = new Error("LuckyToken HTTP server is shutting down");
      const serverClosed = closeServer(server);
      for (const active of activeRequests) {
        if (!active.controller.signal.aborted) {
          active.controller.abort(shutdownReason);
        }
        if (!active.response.destroyed) active.response.destroy(shutdownReason);
      }
      closing = serverClosed.then(() => {
        closed = true;
      });
      return closing;
    },
  });
}
