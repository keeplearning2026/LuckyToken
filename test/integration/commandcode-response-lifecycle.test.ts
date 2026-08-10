import {
  type AssistantMessageEvent,
  type Context,
  type FetchFunction,
  type Model,
} from "@earendil-works/pi-ai";
import { expect, it } from "vitest";

import {
  commandCodePrivateApiId,
  commandCodePrivateProviderId,
  createCommandCodePrivateProvider,
} from "../../src/providers/commandcode-private/provider.js";
import { createEmptyServerConfig } from "../../src/providers/commandcode-private/project.js";

it("converts and replays a committed mixed CommandCode response in order", async () => {
  const model: Model<typeof commandCodePrivateApiId> = {
    id: "model",
    name: "model",
    api: commandCodePrivateApiId,
    provider: commandCodePrivateProviderId,
    baseUrl: "https://fixture.test",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 100,
  };
  const context: Context = {
    messages: [{ role: "user", content: "hello", timestamp: 1 }],
  };
  const fetch: FetchFunction = async () =>
    new Response(
      [
        JSON.stringify({ type: "reasoning-start", id: "r" }),
        JSON.stringify({ type: "text-start", id: "t" }),
        JSON.stringify({ type: "tool-input-start", id: "call", toolName: "preview" }),
        JSON.stringify({ type: "text-delta", id: "t", text: "answer" }),
        JSON.stringify({ type: "reasoning-delta", id: "r", text: "reason" }),
        JSON.stringify({ type: "tool-input-delta", id: "call", delta: "preview" }),
        JSON.stringify({ type: "reasoning-end", id: "r" }),
        JSON.stringify({ type: "text-end", id: "t" }),
        JSON.stringify({ type: "tool-input-end", id: "call" }),
        JSON.stringify({
          type: "tool-call",
          toolCallId: "call",
          toolName: "final-tool",
          input: { value: 1 },
        }),
        JSON.stringify({
          type: "finish",
          finishReason: "tool-calls",
          rawFinishReason: "raw-tool-reason",
          totalUsage: {
            inputTokens: 5,
            inputTokenDetails: { cacheReadTokens: 2 },
            outputTokens: 4,
            outputTokenDetails: { reasoningTokens: 1 },
          },
          systemPromptTokens: 2,
        }),
      ].join("\n"),
    );
  const provider = createCommandCodePrivateProvider({
    apiKey: "key",
    fetch,
    model,
    now: () => 10,
    projectSnapshot: { snapshot: async () => createEmptyServerConfig() },
  });
  const stream = provider.streamSimple(model, context, {
    maxTokens: 20,
    sessionId: "00000000-0000-4000-8000-000000000110",
  });
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  const result = await stream.result();

  expect(result).toMatchObject({
    content: [
      { type: "thinking", thinking: "reason" },
      { type: "text", text: "answer" },
      {
        type: "toolCall",
        id: "call",
        name: "final-tool",
        arguments: { value: 1 },
      },
    ],
    stopReason: "toolUse",
    rawStopReason: "raw-tool-reason",
    usage: {
      input: 3,
      cacheRead: 2,
      cacheWrite: 0,
      output: 4,
      reasoning: 1,
      totalTokens: 9,
    },
  });
  expect(events.map((event) => event.type)).toEqual([
    "start",
    "thinking_start",
    "thinking_delta",
    "thinking_end",
    "text_start",
    "text_delta",
    "text_end",
    "toolcall_start",
    "toolcall_end",
    "done",
  ]);
  expect(events.at(-1)).toMatchObject({
    type: "done",
    reason: "toolUse",
    message: result,
  });
});
