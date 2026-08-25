import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { convertResponsesRequest } from "../../src/protocols/openai-responses/request.js";
import { prepareResponsesReasoning as prepareReasoning } from "../../src/protocols/openai-responses/semantic/reasoning/request.js";

const openAICompletionsModel: Model<"openai-completions"> = {
  id: "deepseek-test",
  name: "deepseek-test",
  api: "openai-completions",
  provider: "provider-test",
  baseUrl: "https://provider.test/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_192,
  maxTokens: 1_024,
};

describe("target-aware reasoning preparation", () => {
  it("writes the model-selected effort into Pi options", () => {
    const converted = convertResponsesRequest(
      {
        model: "client-selector",
        input: "hello",
        reasoning: { effort: "low" },
      },
      1,
    );
    const prepared = prepareReasoning({
      model: {
        ...openAICompletionsModel,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: null,
          medium: null,
          high: "high",
          xhigh: null,
          max: "max",
        },
      },
      context: converted.invocation.pi.context,
      options: converted.invocation.pi.options,
      semantics: converted.invocation.reasoning,
    });

    expect(prepared.effortPlan).toEqual({
      kind: "enabled",
      requested: "low",
      selection: { kind: "selected", level: "high" },
    });
    expect(prepared.options.reasoning).toBe("high");
  });

  it("restores a same-model OpenAI Completions reasoning field selector", () => {
    const converted = convertResponsesRequest(
      {
        model: "client-selector",
        input: [
          {
            type: "reasoning",
            id: "rs_prior",
            summary: [{ type: "summary_text", text: "visible summary" }],
            luckytoken_continuity: {
              version: 1,
              source: {
                provider: "provider-test",
                api: "openai-completions",
                model: "deepseek-test",
              },
              attachments: [
                {
                  target: "thinking",
                  kind: "reasoning-field-selector",
                  value: "reasoning_content",
                },
              ],
            },
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "answer" }],
          },
        ],
      },
      1,
    );

    const prepared = prepareReasoning({
      model: openAICompletionsModel,
      context: converted.invocation.pi.context,
      options: converted.invocation.pi.options,
      semantics: converted.invocation.reasoning,
    });

    expect(converted.invocation.pi.context.messages[0]).toMatchObject({
      provider: "luckytoken-client",
      api: "luckytoken-client-history",
      model: "client-selector",
    });
    expect(converted.invocation.pi.context.messages[0]?.content[0]).toEqual({
      type: "thinking",
      thinking: "visible summary",
    });
    expect(prepared.context.messages[0]).toMatchObject({
      provider: "provider-test",
      api: "openai-completions",
      model: "deepseek-test",
    });
    expect(prepared.context.messages[0]?.content[0]).toEqual({
      type: "thinking",
      thinking: "visible summary",
      thinkingSignature: "reasoning_content",
    });
    expect(prepared.outcomes).toContainEqual({
      subject: "history",
      attachment: {
        target: "thinking",
        messageIndex: 0,
        contentIndex: 0,
        sourceItemId: "rs_prior",
      },
      outcome: { kind: "pi-native" },
    });
  });
});
