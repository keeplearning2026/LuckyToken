import { normalizeContext, type Model } from "@earendil-works/pi-ai";
import { streamSimple as streamOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { describe, expect, it } from "vitest";

import { convertResponsesRequest } from "../../src/protocols/openai-responses/request.js";

const model: Model<"openai-completions"> = {
  id: "model-test",
  name: "model-test",
  api: "openai-completions",
  provider: "provider-test",
  baseUrl: "https://provider.test/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_192,
  maxTokens: 1_024,
  compat: { supportsStrictMode: true },
};

function chatResponse(): Response {
  const chunk = {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1,
    model: model.id,
    choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
  };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("Responses function strict through the Pi OpenAI Chat provider", () => {
  it.each([
    {
      name: "omitted strict with a normalizable schema",
      strict: undefined,
      additionalProperties: undefined,
      expectedStrict: true,
    },
    {
      name: "omitted strict with an incompatible schema",
      strict: undefined,
      additionalProperties: true,
      expectedStrict: false,
    },
    {
      name: "explicit false with a compatible schema",
      strict: false,
      additionalProperties: false,
      expectedStrict: false,
    },
    {
      name: "explicit true with a compatible schema",
      strict: true,
      additionalProperties: false,
      expectedStrict: true,
    },
  ])("sends $name as Chat strict=$expectedStrict", async ({ strict, additionalProperties, expectedStrict }) => {
    const tool = {
      type: "function",
      name: "lookup",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties,
      },
      ...(strict === undefined ? {} : { strict }),
    };
    const converted = convertResponsesRequest({ model: model.id, input: "Hello", tools: [tool] }, 1);
    let chatRequest: unknown;

    await streamOpenAICompletions(model, normalizeContext(converted.invocation.pi.context), {
      ...converted.invocation.pi.options,
      apiKey: "test-only-key",
      fetch: async (input, init) => {
        chatRequest = await new Request(input, init).json();
        return chatResponse();
      },
    }).result();

    expect(chatRequest).toMatchObject({
      tools: [{ type: "function", function: { name: "lookup", strict: expectedStrict } }],
    });
    if (strict === undefined && additionalProperties === undefined) {
      expect(chatRequest).toMatchObject({
        tools: [{ function: { parameters: { additionalProperties: false } } }],
      });
    }
  });
});
