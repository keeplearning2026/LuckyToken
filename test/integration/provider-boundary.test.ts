import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type Models,
  type Provider,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { createAuth } from "../../src/auth.js";
import {
  commandCodePrivateApiId,
  commandCodePrivateProviderId,
  createCommandCodePrivateProvider,
} from "../../src/providers/commandcode-private/provider.js";
import { createEmptyServerConfig } from "../../src/providers/commandcode-private/project.js";
import { createAnthropicMessagesHandler } from "../../src/protocols/anthropic/handler.js";
import { createLuckyTokenRuntime } from "../../src/runtime.js";

const sessionId = "00000000-0000-4000-8000-000000000220";

function model(provider: string, id: string): Model<Api> {
  return {
    id,
    name: id,
    api: `${provider}-private-api`,
    provider,
    baseUrl: `https://${provider}.fixture.test`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 10_000,
  };
}

function message(selected: Model<Api>, text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: selected.api,
    provider: selected.provider,
    model: selected.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1_786_400_000_000,
  };
}

function provider(
  providerId: string,
  modelId: string,
  text: string,
  onDispatch: (selected: Model<Api>) => void,
): Provider {
  const selected = model(providerId, modelId);
  const stream = (dispatched: Model<Api>): AssistantMessageEventStream => {
    onDispatch(dispatched);
    const events = createAssistantMessageEventStream();
    const completed = message(dispatched, text);
    events.push({ type: "start", partial: completed });
    events.push({ type: "done", reason: "stop", message: completed });
    events.end(completed);
    return events;
  };
  return createProvider({
    id: providerId,
    models: [selected],
    auth: {
      apiKey: {
        name: `${providerId} fixture auth`,
        resolve: async () => ({ auth: {}, source: "fixture" }),
      },
    },
    api: { stream, streamSimple: stream },
  });
}

function request(modelId: string): Request {
  return new Request("http://luckytoken.test/v1/messages", {
    method: "POST",
    headers: {
      authorization: "Bearer client-key",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 64,
      messages: [{ role: "user", content: "Hello" }],
    }),
  });
}

describe("Pi Models provider boundary", () => {
  it("keeps every concrete Provider behind one Models dependency", async () => {
    const firstDispatch = vi.fn();
    const secondDispatch = vi.fn();
    const mutableModels = createModels();
    mutableModels.setProvider(
      provider("private-one", "model-one", "first", firstDispatch),
    );
    mutableModels.setProvider(
      provider("private-two", "model-two", "second", secondDispatch),
    );
    const auth = createAuth({
      authorizeToken: async (token) => (token === "client-key" ? {} : undefined),
      createFallbackSessionId: () => sessionId,
    });

    const anthropic = createAnthropicMessagesHandler({
      models: mutableModels,
      auth,
      createMessageId: () => "msg_provider_boundary",
      now: () => 1_786_400_000_000,
    });
    const runtime = createLuckyTokenRuntime({ clientProtocols: [anthropic] });

    expect(Object.keys(runtime).sort()).toEqual(["handle", "routes"]);

    const first = await runtime.handle(request("model-one"));
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      model: "model-one",
      content: [{ type: "text", text: "first" }],
    });
    expect(firstDispatch).toHaveBeenCalledOnce();
    expect(secondDispatch).not.toHaveBeenCalled();

    const second = await runtime.handle(request("private-two/model-two"));
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      model: "private-two/model-two",
      content: [{ type: "text", text: "second" }],
    });
    expect(firstDispatch).toHaveBeenCalledOnce();
    expect(secondDispatch).toHaveBeenCalledOnce();
  });

  it("registers CommandCode as an ordinary Pi Provider and hides it from Runtime", async () => {
    const commandCodeModel: Model<typeof commandCodePrivateApiId> = {
      id: "commandcode-model",
      name: "commandcode-model",
      api: commandCodePrivateApiId,
      provider: commandCodePrivateProviderId,
      baseUrl: "https://commandcode.fixture.test",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 64_000,
    };
    const upstreamRequests: Request[] = [];
    const commandCodeProvider = createCommandCodePrivateProvider({
      apiKey: "provider-key",
      fetch: async (input, init) => {
        upstreamRequests.push(new Request(input, init));
        return new Response(
          [
            JSON.stringify({ type: "text-start", id: "0" }),
            JSON.stringify({ type: "text-delta", id: "0", text: "through Pi" }),
            JSON.stringify({ type: "text-end", id: "0" }),
            JSON.stringify({
              type: "finish",
              finishReason: "stop",
              totalUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            }),
          ].join("\n"),
        );
      },
      model: commandCodeModel,
      now: () => 1_786_400_000_000,
      projectSnapshot: {
        snapshot: async () => createEmptyServerConfig(),
      },
      createSessionId: () => "00000000-0000-4000-8000-000000000221",
    });
    const mutableModels = createModels();
    mutableModels.setProvider(commandCodeProvider);
    const models: Models = mutableModels;
    const auth = createAuth({
      authorizeToken: async (token) => (token === "client-key" ? {} : undefined),
      createFallbackSessionId: () => "00000000-0000-4000-8000-000000000222",
    });
    const anthropic = createAnthropicMessagesHandler({
      models,
      auth,
      createMessageId: () => "msg_commandcode_through_pi",
      now: () => 1_786_400_000_000,
    });
    const runtime = createLuckyTokenRuntime({ clientProtocols: [anthropic] });

    expect(models.getProvider(commandCodePrivateProviderId)).toBe(commandCodeProvider);
    expect(models.getModel(commandCodePrivateProviderId, commandCodeModel.id)).toMatchObject({
      id: commandCodeModel.id,
      provider: commandCodePrivateProviderId,
      api: commandCodePrivateApiId,
    });
    expect(Object.keys(runtime).sort()).toEqual(["handle", "routes"]);
    expect(runtime).not.toHaveProperty("models");
    expect(runtime).not.toHaveProperty("provider");
    expect(runtime).not.toHaveProperty("setProvider");

    const response = await runtime.handle(request(commandCodeModel.id));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "msg_commandcode_through_pi",
      model: commandCodeModel.id,
      content: [{ type: "text", text: "through Pi" }],
      stop_reason: "end_turn",
    });
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]?.url).toBe(
      "https://commandcode.fixture.test/alpha/generate",
    );
    expect(upstreamRequests[0]?.headers.get("authorization")).toBe(
      "Bearer provider-key",
    );
  });
});
