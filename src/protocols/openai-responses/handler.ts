import type {
  FetchFunction,
  Models,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";

import type { Auth } from "../../auth.js";
import {
  execute,
  ExecutionAbortedError,
  freezePiInvocation,
} from "../../execution.js";
import { HttpObserver } from "../../http-observer.js";
import type { ClientProtocolHandler } from "../../http.js";
import { mapUpstreamHttpFailure } from "../upstream-failure.js";
import { resolveModel, ModelResolutionFailure } from "../../model-resolution.js";
import {
  composeOptions,
  type RouterOptionDefaults,
} from "../options.js";
import { InvalidRequest } from "./request.js";
import {
  convertAssistantMessageToResponses,
  renderResponsesError,
  type PreparedHttpResponse,
  type ResponsesResponseObject,
} from "./response.js";
import {
  convertResponsesRequest,
  type ResponsesInvocation,
} from "./request.js";
import { renderResponsesSse } from "./sse.js";
import {
  createResponseSessionState,
  type ResponseSessionState,
} from "./session-state.js";

export const openaiResponsesProtocolId = "openai-responses";

export interface OpenAIResponsesHandlerOptions {
  readonly models: Models;
  readonly auth: Auth;
  readonly stateFile: string;
  readonly shutdownSignal?: AbortSignal;
  /**
   * Optional invocation HTTP observer shared with provider composition. When
   * provided, the handler uses it instead of creating its own, so provider
   * HTTP failures observed through the bound fetch chain are visible to the
   * handler.
   */
  readonly httpObserver?: HttpObserver;
  /** Request body byte ceiling. Single source of truth: the composition root
   *  passes `config.limits.maxRequestBytes`; this handler consumes it and
   *  never supplies its own default. */
  readonly maxRequestBytes: number;
  readonly routerDefaults?: RouterOptionDefaults;
  readonly createResponseId?: () => string;
  readonly now?: () => number;
}

interface OpenAIResponsesDependencies {
  readonly models: Models;
  readonly auth: Auth;
  readonly sessionState: ResponseSessionState;
  readonly httpObserver?: HttpObserver;
  readonly maxRequestBytes: number;
  readonly routerDefaults: RouterOptionDefaults;
  readonly createResponseId: () => string;
  readonly now: () => number;
}

function toResponse(prepared: PreparedHttpResponse): Response {
  return new Response(prepared.body, {
    status: prepared.status,
    headers: { "content-type": prepared.contentType },
  });
}

async function raceWithRequestSignal<T>(
  value: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw new ExecutionAbortedError(signal.reason);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new ExecutionAbortedError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([value, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

function hasJsonContentType(headers: Headers): boolean {
  const contentType = headers.get("content-type");
  return (
    contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json"
  );
}

async function readRawBody(
  request: Request,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<string | undefined> {
  const declaredLength = request.headers.get("content-length");
  if (
    /^[0-9]+$/u.test(declaredLength ?? "") &&
    Number(declaredLength) > maximumBytes
  ) {
    return undefined;
  }
  const rawBody = await raceWithRequestSignal(request.text(), signal);
  return new TextEncoder().encode(rawBody).byteLength <= maximumBytes
    ? rawBody
    : undefined;
}

function rememberAfterSuccess(
  dependencies: OpenAIResponsesDependencies,
  rawBody: unknown,
  rendered: ResponsesResponseObject,
): void {
  // Anti-poisoning + save conditions live inside sessionState.remember.
  void dependencies.sessionState.remember(rawBody, rendered);
}

async function handleOpenAIResponses(
  dependencies: OpenAIResponsesDependencies,
  request: Request,
): Promise<Response> {
  const httpObserver = dependencies.httpObserver ?? new HttpObserver();
  try {
    request.signal.throwIfAborted();
    if (!hasJsonContentType(request.headers)) {
      return toResponse(
        renderResponsesError(
          415,
          "invalid_request_error",
          "Content-Type must be application/json",
        ),
      );
    }

    const authResult = await raceWithRequestSignal(
      dependencies.auth.resolve(request.headers),
      request.signal,
    );
    if (!authResult.authorized) {
      return toResponse(
        renderResponsesError(
          401,
          "authentication_error",
          "Invalid authorization credentials",
        ),
      );
    }

    const rawBody = await readRawBody(
      request,
      dependencies.maxRequestBytes,
      request.signal,
    );
    if (rawBody === undefined) {
      return toResponse(
        renderResponsesError(
          413,
          "request_too_large",
          "Request exceeds the configured maximum size",
        ),
      );
    }
    const body: unknown = JSON.parse(rawBody);

    // Expand previous_response_id into the full input (fail-open).
    const expanded = await raceWithRequestSignal(
      dependencies.sessionState.expand(body),
      request.signal,
    );

    const invocation = convertResponsesRequest(expanded, dependencies.now());
    const model = resolveModel(dependencies.models, invocation.selector);
    const piOptions = composeInvocationOptions(
      invocation,
      {
        sessionId: authResult.sessionId,
        signal: request.signal,
        fetch: httpObserver.observedFetch,
        ...(authResult.projectDir === undefined
          ? {}
          : { projectDir: authResult.projectDir }),
      },
      dependencies.routerDefaults,
    );
    freezePiInvocation(model, invocation.context, piOptions);
    const message = await execute(
      dependencies.models,
      model,
      invocation.context,
      piOptions,
    );
    request.signal.throwIfAborted();

    const rendered = convertAssistantMessageToResponses(
      message,
      invocation.renderState.clientModel,
      dependencies.createResponseId(),
      Math.floor(dependencies.now() / 1000),
      typeof body === "object" && body !== null
        ? ((body as Record<string, unknown>).previous_response_id as
            | string
            | undefined)
        : undefined,
      invocation.renderState.freeformToolNames,
    );
    // Save the EXPANDED body (full history + increment), so each stored
    // entry contains the complete conversation up to this response. A later
    // `previous_response_id` expansion then reproduces the full history;
    // saving the raw (unexpanded) increment would drop all earlier turns.
    rememberAfterSuccess(dependencies, expanded, rendered);

    const prepared = invocation.renderState.stream
      ? renderResponsesSse(rendered)
      : renderResponsesJson(rendered);
    request.signal.throwIfAborted();
    return toResponse(prepared);
  } catch (error) {
    if (request.signal.aborted || error instanceof ExecutionAbortedError) {
      throw new ExecutionAbortedError(request.signal.reason);
    }
    if (error instanceof SyntaxError) {
      return toResponse(
        renderResponsesError(
          400,
          "invalid_request_error",
          "Request body is not valid JSON",
        ),
      );
    }
    if (error instanceof InvalidRequest) {
      return toResponse(
        renderResponsesError(400, "invalid_request_error", error.message),
      );
    }
    if (error instanceof ModelResolutionFailure) {
      return toResponse(
        renderResponsesError(404, "not_found_error", error.message),
      );
    }
    const observation = httpObserver.latestObservation;
    if (observation !== undefined && observation.kind === "response") {
      const mapping = mapUpstreamHttpFailure(observation);
      if (mapping !== undefined) {
        return toResponse(
          renderResponsesError(mapping.status, mapping.type, mapping.message),
        );
      }
    }
    if (
      error instanceof Error &&
      "kind" in error &&
      error.kind === "ExecutionFailure" &&
      "reason" in error &&
      error.reason === "error"
    ) {
      const diagnostic = (error as { diagnostic?: unknown }).diagnostic;
      const message =
        typeof diagnostic === "string"
          ? diagnostic
          : error.message || "Upstream provider failed";
      return toResponse(renderResponsesError(502, "api_error", message));
    }
    return toResponse(
      renderResponsesError(500, "api_error", "Internal server error"),
    );
  }
}

function renderResponsesJson(
  target: ResponsesResponseObject,
): PreparedHttpResponse {
  return {
    status: 200,
    contentType: "application/json",
    body: new TextEncoder().encode(JSON.stringify(target)),
  };
}

function composeInvocationOptions(
  invocation: ResponsesInvocation,
  infrastructure: {
    sessionId: string;
    signal: AbortSignal;
    fetch?: FetchFunction;
    projectDir?: string;
  },
  routerDefaults: RouterOptionDefaults,
): ModelsSimpleStreamOptions {
  const options: ModelsSimpleStreamOptions = { ...invocation.options };
  return composeOptions(options, infrastructure, routerDefaults);
}

export function createOpenAIResponsesHandler(
  options: OpenAIResponsesHandlerOptions,
): ClientProtocolHandler {
  const sessionState = createResponseSessionState({
    stateFile: options.stateFile,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  if (options.shutdownSignal !== undefined) {
    if (options.shutdownSignal.aborted) {
      void sessionState.flush();
    } else {
      options.shutdownSignal.addEventListener(
        "abort",
        () => {
          void sessionState.flush();
        },
        { once: true },
      );
    }
  }
  const dependencies: OpenAIResponsesDependencies = Object.freeze({
    models: options.models,
    auth: options.auth,
    sessionState,
    ...(options.httpObserver === undefined
      ? {}
      : { httpObserver: options.httpObserver }),
    maxRequestBytes: options.maxRequestBytes,
    routerDefaults: Object.freeze({ ...(options.routerDefaults ?? {}) }),
    createResponseId: options.createResponseId ?? (() => `resp_${randomUUID()}`),
    now: options.now ?? Date.now,
  });
  return Object.freeze({
    method: "POST",
    pathname: "/v1/responses",
    handle: (request: Request) => handleOpenAIResponses(dependencies, request),
  });
}
