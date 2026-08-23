import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { parseAnthropicTextInvocation } from "../../src/protocols/anthropic/request.js";
import { prepareAnthropicReasoning } from "../../src/protocols/anthropic/semantic/reasoning/request.js";

function model(id: string): Model<"google-generative-ai"> {
  return {
    id,
    name: id,
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://provider.invalid/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 2_048,
  };
}

function invocation() {
  return parseAnthropicTextInvocation(
    {
      model: "client-model",
      max_tokens: 2_048,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "visible answer",
              luckytoken_continuity: {
                version: 1,
                source: {
                  provider: "google",
                  api: "google-generative-ai",
                  model: "gemini-target",
                },
                attachments: [
                  { target: "text", kind: "opaque-signature", value: "opaque-state" },
                ],
              },
            },
          ],
        },
        { role: "user", content: "continue" },
      ],
    },
    1,
  ).invocation;
}

describe("Anthropic reasoning history preparation", () => {
  it("restores compatible opaque state on the exact Pi block", () => {
    const prepared = prepareAnthropicReasoning({
      model: model("gemini-target"),
      invocation: invocation(),
    });
    const assistant = prepared.invocation.pi.context.messages[0];
    expect(assistant?.role).toBe("assistant");
    if (assistant?.role !== "assistant") throw new Error("expected assistant");
    expect(assistant.content[0]).toMatchObject({
      type: "text",
      text: "visible answer",
      textSignature: "opaque-state",
    });
  });

  it("drops only opaque state after a model switch", () => {
    const prepared = prepareAnthropicReasoning({
      model: model("gemini-other"),
      invocation: invocation(),
    });
    const assistant = prepared.invocation.pi.context.messages[0];
    if (assistant?.role !== "assistant") throw new Error("expected assistant");
    expect(assistant.content[0]).toEqual({ type: "text", text: "visible answer" });
    expect(prepared.outcomes).toEqual([
      expect.objectContaining({ outcome: expect.objectContaining({ kind: "omitted" }) }),
    ]);
  });
});
