import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { convertResponsesRequest } from "../../src/protocols/openai-responses/request.js";
import { convertAssistantMessageToResponses } from "../../src/protocols/openai-responses/response.js";
import { prepareResponsesReasoning as prepareReasoning } from "../../src/protocols/openai-responses/semantic/reasoning/request.js";

function message(
  source: { provider: string; api: string; model: string },
  content: AssistantMessage["content"],
): AssistantMessage {
  return {
    role: "assistant",
    ...source,
    content,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

function target(source: {
  provider: string;
  api: string;
  model: string;
}): Model<string> {
  return {
    id: source.model,
    name: source.model,
    api: source.api,
    provider: source.provider,
    baseUrl: "https://provider.test/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 1_024,
  };
}

function render(value: AssistantMessage) {
  return convertAssistantMessageToResponses(
    value,
    {
      clientModel: "client-selector",
      stream: false,
      notices: [],
    },
    "resp_test",
    1,
    undefined,
  );
}

describe("Provider response reasoning continuity round trip", () => {
  it("renders Anthropic thinking signature on its owning reasoning item", () => {
    const source = {
      provider: "anthropic",
      api: "anthropic-messages",
      model: "claude-test",
    };
    const response = render(
      message(source, [
        {
          type: "thinking",
          thinking: "visible summary",
          thinkingSignature: "anthropic-signature",
        },
        { type: "text", text: "answer" },
      ]),
    );

    expect(response.output[0]).toMatchObject({
      type: "reasoning",
      summary: [{ type: "summary_text", text: "visible summary" }],
      token_continuity: {
        version: 1,
        source,
        attachments: [
          {
            target: "thinking",
            kind: "opaque-signature",
            value: "anthropic-signature",
          },
        ],
      },
    });
  });

  it("keeps Google text and tool-call thought signatures on their original output items", () => {
    const source = {
      provider: "google",
      api: "google-generative-ai",
      model: "gemini-test",
    };
    const response = render(
      message(source, [
        { type: "text", text: "answer", textSignature: "dGV4dA==" },
        {
          type: "toolCall",
          id: "call_1",
          name: "lookup",
          arguments: {},
          thoughtSignature: "dG9vbA==",
        },
      ]),
    );

    expect(response.output[0]).toMatchObject({
      type: "message",
      token_continuity: {
        source,
        attachments: [
          {
            target: "text",
            partIndex: 0,
            kind: "opaque-signature",
            value: "dGV4dA==",
          },
        ],
      },
    });
    expect(response.output[1]).toMatchObject({
      type: "function_call",
      token_continuity: {
        source,
        attachments: [
          {
            target: "toolCall",
            callId: "call_1",
            kind: "opaque-signature",
            value: "dG9vbA==",
          },
        ],
      },
    });
  });

  it("uses standard Responses encrypted_content plus provenance to reconstruct exact next-turn replay", () => {
    const source = {
      provider: "openai",
      api: "openai-responses",
      model: "gpt-test",
    };
    const providerItem = {
      type: "reasoning",
      id: "rs_provider",
      status: "completed",
      summary: [{ type: "summary_text", text: "visible summary" }],
      content: [{ type: "reasoning_text", text: "provider reasoning detail" }],
      encrypted_content: "encrypted-reasoning",
    };
    const response = render(
      message(source, [
        {
          type: "thinking",
          thinking: "visible summary",
          thinkingSignature: JSON.stringify(providerItem),
        },
        { type: "text", text: "answer" },
      ]),
    );
    const reasoningItem = response.output[0] as unknown as Record<string, unknown>;

    expect(reasoningItem).toMatchObject({
      type: "reasoning",
      id: "rs_provider",
      status: "completed",
      summary: [{ type: "summary_text", text: "visible summary" }],
      content: [{ type: "reasoning_text", text: "provider reasoning detail" }],
      encrypted_content: "encrypted-reasoning",
      token_continuity: {
        version: 1,
        source,
        attachments: [],
      },
    });

    const next = convertResponsesRequest(
      {
        model: "client-selector",
        input: response.output,
      },
      2,
    );
    const prepared = prepareReasoning({
      model: target(source),
      context: next.invocation.pi.context,
      options: next.invocation.pi.options,
      semantics: next.invocation.reasoning,
    });

    expect(prepared.context.messages[0]?.content[0]).toEqual({
      type: "thinking",
      thinking: "visible summary",
      thinkingSignature: JSON.stringify({
         type: "reasoning",
         id: "rs_provider",
         status: "completed",
         summary: [{ type: "summary_text", text: "visible summary" }],
         content: [
           { type: "reasoning_text", text: "provider reasoning detail" },
         ],
         encrypted_content: "encrypted-reasoning",
       }),
    });
  });
});
