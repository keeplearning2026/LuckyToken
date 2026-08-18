import type { FetchFunction } from "@earendil-works/pi-ai";

import type { InvocationDiagnostics } from "../../invocation-diagnostics/index.js";
import type { CodexForwardAuth } from "../../codex-native-seam.js";
import {
  CodexResponsesPassthroughBodyReadError,
  CodexResponsesPassthroughTransportError,
  passthroughCodexResponses,
} from "../../codex-responses-passthrough.js";
import type { RequestLedgerEntry } from "../../request-ledger/handler-seam.js";
import { renderResponsesError, type PreparedHttpResponse } from "./response.js";
import { extractResponsesPassthroughUsage } from "./passthrough-usage.js";

export interface CodexNativeBranchOptions {
  readonly request: Request;
  readonly rawBody: string;
  readonly forwardAuth: CodexForwardAuth;
  readonly fetch: FetchFunction;
  readonly diagnostics: InvocationDiagnostics;
  readonly ledger: RequestLedgerEntry;
}

function toResponse(prepared: PreparedHttpResponse): Response {
  return new Response(prepared.body, {
    status: prepared.status,
    headers: { "content-type": prepared.contentType },
  });
}

/**
 * First native passthrough mode: the client owns the Codex OAuth credential.
 * This branch deliberately owns no Alias/Pi resolution and no Provider auth.
 * The enclosing Responses handler still owns request admission, correlation,
 * capture, diagnostics completion, and the final ledger completion event.
 */
export async function executeCodexNativeBranch(
  options: CodexNativeBranchOptions,
): Promise<Response> {
  try {
    options.ledger.executing();
    const upstream = await passthroughCodexResponses({
      rawBody: options.rawBody,
      requestHeaders: options.request.headers,
      forwardAuth: options.forwardAuth,
      signal: options.request.signal,
      fetch: options.fetch,
    });
    options.request.signal.throwIfAborted();
    const usage = extractResponsesPassthroughUsage(
      upstream.body,
      upstream.headers["content-type"] ?? "",
      "openai-codex-responses",
    );
    if (usage !== undefined) options.ledger.terminalUsage(usage);
    if (upstream.status >= 400) {
      options.ledger.terminal("failed", { clientHttpStatus: upstream.status });
    } else {
      options.ledger.terminal("success", { clientHttpStatus: upstream.status });
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...upstream.headers },
    });
  } catch (error) {
    if (
      error instanceof CodexResponsesPassthroughTransportError ||
      error instanceof CodexResponsesPassthroughBodyReadError
    ) {
      options.ledger.fail({ classification: "runtime-failure", error });
      options.ledger.terminal("failed", { clientHttpStatus: 502 });
      await options.diagnostics.fail({
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
