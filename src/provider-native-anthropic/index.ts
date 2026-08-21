import type { FetchFunction, Model, Models } from "@earendil-works/pi-ai";

import type {
  AnthropicNativeExecutionResult,
  AnthropicProviderNativeLane,
} from "../protocols/anthropic/native-lane-contract.js";
import type { RequestModelResolver } from "../protocols/anthropic/options.js";
import {
  AnthropicPassthroughBodyReadError,
  AnthropicPassthroughTransportError,
  isAnthropicNativePassthroughModel,
  passthroughAnthropicRequest,
  passthroughRequestHeaders,
  projectAnthropicPassthroughBody,
} from "./transport.js";

export interface AnthropicProviderNativeLaneOptions {
  readonly models: Pick<Models, "getAuth">;
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
      readonly onExecutionStart: () => void;
    }): Promise<AnthropicNativeExecutionResult> {
      const signal = input.request.signal;
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
        input.onExecutionStart();
        upstream = await raceWithSignal(
          passthroughAnthropicRequest({
            model: options.resolveRequestModel(input.model, auth),
            rawBody: input.rawBody,
            apiKey,
            signal,
            fetch: options.fetch,
            upstreamHeaders: passthroughRequestHeaders(input.request),
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
          error instanceof AnthropicPassthroughBodyReadError
        ) {
          return {
            outcome: "failed",
            response: errorResponse(
              502,
              error instanceof AnthropicPassthroughTransportError
                ? "Upstream provider request failed"
                : "Upstream provider response could not be read",
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
  });
}
