import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  FetchFunction,
  Model,
  Models,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { handleHttpRequest, type HttpBoundaryDependencies } from "../../src/http.js";
import {
  createAnthropicMessagesHandler,
  type AnthropicMessagesHandlerOptions,
} from "../../src/protocols/anthropic/handler.js";
import { defaultAnthropicModelValidityPolicy } from "../../src/protocols/anthropic/representability.js";
import { identityRequestModelResolver } from "../../src/protocols/anthropic/options.js";
import { createAnthropicProviderNativeLane } from "../../src/provider-native-anthropic/index.js";
import { ambientProfileBindings } from "../support/profile-binding-fixture.js";

function anthropicModel(): Model<string> {
  return {
    id: "claude-sonnet",
    name: "claude-sonnet",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://gateway.example.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 64000,
  };
}

function commandCodeModel(): Model<string> {
  return {
    id: "deepseek/deepseek-v4-flash",
    name: "deepseek/deepseek-v4-flash",
    api: "commandcode-private",
    provider: "commandcode-private",
    baseUrl: "https://fixture.commandcode.test",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 64000,
  };
}

function usage() {
  return {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function streamFrom(events: AssistantMessageEvent[]): AssistantMessageEventStream {
  let index = 0;
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        const value = events[index++];
        return value === undefined
          ? { done: true as const, value: undefined }
          : { done: false as const, value };
      },
    }),
  } as AssistantMessageEventStream;
}

function projectedStreamFrom(
  events: AssistantMessageEvent[],
  onStart: () => Promise<unknown>,
): AssistantMessageEventStream {
  const stream = streamFrom(events);
  const iterator = stream[Symbol.asyncIterator]();
  let prepared = false;
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        if (!prepared) {
          prepared = true;
          await onStart();
        }
        return iterator.next();
      },
    }),
  } as AssistantMessageEventStream;
}

