import { streamSimple as streamAnthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as streamOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as streamAzureOpenAIResponses } from "@earendil-works/pi-ai/api/azure-openai-responses";
import { streamSimple as streamOpenAICodexResponses } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { streamSimple as streamPiMessages } from "@earendil-works/pi-ai/api/pi-messages";
import { streamSimple as streamMistral } from "@earendil-works/pi-ai/api/mistral-conversations";
import { processResponsesStream } from "@earendil-works/pi-ai/api/openai-responses-shared";
import type { Context, Model } from "@earendil-works/pi-ai";
import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";

import { createCommandCodePrivateProvider } from "../../packages/provider-commandcode-private/src/provider.js";
import {
  convertAssistantMessageToAnthropicWithPolicy,
} from "../../src/protocols/anthropic/response.js";
import { captureAnthropicContinuityReplay } from "../support/anthropic-continuity-replay.js";

const context: Context = {
  messages: [{ role: "user", content: "Use lookup.", timestamp: 1 }],
};

const CODEX_TEST_TOKEN = `e30.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
})).toString("base64url")}.signature`;

function render(message: Awaited<ReturnType<ReturnType<typeof streamOpenAICompletions>["result"]>>) {
  return convertAssistantMessageToAnthropicWithPolicy(
    message,
    {
      selector: "client-model",
      createMessageId: () => "msg-certified",
      directToolNames: ["lookup"],
    },
    { unknownPiContent: "error" },
  );
}

