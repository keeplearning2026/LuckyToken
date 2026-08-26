import { afterEach, describe, expect, it, vi } from "vitest";

import { streamSimple as streamGoogleGenerativeAI } from "@earendil-works/pi-ai/api/google-generative-ai";
import { streamSimple as streamGoogleVertex } from "@earendil-works/pi-ai/api/google-vertex";
import type { Context, Model } from "@earendil-works/pi-ai";

import { convertAssistantMessageToAnthropicResponse } from "../../src/protocols/anthropic/response.js";
import { captureAnthropicContinuityReplay } from "../support/anthropic-continuity-replay.js";

const context: Context = {
  messages: [{ role: "user", content: "Use lookup.", timestamp: 1 }],
};

describe("Anthropic Google response-parser certification", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["google-generative-ai", streamGoogleGenerativeAI],
    ["google-vertex", streamGoogleVertex],
  ] as const)("certifies %s attachment-local thought signatures", async (api, start) => {
    const providerEvent = {
      responseId: "google-certified-response",
      candidates: [{
        finishReason: "STOP",
        content: {
          parts: [
            {
              thought: true,
              text: "plan",
              thoughtSignature: "Z29vZ2xlLXRoaW5raW5nLXN0YXRl",
            },
            { text: "answer", thoughtSignature: "Z29vZ2xlLXRleHQtc3RhdGU=" },
            {
              functionCall: { id: "call-1", name: "lookup", args: {} },
              thoughtSignature: "Z29vZ2xlLXRvb2wtc3RhdGU=",
            },
          ],
        },
      }],
      usageMetadata: {
        promptTokenCount: 1,
        candidatesTokenCount: 2,
        totalTokenCount: 3,
      },
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      `data: ${JSON.stringify(providerEvent)}\n\n`,
      {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      },
    ));

    const model: Model<typeof api> = {
      id: "gemini-certified",
      name: "Gemini certified fixture",
      api,
      provider: `${api}-fixture`,
      baseUrl: "https://fixture.invalid",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4_096,
    };
    const parsed = await start(model as never, context, {
      apiKey: "test-only-key",
      env: {
        GOOGLE_CLOUD_PROJECT: "fixture-project",
        GOOGLE_CLOUD_LOCATION: "us-central1",
      },
    }).result();
    expect(parsed.stopReason, parsed.errorMessage).not.toBe("error");
    const converted = convertAssistantMessageToAnthropicResponse(
      parsed,
      {
        selector: "client-model",
        createMessageId: () => "msg-google-certified",
        directToolNames: ["lookup"],
      },
    );

    expect(parsed.content).toEqual([
      expect.objectContaining({
        type: "thinking",
        thinking: "plan",
        thinkingSignature: "Z29vZ2xlLXRoaW5raW5nLXN0YXRl",
      }),
      expect.objectContaining({
        type: "text",
        text: "answer",
        textSignature: "Z29vZ2xlLXRleHQtc3RhdGU=",
      }),
      expect.objectContaining({
        type: "toolCall",
        id: "call-1",
        thoughtSignature: "Z29vZ2xlLXRvb2wtc3RhdGU=",
      }),
    ]);
    expect(converted.message.content).toEqual([
      expect.objectContaining({
        type: "thinking",
        signature: "",
        token_continuity: expect.objectContaining({
          attachments: [expect.objectContaining({
            target: "thinking",
            value: "Z29vZ2xlLXRoaW5raW5nLXN0YXRl",
          })],
        }),
      }),
      expect.objectContaining({
        type: "text",
        token_continuity: expect.objectContaining({
          attachments: [expect.objectContaining({
            target: "text",
            value: "Z29vZ2xlLXRleHQtc3RhdGU=",
          })],
        }),
      }),
      expect.objectContaining({
        type: "tool_use",
        caller: { type: "direct" },
        token_continuity: expect.objectContaining({
          attachments: [expect.objectContaining({
            target: "toolCall",
            callId: "call-1",
            value: "Z29vZ2xlLXRvb2wtc3RhdGU=",
          })],
        }),
      }),
    ]);

    const replayPayload = await captureAnthropicContinuityReplay({
      model,
      clientContent: converted.message.content as unknown as readonly Record<string, unknown>[],
      start: (replayContext, options) =>
        start(model as never, replayContext, {
          ...options,
          apiKey: "test-only-key",
          env: {
            GOOGLE_CLOUD_PROJECT: "fixture-project",
            GOOGLE_CLOUD_LOCATION: "us-central1",
          },
        } as never),
      verifyPreparedContext(replayContext) {
        expect(replayContext.messages[0]).toMatchObject({
          role: "assistant",
          provider: model.provider,
          api: model.api,
          model: model.id,
          content: [
            expect.objectContaining({
              type: "thinking",
              thinkingSignature: "Z29vZ2xlLXRoaW5raW5nLXN0YXRl",
            }),
            expect.objectContaining({
              type: "text",
              textSignature: "Z29vZ2xlLXRleHQtc3RhdGU=",
            }),
            expect.objectContaining({
              type: "toolCall",
              thoughtSignature: "Z29vZ2xlLXRvb2wtc3RhdGU=",
            }),
          ],
        });
      },
    });
    expect(replayPayload).toMatchObject({
      contents: expect.arrayContaining([
        expect.objectContaining({
          role: "model",
          parts: [
            expect.objectContaining({
              thought: true,
              text: "plan",
              thoughtSignature: "Z29vZ2xlLXRoaW5raW5nLXN0YXRl",
            }),
            expect.objectContaining({
              text: "answer",
              thoughtSignature: "Z29vZ2xlLXRleHQtc3RhdGU=",
            }),
            expect.objectContaining({
              functionCall: expect.objectContaining({ name: "lookup" }),
              thoughtSignature: "Z29vZ2xlLXRvb2wtc3RhdGU=",
            }),
          ],
        }),
      ]),
    });
  });
});
