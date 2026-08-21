import type { Model, Models } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";

import {
  resolveRequestIdentity,
} from "../../request-identity.js";
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
  type ExecutionOperation,
} from "../../execution.js";
import type { ClientProtocolHandler } from "../../http.js";
import { ModelResolutionFailure } from "../../model-resolution.js";
import {
  resolveDataPlanePublicModel,
  type PublicModelSource,
} from "../../public-model-seam.js";
import type { RouterOptionDefaults } from "../options.js";
import { InvalidRequest } from "./request.js";
import {
  readResponsesRequestBody,
  ResponsesRequestBodyTooLargeError,
  UnsupportedResponsesContentEncodingError,
} from "./request-body.js";
import {
  renderResponsesError,
  renderResponsesErrorResponse,
  type PreparedHttpResponse,
} from "./response.js";
import { mapUpstreamFailureFact } from "./error-rendering.js";
import type { UpstreamFailureFact } from "@luckytoken/provider-contract/diagnostics";
import { extractResponsesModelSelector } from "./request.js";
import {
  createResponseSessionState,
  ResponseStateConversionFailure,
  type ResponseSessionState,
} from "./session-state.js";
import {
  bufferNativeResponsesResponse,
  projectNativeResponsesBody,
  type NativeResponsesResult,
} from "./native-response.js";
import { extractResponsesPassthroughUsage } from "./passthrough-usage.js";
import { executeSemanticResponses } from "./semantic.js";
import type { ProviderResponsesLane } from "../../provider-native-responses/contract.js";

export const openaiResponsesProtocolId = "openai-responses";

/**
 * Ticket 18 correlation: the accepted ledger request id of every request
 * currently being handled (weak: entries vanish with the Request object).
 * The HTTP boundary reads it only to correlate a transport-synthesized
 * error response with the persisted ledger row; the ledger module never
 * enters the transport layer.
 */
const requestIds = new WeakMap<Request, string>();

export interface LocalResponsesLane {
  claims(selector: string): boolean;
  execute(input: {
    readonly request: Request;
    readonly rawBody: string;
    readonly selector: string;
    readonly diagnostics: InvocationDiagnostics;
    readonly ledger: RequestLedgerEntry;
  }): Promise<Response>;
}

export interface OpenAIResponsesHandlerOptions {
  readonly models: Models;
  readonly localNativeLane?: LocalResponsesLane;
  readonly providerNativeLane?: ProviderResponsesLane;
  readonly createSessionId?: () => string;
  readonly configuration?: OpenAIResponsesConfiguration;
  readonly invocationDiagnostics?: InvocationDiagnosticsFactory;
  readonly stateFile: string;
  /**
   * Optional injected session state (test seam). When omitted, the handler
   * creates and owns its own store bound to `stateFile`.
   */
  readonly sessionState?: ResponseSessionState;
  /** Backend-lifetime Public Model source. When absent, direct handler tests
   * use the canonical provider/model selector seam. */
  readonly publicModels?: PublicModelSource;
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
   * Ticket 20: the neutral Pi execution operation. The composition root
   * binds the Provider usage-semantics resolver into the operation
   * (`createExecutionOperation`); the handler never names or carries
   * Provider semantics data. Absent defaults to plain `execute`, whose
   * snapshots are honest Partial undeclared_semantics.
   */
  readonly executeOperation?: ExecutionOperation;
}

interface OpenAIResponsesDependencies {
  readonly models: Models;
  readonly localNativeLane: LocalResponsesLane | undefined;
  readonly providerNativeLane: ProviderResponsesLane | undefined;
  readonly createSessionId: () => string;
  readonly configuration: OpenAIResponsesConfiguration;
  readonly invocationDiagnostics: InvocationDiagnosticsFactory;
  readonly requestLedger: RequestLedger;
  readonly deepCapture: DeepCaptureAuthority;
  readonly sessionState: ResponseSessionState;
  readonly publicModels: PublicModelSource | undefined;
  readonly maxRequestBytes: number;
  readonly routerDefaults: RouterOptionDefaults;
  readonly createResponseId: () => string;
  readonly now: () => number;
  readonly executeOperation: ExecutionOperation;
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

