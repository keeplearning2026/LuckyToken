import type { FetchFunction } from "@earendil-works/pi-ai";

import type { LocalResponsesLane } from "../../protocols/openai-responses/handler.js";
import type {
  CodexLocalCredentialAuthority,
  CodexNativeModelSource,
  CodexForwardAuth,
} from "../../codex-native-seam.js";
import {
  CodexResponsesPassthroughBodyReadError,
  CodexResponsesPassthroughTransportError,
  passthroughCodexResponses,
} from "../../codex-responses-passthrough.js";
import { extractResponsesPassthroughUsage } from "../../protocols/openai-responses/passthrough-usage.js";
import {
  renderResponsesError,
  type PreparedHttpResponse,
} from "../../protocols/openai-responses/response.js";

export interface CreateCodexLocalResponsesLaneOptions {
  readonly credentials: CodexLocalCredentialAuthority;
  readonly models: CodexNativeModelSource;
  readonly fetch: FetchFunction;
}

function toResponse(prepared: PreparedHttpResponse): Response {
  return new Response(prepared.body, {
    status: prepared.status,
    headers: { "content-type": prepared.contentType },
  });
}

async function executeWithAuth(
  input: Parameters<LocalResponsesLane["execute"]>[0],
  forwardAuth: CodexForwardAuth,
  fetch: FetchFunction,
): Promise<Response> {
  try {
    input.ledger.executing();
    const upstream = await passthroughCodexResponses({
      rawBody: input.rawBody,
      requestHeaders: input.request.headers,
      forwardAuth,
      signal: input.request.signal,
      fetch,
    });
    input.request.signal.throwIfAborted();
    const usage = extractResponsesPassthroughUsage(
      upstream.body,
      upstream.headers["content-type"] ?? "",
      "openai-codex-responses",
    );
    if (usage !== undefined) input.ledger.terminalUsage(usage);
    input.ledger.terminal(upstream.status >= 400 ? "failed" : "success", {
      clientHttpStatus: upstream.status,
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...upstream.headers },
    });
  } catch (error) {
    if (
      error instanceof CodexResponsesPassthroughTransportError ||
      error instanceof CodexResponsesPassthroughBodyReadError
    ) {
      input.ledger.fail({ classification: "runtime-failure", error });
      input.ledger.terminal("failed", { clientHttpStatus: 502 });
      await input.diagnostics.fail({
        classification: "runtime-failure",
        stage: "native-passthrough",
        clientStatus: 502,
        error,
      });
      return toResponse(
        renderResponsesError(
          502,
          "api_error",
          error instanceof CodexResponsesPassthroughTransportError
            ? "Upstream provider request failed"
            : "Upstream provider response could not be read",
        ),
      );
    }
    throw error;
  }
}

export function createCodexLocalResponsesLane(
  options: CreateCodexLocalResponsesLaneOptions,
): LocalResponsesLane {
  return Object.freeze({
    claims(selector: string): boolean {
      return options.models.has(selector);
    },
    async execute(
      input: Parameters<LocalResponsesLane["execute"]>[0],
    ): Promise<Response> {
      input.ledger.modelResolved({
        externalAlias: input.selector,
        providerId: "openai-codex",
        realModelId: input.selector,
      });
      const forwardAuth = await options.credentials.resolveForwardAuth(
        input.request.headers,
      );
      if (forwardAuth === undefined) {
        input.ledger.terminal("failed", { clientHttpStatus: 401 });
        return toResponse(
          renderResponsesError(
            401,
            "authentication_error",
            "Local Codex credential is unavailable",
          ),
        );
      }
      return executeWithAuth(input, forwardAuth, options.fetch);
    },
  });
}
