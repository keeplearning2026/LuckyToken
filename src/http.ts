import { randomUUID } from "node:crypto";

import type {
  RequestJourneyBeginInput,
  RequestJourneyCloseInput,
  RequestJourneyObservationAuthority,
  RequestJourneyObservationInput,
  RequestJourneyObserver,
} from "./diagnostics/contract.js";

export interface ClientProtocolRequestContext {
  readonly requestId: string;
  readonly journey: RequestJourneyObserver;
  readonly transport: "http" | "in_process";
}

export interface ClientProtocolHandler {
  readonly method: string;
  readonly pathname: string;
  handle(
    request: Request,
    context?: ClientProtocolRequestContext,
  ): Promise<Response>;
  /**
   * Ticket 18 correlation seam: the accepted request id assigned to
   * `request` while the handler is processing it, when the handler assigns
   * one. Opaque correlation only — the HTTP boundary never interprets it,
   * never generates one, and never imports the Request Ledger. The transport
   * uses it so a synthesized error response still carries the exact ledger
   * request id of a real accepted request.
   */
  readonly requestIdFor?: (request: Request) => string | undefined;
}

export interface HttpBoundaryDependencies {
  readonly clientProtocols: readonly ClientProtocolHandler[];
  readonly requestTimeoutMs: number | undefined;
  readonly shutdownSignal: AbortSignal | undefined;
  readonly diagnostics?: RequestJourneyObservationAuthority;
  readonly createRequestId?: () => string;
}

const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function createRequestJourneyId(
  createRequestId: (() => string) | undefined,
): string {
  try {
    const candidate = createRequestId?.() ?? randomUUID();
    return REQUEST_ID_PATTERN.test(candidate) ? candidate : randomUUID();
  } catch {
    return randomUUID();
  }
}

function createNoopJourneyObserver(requestId: string): RequestJourneyObserver {
  return Object.freeze({
    requestId,
    observe: () => undefined,
    close: () => undefined,
  });
}

/** The HTTP request path defends itself even when an injected diagnostics
 *  authority violates the no-throw contract. The returned observer always
 *  keeps the request-edge id and never exposes diagnostics results. */
export function beginRequestJourney(
  authority: RequestJourneyObservationAuthority | undefined,
  input: RequestJourneyBeginInput,
): ClientProtocolRequestContext {
  let safeObserver: RequestJourneyObserver;
  if (authority === undefined) {
    safeObserver = createNoopJourneyObserver(input.requestId);
    return Object.freeze({
      requestId: input.requestId,
      journey: safeObserver,
      transport: input.transport,
    });
  }
  try {
    const observer = authority.begin(input);
    if (observer.requestId !== input.requestId) {
      safeObserver = createNoopJourneyObserver(input.requestId);
    } else {
      safeObserver = Object.freeze({
        requestId: input.requestId,
        observe(observation: RequestJourneyObservationInput): void {
          try {
            observer.observe(observation);
          } catch {
            // Diagnostics must never affect request serving.
          }
        },
        close(closeInput: RequestJourneyCloseInput): void {
          try {
            observer.close(closeInput);
          } catch {
            // Diagnostics must never affect request serving.
          }
        },
      });
    }
  } catch {
    safeObserver = createNoopJourneyObserver(input.requestId);
  }
  return Object.freeze({
    requestId: input.requestId,
    journey: safeObserver,
    transport: input.transport,
  });
}

function attachRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("x-luckytoken-request-id", requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function observeRequestJourney(
  context: ClientProtocolRequestContext,
  input: RequestJourneyObservationInput,
): void {
  try {
    context.journey.observe(input);
  } catch {
    // The request path remains authoritative over hostile observers.
  }
}

export function closeRequestJourney(
  context: ClientProtocolRequestContext,
  input: RequestJourneyCloseInput,
): void {
  try {
    context.journey.close(input);
  } catch {
    // The request path remains authoritative over hostile observers.
  }
}

export class HttpRequestAbortedError extends Error {
  readonly reason: unknown;
  /** Ticket 18 correlation: the accepted ledger request id of the aborted
   *  request, when the HTTP boundary could determine it (exact id, never
   *  generated here). */
  readonly requestId: string | undefined;

  constructor(reason?: unknown, requestId?: string) {
    super("HTTP request is no longer writable");
    this.name = "HttpRequestAbortedError";
    this.reason = reason;
    this.requestId = requestId;
  }
}

interface RequestLifecycle {
  readonly signal: AbortSignal;
  isWritable(): boolean;
  markDelivered(): void;
  dispose(): void;
}

function createRequestLifecycle(
  requestSignal: AbortSignal,
  shutdownSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): RequestLifecycle {
  const controller = new AbortController();
  let writable = true;
  let delivered = false;
  const removers: Array<() => void> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const abort = (reason: unknown): void => {
    writable = false;
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const follow = (signal: AbortSignal): void => {
    if (signal.aborted) {
      abort(signal.reason);
      return;
    }
    const onAbort = (): void => abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    removers.push(() => signal.removeEventListener("abort", onAbort));
  };

  follow(requestSignal);
  if (shutdownSignal !== undefined) follow(shutdownSignal);
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => abort(new Error("HTTP request timed out")), timeoutMs);
  }

  return {
    signal: controller.signal,
    isWritable: () => writable && !controller.signal.aborted && !delivered,
    markDelivered: () => {
      if (!writable || controller.signal.aborted || delivered) {
        throw new HttpRequestAbortedError(controller.signal.reason);
      }
      delivered = true;
    },
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      for (const remove of removers) remove();
    },
  };
}

