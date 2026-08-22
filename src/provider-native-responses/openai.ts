import type { Model } from "@earendil-works/pi-ai";

import { resolveRequestModel } from "../providers/request-composition.js";
import {
  appendEndpoint,
  applyHeaders,
  executeProviderFetch,
  hasHeader,
  rewriteModelJson,
} from "./common.js";
import type {
  CreateProviderResponsesSenderOptions,
  ProviderResponsesOperation,
  ProviderResponsesSender,
} from "./contract.js";

function assertTransportAuth(
  provider: string,
  apiKey: string | undefined,
  headers: CreateProviderResponsesSenderOptions["auth"]["auth"]["headers"],
): void {
  if (apiKey) return;
  if (
    hasHeader(headers, "authorization") ||
    hasHeader(headers, "cf-aig-authorization")
  ) {
    return;
  }
  throw new Error(`No API key for provider: ${provider}`);
}

function hasImageInput(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (Array.isArray(value)) return value.some((entry) => hasImageInput(entry, depth + 1));
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (
    record.type === "input_image" ||
    record.type === "image" ||
    record.type === "image_url"
  ) {
    return true;
  }
  return Object.values(record).some((entry) => hasImageInput(entry, depth + 1));
}

function inferCopilotInitiator(body: Record<string, unknown>): "user" | "agent" {
  if (typeof body.input === "string") return "user";
  if (!Array.isArray(body.input) || body.input.length === 0) return "user";
  const last = body.input[body.input.length - 1];
  if (typeof last !== "object" || last === null || Array.isArray(last)) return "agent";
  return (last as Record<string, unknown>).role === "user" ? "user" : "agent";
}

function copilotDynamicHeaders(body: Record<string, unknown>): Record<string, string> {
  return {
    "X-Initiator": inferCopilotInitiator(body),
    "Openai-Intent": "conversation-edits",
    ...(hasImageInput(body.input) ? { "Copilot-Vision-Request": "true" } : {}),
  };
}

function applySessionAffinityHeaders(
  headers: Headers,
  model: Model<string>,
  sessionId: string,
): void {
  const format =
    (model as Model<"openai-responses">).compat?.sessionAffinityFormat ??
    (model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai")
      ? "openrouter"
      : "openai");
  if (format === "openrouter") {
    headers.set("x-session-id", sessionId);
    return;
  }
  if (format === "openai") headers.set("session_id", sessionId);
  headers.set("x-client-request-id", sessionId);
}

export function createOpenAIResponsesSender(
  options: CreateProviderResponsesSenderOptions,
): ProviderResponsesSender {
  const model = resolveRequestModel(options.model, options.auth) as Model<string>;
  assertTransportAuth(
    model.provider,
    options.auth.auth.apiKey,
    options.auth.auth.headers,
  );

  return Object.freeze({
    supportsNativeCompact: true,
    async send(
      operation: ProviderResponsesOperation,
      rawBody: string,
      signal: AbortSignal,
    ): Promise<Response> {
      const rewritten = rewriteModelJson(rawBody, model.id);
      const headers = new Headers({
        accept: "application/json",
        "content-type": "application/json",
      });
      const apiKey = options.auth.auth.apiKey;
      if (apiKey !== undefined && apiKey.length > 0) {
        headers.set("authorization", `Bearer ${apiKey}`);
      }
      applyHeaders(headers, model.headers);
      if (model.provider === "github-copilot") {
        applyHeaders(headers, copilotDynamicHeaders(rewritten.parsed));
      }
      if (operation === "responses") {
        if (options.sessionId === undefined) {
          throw new Error("Provider Native Responses requires a session ID");
        }
        applySessionAffinityHeaders(headers, model, options.sessionId);
      }
      applyHeaders(headers, options.auth.auth.headers);
      headers.set("content-type", "application/json");

      const endpoint = operation === "compact" ? "/responses/compact" : "/responses";
      const url = appendEndpoint(model.baseUrl, endpoint);
      return executeProviderFetch(options.fetch, url, {
        method: "POST",
        headers,
        body: rewritten.text,
        signal,
      });
    },
  });
}
