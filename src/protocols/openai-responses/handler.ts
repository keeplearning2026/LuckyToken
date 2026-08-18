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
  createNoopRequestLedger,
  type RequestLedger,
  type RequestLedgerEntry,
} from "../../request-ledger/handler-seam.js";
import {
  createNoopDeepCaptureAuthority,
  createNoopCaptureEntry,
  type DeepCaptureAuthority,
  type DeepCaptureEntry,
} from "../../deep-diagnostics/handler-seam.js";
import {
  bindOpenAIResponsesConfiguration,
  parseOpenAIResponsesConfiguration,
  type OpenAIResponsesConfiguration,
} from "./configuration.js";
import {
  execute,
  ExecutionAbortedError,
  freezePiInvocation,
  type ExecutionOperation,
} from "../../execution.js";
import type { ClientProtocolHandler } from "../../http.js";
import { ModelResolutionFailure } from "../../model-resolution.js";
import {
  resolveDataPlaneModel,
  type AliasModelSource,
} from "../../alias-model-seam.js";
import {
  composeOptions,
  identityRequestModelResolver,
  type RequestModelResolver,
  type RouterOptionDefaults,
} from "../options.js";
import { InvalidRequest } from "./request.js";
import {
  readResponsesRequestBody,
  ResponsesRequestBodyTooLargeError,
  UnsupportedResponsesContentEncodingError,
} from "./request-body.js";
import {
  convertAssistantMessageToResponses,
  renderResponsesError,
  renderResponsesErrorResponse,
  type PreparedHttpResponse,
  type ResponsesEchoTool,
  type ResponsesRenderState,
  type ResponsesResponseObject,
} from "./response.js";
import { mapUpstreamFailureFact } from "./error-rendering.js";
import type { UpstreamFailureFact } from "@luckytoken/provider-contract/diagnostics";
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
  projectResponsesPassthroughBody,
  type PassthroughResponsesResult,
} from "./passthrough.js";
import type {
  CodexLocalCredentialAuthority,
  CodexNativeModelSource,
} from "../../codex-native-seam.js";
import { executeCodexNativeBranch } from "./codex-native-branch.js";
import {
  buildCodexRoutedCompactionRequest,
  CodexRoutedCompactionSummaryError,
  expandLuckyTokenCompactionEnvelopes,
  hasLuckyTokenCompactionEnvelope,
  isCodexRoutedCompactionRequest,
  projectRoutedCompactionResponse,
} from "./codex-routed-compaction.js";
import { extractResponsesPassthroughUsage } from "./passthrough-usage.js";

export const openaiResponsesProtocolId = "openai-responses";

/**
 * Ticket 18 correlation: the accepted ledger request id of every request
 * currently being handled (weak: entries vanish with the Request object).
 * The HTTP boundary reads it only to correlate a transport-synthesized
 * error response with the persisted ledger row; the ledger module never
 * enters the transport layer.
 */
