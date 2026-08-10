import type { Models } from "@earendil-works/pi-ai";

import type { Auth } from "./auth.js";
import { execute, ExecutionAbortedError } from "./execution.js";
import {
  ModelResolutionFailure,
  resolveModel,
} from "./model-resolution.js";
import { InvalidRequest, UnsupportedFeature } from "./protocols/anthropic/failures.js";
import {
  assertImplementedAnthropicProfile,
  resolveAnthropicSourceProfile,
} from "./protocols/anthropic/profile.js";
import {
  convertValidatedAnthropicRequest,
  validateAnthropicSourceRequest,
} from "./protocols/anthropic/request.js";
import {
  assertAnthropicModelAwareValidity,
  type AnthropicModelValidityPolicy,
} from "./protocols/anthropic/representability.js";
import { renderAnthropicTextMessage } from "./protocols/anthropic/response.js";

export class HttpRequestAbortedError extends Error {
  readonly reason: unknown;

  constructor(reason?: unknown) {
    super("HTTP request is no longer writable");
    this.name = "HttpRequestAbortedError";
    this.reason = reason;
  }
}

export interface HttpBoundaryDependencies {
  models: Models;
  auth: Auth;
  modelValidityPolicy: AnthropicModelValidityPolicy;
  createMessageId: () => string;
  maxRequestBytes: number;
  requestTimeoutMs: number | undefined;
  shutdownSignal: AbortSignal | undefined;
  now: () => number;
}

interface RequestLifecycle {
  readonly signal: AbortSignal;
  isWritable(): boolean;
  dispose(): void;
}

function createRequestLifecycle(
  requestSignal: AbortSignal,
  shutdownSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): RequestLifecycle {
  const controller = new AbortController();
  let writable = true;
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
    isWritable: () => writable && !controller.signal.aborted,
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

function jsonResponse(
  lifecycle: RequestLifecycle,
  status: number,
  body: unknown,
): Response {
  assertWritable(lifecycle);
  const bodyText = JSON.stringify(body);
  assertWritable(lifecycle);
  return new Response(bodyText, {
    status,
    headers: { "content-type": "application/json" },
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
  lifecycle: RequestLifecycle,
  maximumBytes: number,
): Promise<string | undefined> {
  const declaredLength = request.headers.get("content-length");
  if (/^[0-9]+$/u.test(declaredLength ?? "") && Number(declaredLength) > maximumBytes) {
    return undefined;
  }

  const rawBody = await raceWithRequestSignal(request.text(), lifecycle.signal);
  return new TextEncoder().encode(rawBody).byteLength <= maximumBytes
    ? rawBody
    : undefined;
}

export async function handleHttpRequest(
  dependencies: HttpBoundaryDependencies,
  request: Request,
): Promise<Response> {
  const lifecycle = createRequestLifecycle(
    request.signal,
    dependencies.shutdownSignal,
    dependencies.requestTimeoutMs,
  );

  try {
    assertWritable(lifecycle);
    const receivedAt = dependencies.now();
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/v1/messages") {
      return jsonResponse(lifecycle, 404, {
        type: "error",
        error: { type: "not_found_error" },
      });
    }
    if (!hasJsonContentType(request.headers)) {
      return jsonResponse(lifecycle, 415, {
        type: "error",
        error: { type: "invalid_request_error" },
      });
    }

    const authResult = await raceWithRequestSignal(
      dependencies.auth.resolve(request.headers),
      lifecycle.signal,
    );
    if (!authResult.authorized) {
      return jsonResponse(lifecycle, 401, {
        type: "error",
        error: { type: "authentication_error" },
      });
    }

    const sourceProfile = resolveAnthropicSourceProfile(request.headers);

    const rawBody = await readRawBody(
      request,
      lifecycle,
      dependencies.maxRequestBytes,
    );
    if (rawBody === undefined) {
      return jsonResponse(lifecycle, 413, {
        type: "error",
        error: { type: "request_too_large" },
      });
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
    const invocation = convertValidatedAnthropicRequest(
      validatedRequest,
      receivedAt,
    );

    const piOptions = {
      maxTokens: invocation.maxTokens,
      sessionId: authResult.sessionId,
      signal: lifecycle.signal,
      ...(authResult.projectDir === undefined
        ? {}
        : { metadata: { projectDir: authResult.projectDir } }),
    };
    const message = await execute(
      dependencies.models,
      model,
      invocation.context,
      piOptions,
    );
    assertWritable(lifecycle);
    const target = renderAnthropicTextMessage(
      message,
      invocation.renderState.clientModel,
      dependencies.createMessageId(),
    );
    return jsonResponse(lifecycle, 200, target);
  } catch (error) {
    if (
      lifecycle.signal.aborted ||
      error instanceof HttpRequestAbortedError ||
      error instanceof ExecutionAbortedError
    ) {
      throw new HttpRequestAbortedError(lifecycle.signal.reason);
    }
    if (error instanceof InvalidRequest || error instanceof SyntaxError) {
      return jsonResponse(lifecycle, 400, {
        type: "error",
        error: { type: "invalid_request_error", message: error.message },
      });
    }
    if (error instanceof UnsupportedFeature) {
      return jsonResponse(lifecycle, 400, {
        type: "error",
        error: { type: "unsupported_feature", message: error.message },
      });
    }
    if (error instanceof ModelResolutionFailure) {
      return jsonResponse(lifecycle, 404, {
        type: "error",
        error: { type: "model_resolution_error", message: error.message },
      });
    }
    const detail = error instanceof Error ? error.message : String(error);
    return jsonResponse(lifecycle, 500, {
      type: "error",
      error: { type: "api_error", message: detail },
    });
  } finally {
    lifecycle.dispose();
  }
}
