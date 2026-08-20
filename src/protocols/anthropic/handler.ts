import type {
  FetchFunction,
  Model,
  Models,
} from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";

import {
  resolveRequestIdentity,
  type RequestIdentity,
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
  bindAnthropicConfiguration,
  parseAnthropicConfiguration,
  type AnthropicConfiguration,
} from "./configuration.js";
import {
  execute,
  ExecutionAbortedError,
  ExecutionFailure,
  freezePiInvocation,
  type ExecutionOperation,
} from "../../execution.js";
import {
  type ClientProtocolHandler,
  HttpRequestAbortedError,
} from "../../http.js";
import {
  ModelResolutionFailure,
} from "../../model-resolution.js";
import {
  resolveDataPlanePublicModel,
  type PublicModelSource,
} from "../../public-model-seam.js";
import {
  composeOptions,
  identityRequestModelResolver,
  type RequestModelResolver,
  type RouterOptionDefaults,
} from "./options.js";
import { InvalidRequest, UnsupportedFeature } from "./failures.js";
import {
  assertImplementedAnthropicProfile,
  resolveAnthropicSourceProfile,
} from "./profile.js";
import {
  convertValidatedAnthropicRequestWithPolicy,
  extractAnthropicModelSelector,
  validateAnthropicSourceRequest,
} from "./request.js";
import {
  assertAnthropicModelAwareValidity,
  defaultAnthropicModelValidityPolicy,
  type AnthropicModelValidityPolicy,
} from "./representability.js";
import { convertAssistantMessageToAnthropicWithPolicy } from "./response.js";
import { renderAnthropicAtomicSse } from "./sse.js";
import {
  renderAnthropicError,
  renderAnthropicJsonSuccess,
  type PreparedHttpResponse,
} from "./wire.js";
import {
  mapUpstreamFailureFact,
  requestIdFromFact,
} from "./failure-rendering.js";
import {
  isAnthropicNativePassthroughModel,
  passthroughAnthropicRequest,
  passthroughRequestHeaders,
  projectAnthropicPassthroughBody,
  type PassthroughAnthropicResult,
} from "./passthrough.js";

export const anthropicMessagesProtocolId = "anthropic-messages";

/**
 * Ticket 18 correlation: the accepted ledger request id of every request
 * currently being handled (weak: entries vanish with the Request object).
 * The HTTP boundary reads it only to correlate a transport-synthesized
 * error response with the persisted ledger row; the ledger module never
 * enters the transport layer.
 */
const requestIds = new WeakMap<Request, string>();

