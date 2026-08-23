import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { streamSimple as streamGoogle } from "@earendil-works/pi-ai/api/google-generative-ai";
import { describe, expect, it } from "vitest";

import { parseAnthropicTextInvocation } from "../../src/protocols/anthropic/request.js";
import { convertAssistantMessageToAnthropicWithPolicy } from "../../src/protocols/anthropic/response.js";
import { prepareAnthropicPayloadProjection } from "../../src/protocols/anthropic/semantic/projection/request.js";
import { prepareAnthropicReasoning } from "../../src/protocols/anthropic/semantic/reasoning/request.js";
import { captureFinalPiPayload } from "../support/pi-final-payload.js";

const model: Model<"google-generative-ai"> = {
  id: "gemini-target",
  name: "Gemini target",
  api: "google-generative-ai",
  provider: "google",
  baseUrl: "https://provider.invalid/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_192,
  maxTokens: 2_048,
};

describe("Anthropic foreign continuity full-history round trip", () => {
  it("restores Provider response text state in the next final Provider request", async () => {
    const providerResponse: AssistantMessage = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [
        {
          type: "text",
          text: "visible answer",
          textSignature: "b3BhcXVlLWdvb2dsZS1zdGF0ZQ==",
        },
      ],
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
    const clientResponse = convertAssistantMessageToAnthropicWithPolicy(
      providerResponse,
      { selector: "client-model", createMessageId: () => "msg-1" },
      { unknownPiContent: "error" },
    ).message;
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
    const projection = prepareAnthropicPayloadProjection({
      model,
      invocation: prepared.invocation,
    });
    const payload = await captureFinalPiPayload((capture) =>
      streamGoogle(model, prepared.invocation.pi.context, {
        ...prepared.invocation.pi.options,
        apiKey: "test-only-key",
        async onPayload(basePayload) {
          const projected = await projection.project(basePayload, model);
          if (projected.failure !== undefined) throw new Error(projected.failure);
          return capture(projected.payload);
        },
      }),
    );

    expect(payload).toMatchObject({
      contents: [
        {
          role: "model",
          parts: [
            {
              text: "visible answer",
              thoughtSignature: "b3BhcXVlLWdvb2dsZS1zdGF0ZQ==",
            },
          ],
        },
        { role: "user" },
      ],
    });
  });
});
