import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { type Duplex, Readable } from "node:stream";

import type {
  RequestJourneyCloseInput,
  RequestJourneyObservationAuthority,
} from "./diagnostics/contract.js";
import { publishSafeHttpEnvelopeArtifact } from "./diagnostics/http-envelope.js";
import {
  beginRequestJourney,
  closeRequestJourney,
  createRequestJourneyId,
  HttpRequestAbortedError,
  observeRequestJourney,
  type ClientProtocolRequestContext,
} from "./http.js";
import type { TokenRuntime } from "./runtime.js";
import type { WebSocketUpgradeHandler } from "./websocket-upgrade.js";
import { preservesDirectStatusText } from "./direct-http-response.js";

export interface TokenHttpServerOptions {
  readonly runtime: TokenRuntime;
  readonly host?: string;
  readonly port?: number;
  readonly diagnostics?: RequestJourneyObservationAuthority;
  readonly createRequestId?: () => string;
  readonly webSocketUpgrade?: WebSocketUpgradeHandler;
  /** Fail-open observation of the server-owned in-flight request count. */
  readonly onActiveRequestCountChanged?: (count: number) => void;
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

export interface RunningTokenHttpServer {
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
        "Token supports HTTP transport only. Retry over HTTP instead of WebSocket.",
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

function rejectWebSocketUpgrade(
  socket: Duplex,
  context: ClientProtocolRequestContext,
): void {
  const primaryLocation = {
    phase: "protocol_ingress",
    step: "reject_transport",
  } as const;
  const failureId = "p1.reject_transport.websocket";
  observeRequestJourney(context, {
    kind: "step_entered",
    stepInstanceId: "p1.reject_transport",
    location: primaryLocation,
  });
  observeRequestJourney(context, {
    kind: "step_completed",
    stepInstanceId: "p1.reject_transport",
    completion: "failed",
    operation: "unsupported_transport",
    location: primaryLocation,
  });
  observeRequestJourney(context, {
    kind: "failure_detected",
    failureId,
    role: "primary",
    classification: "unsupported_websocket_transport",
    origin: "client",
    originPrecision: "exact",
    location: primaryLocation,
  });

  const presentationLocation = {
    phase: "client_response_preparation",
    step: "render_transport_error",
  } as const;
  observeRequestJourney(context, {
    kind: "step_entered",
    stepInstanceId: "p6.render_transport_error",
    location: presentationLocation,
  });
  observeRequestJourney(context, {
    kind: "client_response_prepared",
    status: 426,
    mediaType: "application/json; charset=utf-8",
    location: presentationLocation,
  });
  observeRequestJourney(context, {
    kind: "step_completed",
    stepInstanceId: "p6.render_transport_error",
    completion: "success",
    operation: "unsupported_transport",
    location: presentationLocation,
  });

  const outcomeLocation = {
    phase: "outcome_commit",
    step: "commit_request_outcome",
  } as const;
  observeRequestJourney(context, {
    kind: "step_entered",
    stepInstanceId: "p7.commit_request_outcome",
    location: outcomeLocation,
  });
  observeRequestJourney(context, {
    kind: "work_outcome_committed",
    outcome: "failed",
    terminalAuthority: "http_transport",
    location: outcomeLocation,
  });
  observeRequestJourney(context, {
    kind: "step_completed",
    stepInstanceId: "p7.commit_request_outcome",
    completion: "success",
    operation: "unsupported_transport",
    location: outcomeLocation,
  });

  const responseHead = [
    "HTTP/1.1 426 Upgrade Required",
    "Content-Type: application/json; charset=utf-8",
    `Content-Length: ${WEBSOCKET_FALLBACK_BODY.byteLength}`,
    "Cache-Control: no-store",
    "Connection: close",
    "",
    "",
  ].join("\r\n");
  const responseBytes = Buffer.concat([
    Buffer.from(responseHead, "ascii"),
    WEBSOCKET_FALLBACK_BODY,
  ]);
  const handoffLocation = {
    phase: "http_handoff",
    step: "write_upgrade_response",
  } as const;
  const handoffStep = "p8.write_upgrade_response";
  let settled = false;
  const cleanup = (): void => {
    socket.off("finish", onFinish);
    socket.off("close", onClose);
    socket.off("error", onError);
  };
  const settle = (outcome: "finished" | "closed" | "failed"): void => {
    if (settled) return;
    settled = true;
    cleanup();
    observeRequestJourney(context, {
      kind: "handoff_observed",
      outcome,
      transport: "http",
      writableFinished: socket.writableFinished,
      location: handoffLocation,
    });
    observeRequestJourney(context, {
      kind: "step_completed",
      stepInstanceId: handoffStep,
      completion: outcome === "finished" ? "success" : "failed",
      location: handoffLocation,
    });
    closeRequestJourney(context, {
      outcome: "failed",
      primaryFailureId: failureId,
      closeReason: "unsupported_websocket_transport",
      lastKnownLocation: handoffLocation,
    });
  };
  function onFinish(): void {
    settle("finished");
  }
  function onClose(): void {
    if (!socket.writableFinished) settle("closed");
  }
  function onError(): void {
    settle("failed");
  }

  observeRequestJourney(context, {
    kind: "step_entered",
    stepInstanceId: handoffStep,
    location: handoffLocation,
  });
  observeRequestJourney(context, {
    kind: "handoff_observed",
    outcome: "prepared",
    transport: "http",
    writableFinished: socket.writableFinished,
    location: handoffLocation,
  });
  socket.once("finish", onFinish);
  socket.once("close", onClose);
  socket.once("error", onError);
  try {
    socket.end(responseBytes);
  } catch {
    settle("failed");
    socket.destroy();
  }
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

type HandoffOutcome = "finished" | "closed" | "failed";

async function writeWebResponse(
  target: ServerResponse,
  response: Response,
  context: ClientProtocolRequestContext,
  preserveStatusText: boolean,
): Promise<HandoffOutcome> {
  const location = {
    phase: "http_handoff",
    step: "write_http_response",
  } as const;
  const stepInstanceId = "p8.write_http_response";
  let terminalObserved = false;
  const observeTerminal = (outcome: HandoffOutcome): void => {
    if (terminalObserved) return;
    terminalObserved = true;
    observeRequestJourney(context, {
      kind: "handoff_observed",
      outcome,
      transport: "http",
      writableFinished: target.writableFinished,
      location,
    });
    observeRequestJourney(context, {
      kind: "step_completed",
      stepInstanceId,
      completion: outcome === "finished" ? "success" : "failed",
      location,
    });
  };

  observeRequestJourney(context, {
    kind: "step_entered",
    stepInstanceId,
    location,
  });
  try {
    // This is the existing single materialization seam. Diagnostics observes
    // a bounded copy of these bytes and never clones or re-reads the Response.
    const body = Buffer.from(await response.arrayBuffer());
    publishSafeHttpEnvelopeArtifact(context.journey, {
      artifactId: "client_response_envelope",
      artifactKind: "client_response_envelope",
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      location,
    });
    const capturedBytes = body.byteLength;
    observeRequestJourney(context, {
      kind: "artifact_observed",
      artifactId: "client_response_wire",
      artifactKind: "client_response_wire",
      state: capturedBytes < body.byteLength ? "partial" : "captured",
      ...(response.headers.get("content-type") === null
        ? {}
        : { mediaType: response.headers.get("content-type")! }),
      bytes: new Uint8Array(
        body.buffer,
        body.byteOffset,
        capturedBytes,
      ),
      originalBytes: body.byteLength,
      capturedBytes,
      truncated: capturedBytes < body.byteLength,
      location,
    });
    if (target.destroyed) {
      observeTerminal("closed");
      return "closed";
    }
    return await new Promise<HandoffOutcome>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        target.off("finish", onFinish);
        target.off("close", onClose);
        target.off("error", onError);
      };
      const settle = (
        outcome: HandoffOutcome,
        error?: unknown,
      ): void => {
        if (settled) return;
        settled = true;
        cleanup();
        observeTerminal(outcome);
        if (error === undefined) resolve(outcome);
        else reject(error);
      };
      function onFinish(): void {
        settle("finished");
      }
      function onClose(): void {
        if (!target.writableFinished) settle("closed");
      }
      function onError(error: Error): void {
        settle("failed", error);
      }

      target.once("finish", onFinish);
      target.once("close", onClose);
      target.once("error", onError);
      try {
        target.statusCode = response.status;
        if (preserveStatusText && response.statusText.length > 0) {
          target.statusMessage = response.statusText;
        }
        for (const [name, value] of response.headers) {
          if (name.toLowerCase() === "set-cookie") continue;
          target.setHeader(name, value);
        }
        const setCookies = response.headers.getSetCookie();
        if (setCookies.length > 0) target.setHeader("set-cookie", setCookies);
        // Prepared means the complete response has been materialized and the
        // atomic status/header/body write is ready, not that Node has already
        // finished handing bytes to the socket.
        observeRequestJourney(context, {
          kind: "handoff_observed",
          outcome: "prepared",
          transport: "http",
          writableFinished: target.writableFinished,
          location,
        });
        target.end(body);
      } catch (error) {
        settle("failed", error);
      }
    });
  } catch (error) {
    observeTerminal("failed");
    throw error;
  }
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

export async function startTokenHttpServer(
  options: TokenHttpServerOptions,
): Promise<RunningTokenHttpServer> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 3000;
  let origin = "";
  interface ActiveRequest {
    readonly controller: AbortController;
    readonly response: ServerResponse;
    readonly completion: Promise<void>;
  }
  const activeRequests = new Set<ActiveRequest>();
  const activeWebSocketUpgrades = new Set<Promise<void>>();
  let lastPublishedActiveRequestCount = -1;
  const publishActiveRequestCount = (): void => {
    const count = activeRequests.size + activeWebSocketUpgrades.size;
    if (count === lastPublishedActiveRequestCount) return;
    lastPublishedActiveRequestCount = count;
    queueMicrotask(() => {
      try {
        options.onActiveRequestCountChanged?.(count);
      } catch {
        // Product observation cannot affect request admission or completion.
      }
    });
  };
  let accepting = true;
  const server = createServer((request, response) => {
    const controller = new AbortController();
    const method = request.method ?? "GET";
    const pathname = new URL(request.url ?? "/", origin).pathname;
    const context = beginRequestJourney(options.diagnostics, {
      requestId: createRequestJourneyId(options.createRequestId),
      operationCandidate: "pending",
      transport: "http",
      method,
      path: pathname,
      acceptedAt: Date.now(),
      cancellation: {
        caller: "active",
        shutdown: "not_bound",
      },
    });
    observeRequestJourney(context, {
      kind: "step_entered",
      stepInstanceId: "p0.admit_http_request",
      location: { phase: "http_admission", step: "admit_http_request" },
    });
    observeRequestJourney(context, {
      kind: "step_completed",
      stepInstanceId: "p0.admit_http_request",
      completion: "success",
      location: { phase: "http_admission", step: "admit_http_request" },
    });
    publishSafeHttpEnvelopeArtifact(context.journey, {
      artifactId: "client_request_envelope",
      artifactKind: "client_request_envelope",
      method,
      url: new URL(request.url ?? "/", origin).toString(),
      headers: requestHeaders(request),
      location: { phase: "http_admission", step: "admit_http_request" },
    });
    if (!accepting) {
      const failureLocation = {
        phase: "http_admission",
        step: "reject_server_draining",
      } as const;
      const failureId = `${context.requestId}:server_draining`;
      observeRequestJourney(context, {
        kind: "step_entered",
        stepInstanceId: "p0.reject_server_draining",
        location: failureLocation,
      });
      observeRequestJourney(context, {
        kind: "step_completed",
        stepInstanceId: "p0.reject_server_draining",
        completion: "failed",
        location: failureLocation,
      });
      observeRequestJourney(context, {
        kind: "failure_detected",
        failureId,
        role: "primary",
        classification: "server_draining",
        origin: "Token",
        originPrecision: "exact",
        location: failureLocation,
      });
      observeRequestJourney(context, {
        kind: "client_response_prepared",
        status: 503,
        location: {
          phase: "client_response_preparation",
          step: "prepare_server_draining_response",
        },
      });
      observeRequestJourney(context, {
        kind: "work_outcome_committed",
        outcome: "failed",
        terminalAuthority: "http_server",
        location: {
          phase: "outcome_commit",
          step: "commit_request_outcome",
        },
      });
      request.resume();
      response.writeHead(503, {
        connection: "close",
        "x-token-request-id": context.requestId,
      });
      response.end();
      closeRequestJourney(context, {
        outcome: "failed",
        primaryFailureId: failureId,
        closeReason: "server_draining",
        lastKnownLocation: failureLocation,
      });
      return;
    }
    let settleCompletion: (() => void) | undefined;
    const completion = new Promise<void>((resolve) => {
      settleCompletion = resolve;
    });
    const activeRequest: ActiveRequest = { controller, response, completion };
    activeRequests.add(activeRequest);
    publishActiveRequestCount();
    let journeyClosed = false;
    let handoffStarted = false;
    let unstartedHandoffObserved = false;
    const handoffLocation = {
      phase: "http_handoff",
      step: "write_http_response",
    } as const;
    let transportFailureObserved = false;
    const observeTransportFailure = (
      classification: "http_connection_aborted" | "http_response_handoff_failed",
    ): void => {
      if (transportFailureObserved) return;
      transportFailureObserved = true;
      observeRequestJourney(context, {
        kind: "failure_detected",
        failureId: `${context.requestId}:${classification}`,
        role: "primary",
        classification,
        origin: classification === "http_connection_aborted" ? "client" : "network_os",
        originPrecision: "boundary",
        location: handoffLocation,
      });
    };
    const closeJourneyOnce = (input: RequestJourneyCloseInput): void => {
      if (journeyClosed) return;
      journeyClosed = true;
      closeRequestJourney(context, input);
    };
    const closeBeforeHandoff = (
      handoffOutcome: "closed" | "failed",
      closeOutcome: "aborted" | "failed",
      closeReason: string,
    ): void => {
      if (handoffStarted) return;
      if (!unstartedHandoffObserved) {
        unstartedHandoffObserved = true;
        observeRequestJourney(context, {
          kind: "step_entered",
          stepInstanceId: "p8.write_http_response",
          location: handoffLocation,
        });
        observeRequestJourney(context, {
          kind: "handoff_observed",
          outcome: handoffOutcome,
          transport: "http",
          writableFinished: response.writableFinished,
          location: handoffLocation,
        });
        observeRequestJourney(context, {
          kind: "step_completed",
          stepInstanceId: "p8.write_http_response",
          completion: "failed",
          location: handoffLocation,
        });
      }
      observeTransportFailure(
        closeReason === "http_connection_aborted"
          ? "http_connection_aborted"
          : "http_response_handoff_failed",
      );
      closeJourneyOnce({
        outcome: closeOutcome,
        closeReason,
        lastKnownLocation: handoffLocation,
      });
    };
    const writeResponse = (result: Response): Promise<HandoffOutcome> => {
      handoffStarted = true;
      const preservesNativeStatusText = preservesDirectStatusText(result);
      return writeWebResponse(response, result, context, preservesNativeStatusText);
    };
    const abortRequest = (reason: unknown): void => {
      if (!controller.signal.aborted) controller.abort(reason);
    };
    const onRequestAborted = (): void => {
      abortRequest(new Error("Client request connection was aborted"));
      closeBeforeHandoff(
        response.destroyed ? "closed" : "failed",
        "aborted",
        "http_connection_aborted",
      );
    };
    const onResponseClose = (): void => {
      if (!response.writableFinished) {
        abortRequest(new Error("Client response connection closed early"));
        // Once the writer owns P8, only its finish/close/error settlement may
        // publish the terminal handoff fact and seal the Journey. Before that
        // point, this listener owns the truthful no-write closed outcome.
        closeBeforeHandoff(
          "closed",
          "aborted",
          "http_connection_aborted",
        );
      }
    };
    request.once("aborted", onRequestAborted);
    response.once("close", onResponseClose);
    void (async () => {
      try {
        const result = await options.runtime.handle(
          createWebRequest(request, origin, controller.signal),
          context,
        );
        if (controller.signal.aborted || response.destroyed) {
          closeBeforeHandoff(
            response.destroyed ? "closed" : "failed",
            "aborted",
            "http_connection_aborted",
          );
          return;
        }
        const handoff = await writeResponse(result);
        if (handoff !== "finished") {
          observeTransportFailure(
            controller.signal.aborted || response.destroyed
              ? "http_connection_aborted"
              : "http_response_handoff_failed",
          );
        }
        closeJourneyOnce({
          outcome:
            handoff === "finished"
              ? result.status >= 400
                ? "failed"
                : "success"
              : controller.signal.aborted || response.destroyed
                ? "aborted"
                : "failed",
          lastKnownLocation: handoffLocation,
        });
      } catch (error) {
        const requestWasAborted = error instanceof HttpRequestAbortedError;
        // Only a still-writable edge may receive the transport-synthesized
        // fallback. It goes through the same atomic P8 writer as every other
        // response, so prepared/finished and Journey close reflect reality.
        if (
          !controller.signal.aborted &&
          !response.destroyed &&
          !response.headersSent
        ) {
          const fallback = new Response(null, {
            status: 500,
            headers: {
              "x-token-request-id": context.requestId,
            },
          });
          observeRequestJourney(context, {
            kind: "client_response_prepared",
            status: fallback.status,
            location: {
              phase: "client_response_preparation",
              step: "prepare_transport_error_response",
            },
          });
          try {
            const handoff = await writeResponse(fallback);
            if (handoff !== "finished") {
              observeTransportFailure(
                controller.signal.aborted || response.destroyed
                  ? "http_connection_aborted"
                  : "http_response_handoff_failed",
              );
            }
            closeJourneyOnce({
              outcome:
                handoff === "finished" && requestWasAborted
                  ? "aborted"
                  : "failed",
              closeReason: requestWasAborted
                ? "request_lifecycle_aborted"
                : "http_response_failed",
              lastKnownLocation: handoffLocation,
            });
          } catch {
            closeJourneyOnce({
              outcome: controller.signal.aborted ? "aborted" : "failed",
              closeReason: "http_response_failed",
              lastKnownLocation: handoffLocation,
            });
          }
        } else {
          const aborted =
            controller.signal.aborted || response.destroyed || requestWasAborted;
          const closeReason =
            controller.signal.aborted || response.destroyed
              ? "http_connection_aborted"
              : "http_response_failed";
          if (!handoffStarted) {
            closeBeforeHandoff(
              response.destroyed ? "closed" : "failed",
              aborted ? "aborted" : "failed",
              closeReason,
            );
          } else {
            closeJourneyOnce({
              outcome: aborted ? "aborted" : "failed",
              closeReason,
              lastKnownLocation: handoffLocation,
            });
          }
        }
      } finally {
        activeRequests.delete(activeRequest);
        publishActiveRequestCount();
        request.off("aborted", onRequestAborted);
        response.off("close", onResponseClose);
        settleCompletion?.();
      }
    })();
  });
  server.on("upgrade", (request, socket, head) => {
    socket.once("error", () => socket.destroy());
    if (!accepting || !isWebSocketUpgrade(request)) {
      socket.destroy();
      return;
    }
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", origin);
    const pathname = url.pathname;
    const matchedUpgrade =
      options.webSocketUpgrade?.matches(request, url) ?? false;
    const context = beginRequestJourney(options.diagnostics, {
      requestId: createRequestJourneyId(options.createRequestId),
      operationCandidate: matchedUpgrade ? "pending" : "unsupported_transport",
      transport: "websocket",
      method,
      path: pathname,
      acceptedAt: Date.now(),
      cancellation: {
        caller: "active",
        shutdown: "not_bound",
      },
    });
    const admissionLocation = {
      phase: "http_admission",
      step: "admit_http_request",
    } as const;
    observeRequestJourney(context, {
      kind: "step_entered",
      stepInstanceId: "p0.admit_http_request",
      location: admissionLocation,
    });
    observeRequestJourney(context, {
      kind: "step_completed",
      stepInstanceId: "p0.admit_http_request",
      completion: "success",
      location: admissionLocation,
    });
    if (matchedUpgrade && options.webSocketUpgrade !== undefined) {
      const completion = options.webSocketUpgrade
        .handleUpgrade({
          request,
          socket,
          head,
          url,
          context,
        })
        .catch(() => {
          const location = {
            phase: "upstream_execution",
            lane: "direct",
            step: "dispatch_direct_transport",
          } as const;
          const failureId = `${context.requestId}:websocket_upgrade_handler_failed`;
          observeRequestJourney(context, {
            kind: "failure_detected",
            failureId,
            role: "primary",
            classification: "websocket_upgrade_handler_failed",
            origin: "Token",
            originPrecision: "boundary",
            location,
          });
          observeRequestJourney(context, {
            kind: "work_outcome_committed",
            outcome: "failed",
            terminalAuthority: "http_transport",
            location: { phase: "outcome_commit", step: "commit_request_outcome" },
          });
          observeRequestJourney(context, {
            kind: "handoff_observed",
            outcome: "failed",
            transport: "websocket",
            location: { phase: "http_handoff", step: "close_websocket_session" },
          });
          socket.destroy();
          closeRequestJourney(context, {
            outcome: "failed",
            primaryFailureId: failureId,
            closeReason: "websocket_upgrade_handler_failed",
            lastKnownLocation: location,
          });
        });
      activeWebSocketUpgrades.add(completion);
      publishActiveRequestCount();
      void completion.finally(() => {
        activeWebSocketUpgrades.delete(completion);
        publishActiveRequestCount();
      });
      return;
    }
    rejectWebSocketUpgrade(socket, context);
  });

  await listen(server, host, requestedPort);
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("Token HTTP server did not expose a TCP address");
  }
  const port = address.port;
  origin = `http://${host}:${port}`;
  publishActiveRequestCount();
  let closed = false;
  let closing: Promise<void> | undefined;
  let draining: Promise<DrainOutcome> | undefined;
  const shutdownReason = new Error("Token HTTP server is shutting down");
  const abortActive = (forceWebSockets: boolean): void => {
    for (const active of activeRequests) {
      if (!active.controller.signal.aborted) {
        active.controller.abort(shutdownReason);
      }
      if (!active.response.destroyed) active.response.destroy(shutdownReason);
    }
    if (forceWebSockets) options.webSocketUpgrade?.terminateAll();
    else options.webSocketUpgrade?.closeAll();
  };
  const awaitQuiescence = async (): Promise<void> => {
    await Promise.all([
      ...[...activeRequests].map((active) => active.completion),
      ...activeWebSocketUpgrades,
    ]);
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
          abortActive(true);
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
      abortActive(false);
      server.closeAllConnections();
      closing = Promise.all([serverClosed, awaitQuiescence()]).then(() => {
        closed = true;
      });
      return closing;
    },
  });
}
