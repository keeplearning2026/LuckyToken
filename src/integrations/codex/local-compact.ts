import type {
  CodexFetchFunction,
  CodexLocalCredentialAuthority,
  CodexNativeModelSource,
} from "../../codex-native-seam.js";
import {
  CodexResponsesPassthroughBodyReadError,
  CodexResponsesPassthroughTransportError,
  passthroughCodexResponsesCompact,
} from "../../codex-responses-passthrough.js";
import type { LocalResponsesCompactLane } from "../../protocols/openai-responses/compact-contract.js";
import {
  renderResponsesError,
  type PreparedHttpResponse,
} from "../../protocols/openai-responses/response.js";

export interface CreateCodexLocalCompactLaneOptions {
  readonly credentials: CodexLocalCredentialAuthority;
  readonly models: CodexNativeModelSource;
  readonly fetch: CodexFetchFunction;
}

function toResponse(prepared: PreparedHttpResponse): Response {
  return new Response(prepared.body, {
    status: prepared.status,
    headers: { "content-type": prepared.contentType },
  });
}

function errorResponse(status: number, type: string, message: string): Response {
  return toResponse(renderResponsesError(status, type, message));
}

export function createCodexLocalCompactLane(
  options: CreateCodexLocalCompactLaneOptions,
): LocalResponsesCompactLane {
  return Object.freeze({
    claims(selector: string): boolean {
      return options.models.has(selector);
    },
    async execute(
      input: Parameters<LocalResponsesCompactLane["execute"]>[0],
    ): Promise<Response> {
      const forwardAuth = await options.credentials.resolveForwardAuth(
        input.request.headers,
      );
      if (forwardAuth === undefined) {
        return errorResponse(
          401,
          "authentication_error",
          "Local Codex credential is unavailable",
        );
      }
      try {
        const upstream = await passthroughCodexResponsesCompact({
          rawBody: input.rawBody,
          requestHeaders: input.request.headers,
          forwardAuth,
          signal: input.request.signal,
          fetch: options.fetch,
        });
        return new Response(upstream.body, {
          status: upstream.status,
          headers: { ...upstream.headers },
        });
      } catch (error) {
        if (input.request.signal.aborted) throw error;
        if (
          error instanceof CodexResponsesPassthroughTransportError ||
          error instanceof CodexResponsesPassthroughBodyReadError
        ) {
          return errorResponse(502, "api_error", "Upstream compact request failed");
        }
        throw error;
      }
    },
  });
}
