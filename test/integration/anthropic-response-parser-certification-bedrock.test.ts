import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import type { Context, Model } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/bedrock-converse-stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { convertAssistantMessageToAnthropicWithPolicy } from "../../src/protocols/anthropic/response.js";
import { captureAnthropicContinuityReplay } from "../support/anthropic-continuity-replay.js";

const context: Context = {
  messages: [{ role: "user", content: "Think, then answer.", timestamp: 1 }],
};

async function* responseEvents() {
  yield { messageStart: { role: "assistant" } };
  yield {
    contentBlockDelta: {
      contentBlockIndex: 0,
      delta: { reasoningContent: { text: "plan" } },
    },
  };
  yield {
    contentBlockDelta: {
      contentBlockIndex: 0,
      delta: { reasoningContent: { signature: "bedrock-thinking-state" } },
    },
  };
  yield { contentBlockStop: { contentBlockIndex: 0 } };
  yield {
    contentBlockDelta: {
      contentBlockIndex: 1,
      delta: { text: "answer" },
    },
  };
  yield { contentBlockStop: { contentBlockIndex: 1 } };
  yield { messageStop: { stopReason: "end_turn" } };
  yield {
    metadata: {
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    },
  };
}

describe("Anthropic Bedrock response-parser certification", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("certifies Claude reasoningText signatures at the owning thinking block", async () => {
    vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
      $metadata: { httpStatusCode: 200, requestId: "bedrock-certified-response" },
      stream: responseEvents(),
    } as never);
    const model: Model<"bedrock-converse-stream"> = {
      id: "us.anthropic.claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      api: "bedrock-converse-stream",
      provider: "amazon-bedrock",
      baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4_096,
    };

    const parsed = await stream(model, context, {
      env: { AWS_BEDROCK_SKIP_AUTH: "1" },
    }).result();
    expect(parsed.stopReason, parsed.errorMessage).not.toBe("error");
    expect(parsed.content).toEqual([
      expect.objectContaining({
        type: "thinking",
        thinking: "plan",
        thinkingSignature: "bedrock-thinking-state",
      }),
      expect.objectContaining({ type: "text", text: "answer" }),
    ]);

    const converted = convertAssistantMessageToAnthropicWithPolicy(
      parsed,
      { selector: "client-model", createMessageId: () => "msg-bedrock-certified" },
      { unknownPiContent: "error" },
    );
    expect(converted.message.content[0]).toMatchObject({
      type: "thinking",
      signature: "",
      luckytoken_continuity: {
        source: {
          provider: "amazon-bedrock",
          api: "bedrock-converse-stream",
          model: "us.anthropic.claude-sonnet-4-6",
        },
        attachments: [{
          target: "thinking",
          value: "bedrock-thinking-state",
        }],
      },
    });

    const replayPayload = await captureAnthropicContinuityReplay({
      model,
      clientContent: converted.message.content as unknown as readonly Record<string, unknown>[],
      start: (replayContext, options) =>
        stream(model, replayContext, {
          ...options,
          env: { AWS_BEDROCK_SKIP_AUTH: "1" },
        } as never),
    });
    expect(replayPayload).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: [
            {
              reasoningContent: {
                reasoningText: {
                  text: "plan",
                  signature: "bedrock-thinking-state",
                },
              },
            },
            expect.objectContaining({ text: "answer" }),
          ],
        }),
      ]),
    });
  });
});