    const requestIdentity = resolveRequestIdentity(
      request.headers,
      dependencies.createSessionId,
    );
    ledger.authorized({
      effectiveSessionId: requestIdentity.effectiveSessionId,
      ...(requestIdentity.clientSessionId === undefined
        ? {}
        : { clientSessionId: requestIdentity.clientSessionId }),
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
    if (dependencies.localNativeLane?.claims(selector) === true) {
      return dependencies.localNativeLane.execute({
        request,
        rawBody,
        selector,
        diagnostics,
        ledger,
      });
    }
    const resolution = await resolveDataPlanePublicModel(
      dependencies.models,
      dependencies.publicModels,
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
      dependencies.publicModels === undefined ? undefined : resolution.alias;
    if (dependencies.providerNativeLane?.claims(model, "responses") === true) {
      return providerNativeBranch(
        dependencies,
        request,
        model,
        rawBody,
        diagnostics,
        ledger,
        projectAlias,
      );
    }

    return executeSemanticResponses({
      request,
      body,
      model,
      requestIdentity,
      models: dependencies.models,
      configuration: dependencies.configuration,
      sessionState: dependencies.sessionState,
      routerDefaults: dependencies.routerDefaults,
      createResponseId: dependencies.createResponseId,
      now: dependencies.now,
      executeOperation: dependencies.executeOperation,
      diagnostics,
      ledger,
    });
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

/** Provider Native execution stays behind its lane seam. The protocol owns
 * lifecycle observation and alias projection, never Provider credentials or
 * request construction. */
async function providerNativeBranch(
  dependencies: OpenAIResponsesDependencies,
  request: Request,
  model: Model<string>,
  rawBody: string,
  diagnostics: InvocationDiagnostics,
  ledger: RequestLedgerEntry,
  alias: string | undefined,
): Promise<Response> {
  const lane = dependencies.providerNativeLane;
  if (lane === undefined) throw new Error("Provider Native lane is unavailable");
  let upstream: NativeResponsesResult;
  try {
    ledger.executing();
    const response = await raceWithRequestSignal(
      lane.execute({
        model,
        rawBody,
        request,
        operation: "responses",
      }),
      request.signal,
    );
    upstream = await bufferNativeResponsesResponse(response, request.signal);
  } catch (error) {
    if (request.signal.aborted) throw error;
    ledger.terminal("failed", { clientHttpStatus: 502 });
    ledger.fail({ classification: "runtime-failure", error });
    await diagnostics.fail({
      classification: "runtime-failure",
      stage: "native-passthrough",
      clientStatus: 502,
      error,
    });
    return toResponse(
      renderResponsesError(502, "api_error", "Upstream provider request failed"),
    );
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
    const projected = projectNativeResponsesBody(
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
  const dependencies: OpenAIResponsesDependencies = Object.freeze({
    models: options.models,
    localNativeLane: options.localNativeLane,
    providerNativeLane: options.providerNativeLane,
    createSessionId: options.createSessionId ?? randomUUID,
    configuration,
    invocationDiagnostics:
      options.invocationDiagnostics ?? createNoopInvocationDiagnosticsFactory(),
    requestLedger: options.requestLedger ?? createNoopRequestLedger(),
    deepCapture: options.deepCapture ?? createNoopDeepCaptureAuthority(),
    sessionState,
    publicModels: options.publicModels,
    maxRequestBytes: options.maxRequestBytes,
    routerDefaults: Object.freeze({ ...(options.routerDefaults ?? {}) }),
    createResponseId: options.createResponseId ?? (() => `resp_${randomUUID()}`),
    now: options.now ?? Date.now,
    executeOperation: options.executeOperation ?? execute,
  });
  return Object.freeze({
    method: "POST",
    pathname: "/v1/responses",
    handle: (request: Request) =>
      handleOpenAIResponsesWithDiagnostics(dependencies, request),
    requestIdFor: (request: Request) => requestIds.get(request),
  });
}
