import type { FetchFunction, Model, Models } from "@earendil-works/pi-ai";
import {
  isManagedProviderAuthBindingCapture,
  MAX_PROFILE_ATTEMPTS_PER_REQUEST,
  type ProviderAuthBindingAuthority,
} from "../credentials/profile-contract.js";
import type { CredentialActivitySink } from "../request-ledger/handler-seam.js";

import type {
  AnthropicNativeExecutionResult,
  AnthropicProviderNativeLane,
} from "../protocols/anthropic/native-lane-contract.js";
import type { RequestModelResolver } from "../protocols/anthropic/options.js";
import { AnthropicNativeBodyProjectionError } from "./body-projection.js";
import {
  AnthropicPassthroughBodyReadError,
  AnthropicPassthroughTransportError,
  isAnthropicNativePassthroughModel,
  passthroughAnthropicRequest,
  projectAnthropicPassthroughBody,
} from "./transport.js";

export interface AnthropicProviderNativeLaneOptions {
  readonly models: Pick<Models, "getAuth">;
  readonly bindings: Pick<
    ProviderAuthBindingAuthority,
    "capture" | "runBound" | "advanceAfterFinal429"
  >;
  readonly resolveRequestModel: RequestModelResolver;
  readonly fetch: FetchFunction;
}

