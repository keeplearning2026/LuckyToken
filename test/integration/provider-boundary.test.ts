import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  type Api,
  type AssistantMessage,
  type Model,
  type AssistantMessageEventStream,
  type Provider,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { createAuth } from "../../src/auth.js";
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

    const runtime = createLuckyTokenRuntime({
      models: mutableModels,
      auth,
      createMessageId: () => "msg_provider_boundary",
      now: () => 1_786_400_000_000,
    });

    expect(Object.keys(runtime)).toEqual(["handle"]);

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
});
