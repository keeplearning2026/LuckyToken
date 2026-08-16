import type {
  FetchFunction,
  Model,
  Models,
} from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";

import type { Auth } from "../../auth.js";
import {
  createNoopInvocationDiagnosticsFactory,
  type InvocationDiagnostics,
  type InvocationDiagnosticsFactory,
} from "../../invocation-diagnostics/index.js";
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
} from "../../execution.js";
import {
  type ClientProtocolHandler,
  HttpRequestAbortedError,
} from "../../http.js";
import {
  ModelResolutionFailure,
} from "../../model-resolution.js";
import {
  resolveDataPlaneModel,
  type AliasModelSource,
} from "../../alias-model-seam.js";
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

export interface AnthropicMessagesHandlerOptions {
  readonly models: Models;
  readonly auth: Auth;
  readonly configuration?: AnthropicConfiguration;
  readonly invocationDiagnostics?: InvocationDiagnosticsFactory;
  /** Narrow transport dependency used only by native wire passthrough. */
  readonly passthroughFetch?: FetchFunction;
  readonly modelValidityPolicy?: AnthropicModelValidityPolicy;
  readonly createMessageId?: () => string;
  /**
   * Ticket 15 alias-only model data plane: when wired, only configured
   * aliases are valid selectors, converted and passthrough responses echo
   * the requested alias, and the request captures one immutable resolver
   * snapshot at acceptance. Without it the legacy provider/model selector
   * contract applies (handler-level test seam); the composition root
   * always wires the real authority in production.
   */
  readonly aliasSource?: AliasModelSource;
  /** Request body byte ceiling. Single source of truth: the composition root
   *  passes `config.limits.maxRequestBytes`; this handler consumes it and
   *  never supplies its own default. */
  readonly maxRequestBytes: number;
  readonly routerDefaults?: RouterOptionDefaults;
  readonly now?: () => number;
  /**
   * Narrow Pi-typed request-local model derivation (Ticket 10): the
   * composition root wires the Provider/request-composition implementation.
   * Defaults to identity so direct handler tests and handlers without a
   * wired resolver pass the catalog model through unchanged.
   */
  readonly resolveRequestModel?: RequestModelResolver;
}