function assertWritable(lifecycle: RequestLifecycle): void {
  if (!lifecycle.isWritable()) {
    throw new HttpRequestAbortedError(lifecycle.signal.reason);
  }
}

const IN_PROCESS_HANDOFF_LOCATION = Object.freeze({
  phase: "http_handoff" as const,
  step: "return_in_process_response",
});

function observeInProcessHandoff(
  context: ClientProtocolRequestContext,
  outcome: "finished" | "failed",
): void {
  observeRequestJourney(context, {
    kind: "step_entered",
    stepInstanceId: "p8.return_in_process_response",
    location: IN_PROCESS_HANDOFF_LOCATION,
  });
  observeRequestJourney(context, {
    kind: "handoff_observed",
    outcome,
    transport: "in_process",
    location: IN_PROCESS_HANDOFF_LOCATION,
  });
  observeRequestJourney(context, {
    kind: "step_completed",
    stepInstanceId: "p8.return_in_process_response",
    completion: outcome === "finished" ? "success" : "failed",
    location: IN_PROCESS_HANDOFF_LOCATION,
  });
}

function selectClientProtocol(
  protocols: readonly ClientProtocolHandler[],
  request: Request,
): ClientProtocolHandler | undefined {
  const pathname = new URL(request.url).pathname;
  return protocols.find(
    (protocol) => protocol.method === request.method && protocol.pathname === pathname,
  );
}