function request(
  body: string,
): Request {
  return new Request("http://luckytoken.test/v1/messages", {
    method: "POST",
    headers: {
      authorization: "Bearer client",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body,
  });
}

function dependencies(
  models: Models,
  passthroughFetch?: FetchFunction,
): HttpBoundaryDependencies {
  const options: AnthropicMessagesHandlerOptions = {
    models,
    modelValidityPolicy: defaultAnthropicModelValidityPolicy,
    createMessageId: () => "msg_client",
    maxRequestBytes: 1_000_000,
    routerDefaults: {},
    now: () => 1,
    ...(passthroughFetch === undefined
      ? {}
      : {
          providerNativeLane: createAnthropicProviderNativeLane({
            models,
            bindings: ambientProfileBindings,
            resolveRequestModel: identityRequestModelResolver,
            fetch: passthroughFetch,
          }),
        }),
  };
  const anthropic = createAnthropicMessagesHandler(options);
  return {
    clientProtocols: [anthropic],
    requestTimeoutMs: undefined,
    shutdownSignal: undefined,
  };
}

describe("passthrough routing", () => {
  it("forwards anthropic-messages requests verbatim to the upstream baseUrl", async () => {
    const model = anthropicModel();
    const upstreamRequests: Request[] = [];
    const models = {
      getModels: () => [model],
      getAuth: async () => ({ auth: { apiKey: "sk-gateway" } }),
    } as unknown as Models;
    const passthroughFetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      upstreamRequests.push(new Request(input, init));
      return new Response(
        '{"type":"message","content":[{"type":"text","text":"passthrough ok"}]}',
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as FetchFunction;
    const response = await handleHttpRequest(
      dependencies(models, passthroughFetch),
      request(
          JSON.stringify({
            model: "anthropic/claude-sonnet",
            max_tokens: 32,
            messages: [{ role: "user", content: "hi" }],
            top_p: 0.9,
          }),
        ),
      );
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(
      '{"type":"message","content":[{"type":"text","text":"passthrough ok"}]}',
    );
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]?.url).toBe(
      "https://gateway.example.com/v1/messages",
    );
    expect(upstreamRequests[0]?.headers.get("x-api-key")).toBe("sk-gateway");
    const upstreamBody = await upstreamRequests[0]?.text();
    // The qualified Lucky selector is rewritten to the registered model id:
    // a Lucky selector must never leak to the upstream wire.
    expect(JSON.parse(upstreamBody ?? "{}")).toMatchObject({
      model: "claude-sonnet",
      top_p: 0.9,
    });
  });

  it("returns 502 when the passthrough provider has no api key", async () => {
    const model = anthropicModel();
    const models = {
      getModels: () => [model],
      getAuth: async () => undefined,
    } as unknown as Models;
    const response = await handleHttpRequest(
      dependencies(models, async () => new Response(null, { status: 500 })),
      request(
          JSON.stringify({
            model: "anthropic/claude-sonnet",
            max_tokens: 32,
            messages: [{ role: "user", content: "hi" }],
          }),
        ),
      );
    expect(response.status).toBe(502);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      type: "error",
      error: { type: "api_error" },
    });
  });

  it("keeps non-anthropic-messages models on the Pi IR path", async () => {
    const model = commandCodeModel();
    const streamSimple = vi.fn(
      (m: Model<string>, c: unknown, o?: ModelsSimpleStreamOptions) => {
        void m;
        void c;
        void o;
        return projectedStreamFrom([
          {
            type: "done",
            reason: "stop",
            message: {
              role: "assistant",
              api: "commandcode-private",
              provider: "commandcode-private",
              model: model.id,
              content: [{ type: "text", text: "via pi" }],
              usage: usage(),
              stopReason: "stop",
              timestamp: 1,
            } as AssistantMessage,
          },
        ], async () =>
          o?.onPayload?.({
            config: {},
            params: {
              model: model.id,
              messages: [],
              tools: [],
              stream: true,
              max_tokens: 32,
            },
          }, model),
        );
      },
    );
    const models = {
      getModels: () => [model],
      streamSimple,
    } as unknown as Models;
    const deps = dependencies(models);

    const response = await handleHttpRequest(
      deps,
      request(
        JSON.stringify({
          model: "commandcode-private/deepseek/deepseek-v4-flash",
          max_tokens: 32,
          messages: [{ role: "user", content: "hi" }],
        }),
      ),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      content: [{ type: "text", text: "via pi" }],
    });
    expect(streamSimple).toHaveBeenCalledTimes(1);
  });

  it("does not validate unsupported fields before passthrough (P1)", async () => {
    const model = anthropicModel();
    const upstreamRequests: Request[] = [];
    const models = {
      getModels: () => [model],
      getAuth: async () => ({ auth: { apiKey: "sk-gateway" } }),
    } as unknown as Models;
    const passthroughFetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      upstreamRequests.push(new Request(input, init));
      return new Response('{"type":"message","content":[]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as FetchFunction;
    const response = await handleHttpRequest(
      dependencies(models, passthroughFetch),
      request(
          JSON.stringify({
            model: "anthropic/claude-sonnet",
            max_tokens: 32,
            messages: [
              {
                role: "user",
                content: [
                  { type: "future_block_type", data: "upstream may accept" },
                ],
              },
            ],
          }),
        ),
      );
    // Passthrough must forward verbatim, not 400 on unknown blocks.
    expect(response.status).toBe(200);
    expect(upstreamRequests).toHaveLength(1);
    const upstreamBody = await upstreamRequests[0]?.text();
    expect(JSON.parse(upstreamBody ?? "{}").messages[0].content[0].type).toBe(
      "future_block_type",
    );
  });

  it("returns the upstream error response verbatim (P2)", async () => {
    const model = anthropicModel();
    const models = {
      getModels: () => [model],
      getAuth: async () => ({ auth: { apiKey: "sk-gateway" } }),
    } as unknown as Models;
    const upstreamBody = '{"error":{"type":"rate_limit","message":"slow"}}';
    const passthroughFetch: FetchFunction = async () =>
      new Response(upstreamBody, {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    const response = await handleHttpRequest(
      dependencies(models, passthroughFetch),
      request(
          JSON.stringify({
            model: "anthropic/claude-sonnet",
            max_tokens: 32,
            messages: [{ role: "user", content: "hi" }],
          }),
        ),
      );
    expect(response.status).toBe(429);
    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.text()).resolves.toBe(upstreamBody);
  });

  it("preserves upstream headers on successful passthrough (P4)", async () => {
    const model = anthropicModel();
    const models = {
      getModels: () => [model],
      getAuth: async () => ({ auth: { apiKey: "sk-gateway" } }),
    } as unknown as Models;
    const passthroughFetch: FetchFunction = async () =>
      new Response('{"type":"message","content":[]}', {
        status: 200,
        headers: {
          "content-type": "application/json",
          "request-id": "req_123",
          "x-ratelimit-remaining": "42",
        },
      });
    const response = await handleHttpRequest(
      dependencies(models, passthroughFetch),
      request(
          JSON.stringify({
            model: "anthropic/claude-sonnet",
            max_tokens: 32,
            messages: [{ role: "user", content: "hi" }],
          }),
        ),
      );
    expect(response.status).toBe(200);
    expect(response.headers.get("request-id")).toBe("req_123");
    expect(response.headers.get("x-ratelimit-remaining")).toBe("42");
  });
});