const requestIds = new WeakMap<Request, string>();

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
  /** Narrow transport dependency used only by native wire passthrough. */
  readonly passthroughFetch?: FetchFunction;
  /**
   * Ticket 15 alias-only model data plane: when wired, only configured
   * aliases are valid selectors, converted and passthrough responses echo
   * the requested alias, and the request captures one immutable resolver
   * snapshot at acceptance. Without it the legacy provider/model selector
   * contract applies (handler-level test seam); the composition root
   * always wires the real authority in production.
   */
  readonly aliasSource?: AliasModelSource;
  /**
   * Ticket 18 Request Lifecycle Ledger observer: the wrapper begins one
   * handler-local entry at acceptance, drives the lifecycle transitions,
   * and attaches the request id to every response. Absent means the no-op
   * observer (the header contract still holds).
   */
  readonly requestLedger?: RequestLedger;
  /**
   * Ticket 22 Deep Diagnostics capture authority: the wrapper reads one
   * immutable acceptance-time enable snapshot per request and collects
   * raw request/response artifacts while enabled. Absent means the no-op
   * authority (no capture ever begins).
   */
  readonly deepCapture?: DeepCaptureAuthority;
  /** Request body byte ceiling. Single source of truth: the composition root
   *  passes `config.limits.maxRequestBytes`; this handler consumes it and
   *  never supplies its own default. */
  readonly maxRequestBytes: number;
  readonly routerDefaults?: RouterOptionDefaults;
  readonly createResponseId?: () => string;
  readonly now?: () => number;
  /**
   * Narrow Pi-typed request-local model derivation (Ticket 10): the
   * composition root wires the Provider/request-composition implementation.
   * Defaults to identity so direct handler tests and handlers without a
   * wired resolver pass the catalog model through unchanged.
   */
  readonly resolveRequestModel?: RequestModelResolver;
  /**
   * Ticket 20: the neutral Pi execution operation. The composition root
   * binds the Provider usage-semantics resolver into the operation
   * (`createExecutionOperation`); the handler never names or carries
   * Provider semantics data. Absent defaults to plain `execute`, whose
   * snapshots are honest Partial undeclared_semantics.
   */
  readonly executeOperation?: ExecutionOperation;
  /** Optional native Codex capability. It is independent of local Codex
   *  config management: when wired, authenticated bare native model ids can
   *  use the client-owned Codex OAuth passthrough path. */
  readonly codexLocalAuth?: CodexLocalCredentialAuthority;
  readonly codexNativeModels?: CodexNativeModelSource;
}

interface OpenAIResponsesDependencies {
  readonly models: Models;
  readonly auth: Auth;
  readonly configuration: OpenAIResponsesConfiguration;
  readonly invocationDiagnostics: InvocationDiagnosticsFactory;
  readonly requestLedger: RequestLedger;
  readonly deepCapture: DeepCaptureAuthority;
  readonly sessionState: ResponseSessionState;
  readonly passthroughFetch: FetchFunction;
  readonly aliasSource: AliasModelSource | undefined;
  readonly maxRequestBytes: number;
  readonly routerDefaults: RouterOptionDefaults;
  readonly createResponseId: () => string;
  readonly now: () => number;
  readonly resolveRequestModel: RequestModelResolver;
  readonly executeOperation: ExecutionOperation;
  readonly codexLocalAuth: CodexLocalCredentialAuthority | undefined;
  readonly codexNativeModels: CodexNativeModelSource | undefined;
}

function toResponse(prepared: PreparedHttpResponse): Response {
  return new Response(prepared.body, {
    status: prepared.status,
    headers: { "content-type": prepared.contentType },
  });
}

/** Every Data Plane response of this handler carries the ledger request id
 *  exactly once (success, error, and passthrough alike). */
function attachRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("x-luckytoken-request-id", requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Own-data header facts for the capture observer: the universal redaction
 *  choke point is the safety net; nothing is pre-filtered here. */
function headerRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

const textDecoder = new TextDecoder();

/** Ticket 22 isolation: capture infrastructure must never affect request
 *  handling. A hostile/throwing authority falls back to the safe disabled
 *  entry; the request id correlation always survives. */
function beginCapture(
  dependencies: OpenAIResponsesDependencies,
  request: Request,
  requestId: string,
): DeepCaptureEntry {
  try {
    return dependencies.deepCapture.begin({
      requestId,
      protocolId: openaiResponsesProtocolId,
      requestHeaders: headerRecord(request.headers),
    });
  } catch {
    return createNoopCaptureEntry(requestId);
  }
}

/** Ticket 22 isolation: the delivered response is cloned and read only when
 *  the acceptance decision enabled capture (zero cost while disabled), and
 *  any clone/read/callback failure degrades to a partial capture — it can
 *  never replace or change the model response. */
async function captureDeliveredResponse(
  capture: DeepCaptureEntry,
  response: Response,
): Promise<void> {
  if (!capture.decision.enabled) return;
  try {
    const responseBytes = await response.clone().arrayBuffer();
    capture.response(
      response.status,
      headerRecord(new Headers(response.headers)),
      textDecoder.decode(responseBytes),
    );
  } catch {
    try {
      capture.fail("response-capture-failed");
    } catch {
      // The capture seam must never affect the response path.
    }
  }
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

async function rememberAfterSuccess(
  dependencies: OpenAIResponsesDependencies,
  diagnostics: InvocationDiagnostics,
  ledger: RequestLedgerEntry,
  rawBody: unknown,
  rendered: ResponsesResponseObject,
): Promise<void> {
  // Admission, anti-poisoning, and storage policy live in the deep state
  // module. Awaiting remember provides in-process read-after-write for an
  // admitted checkpoint; disk persistence remains debounced and best-effort.
  await dependencies.sessionState.remember(rawBody, rendered, (code) => {
    const notice = {
      adapter: openaiResponsesProtocolId,
      direction: "request" as const,
      code,
      action: "degrade" as const,
    };
    diagnostics.notice(notice);
    ledger.notice(notice);
  });
}

async function handleOpenAIResponses(
  dependencies: OpenAIResponsesDependencies,
  request: Request,
  diagnostics: InvocationDiagnostics,
  ledger: RequestLedgerEntry,
  capture: DeepCaptureEntry,
): Promise<Response> {
  try {
    request.signal.throwIfAborted();
    diagnostics.checkpoint({ stage: "client-validation" });
    if (!hasJsonContentType(request.headers)) {
      ledger.terminal("failed", { clientHttpStatus: 415 });
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
      ledger.terminal("rejected-auth", { clientHttpStatus: 401 });
      return toResponse(
        renderResponsesError(
          401,
          "authentication_error",
          "Invalid authorization credentials",
        ),
      );
    }
    ledger.authorized({
      effectiveSessionId: authResult.effectiveSessionId,
      ...(authResult.clientSessionId === undefined
        ? {}
        : { clientSessionId: authResult.clientSessionId }),
      ...(authResult.projectDir === undefined
        ? {}
        : { projectDir: authResult.projectDir }),
    });

    const decodedBody = await readResponsesRequestBody(
      request,
      dependencies.maxRequestBytes,
    );
    const rawBody = decodedBody.text;
    // Ticket 22: the raw request body is collected for the capture observer
    // exactly as the request path produced it; sanitization happens at the
    // one store choke point before commit. A throwing capture seam is
    // isolated — it can only degrade the capture, never the request.
    try {
      capture.requestBody(rawBody);
    } catch {
      try {
        capture.fail("request-body-capture-failed");
      } catch {
        // The capture seam must never affect the request path.
      }
    }
    const body: unknown = decodedBody.json;

    // Native passthrough selection happens before any conversion or local
    // state expansion: a model declared Responses-wire-compatible forwards
    // the raw request verbatim to the upstream endpoint, never through Pi.
    const selector = extractResponsesModelSelector(body);
    diagnostics.checkpoint({ stage: "model-resolution", selector });
    if (
      dependencies.codexLocalAuth !== undefined &&
      dependencies.codexNativeModels?.has(selector) === true
    ) {
      const forwardAuth = await raceWithRequestSignal(
        dependencies.codexLocalAuth.resolveForwardAuth(request.headers),
        request.signal,
      );
      if (forwardAuth !== undefined) {
        ledger.modelResolved({
          externalAlias: selector,
          providerId: "openai-codex",
          realModelId: selector,
        });
        return executeCodexNativeBranch({
          request,
          rawBody,
          forwardAuth,
          fetch: dependencies.passthroughFetch,
          diagnostics,
          ledger,
        });
      }
    }
    const codexCompactionRequested = isCodexRoutedCompactionRequest(body);
    const codexReplayRequested = hasLuckyTokenCompactionEnvelope(body);
    const routedCodexAuthenticated =
      (codexCompactionRequested || codexReplayRequested) &&
      dependencies.codexLocalAuth !== undefined &&
      (await raceWithRequestSignal(
        dependencies.codexLocalAuth.resolveForwardAuth(request.headers),
        request.signal,
      )) !== undefined;
    const routedCodexCompaction =
      codexCompactionRequested && routedCodexAuthenticated;
    const routedCodexReplay = codexReplayRequested && routedCodexAuthenticated;
    const routedCompactionStream =
      routedCodexCompaction &&
      typeof body === "object" &&
      body !== null &&
      (body as Record<string, unknown>).stream === true;

    // Ticket 15: the request captures one immutable alias snapshot at
    // acceptance; the resolved canonical target reaches the standard Pi
    // Provider invocation path. Bare ids and canonical selectors are never
    // valid aliases.
    const resolution = await resolveDataPlaneModel(
      dependencies.models,
      dependencies.aliasSource,
      selector,
    );
    if (resolution.kind === "unknown") {
      ledger.aliasCaptured({ externalAlias: selector });
      ledger.terminal("unknown-alias", { clientHttpStatus: 400 });
      return toResponse(
        renderResponsesError(
          400,
          "invalid_request_error",
          `Unknown model: ${selector}`,
          "unknown_model",
        ),
      );
    }
    if (resolution.kind === "unavailable") {
      ledger.aliasCaptured({ externalAlias: selector });
      ledger.terminal("unavailable-alias", { clientHttpStatus: 503 });
      return toResponse(
        renderResponsesError(
          503,
          "api_error",
          "The requested model is not currently available",
          "model_unavailable",
        ),
      );
    }
    const model = resolution.model;
    ledger.modelResolved({
      externalAlias: resolution.alias,
      providerId: model.provider,
      realModelId: model.id,
    });
    // Passthrough response projection is alias-only: the alias captured at
    // acceptance must be echoed symmetrically by the upstream response.
    const projectAlias =
      dependencies.aliasSource === undefined ? undefined : resolution.alias;
    if (
      !routedCodexCompaction &&
      !routedCodexReplay &&
      isResponsesNativePassthroughModel(model)
    ) {
      return passthroughBranch(
        dependencies,
        dependencies.passthroughFetch,
        request,
        model,
        rawBody,
        diagnostics,
        ledger,
        projectAlias,
      );
    }

    // Complete requests stay on the existing conversion path. Only requests
    // that actually reference local continuation state pay the expansion cost.
    const previousResponseId =
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>).previous_response_id
        : undefined;
    const expanded =
      typeof previousResponseId === "string" && previousResponseId.length > 0
        ? await raceWithRequestSignal(
            dependencies.sessionState.expand(body),
            request.signal,
          )
        : body;

    const replayExpanded = routedCodexReplay
      ? expandLuckyTokenCompactionEnvelopes(expanded)
      : expanded;
    const executionBody = routedCodexCompaction
      ? buildCodexRoutedCompactionRequest(replayExpanded)
      : replayExpanded;
    const invocation = convertResponsesRequest(
      executionBody,
      dependencies.now(),
      dependencies.configuration.conversion.request,
    );
    for (const notice of invocation.notices) {
      diagnostics.notice(notice);
      ledger.notice(notice);
    }
    const piOptions = composeInvocationOptions(
      invocation,
      {
        sessionId: authResult.effectiveSessionId,
        signal: request.signal,
        ...(authResult.projectDir === undefined
          ? {}
          : { projectDir: authResult.projectDir }),
      },
      dependencies.routerDefaults,
    );
    diagnostics.checkpoint({ stage: "pi-execution", selector: invocation.selector });
    freezePiInvocation(model, invocation.context, piOptions);
    ledger.executing();
    const message = await dependencies.executeOperation(
      dependencies.models,
      model,
      invocation.context,
      piOptions,
      {
        notice: (notice) => {
          diagnostics.notice(notice);
          ledger.notice(notice);
        },
        attempt: (attempt) => {
          diagnostics.attempt(attempt);
          ledger.attempt(attempt);
        },
        // Ticket 20: the canonical terminal-usage snapshot is persisted in
        // the Request Ledger independently of Client Wire usage conversion.
        terminalUsage: (snapshot) => {
          ledger.terminalUsage(snapshot);
        },
      },
    );
    request.signal.throwIfAborted();
    ledger.terminal("success", { piStopReason: message.stopReason });
    diagnostics.checkpoint({ stage: "client-render", selector: invocation.selector });
    ledger.rendering();

    const responseId = dependencies.createResponseId();
    const renderState = buildRenderState(
      invocation,
      dependencies.configuration.conversion.response.unknownPiContent,
      (notice) => {
        diagnostics.notice(notice);
        ledger.notice(notice);
      },
    );
    const renderedBase = convertAssistantMessageToResponses(
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
    const rendered = routedCodexCompaction
      ? projectRoutedCompactionResponse(renderedBase, message)
      : renderedBase;
    // Compaction replaces the client's history, so the synthetic summary
    // turn must never be recorded as an ordinary continuation checkpoint.
    if (!routedCodexCompaction) {
      await rememberAfterSuccess(
        dependencies,
        diagnostics,
        ledger,
        body,
        rendered,
      );
    }

    const prepared =
      (routedCodexCompaction ? routedCompactionStream : invocation.renderState.stream)
        ? renderResponsesSse(rendered)
        : renderResponsesJson(rendered);
    request.signal.throwIfAborted();
    return toResponse(prepared);
  } catch (error) {
    if (request.signal.aborted || error instanceof ExecutionAbortedError) {
      throw new ExecutionAbortedError(request.signal.reason);
    }
    if (error instanceof ResponsesRequestBodyTooLargeError) {
      ledger.terminal("failed", { clientHttpStatus: 413 });
      return toResponse(
        renderResponsesError(
          413,
          "request_too_large",
          "Request exceeds the configured maximum size",
        ),
      );
    }
    if (error instanceof UnsupportedResponsesContentEncodingError) {
      ledger.terminal("failed", { clientHttpStatus: 415 });
      return toResponse(
        renderResponsesError(
          415,
          "invalid_request_error",
          "Unsupported Content-Encoding",
        ),
      );
    }
    if (error instanceof SyntaxError) {
      ledger.terminal("failed", { clientHttpStatus: 400 });
      return toResponse(
        renderResponsesError(
          400,
          "invalid_request_error",
          "Request body is not valid JSON",
        ),
      );
    }
    if (error instanceof CodexRoutedCompactionSummaryError) {
      ledger.fail({ classification: "runtime-failure", error });
      ledger.terminal("failed", { clientHttpStatus: 502 });
      return toResponse(
        renderResponsesError(
          502,
          "api_error",
          "Routed compaction summarizer produced no text",
        ),
      );
    }
    if (error instanceof InvalidRequest) {
      ledger.terminal("failed", { clientHttpStatus: 400 });
      return toResponse(
        renderResponsesError(400, "invalid_request_error", error.message),
      );
    }
    if (error instanceof ResponseStateConversionFailure) {
      ledger.terminal("failed", { clientHttpStatus: 400 });
      return toResponse(
        renderResponsesError(400, "invalid_request_error", error.message),
      );
    }
    if (error instanceof ModelResolutionFailure) {
      ledger.terminal("failed", { clientHttpStatus: 404 });
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
        ledger.terminal("failed", { clientHttpStatus: mapping.status });
        ledger.fail({ classification: "runtime-failure", error });
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
    if (
      error instanceof Error &&
      "kind" in error &&
      error.kind === "ExecutionFailure" &&
      "reason" in error &&
      error.reason === "error"
    ) {
      ledger.terminal("failed", { clientHttpStatus: 502 });
      ledger.fail({ classification: "runtime-failure", error });
      return toResponse(
        renderResponsesError(502, "api_error", "Upstream provider failed"),
      );
    }
    ledger.terminal("failed", { clientHttpStatus: 500 });
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
  // Ticket 18: the handler assigns the safe unique request id and records an
  // accepted request at handler entry, before content-type/body/auth/model
  // validation and before Pi execution. The correlation is published before
  // the first await so a transport-synthesized error response can still
  // carry the exact id of this accepted request.
  const ledger = dependencies.requestLedger.begin(openaiResponsesProtocolId);
  requestIds.set(request, ledger.requestId);
  // Ticket 22: the capture observer reads the one global enable snapshot at
  // the same acceptance line and keeps it immutable for this request; the
  // request id is the ledger's — capture never mints its own. begin is
  // isolated: a throwing authority falls back to the safe disabled entry.
  const capture = beginCapture(dependencies, request, ledger.requestId);
  try {
    const response = await handleOpenAIResponses(dependencies, request, diagnostics, ledger, capture);
    if (response.status >= 400) {
      await diagnostics.fail({
        classification: response.status >= 500 ? "runtime-failure" : "client-failure",
        clientStatus: response.status,
      });
    } else {
      await diagnostics.succeed();
    }
    // Terminal response preparation: the final Response exists (rendered +
    // request id attached below), so the ledger commits the terminal row.
    ledger.completed(response.status);
    // The request id header is attached first: the captured bytes are the
    // exact response the client receives, and the request id survives as a
    // safe correlation fact (never treated as a client credential).
    const delivered = attachRequestId(response, ledger.requestId);
    await captureDeliveredResponse(capture, delivered);
    try {
      capture.finalize();
    } catch {
      // Capture finalize must never affect the response path.
    }
    return delivered;
  } catch (error) {
    const aborted =
      request.signal.aborted ||
      error instanceof ExecutionAbortedError;
    // The truthful terminal outcome is recorded before the diagnostics seam
    // runs, so a throwing diagnostics seam can never lose it. An unexpected
    // failure still reaches the client as a transport-synthesized 500 (when
    // the client is live), so the status is recorded too.
    ledger.fail({
      classification: aborted ? "caller-cancellation" : "unhandled-failure",
      error,
    });
    ledger.terminal(
      aborted ? "aborted" : "failed",
      aborted ? undefined : { clientHttpStatus: 500 },
    );
    try {
      capture.fail(aborted ? "aborted" : "unhandled-failure");
    } catch {
      // The capture seam must never affect the response path.
    }
    try {
      capture.finalize();
    } catch {
      // The capture seam must never affect the response path.
    }
    await diagnostics.fail({
      classification: aborted ? "caller-cancellation" : "unhandled-failure",
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
  ledger: RequestLedgerEntry,
  alias: string | undefined,
): Promise<Response> {
  const auth = await raceWithRequestSignal(
    dependencies.models.getAuth(model),
    request.signal,
  );
  const apiKey = auth?.auth.apiKey;
  const composedHeaders = auth?.auth.headers;
  const hasHeaderAuth =
    composedHeaders !== undefined &&
    Object.entries(composedHeaders).some(([name, value]) => {
      const lower = name.toLowerCase();
      return (
        (lower === "authorization" || lower === "cf-aig-authorization") &&
        value !== undefined &&
        value !== null &&
        value.trim().length > 0
      );
    });
  if (apiKey === undefined && !hasHeaderAuth) {
    ledger.terminal("failed", { clientHttpStatus: 502 });
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
    ledger.executing();
    upstream = await raceWithRequestSignal(
      passthroughResponsesRequest({
        model: dependencies.resolveRequestModel(model, auth),
        rawBody,
        apiKey,
        signal: request.signal,
        fetch: fetchImpl,
        upstreamHeaders: passthroughResponsesRequestHeaders(request),
        ...(auth?.auth.headers === undefined
          ? {}
          : { composedHeaders: auth.auth.headers }),
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
      // non-streaming Responses error, never a raw exception. The client
      // sees fixed actionable text — the raw cause may name the endpoint
      // or the canonical target and goes only to the sanitized
      // diagnostics journal.
      ledger.terminal("failed", { clientHttpStatus: 502 });
      ledger.fail({ classification: "runtime-failure", error });
      await diagnostics.fail({
        classification: "runtime-failure",
        stage: "native-passthrough",
        clientStatus: 502,
        error,
      });
      return toResponse(
        renderResponsesError(
          502,
          "api_error",
          error.kind === "ResponsesPassthroughTransportError"
            ? "Upstream provider request failed"
            : "Upstream provider response could not be read",
        ),
      );
    }
    throw error;
  }
  request.signal.throwIfAborted();
  const terminalUsage = extractResponsesPassthroughUsage(
    upstream.body,
    upstream.headers["content-type"] ?? "",
    model.api,
  );
  if (terminalUsage !== undefined) ledger.terminalUsage(terminalUsage);
  if (upstream.status >= 400 && alias === undefined) {
    // Legacy handler seam: upstream error responses pass through verbatim.
    ledger.terminal("failed", { clientHttpStatus: upstream.status });
    await diagnostics.fail({
      classification: "runtime-failure",
      stage: "native-passthrough",
      clientStatus: upstream.status,
      ...(upstream.headers["request-id"] === undefined
        ? {}
        : { safeIds: { requestId: upstream.headers["request-id"] } }),
    });
  }
  if (upstream.status >= 400 && alias !== undefined) {
    // Alias mode never forwards upstream error bytes: arbitrary upstream
    // error text or headers could name the canonical target. The client
    // receives a legal fixed value-free error instead.
    ledger.terminal("failed", { clientHttpStatus: 502 });
    await diagnostics.fail({
      classification: "runtime-failure",
      stage: "native-passthrough",
      clientStatus: upstream.status,
      ...(upstream.headers["request-id"] === undefined
        ? {}
        : { safeIds: { requestId: upstream.headers["request-id"] } }),
    });
    return toResponse(
      renderResponsesError(502, "api_error", "Upstream provider failed"),
    );
  }
  // Ticket 15 symmetry: a successful upstream response must expose the
  // requested alias, never the canonical model id. The buffered body is
  // projected before any byte is committed; an unprojectable shape fails
  // safely (no upstream bytes, no canonical identity).
  let body = upstream.body;
  if (alias !== undefined) {
    const projected = projectResponsesPassthroughBody(
      body,
      upstream.headers["content-type"] ?? "",
      alias,
    );
    if ("error" in projected) {
      // The detailed projection reason is value-free and useful for
      // diagnostics; the client sees only the fixed safe envelope.
      ledger.terminal("failed", { clientHttpStatus: 502 });
      ledger.fail({ classification: "runtime-failure", error: projected.error });
      await diagnostics.fail({
        classification: "runtime-failure",
        stage: "native-passthrough",
        clientStatus: 502,
        error: new Error(projected.error),
      });
      return toResponse(
        renderResponsesError(
          502,
          "api_error",
          "Upstream response could not be projected safely",
        ),
      );
    }
    body = projected.body;
  }
  if (upstream.status < 400) {
    ledger.terminal("success", { clientHttpStatus: upstream.status });
  }
  return new Response(body, {
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
    requestLedger: options.requestLedger ?? createNoopRequestLedger(),
    deepCapture: options.deepCapture ?? createNoopDeepCaptureAuthority(),
    sessionState,
    passthroughFetch: options.passthroughFetch ?? globalThis.fetch,
    aliasSource: options.aliasSource,
    maxRequestBytes: options.maxRequestBytes,
    routerDefaults: Object.freeze({ ...(options.routerDefaults ?? {}) }),
    createResponseId: options.createResponseId ?? (() => `resp_${randomUUID()}`),
    now: options.now ?? Date.now,
    resolveRequestModel: options.resolveRequestModel ?? identityRequestModelResolver,
    executeOperation: options.executeOperation ?? execute,
    codexLocalAuth: options.codexLocalAuth,
    codexNativeModels: options.codexNativeModels,
  });
  return Object.freeze({
    method: "POST",
    pathname: "/v1/responses",
    handle: (request: Request) =>
      handleOpenAIResponsesWithDiagnostics(dependencies, request),
    requestIdFor: (request: Request) => requestIds.get(request),
  });
}
