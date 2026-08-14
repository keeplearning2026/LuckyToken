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
import { HttpObserver } from "../../http-observer.js";
import { supportsFetchObservation } from "../../http-failure-acquisition.js";
import {
  ModelResolutionFailure,
  resolveModel,
} from "../../model-resolution.js";
import { composeOptions, type RouterOptionDefaults } from "./options.js";
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
import { mapUpstreamHttpFailure } from "./upstream-failure.js";
import {
  isAnthropicNativePassthroughModel,
  passthroughAnthropicRequest,
  passthroughRequestHeaders,
  type PassthroughAnthropicResult,
} from "./passthrough.js";

export const anthropicMessagesProtocolId = "anthropic-messages";

export interface AnthropicMessagesHandlerOptions {
  readonly models: Models;
  readonly auth: Auth;
  readonly configuration?: AnthropicConfiguration;
  readonly invocationDiagnostics?: InvocationDiagnosticsFactory;
  /**
   * Optional invocation HTTP observer shared with provider composition. When
   * provided, the handler uses it instead of creating its own, so provider
   * HTTP failures observed through the bound fetch chain are visible to the
   * handler.
   */
  readonly httpObserver?: HttpObserver;
  readonly modelValidityPolicy?: AnthropicModelValidityPolicy;
  readonly createMessageId?: () => string;
  /** Request body byte ceiling. Single source of truth: the composition root
   *  passes `config.limits.maxRequestBytes`; this handler consumes it and
   *  never supplies its own default. */
  readonly maxRequestBytes: number;
  readonly routerDefaults?: RouterOptionDefaults;
  readonly now?: () => number;
}

interface AnthropicMessagesDependencies {
  readonly models: Models;
  readonly auth: Auth;
  readonly configuration: AnthropicConfiguration;
  readonly invocationDiagnostics: InvocationDiagnosticsFactory;
  readonly httpObserver?: HttpObserver;
  readonly modelValidityPolicy: AnthropicModelValidityPolicy;
  readonly createMessageId: () => string;
  readonly maxRequestBytes: number;
  readonly routerDefaults: RouterOptionDefaults;
  readonly now: () => number;
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
  // Invocation-local HTTP observer. Created before the try so the catch can
  // read the latest upstream HTTP outcome after `execute` throws.
  const httpObserver = dependencies.httpObserver ?? new HttpObserver();
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
    const model = resolveModel(dependencies.models, selector);
    if (isAnthropicNativePassthroughModel(model)) {
      return passthroughBranch(
        dependencies,
        httpObserver.observedFetch,
        request,
        model,
        rawBody,
        diagnostics,
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
        sessionId: authResult.sessionId,
        signal: request.signal,
        // Only inject the HTTP observer for Pi adapters that accept and use
        // options.fetch. Adapters with their own fetch binding must keep
        // their injected fetch chain.
        ...(supportsFetchObservation(model.api)
          ? { fetch: httpObserver.observedFetch }
          : {}),
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
    const observation = httpObserver.latestObservation;
    if (observation !== undefined && observation.kind === "response") {
      const mapping = mapUpstreamHttpFailure(observation);
      if (mapping !== undefined) {
        return toResponse(
          renderAnthropicError(mapping.status, mapping.type, mapping.message),
        );
      }
    }
    // Provider execution failure without an observed HTTP response: forward
    // the Pi error text as a 502 (upstream failure) so the Anthropic client
    // sees the real reason instead of a generic 500. Structural check rather
    // than `instanceof` so module duplication across test runtimes cannot
    // misclassify the error. Only the exact ExecutionFailure kind (not the
    // MalformedExecutionStreamError / UnsupportedExecutionOutcomeError
    // subclasses) represents a provider-reported failure.
    if (
      error instanceof Error &&
      "kind" in error &&
      error.kind === "ExecutionFailure" &&
      "diagnostic" in error &&
      "reason" in error &&
      error.reason === "error"
    ) {
      const diagnostic = error.diagnostic;
      const message =
        typeof diagnostic === "string"
          ? diagnostic
          : error.message || "Upstream provider failed";
      return toResponse(
        renderAnthropicError(502, "api_error", message),
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
 * and upstream HTTP failure. The HttpObserver still records the upstream
 * outcome through its observed fetch, but the client always sees the
 * upstream response as-is.
 */
async function passthroughBranch(
  dependencies: AnthropicMessagesDependencies,
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
        model,
        rawBody,
        apiKey,
        signal: request.signal,
        fetch: fetchImpl,
        upstreamHeaders: passthroughRequestHeaders(request),
      }),
      request.signal,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      "kind" in error &&
      error.kind === "AnthropicPassthroughBodyReadError"
    ) {
      // Pre-commit upstream body-read failure: the upstream response never
      // committed, so this is a legal non-streaming Anthropic error (upstream
      // failure), never a raw exception.
      return toResponse(
        renderAnthropicError(502, "api_error", error.message),
      );
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
    ...(options.httpObserver === undefined
      ? {}
      : { httpObserver: options.httpObserver }),
    modelValidityPolicy,
    createMessageId: options.createMessageId ?? (() => `msg_${randomUUID()}`),
    maxRequestBytes: options.maxRequestBytes,
    routerDefaults: Object.freeze({ ...(options.routerDefaults ?? {}) }),
    now: options.now ?? Date.now,
  });
  return Object.freeze({
    method: "POST",
    pathname: "/v1/messages",
    handle: (request: Request) =>
      handleAnthropicMessagesWithDiagnostics(dependencies, request),
  });
}
