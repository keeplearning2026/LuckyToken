import type { Models } from "@earendil-works/pi-ai";

import { execute } from "./execution.js";
import {
  AnthropicRequestError,
  parseAnthropicTextInvocation,
} from "./protocols/anthropic/request.js";
import { renderAnthropicTextMessage } from "./protocols/anthropic/response.js";

export interface HttpBoundaryDependencies {
  models: Models;
  providerId: string;
  clientApiKey: string;
  createMessageId: () => string;
  createSessionId: () => string;
  now: () => number;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function handleHttpRequest(
  dependencies: HttpBoundaryDependencies,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== "/v1/messages") {
    return jsonResponse(404, { type: "error", error: { type: "not_found_error" } });
  }
  if (request.headers.get("authorization") !== `Bearer ${dependencies.clientApiKey}`) {
    return jsonResponse(401, { type: "error", error: { type: "authentication_error" } });
  }
  if (request.headers.get("content-type") !== "application/json") {
    return jsonResponse(415, { type: "error", error: { type: "invalid_request_error" } });
  }
  if (request.headers.get("anthropic-version") !== "2023-06-01") {
    return jsonResponse(400, { type: "error", error: { type: "invalid_request_error" } });
  }

  try {
    const body: unknown = await request.json();
    const invocation = parseAnthropicTextInvocation(body, dependencies.now());
    const model = dependencies.models.getModel(dependencies.providerId, invocation.selector);
    if (!model) {
      return jsonResponse(404, { type: "error", error: { type: "not_found_error" } });
    }

    const message = await execute(dependencies.models, model, invocation.context, {
      maxTokens: invocation.maxTokens,
      sessionId: dependencies.createSessionId(),
    });
    const target = renderAnthropicTextMessage(
      message,
      invocation.renderState.clientModel,
      dependencies.createMessageId(),
    );
    return jsonResponse(200, target);
  } catch (error) {
    if (error instanceof AnthropicRequestError || error instanceof SyntaxError) {
      return jsonResponse(400, {
        type: "error",
        error: { type: "invalid_request_error", message: error.message },
      });
    }
    const detail = error instanceof Error ? error.message : String(error);
    return jsonResponse(500, {
      type: "error",
      error: { type: "api_error", message: detail },
    });
  }
}