function sse(events: readonly { readonly event?: string; readonly data: unknown }[]): Response {
  const body = events
    .map(({ event, data }) => `${event === undefined ? "" : `event: ${event}\n`}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`)
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("Anthropic response interpretation parser certification", () => {
  it.each([
    "openai-responses",
    "azure-openai-responses",
    "openai-codex-responses",
  ] as const)("certifies %s reasoning and text continuity through the pinned Responses parser", async (api) => {
    const model: Model<typeof api> = {
      id: "responses-certified",
      name: "Responses certified fixture",
      api,
      provider: `${api}-fixture`,
      baseUrl: "https://fixture.invalid/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4_096,
    };
    const parsed = {
      role: "assistant" as const,
      content: [],
      api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending" as const,
      timestamp: 1,
    };
    async function* events(): AsyncIterable<ResponseStreamEvent> {
      yield {
        type: "response.output_item.added",
        sequence_number: 0,
        output_index: 0,
        item: { type: "reasoning", id: "rs-certified", summary: [] },
      } as unknown as ResponseStreamEvent;
      yield {
        type: "response.reasoning_summary_text.delta",
        sequence_number: 1,
        output_index: 0,
        item_id: "rs-certified",
        summary_index: 0,
        delta: "plan",
      } as ResponseStreamEvent;
      yield {
        type: "response.output_item.done",
        sequence_number: 2,
        output_index: 0,
        item: {
          type: "reasoning",
          id: "rs-certified",
          summary: [{ type: "summary_text", text: "plan" }],
          encrypted_content: "responses-replay-state",
        },
      } as ResponseStreamEvent;
      yield {
        type: "response.output_item.added",
        sequence_number: 3,
        output_index: 1,
        item: {
          type: "message",
          id: "msg-certified",
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      } as ResponseStreamEvent;
      yield {
        type: "response.output_item.done",
        sequence_number: 4,
        output_index: 1,
        item: {
          type: "message",
          id: "msg-certified",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "answer", annotations: [] }],
        },
      } as ResponseStreamEvent;
      yield {
        type: "response.completed",
        sequence_number: 5,
        response: {
          id: "resp-certified",
          status: "completed",
          output: [],
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            total_tokens: 3,
            input_tokens_details: { cached_tokens: 0 },
          },
        },
      } as unknown as ResponseStreamEvent;
    }

    await processResponsesStream(
      events(),
      parsed,
      { push() {} } as never,
      model,
    );
    const converted = render(parsed);

    expect(parsed.content).toEqual([
      expect.objectContaining({
        type: "thinking",
        thinking: "plan",
        thinkingSignature: expect.stringContaining("responses-replay-state"),
      }),
      expect.objectContaining({
        type: "text",
        text: "answer",
        textSignature: expect.any(String),
      }),
    ]);
    expect(converted.message.content).toEqual([
      expect.objectContaining({
        type: "thinking",
        luckytoken_continuity: expect.objectContaining({
          source: expect.objectContaining({ api }),
          attachments: [expect.objectContaining({ target: "thinking" })],
        }),
      }),
      expect.objectContaining({
        type: "text",
        luckytoken_continuity: expect.objectContaining({
          attachments: [expect.objectContaining({ target: "text" })],
        }),
      }),
    ]);

    const start =
      api === "openai-responses"
        ? streamOpenAIResponses
        : api === "azure-openai-responses"
          ? streamAzureOpenAIResponses
          : streamOpenAICodexResponses;
    const captureReplay = () => captureAnthropicContinuityReplay({
      model,
      clientContent: converted.message.content as unknown as readonly Record<string, unknown>[],
      start: (replayContext, options) =>
        start(model as never, replayContext, {
          ...options,
          apiKey: api === "openai-codex-responses"
            ? CODEX_TEST_TOKEN
            : "test-only-key",
        } as never),
    });
    const replayPayload = await captureReplay();
    expect(replayPayload).toMatchObject({
      input: expect.arrayContaining([
        expect.objectContaining({
          type: "reasoning",
          encrypted_content: "responses-replay-state",
        }),
        expect.objectContaining({
          type: "message",
          role: "assistant",
          content: [expect.objectContaining({ type: "output_text", text: "answer" })],
        }),
      ]),
    });
  });

  it("certifies Mistral structured thinking through its pinned SSE parser", async () => {
    const model: Model<"mistral-conversations"> = {
      id: "mistral-large-latest",
      name: "Mistral Large",
      api: "mistral-conversations",
      provider: "mistral",
      baseUrl: "https://fixture.invalid/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4_096,
    };
    const response = sse([
      {
        data: {
          id: "mistral-certified",
          model: model.id,
          choices: [{
            index: 0,
            finish_reason: null,
            delta: {
              content: [{ type: "thinking", thinking: [{ type: "text", text: "plan" }] }],
            },
          }],
        },
      },
      {
        data: {
          id: "mistral-certified",
          model: model.id,
          choices: [{
            index: 0,
            finish_reason: "stop",
            delta: { content: [{ type: "text", text: "answer" }] },
          }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        },
      },
      { data: "[DONE]" },
    ]);
    const parsed = await streamMistral(model, context, {
      apiKey: "test-only-key",
      fetch: async () => response,
    }).result();

    expect(parsed.content).toEqual([
      { type: "thinking", thinking: "plan" },
      { type: "text", text: "answer" },
    ]);
    expect(render(parsed).message.content).toEqual([
      expect.objectContaining({ type: "thinking", thinking: "plan", signature: "" }),
      expect.objectContaining({ type: "text", text: "answer" }),
    ]);
  });

  it("certifies CommandCode Private through its real provider parser", async () => {
    const model: Model<"commandcode-private"> = {
      id: "deepseek/deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      api: "commandcode-private",
      provider: "commandcode-private",
      baseUrl: "https://fixture.invalid",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4_096,
    };
    const provider = createCommandCodePrivateProvider({
      apiKey: "test-only-key",
      model,
      now: () => 10,
      fetch: async () =>
        new Response([
          JSON.stringify({ type: "reasoning-start", id: "r" }),
          JSON.stringify({ type: "reasoning-delta", id: "r", text: "plan" }),
          JSON.stringify({ type: "reasoning-end", id: "r" }),
          JSON.stringify({ type: "tool-input-start", id: "call-1", toolName: "lookup" }),
          JSON.stringify({ type: "tool-input-delta", id: "call-1", delta: "{}" }),
          JSON.stringify({ type: "tool-input-end", id: "call-1" }),
          JSON.stringify({ type: "tool-call", toolCallId: "call-1", toolName: "lookup", input: {} }),
          JSON.stringify({
            type: "finish",
            finishReason: "tool-calls",
            rawFinishReason: "tool-calls",
            totalUsage: {
              inputTokens: 1,
              inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0 },
              outputTokens: 1,
              totalTokens: 2,
            },
          }),
        ].join("\n")),
    });

    const parsed = await provider.streamSimple(model, context, {
      maxTokens: 512,
      sessionId: "00000000-0000-4000-8000-000000000321",
    }).result();
    const converted = render(parsed);

    expect(parsed.api).toBe("commandcode-private");
    expect(parsed.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "thinking", thinking: "plan" }),
      expect.objectContaining({ type: "toolCall", id: "call-1", name: "lookup" }),
    ]));
    expect(converted.message).toMatchObject({
      stop_reason: "tool_use",
      content: expect.arrayContaining([
        expect.objectContaining({ type: "tool_use", id: "call-1", caller: { type: "direct" } }),
      ]),
    });
  });

  it("certifies OpenAI Completions through the pinned Pi SSE parser", async () => {
    const model: Model<"openai-completions"> = {
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      api: "openai-completions",
      provider: "opencode-go",
      baseUrl: "https://fixture.invalid/v1",
      reasoning: true,
      thinkingLevelMap: { off: null, high: "high" },
      compat: { thinkingFormat: "deepseek", supportsReasoningEffort: true },
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4_096,
    };
    const response = sse([
      {
        data: {
          id: "chatcmpl-certified",
          object: "chat.completion.chunk",
          created: 1,
          model: model.id,
          choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "plan" }, finish_reason: null }],
        },
      },
      {
        data: {
          id: "chatcmpl-certified",
          object: "chat.completion.chunk",
          created: 1,
          model: model.id,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: "call-1",
                type: "function",
                function: { name: "lookup", arguments: "{}" },
              }],
              reasoning_details: [{
                type: "reasoning.encrypted",
                id: "call-1",
                data: "opaque-tool-state",
              }],
            },
            finish_reason: null,
          }],
        },
      },
      {
        data: {
          id: "chatcmpl-certified",
          object: "chat.completion.chunk",
          created: 1,
          model: model.id,
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      },
      { data: "[DONE]" },
    ]);

    const parsed = await streamOpenAICompletions(model, context, {
      apiKey: "test-only-key",
      maxTokens: 512,
      fetch: async () => response,
    }).result();
    const converted = render(parsed);

    expect(parsed.api).toBe("openai-completions");
    expect(parsed.content).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "thinking",
        thinking: "plan",
        thinkingSignature: "reasoning_content",
      }),
      expect.objectContaining({
        type: "toolCall",
        id: "call-1",
        name: "lookup",
        thoughtSignature: JSON.stringify({
          type: "reasoning.encrypted",
          id: "call-1",
          data: "opaque-tool-state",
        }),
      }),
    ]));
    expect(converted.message.stop_reason).toBe("tool_use");
    expect(converted.message.content).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "thinking",
        luckytoken_continuity: expect.objectContaining({
          attachments: [expect.objectContaining({
            target: "thinking",
            value: "reasoning_content",
          })],
        }),
      }),
      expect.objectContaining({
        type: "tool_use",
        id: "call-1",
        caller: { type: "direct" },
        luckytoken_continuity: expect.objectContaining({
          attachments: [expect.objectContaining({
            target: "toolCall",
            callId: "call-1",
          })],
        }),
      }),
    ]));

    const replayPayload = await captureAnthropicContinuityReplay({
      model,
      clientContent: converted.message.content as unknown as readonly Record<string, unknown>[],
      start: (replayContext, options) =>
        streamOpenAICompletions(model, replayContext, {
          ...options,
          apiKey: "test-only-key",
        }),
    });
    expect(replayPayload).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          reasoning_content: "plan",
          tool_calls: [
            expect.objectContaining({
              id: "call-1",
              function: expect.objectContaining({ name: "lookup" }),
            }),
          ],
          reasoning_details: [{
            type: "reasoning.encrypted",
            id: "call-1",
            data: "opaque-tool-state",
          }],
        }),
      ]),
    });
  });

  it("certifies CommandCode Goat through the pinned OpenAI Completions parser", async () => {
    const model: Model<"openai-completions"> = {
      id: "deepseek/deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      api: "openai-completions",
      provider: "commandcode-goat",
      baseUrl: "https://api.commandcode.ai/provider/v1",
      reasoning: true,
      thinkingLevelMap: { high: "high", max: "max" },
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 131_072,
    };
    const response = sse([
      {
        data: {
          id: "chatcmpl-goat-certified",
          object: "chat.completion.chunk",
          created: 1,
          model: model.id,
          choices: [{
            index: 0,
            delta: { role: "assistant", reasoning_content: "plan" },
            finish_reason: null,
          }],
        },
      },
      {
        data: {
          id: "chatcmpl-goat-certified",
          object: "chat.completion.chunk",
          created: 1,
          model: model.id,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: "call-goat-1",
                type: "function",
                function: { name: "lookup", arguments: "{}" },
              }],
            },
            finish_reason: null,
          }],
        },
      },
      {
        data: {
          id: "chatcmpl-goat-certified",
          object: "chat.completion.chunk",
          created: 1,
          model: model.id,
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      },
      { data: "[DONE]" },
    ]);

    const parsed = await streamOpenAICompletions(model, context, {
      apiKey: "test-only-key",
      maxTokens: 512,
      fetch: async () => response,
    }).result();
    const converted = render(parsed);

    expect(parsed).toMatchObject({
      api: "openai-completions",
      provider: "commandcode-goat",
      model: "deepseek/deepseek-v4-flash",
      stopReason: "toolUse",
    });
    expect(parsed.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "thinking", thinking: "plan" }),
      expect.objectContaining({ type: "toolCall", id: "call-goat-1", name: "lookup" }),
    ]));
    expect(converted.message.content).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "tool_use",
        id: "call-goat-1",
        caller: { type: "direct" },
      }),
    ]));
  });

  it("certifies Pi Messages text and reasoning continuity through its real SSE parser", async () => {
    const model: Model<"pi-messages"> = {
      id: "pi-certified",
      name: "Pi certified fixture",
      api: "pi-messages",
      provider: "radius-fixture",
      baseUrl: "https://fixture.invalid",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4_096,
    };
    const response = sse([
      { data: { type: "start" } },
      { data: { type: "thinking_start", contentIndex: 0 } },
      { data: { type: "thinking_delta", contentIndex: 0, delta: "plan" } },
      {
        data: {
          type: "thinking_end",
          contentIndex: 0,
          content: "plan",
          contentSignature: "pi-thinking-state",
        },
      },
      { data: { type: "text_start", contentIndex: 1 } },
      { data: { type: "text_delta", contentIndex: 1, delta: "answer" } },
      {
        data: {
          type: "text_end",
          contentIndex: 1,
          content: "answer",
          contentSignature: "pi-text-state",
        },
      },
      {
        data: {
          type: "done",
          reason: "stop",
          usage: {
            input: 1,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 3,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          responseId: "pi-response-1",
        },
      },
    ]);

    const parsed = await streamPiMessages(model, context, {
      apiKey: "test-only-key",
      maxTokens: 512,
      fetch: async () => response,
    }).result();
    const converted = render(parsed);

    expect(parsed.content).toEqual([
      expect.objectContaining({
        type: "thinking",
        thinking: "plan",
        thinkingSignature: "pi-thinking-state",
      }),
      expect.objectContaining({
        type: "text",
        text: "answer",
        textSignature: "pi-text-state",
      }),
    ]);
    expect(converted.message.content).toEqual([
      expect.objectContaining({
        type: "thinking",
        signature: "",
        luckytoken_continuity: expect.objectContaining({
          attachments: [expect.objectContaining({
            target: "thinking",
            value: "pi-thinking-state",
          })],
        }),
      }),
      expect.objectContaining({
        type: "text",
        text: "answer",
        luckytoken_continuity: expect.objectContaining({
          attachments: [expect.objectContaining({
            target: "text",
            value: "pi-text-state",
          })],
        }),
      }),
    ]);

    const replayPayload = await captureAnthropicContinuityReplay({
      model,
      clientContent: converted.message.content as unknown as readonly Record<string, unknown>[],
      start: (replayContext, options) =>
        streamPiMessages(model, replayContext, {
          ...options,
          apiKey: "test-only-key",
        }),
    });
    expect(replayPayload).toMatchObject({
      context: {
        messages: [
          expect.objectContaining({
            role: "assistant",
            content: [
              expect.objectContaining({
                type: "thinking",
                thinkingSignature: "pi-thinking-state",
              }),
              expect.objectContaining({
                type: "text",
                textSignature: "pi-text-state",
              }),
            ],
          }),
          expect.objectContaining({ role: "user" }),
        ],
      },
    });
  });

  it("restores native Anthropic thinking signatures in the next final Provider request", async () => {
    const model: Model<"anthropic-messages"> = {
      id: "claude-certified",
      name: "Claude certified fixture",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://fixture.invalid",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4_096,
    };
    const response = sse([
      {
        event: "message_start",
        data: {
          type: "message_start",
          message: {
            id: "msg_upstream",
            usage: {
              input_tokens: 1,
              output_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        },
      },
      {
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "", signature: "" },
        },
      },
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "plan" },
        },
      },
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "anthropic-thinking-state" },
        },
      },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
      {
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: 1,
          content_block: { type: "text", text: "" },
        },
      },
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "answer" },
        },
      },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
      {
        event: "message_delta",
        data: {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
      { event: "message_stop", data: { type: "message_stop" } },
    ]);

    const parsed = await streamAnthropicMessages(model, context, {
      apiKey: "test-only-key",
      maxTokens: 512,
      fetch: async () => response,
    }).result();
    const converted = render(parsed);
    expect(converted.message.content[0]).toMatchObject({
      type: "thinking",
      thinking: "plan",
      signature: "anthropic-thinking-state",
      luckytoken_continuity: {
        source: {
          provider: "anthropic",
          api: "anthropic-messages",
          model: "claude-certified",
        },
        attachments: [{ target: "thinking", kind: "native-field-provenance" }],
      },
    });

    const replayPayload = await captureAnthropicContinuityReplay({
      model,
      clientContent: converted.message.content as unknown as readonly Record<string, unknown>[],
      start: (replayContext, options) =>
        streamAnthropicMessages(model, replayContext, {
          ...options,
          apiKey: "test-only-key",
        }),
    });
    expect(replayPayload).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "plan",
              signature: "anthropic-thinking-state",
            },
            expect.objectContaining({ type: "text", text: "answer" }),
          ],
        }),
      ]),
    });
  });

  it("certifies that the pinned Anthropic parser discards tool caller provenance", async () => {
    const model: Model<"anthropic-messages"> = {
      id: "claude-certified",
      name: "Claude certified fixture",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://fixture.invalid",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4_096,
    };
    const response = sse([
      {
        event: "message_start",
        data: {
          type: "message_start",
          message: {
            id: "msg_upstream",
            usage: {
              input_tokens: 1,
              output_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        },
      },
      {
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "call-1",
            name: "lookup",
            input: {},
            caller: { type: "code_execution_20250825", tool_id: "srv-1" },
          },
        },
      },
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: "{}" },
        },
      },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
      {
        event: "message_delta",
        data: {
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
      { event: "message_stop", data: { type: "message_stop" } },
    ]);

    const parsed = await streamAnthropicMessages(model, context, {
      apiKey: "test-only-key",
      maxTokens: 512,
      fetch: async () => response,
    }).result();

    expect(parsed.content).toEqual([
      expect.objectContaining({ type: "toolCall", id: "call-1", name: "lookup" }),
    ]);
    expect(() => render(parsed)).toThrow(/caller provenance is unavailable/iu);
  });
});
