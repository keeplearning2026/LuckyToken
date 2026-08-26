import type { Context, Model } from "@earendil-works/pi-ai";
import { streamSimple as streamOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { describe, expect, it } from "vitest";

import { parseAnthropicTextInvocation } from "../../src/protocols/anthropic/request.js";
import { convertAssistantMessageToAnthropicResponse } from "../../src/protocols/anthropic/response.js";
import { prepareAnthropicPayloadProjection } from "../../src/protocols/anthropic/semantic/projection/request.js";
import { prepareAnthropicReasoning } from "../../src/protocols/anthropic/semantic/reasoning/request.js";
import { captureFinalPiPayload } from "../support/pi-final-payload.js";

const model: Model<"openai-completions"> = {
  id: "deepseek-v4-flash",
  name: "DeepSeek V4 Flash",
  api: "openai-completions",
  provider: "opencode-go",
  baseUrl: "https://provider.invalid/v1",
  reasoning: true,
  thinkingLevelMap: { off: null, high: "high" },
  compat: { thinkingFormat: "deepseek", supportsReasoningEffort: true },
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_192,
  maxTokens: 2_048,
};

function parserFixture(): Response {
  const chunks = [
    {
      id: "chatcmpl-roundtrip",
      object: "chat.completion.chunk",
      created: 1,
      model: model.id,
      choices: [{
        index: 0,
        delta: { role: "assistant", reasoning_content: "private plan" },
        finish_reason: null,
      }],
    },
    {
      id: "chatcmpl-roundtrip",
      object: "chat.completion.chunk",
      created: 1,
      model: model.id,
      choices: [{ index: 0, delta: { content: "visible answer" }, finish_reason: null }],
    },
    {
      id: "chatcmpl-roundtrip",
      object: "chat.completion.chunk",
      created: 1,
      model: model.id,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    },
  ];
  const body = [
    ...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`),
    "data: [DONE]\n\n",
  ].join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("Anthropic foreign continuity full-history round trip", () => {
  it("restores a real Pi-parsed reasoning selector in the next final Provider request", async () => {
    const initialContext: Context = {
      messages: [{ role: "user", content: "think", timestamp: 1 }],
    };
    const providerResponse = await streamOpenAICompletions(model, initialContext, {
      apiKey: "test-only-key",
      maxTokens: 512,
      fetch: async () => parserFixture(),
    }).result();

    expect(providerResponse.content).toEqual([
      expect.objectContaining({
        type: "thinking",
        thinking: "private plan",
        thinkingSignature: "reasoning_content",
      }),
      expect.objectContaining({ type: "text", text: "visible answer" }),
    ]);

    const clientResponse = convertAssistantMessageToAnthropicResponse(
      providerResponse,
      { selector: "client-model", createMessageId: () => "msg-1" },
    ).message;
    expect(clientResponse.content[0]).toMatchObject({
      type: "thinking",
      signature: "",
      token_continuity: {
        source: {
          provider: "opencode-go",
          api: "openai-completions",
          model: "deepseek-v4-flash",
        },
        attachments: [{
          target: "thinking",
          kind: "opaque-signature",
          value: "reasoning_content",
        }],
      },
    });

    const converted = parseAnthropicTextInvocation(
      {
        model: "client-model",
        max_tokens: 2_048,
        messages: [
          { role: "assistant", content: clientResponse.content },
          { role: "user", content: "continue" },
        ],
      },
      2,
    );
    const prepared = prepareAnthropicReasoning({
      model,
      invocation: converted.invocation,
    });
    const assistant = prepared.invocation.pi.context.messages[0];
    if (assistant?.role !== "assistant") throw new Error("expected assistant replay");
    expect(assistant.content[0]).toMatchObject({
      type: "thinking",
      thinking: "private plan",
      thinkingSignature: "reasoning_content",
    });

    const projection = prepareAnthropicPayloadProjection({
      model,
      invocation: prepared.invocation,
      effortPlan: prepared.effortPlan,
    });
    const payload = await captureFinalPiPayload((capture) =>
      streamOpenAICompletions(model, prepared.invocation.pi.context, {
        ...prepared.invocation.pi.options,
        apiKey: "test-only-key",
        async onPayload(basePayload) {
          const projected = await projection.project(basePayload, model);
          return capture(projected.payload);
        },
      }),
    );

    expect(payload).toMatchObject({
      messages: [
        expect.objectContaining({
          role: "assistant",
          reasoning_content: "private plan",
          content: "visible answer",
        }),
        expect.objectContaining({ role: "user" }),
      ],
    });
  });
});
