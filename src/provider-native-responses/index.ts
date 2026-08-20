import type { FetchFunction, Model, Models } from "@earendil-works/pi-ai";

import { renderResponsesError } from "../protocols/openai-responses/response.js";
import { createAzureResponsesSender } from "./azure.js";
import { createCodexResponsesSender } from "./codex.js";
import type {
  CreateProviderResponsesSenderOptions,
  ProviderResponsesLane,
  ProviderResponsesSender,
} from "./contract.js";
import { createOpenAIResponsesSender } from "./openai.js";

export type {
  CreateProviderResponsesSenderOptions,
  ProviderResponsesLane,
  ProviderResponsesOperation,
  ProviderResponsesSender,
} from "./contract.js";

export interface CreateProviderNativeResponsesOptions {
  readonly models: Pick<Models, "getAuth">;
  readonly fetch: FetchFunction;
}

function safeForwardedHeaders(request: Request): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const [name, value] of request.headers.entries()) {
    if (name.toLowerCase().startsWith("x-stainless-")) output[name.toLowerCase()] = value;
  }
  return Object.freeze(output);
}

function errorResponse(status: number, type: string, message: string): Response {
  const prepared = renderResponsesError(status, type, message);
  return new Response(prepared.body, {
    status: prepared.status,
    headers: { "content-type": prepared.contentType },
  });
}

export function supportsProviderNativeResponses(model: Model<string>): boolean {
  return (
    model.api === "openai-responses" ||
    (model.provider === "openai-codex" && model.api === "openai-codex-responses") ||
    (model.provider === "azure-openai-responses" && model.api === "azure-openai-responses")
  );
}

export function createProviderResponsesSender(
  options: CreateProviderResponsesSenderOptions,
): ProviderResponsesSender | undefined {
  if (options.model.api === "openai-responses") {
    return createOpenAIResponsesSender(options);
  }
  if (
    options.model.provider === "openai-codex" &&
    options.model.api === "openai-codex-responses"
  ) {
    return createCodexResponsesSender(options);
  }
  if (
    options.model.provider === "azure-openai-responses" &&
    options.model.api === "azure-openai-responses"
  ) {
    return createAzureResponsesSender(options);
  }
  return undefined;
}

export function createProviderNativeResponses(
  options: CreateProviderNativeResponsesOptions,
): ProviderResponsesLane {
  return Object.freeze({
    claims(model: Model<string>): boolean {
      return supportsProviderNativeResponses(model);
    },
    async execute(
      input: Parameters<ProviderResponsesLane["execute"]>[0],
    ): Promise<Response> {
      const auth = await options.models.getAuth(input.model);
      if (auth === undefined) {
        return errorResponse(502, "api_error", "Provider is not configured");
      }
      const sender = createProviderResponsesSender({
        model: input.model,
        auth,
        fetch: options.fetch,
        forwardedHeaders: safeForwardedHeaders(input.request),
      });
      if (sender === undefined) {
        return errorResponse(502, "api_error", "Provider native transport is unavailable");
      }
      try {
        return await sender.send(
          input.operation,
          input.rawBody,
          input.request.signal,
        );
      } catch (error) {
        if (input.request.signal.aborted) throw error;
        return errorResponse(502, "api_error", "Upstream provider request failed");
      }
    },
  });
}
