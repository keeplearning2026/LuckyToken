import type { Models } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";

import type { Auth } from "../../auth.js";
import {
  execute,
  ExecutionAbortedError,
  freezePiInvocation,
} from "../../execution.js";
import {
  type ClientProtocolHandler,
  HttpRequestAbortedError,
} from "../../http.js";
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
  convertValidatedAnthropicRequest,
  validateAnthropicSourceRequest,
} from "./request.js";
import {
  assertAnthropicModelAwareValidity,
  defaultAnthropicModelValidityPolicy,
  type AnthropicModelValidityPolicy,
} from "./representability.js";
import { renderAnthropicTextMessage } from "./response.js";
import { renderAnthropicAtomicSse } from "./sse.js";
import {
  renderAnthropicError,
  renderAnthropicJsonSuccess,
  type PreparedHttpResponse,
} from "./wire.js";

export const anthropicMessagesProtocolId = "anthropic-messages";

export interface AnthropicMessagesHandlerOptions {
  readonly models: Models;
  readonly auth: Auth;
  readonly modelValidityPolicy?: AnthropicModelValidityPolicy;
  readonly createMessageId?: () => string;
  readonly maxRequestBytes?: number;
  readonly routerDefaults?: RouterOptionDefaults;
  readonly now?: () => number;
}

interface AnthropicMessagesDependencies {
  readonly models: Models;
  readonly auth: Auth;
  readonly modelValidityPolicy: AnthropicModelValidityPolicy;
  readonly createMessageId: () => string;
  readonly maxRequestBytes: number;
  readonly routerDefaults: RouterOptionDefaults;
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
): Promise<Response> {
  try {
    request.signal.throwIfAborted();
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
    const validatedRequest = validateAnthropicSourceRequest(
      body,
      sourceProfile.unclassifiedAnthropicHeaders,
    );
    const model = resolveModel(dependencies.models, validatedRequest.selector);
    assertAnthropicModelAwareValidity(
      validatedRequest,
      model,
      sourceProfile,
      dependencies.modelValidityPolicy,
    );
    const invocation = convertValidatedAnthropicRequest(validatedRequest, receivedAt);
    const piOptions = composeOptions(
      invocation.options,
      {
        sessionId: authResult.sessionId,
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
    );
    request.signal.throwIfAborted();
    const target = renderAnthropicTextMessage(
      message,
      invocation.renderState.clientModel,
      dependencies.createMessageId(),
    );
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
    return toResponse(
      renderAnthropicError(500, "api_error", "Internal server error"),
    );
  }
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
    modelValidityPolicy,
    createMessageId: options.createMessageId ?? (() => `msg_${randomUUID()}`),
    maxRequestBytes: options.maxRequestBytes ?? 1_048_576,
    routerDefaults: Object.freeze({ ...(options.routerDefaults ?? {}) }),
    now: options.now ?? Date.now,
  });
  return Object.freeze({
    method: "POST",
    pathname: "/v1/messages",
    handle: (request: Request) => handleAnthropicMessages(dependencies, request),
  });
}
