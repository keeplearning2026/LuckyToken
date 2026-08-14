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
import { parseCommandCodeConfiguration } from "../../src/providers/commandcode-private/configuration.js";
import { createEmptyServerConfig } from "../../src/providers/commandcode-private/project.js";
import { findUpstreamFailureFact } from "../../src/protocols/upstream-failure.js";

function lifecycleModel(): Model<typeof commandCodePrivateApiId> {
  return {
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
}

const lifecycleContext: Context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

function jsonl(events: readonly Record<string, unknown>[]): Response {
  return new Response(events.map((event) => JSON.stringify(event)).join("\n"));
}

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

it("carries Provider-local missing-result notices on the Pi terminal", async () => {
  const model: Model<typeof commandCodePrivateApiId> = {
    id: "model",
    name: "model",
    api: commandCodePrivateApiId,
    provider: commandCodePrivateProviderId,
    baseUrl: "https://fixture.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 100,
  };
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const context: Context = {
    messages: [
      {
        role: "assistant",
        api: "luckytoken-client-history",
        provider: "luckytoken-client",
        model: "client-model",
        content: [{ type: "toolCall", id: "lost", name: "lookup", arguments: {} }],
        usage,
        stopReason: "toolUse",
        timestamp: 1,
      },
    ],
  };
  let requestBody: unknown;
  const fetch: FetchFunction = async (request) => {
    requestBody = JSON.parse(await new Request(request).text());
    return new Response(
      JSON.stringify({
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 0, outputTokens: 0 },
      }),
    );
  };
  const provider = createCommandCodePrivateProvider({
    apiKey: "key",
    fetch,
    model,
    now: () => 10,
    projectSnapshot: { snapshot: async () => createEmptyServerConfig() },
    configuration: parseCommandCodeConfiguration({
      conversion: {
        request: { syntheticMissingToolResultOutputType: "error-text" },
      },
    }),
  });

  const result = await provider
    .streamSimple(model, context, {
      maxTokens: 20,
      sessionId: "00000000-0000-4000-8000-000000000110",
    })
    .result();

  expect(requestBody).toMatchObject({
    params: {
      messages: [
        { role: "assistant" },
        {
          role: "tool",
          content: [
            {
              toolCallId: "lost",
              toolName: "lookup",
              output: { type: "error-text" },
            },
          ],
        },
      ],
    },
  });
  expect(result.diagnostics).toEqual([
    expect.objectContaining({
      type: "luckytoken.conversion_notice.v1",
      details: {
        notice: {
          adapter: "commandcode-private",
          direction: "request",
          code: "missing_tool_result_xrepair",
          jsonPath: "$.messages",
          action: "xrepair",
        },
      },
    }),
  ]);
});

it("applies unknown-ignore and pause-stop policies through the Provider seam", async () => {
  const model = lifecycleModel();
  const provider = createCommandCodePrivateProvider({
    apiKey: "key",
    fetch: async () =>
      jsonl([
        { type: "future-event", privatePayload: "discarded" },
        { type: "tool-input-start", id: "call", toolName: "preview" },
        { type: "tool-input-end", id: "call" },
        {
          type: "tool-call",
          toolCallId: "call",
          toolName: "final-tool",
          input: { exact: true },
        },
        {
          type: "finish-step",
          usage: { mustNotWin: true },
          response: { id: "response-id", modelId: "response-model" },
        },
        {
          type: "finish",
          finishReason: "tool-calls",
          rawFinishReason: "pause_turn",
          totalUsage: { inputTokens: 1, outputTokens: 1 },
        },
      ]),
    model,
    now: () => 10,
    projectSnapshot: { snapshot: async () => createEmptyServerConfig() },
    configuration: parseCommandCodeConfiguration({
      conversion: {
        response: { pauseTurn: "stop", unknownEvent: "ignore" },
      },
    }),
  });

  const result = await provider
    .streamSimple(model, lifecycleContext, {
      maxTokens: 20,
      sessionId: "00000000-0000-4000-8000-000000000111",
    })
    .result();

  expect(result).toMatchObject({
    stopReason: "toolUse",
    rawStopReason: "pause_turn",
    content: [
      {
        type: "toolCall",
        id: "call",
        name: "final-tool",
        arguments: { exact: true },
      },
    ],
  });
  expect(
    result.diagnostics?.map((diagnostic) => diagnostic.details?.notice),
  ).toEqual([
    {
      adapter: "commandcode-private",
      direction: "response",
      code: "unknown_event_ignored",
      action: "ignore",
    },
    {
      adapter: "commandcode-private",
      direction: "response",
      code: "pause_turn_degraded",
      action: "degrade",
    },
  ]);
  expect(JSON.stringify(result.diagnostics)).not.toContain("privatePayload");
});

it("rolls back pause-error and wire-abort as distinct neutral failures", async () => {
  const model = lifecycleModel();
  const run = async (
    events: readonly Record<string, unknown>[],
    pauseTurn: "stop" | "error",
  ) => {
    const provider = createCommandCodePrivateProvider({
      apiKey: "key",
      fetch: async () => jsonl(events),
      model,
      now: () => 10,
      projectSnapshot: { snapshot: async () => createEmptyServerConfig() },
      configuration: parseCommandCodeConfiguration({
        conversion: { response: { pauseTurn } },
      }),
    });
    return provider
      .streamSimple(model, lifecycleContext, {
        maxTokens: 20,
        sessionId: "00000000-0000-4000-8000-000000000112",
      })
      .result();
  };

  const pause = await run(
    [
      { type: "text-start", id: "partial" },
      { type: "text-delta", id: "partial", text: "discard" },
      { type: "text-end", id: "partial" },
      { type: "finish", rawFinishReason: "pause_turn" },
    ],
    "error",
  );
  const abort = await run(
    [
      { type: "text-start", id: "partial" },
      { type: "text-delta", id: "partial", text: "discard" },
      { type: "abort" },
    ],
    "stop",
  );

  expect(pause).toMatchObject({ stopReason: "error", content: [] });
  expect(findUpstreamFailureFact(pause.diagnostics)).toMatchObject({
    kind: "protocol",
    providerType: "pause_turn",
    retryable: false,
  });
  expect(abort).toMatchObject({ stopReason: "error", content: [] });
  expect(findUpstreamFailureFact(abort.diagnostics)).toMatchObject({
    kind: "upstream_stream",
    providerType: "abort",
    retryable: false,
  });
});