function errorResponse(
  status: number,
  message: string,
  requestId?: string,
): Response {
  return new Response(
    JSON.stringify({
      type: "error",
      error: { type: "api_error", message },
      ...(requestId === undefined ? {} : { request_id: requestId }),
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

async function raceWithSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

function hasHeaderAuth(
  headers: Readonly<Record<string, string | null>> | undefined,
): boolean {
  if (headers === undefined) return false;
  return Object.entries(headers).some(([name, value]) => {
    const normalized = name.toLowerCase();
    return (
      (normalized === "authorization" ||
        normalized === "x-api-key" ||
        normalized === "cf-aig-authorization") &&
      value !== null &&
      value.trim().length > 0
    );
  });
}

function safeRequestId(headers: Readonly<Record<string, string>>): string | undefined {
  const value = headers["request-id"] ?? headers["x-request-id"];
  return value !== undefined && /^[A-Za-z0-9._:-]{1,256}$/u.test(value)
    ? value
    : undefined;
}

function retryAfterMs(response: Response): number | undefined {
  const milliseconds = response.headers.get("retry-after-ms");
  if (milliseconds !== null) {
    const parsed = Number(milliseconds);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter === null) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const timestamp = Date.parse(retryAfter);
  return Number.isNaN(timestamp) ? undefined : Math.max(0, timestamp - Date.now());
}

export function createAnthropicProviderNativeLane(
  options: AnthropicProviderNativeLaneOptions,
): AnthropicProviderNativeLane {
  return Object.freeze({
    claims: isAnthropicNativePassthroughModel,
    async execute(input: {
      readonly model: Model<string>;
      readonly rawBody: string;
      readonly request: Request;
      readonly alias?: string;
      readonly requestId: string;
      readonly sessionId?: string;
      readonly onExecutionStart: () => void;
      readonly credentialActivity?: CredentialActivitySink;
    }): Promise<AnthropicNativeExecutionResult> {
      const signal = input.request.signal;
      let capture = await options.bindings.capture(input.model.provider);
      const attemptedCredentialIds: string[] = [];
      let profileAttempt = 1;
      let selectionReason: "active" | "http_429_switch" = "active";
      if (capture.facts.kind === "managed") {
        input.credentialActivity?.credentialCaptured({
          ...capture.facts,
          lane: "provider_native",
          selectionReason,
        });
      }
      let started = false;
      for (;;) {
      let result: AnthropicNativeExecutionResult;
      try {
      result = await options.bindings.runBound(
        capture,
        async (): Promise<AnthropicNativeExecutionResult> => {
      let auth: Awaited<ReturnType<Pick<Models, "getAuth">["getAuth"]>>;
      try {
        auth = await raceWithSignal(options.models.getAuth(input.model), signal);
      } catch (error) {
        if (signal.aborted) throw error;
        return {
          outcome: "failed",
          response: errorResponse(500, "Internal server error", input.requestId),
          diagnostic: { error },
        };
      }
      const apiKey = auth?.auth.apiKey;
      if (apiKey === undefined && !hasHeaderAuth(auth?.auth.headers)) {
        return {
          outcome: "failed",
          response: errorResponse(
            502,
            `Provider is not configured: ${input.model.provider}`,
            input.requestId,
          ),
        };
      }

      let upstream: Awaited<ReturnType<typeof passthroughAnthropicRequest>>;
      try {
        if (!started) {
          started = true;
          input.onExecutionStart();
        }
        upstream = await raceWithSignal(
          passthroughAnthropicRequest({
            model: options.resolveRequestModel(input.model, auth),
            rawBody: input.rawBody,
            apiKey,
            signal,
            fetch: options.fetch,
            bodyProjectionMode:
              capture.facts.kind === "managed" &&
              input.model.provider === "anthropic" &&
              input.model.api === "anthropic-messages" &&
              capture.facts.authType === "oauth"
                ? "anthropic_oauth"
                : "model_only",
            authMode:
              input.model.provider === "github-copilot"
                ? "github_copilot"
                : capture.facts.kind === "managed"
                  ? capture.facts.authType
                  : "ambient",
            ...(input.sessionId === undefined
              ? {}
              : { sessionId: input.sessionId }),
            ...(auth?.auth.headers === undefined
              ? {}
              : { composedHeaders: auth.auth.headers }),
          }),
          signal,
        );
      } catch (error) {
        if (signal.aborted) throw error;
        if (
          error instanceof AnthropicPassthroughTransportError ||
          error instanceof AnthropicPassthroughBodyReadError ||
          error instanceof AnthropicNativeBodyProjectionError
        ) {
          return {
            outcome: "failed",
            response: errorResponse(
              502,
              error instanceof AnthropicPassthroughTransportError
                ? "Upstream provider request failed"
                : error instanceof AnthropicPassthroughBodyReadError
                  ? "Upstream provider response could not be read"
                  : "Provider Native request could not be projected safely",
              input.requestId,
            ),
            diagnostic: { error },
          };
        }
        throw error;
      }

      signal.throwIfAborted();
      const upstreamRequestId = safeRequestId(upstream.headers);
      if (upstream.status >= 400) {
        if (input.alias === undefined) {
          return {
            outcome: "failed",
            response: new Response(upstream.body, {
              status: upstream.status,
              headers: { ...upstream.headers },
            }),
            diagnostic: {
              upstreamStatus: upstream.status,
              ...(upstreamRequestId === undefined
                ? {}
                : { safeRequestId: upstreamRequestId }),
            },
          };
        }
        return {
          outcome: "failed",
          response: errorResponse(502, "Upstream provider failed", input.requestId),
          diagnostic: {
            upstreamStatus: upstream.status,
            ...(upstreamRequestId === undefined
              ? {}
              : { safeRequestId: upstreamRequestId }),
          },
        };
      }

      let body = upstream.body;
      if (input.alias !== undefined) {
        const projected = projectAnthropicPassthroughBody(
          body,
          upstream.headers["content-type"] ?? "",
          input.alias,
        );
        if ("error" in projected) {
          const error = new Error(projected.error);
          return {
            outcome: "failed",
            response: errorResponse(
              502,
              "Upstream response could not be projected safely",
              input.requestId,
            ),
            diagnostic: { error },
          };
        }
        body = projected.body;
      }
      return {
        outcome: "success",
        response: new Response(body, {
          status: upstream.status,
          headers: { ...upstream.headers },
        }),
      };
        },
      );
      } catch (error) {
        if (capture.facts.kind === "managed") {
          input.credentialActivity?.credentialAttempt({
            ...capture.facts,
            lane: "provider_native",
            selectionReason,
            attempt: profileAttempt,
            outcome: signal.aborted ? "aborted" : "failed",
          });
        }
        throw error;
      }
      if (capture.facts.kind === "managed") {
        input.credentialActivity?.credentialAttempt({
          ...capture.facts,
          lane: "provider_native",
          selectionReason,
          attempt: profileAttempt,
          outcome:
            result.outcome === "success"
              ? "success"
              : result.diagnostic?.upstreamStatus === 429
                ? "http_429"
                : "failed",
        });
      }
      if (
        result.outcome !== "failed" ||
        result.diagnostic === undefined ||
        !("upstreamStatus" in result.diagnostic) ||
        result.diagnostic.upstreamStatus !== 429
      ) {
        return result;
      }
      if (!isManagedProviderAuthBindingCapture(capture)) return result;
      attemptedCredentialIds.push(capture.facts.credentialId);
      if (profileAttempt >= MAX_PROFILE_ATTEMPTS_PER_REQUEST) return result;
      const requestedDelay = retryAfterMs(result.response);
      const transition = await options.bindings.advanceAfterFinal429({
        capture,
        attemptedCredentialIds,
        signal,
        ...(requestedDelay === undefined ? {} : { retryAfterMs: requestedDelay }),
      });
      if (transition.outcome !== "switched") return result;
      await result.response.body?.cancel().catch(() => undefined);
      capture = transition.capture;
      profileAttempt += 1;
      selectionReason = "http_429_switch";
      }
    },
  });
}
