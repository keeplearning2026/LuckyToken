import type {
  AssistantMessage,
  Context,
  Model,
  Models,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { createOpenAIResponsesHandler } from "../../src/protocols/openai-responses/handler.js";
import {
  ROUTED_COMPACTION_PROMPT,
  ROUTED_COMPACTION_SYSTEM_PROMPT,
} from "../../src/responses-compaction.js";

const THIRD_PARTY_MODEL: Model<string> = {
  id: "third-party-model",
  name: "third-party-model",
  api: "openai-completions",
  provider: "third-party",
  baseUrl: "https://third-party.test/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
};

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    api: THIRD_PARTY_MODEL.api,
    provider: THIRD_PARTY_MODEL.provider,
    model: THIRD_PARTY_MODEL.id,
    content: [{ type: "text", text }],
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

function sseEvents(body: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const block of body.split("\n\n")) {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice("data:".length).trim();
      if (payload.length === 0) continue;
      try {
        const parsed = JSON.parse(payload) as unknown;
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          events.push(parsed as Record<string, unknown>);
        }
      } catch {
        // Ignore non-JSON SSE payloads; this test asserts on typed events.
      }
    }
  }
  return events;
}

const MARKER_TOOL = {
  type: "function",
  name: "marker_tool",
  description: "must not reach the summarizer",
  parameters: { type: "object", properties: {}, additionalProperties: false },
} as const;

function compressionBody(input: unknown, tools: unknown[] = [MARKER_TOOL]): Request {
  return new Request("http://Token.test/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "third-party/third-party-model",
      stream: true,
      tools,
      input,
    }),
  });
}

