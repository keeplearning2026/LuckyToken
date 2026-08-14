import type { Context, Model, ToolCall, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  buildCommandCodeBody,
  commandCodePrivateApiId,
  commandCodePrivateProviderId,
} from "../../packages/provider-commandcode-private/src/provider.js";
import { createEmptyServerConfig } from "../../packages/provider-commandcode-private/src/project.js";

const model: Model<typeof commandCodePrivateApiId> = {
  id: "model",
  name: "model",
  api: commandCodePrivateApiId,
  provider: commandCodePrivateProviderId,
  baseUrl: "https://fixture.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 100,
};

const usage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

function requestMessages(
  context: Context,
  syntheticMissingToolResultOutputType: "text" | "error-text" = "text",
): unknown[] {
  const body = buildCommandCodeBody(
    model,
    context,
    {},
    createEmptyServerConfig(),
    "00000000-0000-4000-8000-000000000021",
    {},
    { syntheticMissingToolResultOutputType },
  ).body;
  return (body.params as { messages: unknown[] }).messages;
}

describe("CommandCode Pi tool-turn conversion", () => {
  it("ignores every historical stop reason while preserving assistant content", () => {
    for (const stopReason of [
      "stop",
      "length",
      "toolUse",
      "pending",
      "error",
      "aborted",
      "deferred",
      "future-runtime-value",
    ]) {
      const messages = requestMessages({
        messages: [
          {
            role: "assistant",
            api: "luckytoken-client-history",
            provider: "luckytoken-client",
            model: "client-model",
            content: [{ type: "text", text: `kept:${stopReason}` }],
            usage,
            stopReason,
            timestamp: 1,
          } as Context["messages"][number],
        ],
      });
      expect(messages).toEqual([
        {
          role: "assistant",
          content: [{ type: "text", text: `kept:${stopReason}` }],
        },
      ]);
    }
  });

  it("maps real results and repairs only known unresolved calls in call order", () => {
    const context: Context = {
      messages: [
        {
          role: "assistant",
          api: "luckytoken-client-history",
          provider: "luckytoken-client",
          model: "client-model",
          content: [
            toolCall("a", "alpha", { nested: [1, true, null] }),
            toolCall("b", "beta", {}),
            toolCall("c", "gamma", {}),
          ],
          usage,
          stopReason: "toolUse",
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "b",
          toolName: "beta",
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
          isError: true,
          timestamp: 2,
        },
        { role: "user", content: "continue", timestamp: 3 },
      ],
    };

    expect(requestMessages(context)).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "a",
            toolName: "alpha",
            input: { nested: [1, true, null] },
          },
          { type: "tool-call", toolCallId: "b", toolName: "beta", input: {} },
          { type: "tool-call", toolCallId: "c", toolName: "gamma", input: {} },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "b",
            toolName: "beta",
            output: { type: "error-text", value: "first\nsecond" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "a",
            toolName: "alpha",
            output: {
              type: "text",
              value:
                "No result — the tool call did not complete (interrupted or lost).",
            },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c",
            toolName: "gamma",
            output: {
              type: "text",
              value:
                "No result — the tool call did not complete (interrupted or lost).",
            },
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "continue" }] },
    ]);
  });

  it("rejects duplicate call IDs and preserves the real result toolName", () => {
    const assistant = {
      role: "assistant" as const,
      api: "luckytoken-client-history",
      provider: "luckytoken-client",
      model: "client-model",
      content: [toolCall("same", "alpha", {}), toolCall("same", "beta", {})],
      usage,
      stopReason: "toolUse" as const,
      timestamp: 1,
    };
    expect(() =>
      requestMessages({ messages: [assistant] }),
    ).toThrow("Duplicate Pi ToolCall id");

    assistant.content = [toolCall("same", "alpha", {})];
    const converted = requestMessages({
      messages: [
        assistant,
        {
          role: "toolResult",
          toolCallId: "same",
          toolName: "wrong",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: 2,
        },
      ],
    });
    expect(converted[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "same",
          toolName: "wrong",
          output: { type: "text", value: "ok" },
        },
      ],
    });
  });

  it("rejects non-lossless arguments and namespaces but drops opaque continuity", () => {
    const convertCall = (call: ToolCall, sameTarget = false): (() => unknown) => () =>
      requestMessages({
        messages: [
          {
            role: "assistant",
            api: sameTarget ? model.api : "luckytoken-client-history",
            provider: sameTarget ? model.provider : "luckytoken-client",
            model: sameTarget ? model.id : "client-model",
            content: [call],
            usage,
            stopReason: "toolUse",
            timestamp: 1,
          },
        ],
      });

    expect(convertCall(toolCall("bad", "tool", { value: undefined }))).toThrow(
      "non-JSON value",
    );
    expect(
      convertCall({ ...toolCall("ns", "tool", {}), namespace: "foreign" } as ToolCall),
    ).toThrow("namespace");
    expect(
      convertCall(
        { ...toolCall("sig", "tool", {}), thoughtSignature: "opaque" },
        true,
      )(),
    ).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "sig",
            toolName: "tool",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "sig",
            toolName: "tool",
            output: {
              type: "text",
              value:
                "No result — the tool call did not complete (interrupted or lost).",
            },
          },
        ],
      },
    ]);
  });

  it("drops redacted thinking while preserving the other assistant content", () => {
    for (const sameTarget of [true, false]) {
      const converted = requestMessages({
        messages: [
          {
            role: "assistant",
            api: sameTarget ? model.api : "luckytoken-client-history",
            provider: sameTarget ? model.provider : "luckytoken-client",
            model: sameTarget ? model.id : "client-model",
            content: [
              {
                type: "thinking",
                thinking: "",
                thinkingSignature: "redacted-payload",
                redacted: true,
              },
              { type: "text", text: "answer" },
            ],
            usage,
            stopReason: "stop",
            timestamp: 1,
          },
        ],
      });
      expect(converted).toEqual([
        {
          role: "assistant",
          content: [{ type: "text", text: "answer" }],
        },
      ]);
    }
  });

  it("drops ToolResult images while preserving text and correlation", () => {
    const messages = requestMessages({
      messages: [
        {
          role: "assistant",
          api: "luckytoken-client-history",
          provider: "luckytoken-client",
          model: "client-model",
          content: [toolCall("mixed", "inspect", {}), toolCall("image", "see", {})],
          usage,
          stopReason: "toolUse",
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "mixed",
          toolName: "inspect",
          content: [
            { type: "text", text: "before" },
            { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
            { type: "text", text: "after" },
          ],
          isError: false,
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "image",
          toolName: "see",
          content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
          isError: false,
          timestamp: 3,
        },
      ],
    });

    expect(messages.slice(1)).toEqual([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "mixed",
            toolName: "inspect",
            output: { type: "text", value: "before\nafter" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "image",
            toolName: "see",
            output: { type: "text", value: "" },
          },
        ],
      },
    ]);
  });

  it("uses the Provider request policy for synthetic result output type", () => {
    const messages = requestMessages(
      {
        messages: [
          {
            role: "assistant",
            api: "luckytoken-client-history",
            provider: "luckytoken-client",
            model: "client-model",
            content: [toolCall("lost", "lookup", {})],
            usage,
            stopReason: "toolUse",
            timestamp: 1,
          },
        ],
      },
      "error-text",
    );

    expect(messages[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "lost",
          toolName: "lookup",
          output: {
            type: "error-text",
            value: "No result — the tool call did not complete (interrupted or lost).",
          },
        },
      ],
    });
  });

  it("records missing-result repair as a non-model-visible Provider notice", () => {
    const built = buildCommandCodeBody(
      model,
      {
        messages: [
          {
            role: "assistant",
            api: "luckytoken-client-history",
            provider: "luckytoken-client",
            model: "client-model",
            content: [toolCall("lost", "lookup", {})],
            usage,
            stopReason: "toolUse",
            timestamp: 1,
          },
        ],
      },
      {},
      createEmptyServerConfig(),
      "00000000-0000-4000-8000-000000000021",
      {},
    );

    expect(built.notices).toEqual([
      {
        adapter: "commandcode-private",
        direction: "request",
        code: "missing_tool_result_xrepair",
        jsonPath: "$.messages",
        action: "xrepair",
      },
    ]);
    expect(JSON.stringify(built.body)).not.toContain("missing_tool_result_xrepair");
  });

  it("drops opaque assistant signatures without changing content order", () => {
    const messages = requestMessages({
      messages: [
        {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: [
            { type: "text", text: "first", textSignature: "opaque-text" },
            {
              type: "thinking",
              thinking: "reason",
              thinkingSignature: "opaque-thinking",
            },
            { ...toolCall("signed", "tool", { value: 1 }), thoughtSignature: "opaque-tool" },
          ],
          usage,
          stopReason: "toolUse",
          timestamp: 1,
        },
      ],
    });

    expect(messages[0]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "first" },
        { type: "reasoning", text: "reason" },
        {
          type: "tool-call",
          toolCallId: "signed",
          toolName: "tool",
          input: { value: 1 },
        },
      ],
    });
  });

  it("rejects a real ToolResult without its required tool name", () => {
    expect(() =>
      requestMessages({
        messages: [
          {
            role: "assistant",
            api: "luckytoken-client-history",
            provider: "luckytoken-client",
            model: "client-model",
            content: [toolCall("call", "tool", {})],
            usage,
            stopReason: "toolUse",
            timestamp: 1,
          },
          {
            role: "toolResult",
            toolCallId: "call",
            toolName: "",
            content: [{ type: "text", text: "result" }],
            isError: false,
            timestamp: 2,
          },
        ],
      }),
    ).toThrow("toolName must be non-empty");
  });
});