interface AnthropicMessagesDependencies {
  readonly models: Models;
  readonly auth: Auth;
  readonly configuration: AnthropicConfiguration;
  readonly invocationDiagnostics: InvocationDiagnosticsFactory;
  readonly passthroughFetch: FetchFunction;
  readonly modelValidityPolicy: AnthropicModelValidityPolicy;
  readonly createMessageId: () => string;
  readonly aliasSource: AliasModelSource | undefined;
  readonly maxRequestBytes: number;
  readonly routerDefaults: RouterOptionDefaults;
  readonly now: () => number;
  readonly resolveRequestModel: RequestModelResolver;
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
): Promise<Response> {
  try {
    request.signal.throwIfAborted();
    diagnostics.checkpoint({ stage: "client-validation" });
    const receivedAt = dependencies.now();
    if (!hasJsonContentType(request.headers)) {
      return toResponse(
        renderAnthropicError(
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
        renderAnthropicError(
          401,
          "authentication_error",
          "Invalid authorization credentials",
        ),
      );
    }

    const sourceProfile = resolveAnthropicSourceProfile(request.headers);
    const rawBody = await readRawBody(request, dependencies.maxRequestBytes);
    if (rawBody === undefined) {
      return toResponse(
        renderAnthropicError(
          413,
          "request_too_large",
          "Request exceeds the configured maximum size",
        ),
      );
    }
    const body: unknown = JSON.parse(rawBody);
    assertImplementedAnthropicProfile(sourceProfile);
    const selector = extractAnthropicModelSelector(body);
    diagnostics.checkpoint({ stage: "model-resolution", selector });
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
      return toResponse(
        renderAnthropicError(404, "not_found_error", `Unknown model: ${selector}`),
      );
    }
    if (resolution.kind === "unavailable") {
      return toResponse(
        renderAnthropicError(
          502,
          "api_error",
          "The requested model is not currently available",
        ),
      );
    }
    const model = resolution.model;
    // Passthrough response projection is alias-only: the alias captured at
    // acceptance must be echoed symmetrically by the upstream response.
    const projectAlias =
      dependencies.aliasSource === undefined ? undefined : resolution.alias;
    if (isAnthropicNativePassthroughModel(model)) {
      return passthroughBranch(
        dependencies,
        dependencies.passthroughFetch,
        request,
        model,
        rawBody,
        diagnostics,
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
    }
    diagnostics.checkpoint({ stage: "pi-composition", selector });
    const piOptions = composeOptions(
      invocation.options,
      {
        sessionId: authResult.effectiveSessionId,
        signal: request.signal,
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
      {
        notice: (notice) => diagnostics.notice(notice),
        attempt: (attempt) => diagnostics.attempt(attempt),
      },
    );
    diagnostics.checkpoint({ stage: "client-render", selector });
    request.signal.throwIfAborted();
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
      return toResponse(
        renderAnthropicError(500, "api_error", "Model execution was aborted"),
      );
    }
    if (error instanceof SyntaxError) {
      return toResponse(
        renderAnthropicError(
          400,
          "invalid_request_error",
          "Request body is not valid JSON",
        ),
      );
    }
    if (error instanceof InvalidRequest || error instanceof UnsupportedFeature) {
      return toResponse(
        renderAnthropicError(400, "invalid_request_error", error.message),
      );
    }
    if (error instanceof ModelResolutionFailure) {
      return toResponse(renderAnthropicError(404, "not_found_error", error.message));
    }
    if (
      error instanceof ExecutionFailure &&
      error.failure !== undefined &&
      error.failure.kind !== "caller_cancellation"
    ) {
      const mapping = mapUpstreamFailureFact(error.failure);
      return toResponse(
        renderAnthropicError(
          mapping.status,
          mapping.type,
          mapping.message,
          requestIdFromFact(error.failure),
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
      return toResponse(
        renderAnthropicError(502, "api_error", "Upstream provider failed"),
      );
    }
    return toResponse(
      renderAnthropicError(500, "api_error", "Internal server error"),
    );
  }
}

async function handleAnthropicMessagesWithDiagnostics(
  dependencies: AnthropicMessagesDependencies,
  request: Request,
): Promise<Response> {
  const diagnostics = dependencies.invocationDiagnostics.begin(anthropicMessagesProtocolId);
  try {
    const response = await handleAnthropicMessages(dependencies, request, diagnostics);
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
    return toResponse(
      renderAnthropicError(
        502,
        "api_error",
        `Provider is not configured: ${model.provider}`,
      ),
    );
  }
  let upstream: PassthroughAnthropicResult;
  try {
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
        ),
      );
    }
    throw error;
  }
  request.signal.throwIfAborted();
  if (upstream.status >= 400 && alias === undefined) {
    // Legacy handler seam: upstream error responses pass through verbatim.
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
    await diagnostics.fail({
      classification: "runtime-failure",
      stage: "native-passthrough",
      clientStatus: upstream.status,
      ...(upstream.headers["request-id"] === undefined
        ? {}
        : { safeIds: { requestId: upstream.headers["request-id"] } }),
    });
    return toResponse(
      renderAnthropicError(502, "api_error", "Upstream provider failed"),
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
    auth: options.auth,
    configuration:
      options.configuration === undefined
        ? parseAnthropicConfiguration()
        : bindAnthropicConfiguration(options.configuration),
    invocationDiagnostics:
      options.invocationDiagnostics ?? createNoopInvocationDiagnosticsFactory(),
    passthroughFetch: options.passthroughFetch ?? globalThis.fetch,
    modelValidityPolicy,
    createMessageId: options.createMessageId ?? (() => `msg_${randomUUID()}`),
    aliasSource: options.aliasSource,
    maxRequestBytes: options.maxRequestBytes,
    routerDefaults: Object.freeze({ ...(options.routerDefaults ?? {}) }),
    now: options.now ?? Date.now,
    resolveRequestModel: options.resolveRequestModel ?? identityRequestModelResolver,
  });
  return Object.freeze({
    method: "POST",
    pathname: "/v1/messages",
    handle: (request: Request) =>
      handleAnthropicMessagesWithDiagnostics(dependencies, request),
  });
}