export async function handleHttpRequest(
  dependencies: HttpBoundaryDependencies,
  request: Request,
  suppliedContext?: ClientProtocolRequestContext,
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  const ownsJourney = suppliedContext === undefined;
  const hasJourneyAuthority =
    suppliedContext !== undefined || dependencies.diagnostics !== undefined;
  const context = suppliedContext ?? beginRequestJourney(dependencies.diagnostics, {
    requestId: createRequestJourneyId(dependencies.createRequestId),
    operationCandidate: "pending",
    transport: "in_process",
    method: request.method,
    path: pathname,
    acceptedAt: Date.now(),
    cancellation: {
      caller: request.signal.aborted ? "aborted" : "active",
      shutdown:
        dependencies.shutdownSignal === undefined
          ? "not_bound"
          : dependencies.shutdownSignal.aborted
            ? "aborted"
            : "active",
      ...(dependencies.requestTimeoutMs === undefined
        ? {}
        : { timeoutMs: dependencies.requestTimeoutMs }),
    },
  });
  const requestId = context.requestId;
  if (ownsJourney) {
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
  }
  const lifecycle = createRequestLifecycle(
    request.signal,
    dependencies.shutdownSignal,
    dependencies.requestTimeoutMs,
  );
  let routedRequest: Request | undefined;
  let protocol: ClientProtocolHandler | undefined;
  let protocolHandlerStepActive = false;
  const protocolHandlerLocation = {
    phase: "protocol_ingress",
    step: "invoke_protocol_handler",
  } as const;

  try {
    assertWritable(lifecycle);
    observeRequestJourney(context, {
      kind: "step_entered",
      stepInstanceId: "p1.resolve_route",
      location: { phase: "protocol_ingress", step: "resolve_route" },
    });
    protocol = selectClientProtocol(dependencies.clientProtocols, request);
    if (protocol === undefined) {
      const failureLocation = {
        phase: "protocol_ingress",
        step: "resolve_route",
      } as const;
      const failureId = "p1.resolve_route.unmatched";
      observeRequestJourney(context, {
        kind: "step_completed",
        stepInstanceId: "p1.resolve_route",
        completion: "failed",
        operation: "unmatched_request",
        location: failureLocation,
      });
      observeRequestJourney(context, {
        kind: "failure_detected",
        failureId,
        role: "primary",
        classification: "unmatched_route",
        origin: "client",
        originPrecision: "exact",
        location: failureLocation,
      });
      const presentationLocation = {
        phase: "client_response_preparation",
        step: "render_client_error",
      } as const;
      observeRequestJourney(context, {
        kind: "step_entered",
        stepInstanceId: "p6.render_client_error",
        location: presentationLocation,
      });
      const response = attachRequestId(new Response(null, { status: 404 }), requestId);
      observeRequestJourney(context, {
        kind: "client_response_prepared",
        status: response.status,
        location: presentationLocation,
      });
      observeRequestJourney(context, {
        kind: "step_completed",
        stepInstanceId: "p6.render_client_error",
        completion: "success",
        operation: "unmatched_request",
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
        terminalAuthority: "http_routing",
        location: outcomeLocation,
      });
      observeRequestJourney(context, {
        kind: "step_completed",
        stepInstanceId: "p7.commit_request_outcome",
        completion: "success",
        operation: "unmatched_request",
        location: outcomeLocation,
      });
      lifecycle.markDelivered();
      if (ownsJourney) {
        observeInProcessHandoff(context, "finished");
        closeRequestJourney(context, {
          outcome: "failed",
          primaryFailureId: failureId,
          lastKnownLocation: IN_PROCESS_HANDOFF_LOCATION,
        });
      }
      return response;
    }
    observeRequestJourney(context, {
      kind: "step_completed",
      stepInstanceId: "p1.resolve_route",
      completion: "success",
      location: { phase: "protocol_ingress", step: "resolve_route" },
    });
    routedRequest = new Request(request, { signal: lifecycle.signal });
    // Completion is also the serving-lifecycle quiescence barrier.  Do not
    // race the handler with cancellation here: the handler receives the
    // combined signal and must be allowed to unwind before `handle()` settles.
    protocolHandlerStepActive = true;
    observeRequestJourney(context, {
      kind: "step_entered",
      stepInstanceId: "p1.invoke_protocol_handler",
      location: protocolHandlerLocation,
    });
    const response = await protocol.handle(
      routedRequest,
      hasJourneyAuthority ? context : undefined,
    );
    observeRequestJourney(context, {
      kind: "step_completed",
      stepInstanceId: "p1.invoke_protocol_handler",
      completion: "success",
      location: protocolHandlerLocation,
    });
    protocolHandlerStepActive = false;
    assertWritable(lifecycle);
    lifecycle.markDelivered();
    // A transport edge assigns the authoritative request identity at P0.
    // The legacy handler seam remains available only to direct/in-process
    // callers that do not supply that edge context.
    const responseRequestId =
      suppliedContext === undefined
        ? protocol.requestIdFor?.(routedRequest) ?? requestId
        : requestId;
    const delivered = attachRequestId(response, responseRequestId);
    if (ownsJourney) {
      observeInProcessHandoff(context, "finished");
      closeRequestJourney(context, {
        outcome: delivered.status >= 400 ? "failed" : "success",
        lastKnownLocation: IN_PROCESS_HANDOFF_LOCATION,
      });
    }
    return delivered;
  } catch (error) {
    // The exact accepted ledger request id, when the handler published one
    // for this request (opaque correlation; never guessed or generated).
    const handlerRequestId =
      suppliedContext !== undefined || routedRequest === undefined
        ? requestId
        : protocol?.requestIdFor?.(routedRequest) ?? requestId;
    if (protocolHandlerStepActive) {
      const aborted =
        lifecycle.signal.aborted || error instanceof HttpRequestAbortedError;
      observeRequestJourney(context, {
        kind: "step_completed",
        stepInstanceId: "p1.invoke_protocol_handler",
        completion: aborted ? "aborted" : "failed",
        location: protocolHandlerLocation,
      });
      observeRequestJourney(context, {
        kind: "failure_detected",
        failureId: `${requestId}:${aborted ? "request_lifecycle_aborted" : "protocol_handler_failed"}`,
        role: "primary",
        classification: aborted
          ? "request_lifecycle_aborted"
          : "protocol_handler_failed",
        origin: aborted && request.signal.aborted ? "client" : "luckytoken",
        originPrecision: "boundary",
        location: protocolHandlerLocation,
      });
      protocolHandlerStepActive = false;
    }
    if (lifecycle.signal.aborted || error instanceof HttpRequestAbortedError) {
      if (ownsJourney) {
        observeInProcessHandoff(context, "failed");
        closeRequestJourney(context, {
          outcome: "aborted",
          lastKnownLocation: IN_PROCESS_HANDOFF_LOCATION,
        });
      }
      throw new HttpRequestAbortedError(lifecycle.signal.reason, handlerRequestId);
    }
    const fallback = new Response(null, {
      status: 500,
      headers: { "x-luckytoken-request-id": handlerRequestId },
    });
    const presentationLocation = {
      phase: "client_response_preparation",
      step: "prepare_runtime_fallback_response",
    } as const;
    observeRequestJourney(context, {
      kind: "step_entered",
      stepInstanceId: "p6.prepare_runtime_fallback_response",
      location: presentationLocation,
    });
    observeRequestJourney(context, {
      kind: "client_response_prepared",
      status: fallback.status,
      location: presentationLocation,
    });
    observeRequestJourney(context, {
      kind: "step_completed",
      stepInstanceId: "p6.prepare_runtime_fallback_response",
      completion: "success",
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
      terminalAuthority: "http_runtime_boundary",
      location: outcomeLocation,
    });
    observeRequestJourney(context, {
      kind: "step_completed",
      stepInstanceId: "p7.commit_request_outcome",
      completion: "success",
      location: outcomeLocation,
    });
    if (ownsJourney) {
      observeInProcessHandoff(context, "finished");
      closeRequestJourney(context, {
        outcome: "failed",
        lastKnownLocation: IN_PROCESS_HANDOFF_LOCATION,
      });
    }
    return fallback;
  } finally {
    lifecycle.dispose();
  }
}