describe("Codex routed v2 compaction over Semantic Conversion", () => {
  it("answers a compaction_trigger turn with exactly one Token compaction item", async () => {
    const models = {
      getModels: () => [THIRD_PARTY_MODEL],
    } as unknown as Models;
    const calls: Array<{
      readonly context: Context;
      readonly options: ModelsSimpleStreamOptions;
    }> = [];
    const executeOperation = vi.fn(
      async (
        _models: Models,
        _model: Model<string>,
        context: Context,
        options: ModelsSimpleStreamOptions,
      ): Promise<AssistantMessage> => {
        calls.push({ context, options });
        return assistantMessage("handoff summary text");
      },
    );
    const handler = createOpenAIResponsesHandler({
      models,
      executeOperation,
      stateFile: "unused-routed-compaction.json",
      maxRequestBytes: 65_536,
      now: () => 1,
      createResponseId: () => "resp_compact_test",
    });

    const response = await handler.handle(
      compressionBody([
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Fix the widget." }],
        },
        {
          type: "additional_tools",
          role: "user",
          tools: [
            {
              type: "function",
              name: "marker_tool",
              description: "must not reach the summarizer",
              parameters: {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
            },
          ],
        },
        { type: "compaction_trigger" },
      ]),
    );

    expect(response.status).toBe(200);
    const events = sseEvents(await response.text());
    const items = events
      .filter((event) => event.type === "response.output_item.done")
      .map((event) => event.item)
      .filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null,
      );
    const compactionItems = items.filter((item) => item.type === "compaction");

    expect(
      events.some((event) => event.type === "response.completed"),
    ).toBe(true);
    expect(items).toHaveLength(1);
    expect(compactionItems).toHaveLength(1);
    const encrypted = compactionItems[0]!.encrypted_content;
    expect(typeof encrypted).toBe("string");
    expect(String(encrypted)).toMatch(/^Token1:/u);
    expect(
      Buffer.from(String(encrypted).slice("Token1:".length), "base64").toString("utf8"),
    ).toBe("handoff summary text");
    const completed = events.find(
      (event) => event.type === "response.completed",
    );
    const completedOutput = (completed?.response as { output?: unknown[] })
      ?.output;
    expect(completedOutput).toEqual([compactionItems[0]]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.context.systemPrompt).toBe(
      ROUTED_COMPACTION_SYSTEM_PROMPT,
    );
    const lastMessage = calls[0]!.context.messages.at(-1);
    expect(JSON.stringify(lastMessage)).toContain(
      ROUTED_COMPACTION_PROMPT.slice(0, 48),
    );
    expect(calls[0]!.context.tools ?? []).toHaveLength(0);
    expect(JSON.stringify(calls[0]!.context)).not.toContain("marker_tool");
  });

  it("keeps the canonical replay identity of namespaced history calls", async () => {
    const models = {
      getModels: () => [THIRD_PARTY_MODEL],
    } as unknown as Models;
    const contexts: Context[] = [];
    const options: ModelsSimpleStreamOptions[] = [];
    const executeOperation = vi.fn(
      async (
        _models: Models,
        _model: Model<string>,
        context: Context,
        streamOptions: ModelsSimpleStreamOptions,
      ): Promise<AssistantMessage> => {
        contexts.push(context);
        options.push(streamOptions);
        return assistantMessage("handoff summary text");
      },
    );
    const handler = createOpenAIResponsesHandler({
      models,
      executeOperation,
      stateFile: "unused-routed-compaction-namespace.json",
      maxRequestBytes: 65_536,
      now: () => 1,
      createResponseId: () => "resp_namespace_test",
    });

    const response = await handler.handle(
      compressionBody(
        [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Fix the widget." }],
          },
          {
            type: "function_call",
            call_id: "call_spawn_1",
            namespace: "multi_agent_v1",
            name: "spawn_agent",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: "call_spawn_1",
            output: "agent started",
          },
          {
            type: "custom_tool_call",
            call_id: "call_compose_1",
            namespace: "notes_v1",
            name: "compose",
            input: "draft the notes",
          },
          {
            type: "custom_tool_call_output",
            call_id: "call_compose_1",
            output: "notes drafted",
          },
          {
            type: "additional_tools",
            role: "user",
            tools: [
              {
                type: "namespace",
                name: "multi_agent_v1",
                tools: [
                  {
                    type: "function",
                    name: "spawn_agent",
                    parameters: {
                      type: "object",
                      properties: {},
                      additionalProperties: false,
                    },
                  },
                ],
              },
              {
                type: "namespace",
                name: "remote_notes",
                description: "Deferred notes tools.",
                tools: [
                  {
                    type: "function",
                    name: "ping",
                    parameters: {
                      type: "object",
                      properties: {},
                      additionalProperties: false,
                    },
                  },
                ],
              },
            ],
          },
          {
            type: "function_call",
            call_id: "call_ping_1",
            namespace: "remote_notes",
            name: "ping",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: "call_ping_1",
            output: "pong",
          },
          { type: "compaction_trigger" },
        ],
        [
          MARKER_TOOL,
          {
            type: "namespace",
            name: "multi_agent_v1",
            description: "Tools for spawning and managing sub-agents.",
            tools: [
              {
                type: "function",
                name: "spawn_agent",
                parameters: {
                  type: "object",
                  properties: {},
                  additionalProperties: false,
                },
              },
              {
                type: "function",
                name: "close_agent",
                parameters: {
                  type: "object",
                  properties: {},
                  additionalProperties: false,
                },
              },
            ],
          },
          {
            type: "namespace",
            name: "notes_v1",
            description: "Freeform note tools.",
            tools: [
              {
                type: "custom",
                name: "compose",
                format: { type: "lark", grammar: "start: /(.+)/" },
              },
            ],
          },
        ],
      ),
    );

    expect(response.status).toBe(200);
    expect(contexts).toHaveLength(1);
    const context = contexts[0]!;
    expect(context.tools ?? []).toEqual([]);
    expect(options).toHaveLength(1);
    const toolCalls = context.messages.flatMap((message) =>
      message.role === "assistant"
        ? message.content.filter((block) => block.type === "toolCall")
        : [],
    );
    expect(toolCalls.map((toolCall) => toolCall.name)).toEqual([
      "multi_agent_v1__spawn_agent",
      "notes_v1__compose",
      "remote_notes__ping",
    ]);
    expect(toolCalls.map((toolCall) => toolCall.namespace)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(JSON.stringify(context)).not.toContain("marker_tool");
  });

  it("keeps failing closed when namespaced history has no matching declaration or child", async () => {
    const models = {
      getModels: () => [THIRD_PARTY_MODEL],
    } as unknown as Models;
    const executeOperation = vi.fn(
      async (): Promise<AssistantMessage> => assistantMessage("unused"),
    );
    const handler = createOpenAIResponsesHandler({
      models,
      executeOperation,
      stateFile: "unused-routed-compaction-unmatched.json",
      maxRequestBytes: 65_536,
      now: () => 1,
      createResponseId: () => "resp_unmatched_namespace",
    });

    const unmatchedHistory = [
      {
        type: "function_call",
        call_id: "call_spawn_2",
        namespace: "multi_agent_v1",
        name: "spawn_agent",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "call_spawn_2",
        output: "agent started",
      },
    ];
    const wrongChildDeclaration = {
      type: "namespace",
      name: "multi_agent_v1",
      tools: [
        {
          type: "function",
          name: "close_agent",
          parameters: { type: "object", properties: {} },
        },
      ],
    };
    const unmatchedDeclarations = [
      [MARKER_TOOL],
      [MARKER_TOOL, wrongChildDeclaration],
    ];
    for (const tools of unmatchedDeclarations) {
      const response = await handler.handle(
        compressionBody(
          [...unmatchedHistory, { type: "compaction_trigger" }],
          tools,
        ),
      );

      expect(response.status).toBe(400);
      expect(executeOperation).not.toHaveBeenCalled();
      expect(await response.text()).toContain(
        "Namespaced tool-call history requires a matching namespace tool declaration",
      );

      // Conversion transparency: the rewrite must not invent the rejection.
      // The same history without the trigger already fails for the same reason.
      const ordinaryTurn = await handler.handle(
        compressionBody(unmatchedHistory, tools),
      );
      expect(ordinaryTurn.status).toBe(400);
      expect(await ordinaryTurn.text()).toContain(
        "Namespaced tool-call history requires a matching namespace tool declaration",
      );
    }
    expect(executeOperation).not.toHaveBeenCalled();
  });

  it("replays a Token compaction item as model-visible summary text", async () => {
    const models = {
      getModels: () => [THIRD_PARTY_MODEL],
    } as unknown as Models;
    const contexts: Context[] = [];
    const executeOperation = vi.fn(
      async (
        _models: Models,
        _model: Model<string>,
        context: Context,
      ): Promise<AssistantMessage> => {
        contexts.push(context);
        return assistantMessage("continued");
      },
    );
    const handler = createOpenAIResponsesHandler({
      models,
      executeOperation,
      stateFile: "unused-routed-compaction-replay.json",
      maxRequestBytes: 65_536,
      now: () => 1,
      createResponseId: () => "resp_replay_test",
    });
    const envelope =
      "Token1:" +
      Buffer.from("earlier handoff summary", "utf8").toString("base64");

    const response = await handler.handle(
      compressionBody([
        {
          type: "compaction",
          id: "cmp_1",
          encrypted_content: envelope,
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "continue" }],
        },
      ]),
    );

    expect(response.status).toBe(200);
    expect(contexts).toHaveLength(1);
    const text = JSON.stringify(contexts[0]!.messages);
    expect(text).toContain("earlier handoff summary");
    expect(text).toContain("<summary>");
  });

});
