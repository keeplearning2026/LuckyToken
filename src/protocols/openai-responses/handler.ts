import type {
  FetchFunction,
  Model,
  Models,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";

import type { Auth } from "../../auth.js";
import {
  createNoopInvocationDiagnosticsFactory,
  type InvocationDiagnostics,
  type InvocationDiagnosticsFactory,
} from "../../invocation-diagnostics/index.js";
import {
  bindOpenAIResponsesConfiguration,
  parseOpenAIResponsesConfiguration,
  type OpenAIResponsesConfiguration,
} from "./configuration.js";
import {
  execute,
  ExecutionAbortedError,
  freezePiInvocation,
} from "../../execution.js";
import { HttpObserver } from "../../http-observer.js";
import { supportsFetchObservation } from "../../http-failure-acquisition.js";
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
  renderResponsesErrorResponse,
  validResponsesResponseId,
  type PreparedHttpResponse,
  type ResponsesEchoTool,
  type ResponsesRenderState,
  type ResponsesResponseObject,
} from "./response.js";
import {
  mapUpstreamFailureFact,
  redactMessage,
  SAFE_RESPONSE_HEADERS,
} from "./error-rendering.js";
import type { UpstreamFailureFact } from "../upstream-failure.js";
import {
  convertResponsesRequest,
  extractResponsesModelSelector,
  type ResponsesInvocation,
} from "./request.js";
import { renderResponsesSse } from "./sse.js";
import {
  createResponseSessionState,
  ResponseStateConversionFailure,
  type ResponseSessionState,
} from "./session-state.js";
import {
  isResponsesNativePassthroughModel,
  passthroughResponsesRequest,
  passthroughResponsesRequestHeaders,
  type PassthroughResponsesResult,
} from "./passthrough.js";

export const openaiResponsesProtocolId = "openai-responses";

