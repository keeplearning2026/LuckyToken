import type { FetchFunction, Model, Models } from "@earendil-works/pi-ai";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Auth } from "../../src/auth.js";
import { handleHttpRequest, type HttpBoundaryDependencies } from "../../src/http.js";
import {
  createAnthropicMessagesHandler,
  type AnthropicMessagesHandlerOptions,
} from "../../src/protocols/anthropic/handler.js";
import { defaultAnthropicModelValidityPolicy } from "../../src/protocols/anthropic/representability.js";
import {
  createOpenAIResponsesHandler,
  type OpenAIResponsesHandlerOptions,
} from "../../src/protocols/openai-responses/handler.js";
import { resolveRequestModel } from "../../src/providers/request-composition.js";

/**
 * Ticket 10 Client Protocol isolation seam: handlers receive the request-local
 * model derivation as a narrow Pi-typed operation wired by the composition
 * root. Direct handler construction without the option uses the safe identity
 * default (catalog model passed through); with the real Provider-seam
 * implementation wired, the request-local Cloudflare baseUrl materialization
 * applies. The certification test (test/certification/protocol-boundaries)
 * proves handlers never import Provider modules themselves.
 */

const CLOUDFLARE_BASE_URL =
  "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}";

function cloudflareModel(api: string): Model<string> {
  return {
    id: api === "anthropic-messages" ? "claude-3-5-haiku" : "gpt-4o",
    name: "cf-model",
    api,
    provider: "cloudflare-ai-gateway",
    baseUrl: `${CLOUDFLARE_BASE_URL}/${api === "anthropic-messages" ? "anthropic" : "openai"}`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 64000,
  };
}

function cloudflareAuth(): unknown {
  return {
    auth: {
      headers: { "cf-aig-authorization": "Bearer cf-token" },
    },
    env: {
      CLOUDFLARE_ACCOUNT_ID: "cf-account-123",
      CLOUDFLARE_GATEWAY_ID: "cf-gateway-456",
    },
    source: "CLOUDFLARE_API_KEY",
  };
}

function passthroughModels(
  model: Model<string>,
  authResult: unknown = { auth: { apiKey: "sk" } },
): Models {
  return {
    getModels: () => [model],
    getAuth: async () => authResult,
  } as unknown as Models;
}

function captureFetch(): {
  urls: string[];
  passthroughFetch: FetchFunction;
} {
  const urls: string[] = [];
  return {
    urls,
    passthroughFetch: (async (input) => {
      urls.push(String(input));
      return new Response(
        JSON.stringify({
          id: "up",
          object: "response",
          created_at: 1,
          status: "completed",
          model: "m",
          output: [],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as FetchFunction,
  };
}

describe("Client Protocol request-model seam", () => {
  const roots: string[] = [];
  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  function auth(): Auth {
    return {
      resolve: async () => ({ authorized: true, effectiveSessionId: "session" }),
    };
  }

  describe("Anthropic handler", () => {
    function anthropicDependencies(
      models: Models,
      extra: Partial<AnthropicMessagesHandlerOptions> = {},
      passthroughFetch?: FetchFunction,
    ): HttpBoundaryDependencies {
      const options: AnthropicMessagesHandlerOptions = {
        models,
        auth: auth(),
        modelValidityPolicy: defaultAnthropicModelValidityPolicy,
        createMessageId: () => "msg_client",
        maxRequestBytes: 1_000_000,
        routerDefaults: {},
        now: () => 1,
        ...extra,
        ...(passthroughFetch === undefined ? {} : { passthroughFetch }),
      };
      const anthropic = createAnthropicMessagesHandler(options);
      return {
        clientProtocols: [anthropic],
        requestTimeoutMs: undefined,
        shutdownSignal: undefined,
      };
    }

    function anthropicRequest(): Request {
      return new Request("http://luckytoken.test/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer client",
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "cloudflare-ai-gateway/claude-3-5-haiku",
          max_tokens: 32,
          messages: [{ role: "user", content: "hello" }],
        }),
      });
    }

    it("defaults to identity: without a wired resolver the catalog baseUrl passes through", async () => {
      const model = cloudflareModel("anthropic-messages");
      const capture = captureFetch();
      const dependencies = anthropicDependencies(
        passthroughModels(model, cloudflareAuth()),
        {},
        capture.passthroughFetch,
      );
      const response = await handleHttpRequest(dependencies, anthropicRequest());
      expect(response.status).toBe(200);
      expect(capture.urls[0]).toContain(
        "{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/anthropic",
      );
    });

    it("applies the wired Provider-seam resolver to the passthrough request model", async () => {
      const model = cloudflareModel("anthropic-messages");
      const capture = captureFetch();
      const dependencies = anthropicDependencies(
        passthroughModels(model, cloudflareAuth()),
        { resolveRequestModel },
        capture.passthroughFetch,
      );
      const response = await handleHttpRequest(dependencies, anthropicRequest());
      expect(response.status).toBe(200);
      expect(capture.urls[0]).toBe(
        "https://gateway.ai.cloudflare.com/v1/cf-account-123/cf-gateway-456/anthropic/v1/messages",
      );
    });
  });

  describe("OpenAI Responses handler", () => {
    function responsesDependencies(
      models: Models,
      extra: Partial<OpenAIResponsesHandlerOptions> = {},
      passthroughFetch?: FetchFunction,
    ): HttpBoundaryDependencies {
      const stateFile = join(tmpdir(), `luckytoken-seam-state-${Math.random()}.json`);
      roots.push(stateFile);
      const options: OpenAIResponsesHandlerOptions = {
        models,
        auth: auth(),
        createResponseId: () => "resp_test",
        maxRequestBytes: 1_000_000,
        routerDefaults: {},
        stateFile,
        now: () => 1,
        ...extra,
        ...(passthroughFetch === undefined ? {} : { passthroughFetch }),
      };
      const responses = createOpenAIResponsesHandler(options);
      return {
        clientProtocols: [responses],
        requestTimeoutMs: undefined,
        shutdownSignal: undefined,
      };
    }

    function responsesRequest(): Request {
      return new Request("http://luckytoken.test/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer client",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "cloudflare-ai-gateway/gpt-4o",
          input: "hello",
        }),
      });
    }

    it("defaults to identity: without a wired resolver the catalog baseUrl passes through", async () => {
      const model = cloudflareModel("openai-responses");
      const capture = captureFetch();
      const dependencies = responsesDependencies(
        passthroughModels(model, cloudflareAuth()),
        {},
        capture.passthroughFetch,
      );
      const response = await handleHttpRequest(dependencies, responsesRequest());
      expect(response.status).toBe(200);
      expect(capture.urls[0]).toContain(
        "{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/openai",
      );
    });

    it("applies the wired Provider-seam resolver to the passthrough request model", async () => {
      const model = cloudflareModel("openai-responses");
      const capture = captureFetch();
      const dependencies = responsesDependencies(
        passthroughModels(model, cloudflareAuth()),
        { resolveRequestModel },
        capture.passthroughFetch,
      );
      const response = await handleHttpRequest(dependencies, responsesRequest());
      expect(response.status).toBe(200);
      expect(capture.urls[0]).toBe(
        "https://gateway.ai.cloudflare.com/v1/cf-account-123/cf-gateway-456/openai/responses",
      );
    });
  });
});