export interface AnthropicMessagesHandlerOptions {
  readonly models: Models;
  readonly createSessionId?: () => string;
  readonly onRequestIdentity?: (identity: RequestIdentity) => void;
  readonly configuration?: AnthropicConfiguration;
  readonly invocationDiagnostics?: InvocationDiagnosticsFactory;
  /** Narrow transport dependency used only by native wire passthrough. */
  readonly passthroughFetch?: FetchFunction;
  readonly modelValidityPolicy?: AnthropicModelValidityPolicy;
  readonly createMessageId?: () => string;
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
  readonly now?: () => number;
  /**
   * Ticket 10: narrow Pi-typed request-local model derivation: the
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
}

interface AnthropicMessagesDependencies {
  readonly models: Models;
  readonly createSessionId: () => string;
  readonly onRequestIdentity: ((identity: RequestIdentity) => void) | undefined;
  readonly configuration: AnthropicConfiguration;
  readonly invocationDiagnostics: InvocationDiagnosticsFactory;
  readonly requestLedger: RequestLedger;
  readonly deepCapture: DeepCaptureAuthority;
  readonly passthroughFetch: FetchFunction;
  readonly modelValidityPolicy: AnthropicModelValidityPolicy;
  readonly createMessageId: () => string;
  readonly publicModels: PublicModelSource | undefined;
  readonly maxRequestBytes: number;
  readonly routerDefaults: RouterOptionDefaults;
  readonly now: () => number;
  readonly resolveRequestModel: RequestModelResolver;
  readonly executeOperation: ExecutionOperation;
}

function toResponse(prepared: PreparedHttpResponse): Response {
  const headers: Record<string, string> = {
    "content-type": prepared.contentType,
  };
  if (prepared.headers !== undefined) {
    for (const [name, value] of Object.entries(prepared.headers)) {
      headers[name] = value;
    }
  }
  return new Response(prepared.body, {
    status: prepared.status,
    headers,
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
  dependencies: AnthropicMessagesDependencies,
  request: Request,
  requestId: string,
): DeepCaptureEntry {
  try {
    return dependencies.deepCapture.begin({
      requestId,
      protocolId: anthropicMessagesProtocolId,
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
  if (signal.aborted) throw new HttpRequestAbortedError(signal.reason);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new HttpRequestAbortedError(signal.reason));
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
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

async function readRawBody(
  request: Request,
  maximumBytes: number,
): Promise<string | undefined> {
  const declaredLength = request.headers.get("content-length");
  if (/^[0-9]+$/u.test(declaredLength ?? "") && Number(declaredLength) > maximumBytes) {
    return undefined;
  }
  const rawBody = await raceWithRequestSignal(request.text(), request.signal);
  return new TextEncoder().encode(rawBody).byteLength <= maximumBytes
    ? rawBody
    : undefined;
}

async function handleAnthropicMessages(
  dependencies: AnthropicMessagesDependencies,
  request: Request,
  diagnostics: InvocationDiagnostics,
  ledger: RequestLedgerEntry,
  capture: DeepCaptureEntry,
): Promise<Response> {
  try {
    request.signal.throwIfAborted();
    diagnostics.checkpoint({ stage: "client-validation" });
    const receivedAt = dependencies.now();
    if (!hasJsonContentType(request.headers)) {
      ledger.terminal("failed", { clientHttpStatus: 415 });
      return toResponse(
        renderAnthropicError(
          415,
          "invalid_request_error",
          "Content-Type must be application/json",
          ledger.requestId,
        ),
      );
    }

    const requestIdentity = resolveRequestIdentity(
      request.headers,
      dependencies.createSessionId,
    );
    dependencies.onRequestIdentity?.(requestIdentity);
    ledger.authorized({
      effectiveSessionId: requestIdentity.effectiveSessionId,
      ...(requestIdentity.clientSessionId === undefined
        ? {}
        : { clientSessionId: requestIdentity.clientSessionId }),
    });

    const sourceProfile = resolveAnthropicSourceProfile(request.headers);
    const rawBody = await readRawBody(request, dependencies.maxRequestBytes);
    if (rawBody === undefined) {
      ledger.terminal("failed", { clientHttpStatus: 413 });
      return toResponse(
        renderAnthropicError(
          413,
          "request_too_large",
          "Request exceeds the configured maximum size",
          ledger.requestId,
        ),
      );
    }
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
    const body: unknown = JSON.parse(rawBody);
    assertImplementedAnthropicProfile(sourceProfile);
    const selector = extractAnthropicModelSelector(body);
    diagnostics.checkpoint({ stage: "model-resolution", selector });
    const resolution = await resolveDataPlanePublicModel(
      dependencies.models,
      dependencies.publicModels,
      selector,
    );
    if (resolution.kind === "unknown") {
      ledger.aliasCaptured({ externalAlias: selector });
      ledger.terminal("unknown-alias", { clientHttpStatus: 404 });
      return toResponse(
        renderAnthropicError(
          404,
          "not_found_error",
          `Unknown model: ${selector}`,
          ledger.requestId,
        ),
      );
    }
    if (resolution.kind === "unavailable") {
      ledger.aliasCaptured({ externalAlias: selector });
      ledger.terminal("unavailable-alias", { clientHttpStatus: 502 });
      return toResponse(
        renderAnthropicError(
          502,
          "api_error",
          "The requested model is not currently available",
          ledger.requestId,
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
    if (isAnthropicNativePassthroughModel(model)) {
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
    const validatedRequest = validateAnthropicSourceRequest(body);
    assertAnthropicModelAwareValidity(
      validatedRequest,
      model,
      sourceProfile,
      dependencies.modelValidityPolicy,
    );
    const invocation = convertValidatedAnthropicRequestWithPolicy(
      validatedRequest,
      receivedAt,
      dependencies.configuration.conversion.request,
    );
    for (const notice of invocation.notices) {
      diagnostics.notice(notice);
      ledger.notice(notice);
    }
    diagnostics.checkpoint({ stage: "pi-composition", selector });
    const piOptions = composeOptions(
      invocation.options,
      {
        sessionId: requestIdentity.effectiveSessionId,
        signal: request.signal,
      },
      dependencies.routerDefaults,
    );
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
    diagnostics.checkpoint({ stage: "client-render", selector });
    ledger.rendering();
    const responseConversion = convertAssistantMessageToAnthropicWithPolicy(
      message,
      {
        selector: invocation.renderState.selector,
        createMessageId: dependencies.createMessageId,
      },
      dependencies.configuration.conversion.response,
    );
    for (const notice of responseConversion.notices) {
      diagnostics.notice(notice);
      ledger.notice(notice);
    }
    const target = responseConversion.message;
    const prepared = invocation.renderState.stream
      ? renderAnthropicAtomicSse(target)
      : renderAnthropicJsonSuccess(target);
    request.signal.throwIfAborted();
    return toResponse(prepared);
  } catch (error) {
    if (request.signal.aborted || error instanceof HttpRequestAbortedError) {
      throw new HttpRequestAbortedError(request.signal.reason);
    }
    if (error instanceof ExecutionAbortedError) {
      ledger.terminal("aborted", { clientHttpStatus: 500 });
      return toResponse(
        renderAnthropicError(
          500,
          "api_error",
          "Model execution was aborted",
          ledger.requestId,
        ),
      );
    }
    if (error instanceof SyntaxError) {
      ledger.terminal("failed", { clientHttpStatus: 400 });
      return toResponse(
        renderAnthropicError(
          400,
          "invalid_request_error",
          "Request body is not valid JSON",
          ledger.requestId,
        ),
      );
    }
    if (error instanceof InvalidRequest || error instanceof UnsupportedFeature) {
      ledger.terminal("failed", { clientHttpStatus: 400 });
      return toResponse(
        renderAnthropicError(
          400,
          "invalid_request_error",
          error.message,
          ledger.requestId,
        ),
      );
    }
    if (error instanceof ModelResolutionFailure) {
      ledger.terminal("failed", { clientHttpStatus: 404 });
      return toResponse(
        renderAnthropicError(
          404,
          "not_found_error",
          error.message,
          ledger.requestId,
        ),
      );
    }
    if (
      error instanceof ExecutionFailure &&
      error.failure !== undefined &&
      error.failure.kind !== "caller_cancellation"
    ) {
      const mapping = mapUpstreamFailureFact(error.failure);
      ledger.terminal("failed", { clientHttpStatus: mapping.status });
      ledger.fail({ classification: "runtime-failure", error });
      return toResponse(
        renderAnthropicError(
          mapping.status,
          mapping.type,
          mapping.message,
          requestIdFromFact(error.failure) ?? ledger.requestId,
          mapping.safeHeaders,
        ),
      );
    }
    // A Provider failure without a trusted neutral fact has no authority for
    // a client-visible status, type, code, headers, or message. Structural
    // matching keeps module duplication harmless while excluding the
    // malformed/deferred ExecutionFailure subclasses.
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
        renderAnthropicError(
          502,
          "api_error",
          "Upstream provider failed",
          ledger.requestId,
        ),
      );
    }
    ledger.terminal("failed", { clientHttpStatus: 500 });
    return toResponse(
      renderAnthropicError(
        500,
        "api_error",
        "Internal server error",
        ledger.requestId,
      ),
    );
  }
}

async function handleAnthropicMessagesWithDiagnostics(
  dependencies: AnthropicMessagesDependencies,
  request: Request,
): Promise<Response> {
  const diagnostics = dependencies.invocationDiagnostics.begin(anthropicMessagesProtocolId);
  // Ticket 18: the handler assigns the safe unique request id and records an
  // accepted request at handler entry, before content-type/body/auth/model
  // validation and before Pi execution. The correlation is published before
  // the first await so a transport-synthesized error response can still
  // carry the exact id of this accepted request.
  const ledger = dependencies.requestLedger.begin(anthropicMessagesProtocolId);
  requestIds.set(request, ledger.requestId);
  // Ticket 22: the capture observer reads the one global enable snapshot at
  // the same acceptance line and keeps it immutable for this request; the
  // request id is the ledger's — capture never mints its own. begin is
  // isolated: a throwing authority falls back to the safe disabled entry.
  const capture = beginCapture(dependencies, request, ledger.requestId);
  try {
    const response = await handleAnthropicMessages(dependencies, request, diagnostics, ledger, capture);
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
      error instanceof HttpRequestAbortedError ||
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
 * Passthrough branch: forward the client's raw Anthropic request verbatim to
 * the upstream endpoint and return its response unchanged (buffered Atomic).
 *
 * Owns the full passthrough lifecycle: upstream auth resolution, forwarding,
 * and verbatim response return (status + headers + body) for both success
 * and upstream HTTP failure. The client always sees the upstream response
 * as-is; this direct transport is deliberately separate from conversion.
 */
async function passthroughBranch(
  dependencies: AnthropicMessagesDependencies,
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
        (lower === "authorization" ||
          lower === "x-api-key" ||
          lower === "cf-aig-authorization") &&
        value !== undefined &&
        value !== null &&
        value.trim().length > 0
      );
    });
  if (apiKey === undefined && !hasHeaderAuth) {
    ledger.terminal("failed", { clientHttpStatus: 502 });
    return toResponse(
      renderAnthropicError(
        502,
        "api_error",
        `Provider is not configured: ${model.provider}`,
        ledger.requestId,
      ),
    );
  }
  let upstream: PassthroughAnthropicResult;
  try {
    ledger.executing();
    upstream = await raceWithRequestSignal(
      passthroughAnthropicRequest({
        model: dependencies.resolveRequestModel(model, auth),
        rawBody,
        apiKey,
        signal: request.signal,
        fetch: fetchImpl,
        upstreamHeaders: passthroughRequestHeaders(request),
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
      (error.kind === "AnthropicPassthroughBodyReadError" ||
        error.kind === "AnthropicPassthroughTransportError")
    ) {
      // Pre-commit upstream failure (body-read or transport): no upstream
      // response byte ever committed to the client, so this is a legal
      // non-streaming Anthropic error (upstream failure), never a raw
      // exception. The client sees fixed actionable text — the raw cause
      // may name the endpoint or the canonical target and goes only to
      // the sanitized diagnostics journal.
      ledger.terminal("failed", { clientHttpStatus: 502 });
      ledger.fail({ classification: "runtime-failure", error });
      await diagnostics.fail({
        classification: "runtime-failure",
        stage: "native-passthrough",
        clientStatus: 502,
        error,
      });
      return toResponse(
        renderAnthropicError(
          502,
          "api_error",
          error.kind === "AnthropicPassthroughTransportError"
            ? "Upstream provider request failed"
            : "Upstream provider response could not be read",
          ledger.requestId,
        ),
      );
    }
    throw error;
  }
  request.signal.throwIfAborted();
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
      renderAnthropicError(
        502,
        "api_error",
        "Upstream provider failed",
        ledger.requestId,
      ),
    );
  }
  // Ticket 15 symmetry: a successful upstream response must expose the
  // requested alias, never the canonical model id. The buffered body is
  // projected before any byte is committed; an unprojectable shape fails
  // safely (no upstream bytes, no canonical identity).
  let body = upstream.body;
  if (alias !== undefined) {
    const projected = projectAnthropicPassthroughBody(
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
        renderAnthropicError(
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

export function createAnthropicMessagesHandler(
  options: AnthropicMessagesHandlerOptions,
): ClientProtocolHandler {
  const policy = options.modelValidityPolicy ?? defaultAnthropicModelValidityPolicy;
  const classifyFinalAssistantPrefill = policy.classifyFinalAssistantPrefill;
  const hasCertifiedImageFidelity = policy.hasCertifiedImageFidelity;
  const modelValidityPolicy: AnthropicModelValidityPolicy = Object.freeze({
    revision: policy.revision,
    classifyFinalAssistantPrefill: (
      model: Parameters<
        AnthropicModelValidityPolicy["classifyFinalAssistantPrefill"]
      >[0],
      profile: Parameters<
        AnthropicModelValidityPolicy["classifyFinalAssistantPrefill"]
      >[1],
    ) =>
      classifyFinalAssistantPrefill(model, profile),
    hasCertifiedImageFidelity: (
      model: Parameters<
        AnthropicModelValidityPolicy["hasCertifiedImageFidelity"]
      >[0],
    ) => hasCertifiedImageFidelity(model),
  });
  const dependencies: AnthropicMessagesDependencies = Object.freeze({
    models: options.models,
    createSessionId: options.createSessionId ?? randomUUID,
    onRequestIdentity: options.onRequestIdentity,
    configuration:
      options.configuration === undefined
        ? parseAnthropicConfiguration()
        : bindAnthropicConfiguration(options.configuration),
    invocationDiagnostics:
      options.invocationDiagnostics ?? createNoopInvocationDiagnosticsFactory(),
    requestLedger: options.requestLedger ?? createNoopRequestLedger(),
    deepCapture: options.deepCapture ?? createNoopDeepCaptureAuthority(),
    passthroughFetch: options.passthroughFetch ?? globalThis.fetch,
    modelValidityPolicy,
    createMessageId: options.createMessageId ?? (() => `msg_${randomUUID()}`),
    publicModels: options.publicModels,
    maxRequestBytes: options.maxRequestBytes,
    routerDefaults: Object.freeze({ ...(options.routerDefaults ?? {}) }),
    now: options.now ?? Date.now,
    resolveRequestModel: options.resolveRequestModel ?? identityRequestModelResolver,
    executeOperation: options.executeOperation ?? execute,
  });
  return Object.freeze({
    method: "POST",
    pathname: "/v1/messages",
    handle: (request: Request) =>
      handleAnthropicMessagesWithDiagnostics(dependencies, request),
    requestIdFor: (request: Request) => requestIds.get(request),
  });
}