export interface OpenAIResponsesHandlerOptions {
  readonly models: Models;
  readonly auth: Auth;
  readonly configuration?: OpenAIResponsesConfiguration;
  readonly invocationDiagnostics?: InvocationDiagnosticsFactory;
  readonly stateFile: string;
  /**
   * Optional injected session state (test seam). When omitted, the handler
   * creates and owns its own store bound to `stateFile`.
   */
  readonly sessionState?: ResponseSessionState;
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
  readonly configuration: OpenAIResponsesConfiguration;
  readonly invocationDiagnostics: InvocationDiagnosticsFactory;
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

async function rememberAfterSuccess(
  dependencies: OpenAIResponsesDependencies,
  diagnostics: InvocationDiagnostics,
  rawBody: unknown,
  rendered: ResponsesResponseObject,
): Promise<void> {
  // Anti-poisoning + save conditions live inside sessionState.remember.
  // store:false=persist surfaces a request-local notice through the current
  // invocation's diagnostics. The notice is emitted synchronously inside
  // remember before its first await, so awaiting remember here guarantees
  // the notice lands before the invocation finalizes. This does NOT wait for
  // the debounced disk commit — the first response still returns without
  // waiting for persistence.
  await dependencies.sessionState.remember(rawBody, rendered, (code) => {
    diagnostics.notice({
      adapter: openaiResponsesProtocolId,
      direction: "request",
      code,
      action: "degrade",
    });
  });
}

async function handleOpenAIResponses(
  dependencies: OpenAIResponsesDependencies,
  request: Request,
  diagnostics: InvocationDiagnostics,
): Promise<Response> {
  const httpObserver = dependencies.httpObserver ?? new HttpObserver();
  try {
    request.signal.throwIfAborted();
    diagnostics.checkpoint({ stage: "client-validation" });
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

    // Native passthrough selection happens before any conversion or local
    // state expansion: a model declared Responses-wire-compatible forwards
    // the raw request verbatim to the upstream endpoint, never through Pi.
    const selector = extractResponsesModelSelector(body);
    diagnostics.checkpoint({ stage: "model-resolution", selector });
    const model = resolveModel(dependencies.models, selector);
    if (isResponsesNativePassthroughModel(model)) {
      return passthroughBranch(
        dependencies,
        httpObserver.observedFetch,
        request,
        model,
        rawBody,
        diagnostics,
      );
    }

    // Expand previous_response_id into the full input. Unknown/expired/
    // evicted/corrupt/unresolvable IDs throw a typed conversion error.
    const expanded = await raceWithRequestSignal(
      dependencies.sessionState.expand(body),
      request.signal,
    );

    const invocation = convertResponsesRequest(
      expanded,
      dependencies.now(),
      dependencies.configuration.conversion.request,
    );
    for (const notice of invocation.notices) {
      diagnostics.notice(notice);
    }
    const piOptions = composeInvocationOptions(
      invocation,
      {
        sessionId: authResult.sessionId,
        signal: request.signal,
        ...(supportsFetchObservation(model.api)
          ? { fetch: httpObserver.observedFetch }
          : {}),
        ...(authResult.projectDir === undefined
          ? {}
          : { projectDir: authResult.projectDir }),
      },
      dependencies.routerDefaults,
    );
    diagnostics.checkpoint({ stage: "pi-execution", selector: invocation.selector });
    freezePiInvocation(model, invocation.context, piOptions);
    const message = await execute(
      dependencies.models,
      model,
      invocation.context,
      piOptions,
      {
        notice: (notice) => diagnostics.notice(notice),
        attempt: (attempt) => diagnostics.attempt(attempt),
      },
    );
    request.signal.throwIfAborted();
    diagnostics.checkpoint({ stage: "client-render", selector: invocation.selector });

    const responseId = validResponsesResponseId(message.responseId)
      ? message.responseId
      : dependencies.createResponseId();
    const renderState = buildRenderState(
      invocation,
      dependencies.configuration.conversion.response.unknownPiContent,
      (notice) => {
        diagnostics.notice(notice);
      },
    );
    const rendered = convertAssistantMessageToResponses(
      message,
      renderState,
      responseId,
      Math.floor(dependencies.now() / 1000),
      typeof body === "object" && body !== null
        ? ((body as Record<string, unknown>).previous_response_id as
            | string
            | undefined)
        : undefined,
    );
    // Save the EXPANDED body (full history + increment), so each stored
    // entry contains the complete conversation up to this response. A later
    // `previous_response_id` expansion then reproduces the full history;
    // saving the raw (unexpanded) increment would drop all earlier turns.
    await rememberAfterSuccess(dependencies, diagnostics, expanded, rendered);

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
    if (error instanceof ResponseStateConversionFailure) {
      return toResponse(
        renderResponsesError(400, "invalid_request_error", error.message),
      );
    }
    if (error instanceof ModelResolutionFailure) {
      return toResponse(
        renderResponsesError(404, "not_found_error", error.message),
      );
    }
    if (
      error instanceof Error &&
      "kind" in error &&
      error.kind === "ExecutionFailure" &&
      "reason" in error &&
      error.reason === "error"
    ) {
      // A formed failed Response (stop reason error) is handled inside the
      // try block; anything reaching here is a pre-commit execution failure
      // and returns the non-streaming error envelope — never a fabricated
      // response.failed.
      const execution = error as unknown as {
        diagnostic?: unknown;
        failure?: UpstreamFailureFact;
        message: string;
      };
      if (execution.failure !== undefined) {
        const mapping = mapUpstreamFailureFact(execution.failure);
        return renderResponsesErrorResponse({
          status: mapping.status,
          type: mapping.type,
          message: mapping.message,
          code: mapping.code,
          param: mapping.param,
          safeHeaders: mapping.safeHeaders,
        });
      }
    }
    // Legacy observer path (removed in ticket 27): used when no neutral
    // failure fact survived execution (e.g. providers not yet migrated).
    const observation = httpObserver.latestObservation;
    if (observation !== undefined && observation.kind === "response") {
      const mapping = mapUpstreamHttpFailure(observation);
      if (mapping !== undefined) {
        const safeHeaders: Record<string, string> = {};
        for (const [name, value] of observation.headers.entries()) {
          if (!SAFE_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
          safeHeaders[name.toLowerCase()] = value;
        }
        return renderResponsesErrorResponse({
          status: mapping.status,
          type: mapping.type,
          // The legacy observer body-derived message is bounded and redacted
          // here; it must never echo a credential fragment.
          message: redactMessage(mapping.message),
          code: null,
          param: null,
          safeHeaders,
        });
      }
    }
    if (
      error instanceof Error &&
      "kind" in error &&
      error.kind === "ExecutionFailure" &&
      "reason" in error &&
      error.reason === "error"
    ) {
      const execution = error as unknown as {
        diagnostic?: unknown;
        message: string;
      };
      const message =
        typeof execution.diagnostic === "string"
          ? execution.diagnostic
          : execution.message || "Upstream provider failed";
      return toResponse(renderResponsesError(502, "api_error", message));
    }
    return toResponse(
      renderResponsesError(500, "api_error", "Internal server error"),
    );
  }
}

async function handleOpenAIResponsesWithDiagnostics(
  dependencies: OpenAIResponsesDependencies,
  request: Request,
): Promise<Response> {
  const diagnostics = dependencies.invocationDiagnostics.begin(openaiResponsesProtocolId);
  try {
    const response = await handleOpenAIResponses(dependencies, request, diagnostics);
    if (response.status >= 400) {
      await diagnostics.fail({
        classification: response.status >= 500 ? "runtime-failure" : "client-failure",
        clientStatus: response.status,
      });
    } else {
      await diagnostics.succeed();
    }
    return response;
  } catch (error) {
    await diagnostics.fail({
      classification: request.signal.aborted ? "caller-cancellation" : "unhandled-failure",
      cancellation: request.signal.aborted,
      error,
    });
    throw error;
  }
}

/**
 * Passthrough branch: forward the client's raw Responses request verbatim to
 * the upstream endpoint and return its response unchanged (buffered atomic).
 *
 * Owns the full passthrough lifecycle: upstream auth resolution, forwarding,
 * and verbatim response return (status + headers + body) for both success
 * and upstream HTTP failure. Selection precedes conversion; the client always
 * sees the upstream response as-is.
 */
async function passthroughBranch(
  dependencies: OpenAIResponsesDependencies,
  fetchImpl: FetchFunction,
  request: Request,
  model: Model<string>,
  rawBody: string,
  diagnostics: InvocationDiagnostics,
): Promise<Response> {
  const auth = await raceWithRequestSignal(
    dependencies.models.getAuth(model),
    request.signal,
  );
  const apiKey = auth?.auth.apiKey;
  if (apiKey === undefined) {
    return toResponse(
      renderResponsesError(
        502,
        "api_error",
        `Provider is not configured: ${model.provider}`,
      ),
    );
  }
  let upstream: PassthroughResponsesResult;
  try {
    upstream = await raceWithRequestSignal(
      passthroughResponsesRequest({
        model,
        rawBody,
        apiKey,
        signal: request.signal,
        fetch: fetchImpl,
        upstreamHeaders: passthroughResponsesRequestHeaders(request),
      }),
      request.signal,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      "kind" in error &&
      (error.kind === "ResponsesPassthroughBodyReadError" ||
        error.kind === "ResponsesPassthroughTransportError")
    ) {
      // Pre-commit upstream failure (body-read or transport): no upstream
      // response byte ever committed to the client, so this is a legal
      // non-streaming Responses error, never a raw exception.
      return toResponse(renderResponsesError(502, "api_error", error.message));
    }
    throw error;
  }
  request.signal.throwIfAborted();
  if (upstream.status >= 400) {
    await diagnostics.fail({
      classification: "runtime-failure",
      stage: "native-passthrough",
      clientStatus: upstream.status,
      ...(upstream.headers["request-id"] === undefined
        ? {}
        : { safeIds: { requestId: upstream.headers["request-id"] } }),
    });
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { ...upstream.headers },
  });
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

/**
 * Build the immutable render facts the Response converter consumes: the
 * effective normalized controls that actually took effect, echoed from the
 * request-local render state. Raw caller intent that was dropped or degraded
 * (hosted tools, forced choices, parallel flag, unsupported controls) never
 * appears here, so the wire can never claim it took effect.
 *
 * Only function/custom tools that were actually offered to Pi are echoed. A
 * tool is echoed exactly once: its flattened name (used for calls) or its
 * reversed child name under a namespace, matching how the call output items
 * are rendered.
 */
function buildRenderState(
  invocation: ResponsesInvocation,
  unknownPiContent: "error" | "ignore",
  notice: (notice: {
    readonly adapter: string;
    readonly direction: "request" | "response";
    readonly code: string;
    readonly jsonPath?: string;
    readonly action: "ignore" | "degrade" | "xrepair";
  }) => void,
): ResponsesRenderState {
  const state = invocation.renderState;
  const tools = buildEchoTools(invocation);
  const freeformNames = state.freeformToolNames;
  const namespaceReverse = state.namespaceReverse;
  // Effective sampling values are echoed only when the caller provided them;
  // the target defaults (null) apply otherwise.
  const temperature =
    typeof invocation.options.temperature === "number"
      ? invocation.options.temperature
      : undefined;
  const topP =
    typeof invocation.options.samplingParams?.top_p === "number"
      ? (invocation.options.samplingParams.top_p as number)
      : undefined;
  return Object.freeze({
    clientModel: state.clientModel,
    stream: state.stream,
    ...(state.toolChoice === undefined ? {} : { toolChoice: state.toolChoice }),
    ...(freeformNames === undefined || freeformNames.size === 0
      ? {}
      : { freeformToolNames: freeformNames }),
    ...(namespaceReverse === undefined ||
    Object.keys(namespaceReverse).length === 0
      ? {}
      : { namespaceReverse }),
    ...(state.metadataEcho === undefined ? {} : { metadataEcho: state.metadataEcho }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { topP }),
    ...(tools.length === 0 ? {} : { tools }),
    unknownPiContent,
    notices: { push: notice },
  });
}

function buildEchoTools(invocation: ResponsesInvocation): ResponsesEchoTool[] {
  const state = invocation.renderState;
  const freeformNames = state.freeformToolNames;
  const namespaceReverse = state.namespaceReverse;
  const catalog = invocation.context.tools;
  if (catalog === undefined || catalog.length === 0) return [];
  const seen = new Set<string>();
  const tools: ResponsesEchoTool[] = [];
  for (const tool of catalog) {
    const reverse = namespaceReverse?.[tool.name];
    const name = reverse?.child ?? tool.name;
    const key = reverse === undefined ? tool.name : `${reverse.namespace}.${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const freeform = freeformNames?.has(tool.name) === true;
    // A freeform custom tool is echoed under its own `custom` type. The
    // installed SDK models CustomTool as {type,name,description?,format?}
    // with no `input_schema` field; the freeform input contract is the SDK
    // `format: {type:"text"}` shape. Ordinary functions echo as strict
    // function declarations.
    if (freeform) {
      tools.push({
        type: "custom",
        name,
        ...(reverse === undefined ? {} : { namespace: reverse.namespace }),
        description: tool.description,
        format: { type: "text" },
      });
      continue;
    }
    tools.push({
      type: "function",
      name,
      ...(reverse === undefined ? {} : { namespace: reverse.namespace }),
      description: tool.description,
      parameters: tool.parameters as Readonly<Record<string, unknown>>,
      strict:
        tool.constrainedSampling !== undefined &&
        tool.constrainedSampling !== false &&
        tool.constrainedSampling.type === "json_schema",
    });
  }
  return tools as ResponsesEchoTool[];
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

function dependenciesConfiguration(
  options: OpenAIResponsesHandlerOptions,
): OpenAIResponsesConfiguration {
  return options.configuration === undefined
    ? parseOpenAIResponsesConfiguration()
    : bindOpenAIResponsesConfiguration(options.configuration);
}

export function createOpenAIResponsesHandler(
  options: OpenAIResponsesHandlerOptions,
): ClientProtocolHandler {
  const configuration = dependenciesConfiguration(options);
  const sessionState =
    options.sessionState ??
    createResponseSessionState({
      stateFile: options.stateFile,
      ...(options.now === undefined ? {} : { now: options.now }),
      storeFalsePolicy: configuration.conversion.response.storeFalse,
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
    configuration,
    invocationDiagnostics:
      options.invocationDiagnostics ?? createNoopInvocationDiagnosticsFactory(),
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
    handle: (request: Request) =>
      handleOpenAIResponsesWithDiagnostics(dependencies, request),
  });
}
