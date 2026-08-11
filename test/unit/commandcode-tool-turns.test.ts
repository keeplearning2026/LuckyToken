import type { Context, Model, ToolCall, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  commandCodePrivateApiId,
  commandCodePrivateProviderId,
  convertCommandCodeMessages,
} from "../../src/providers/commandcode-private/provider.js";

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

describe("CommandCode Pi tool-turn conversion", () => {
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

    expect(convertCommandCodeMessages(model, context)).toEqual([
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
            toolName: "",
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
            toolName: "",
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
            toolName: "",
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

  it("rejects duplicate call IDs and correlates results by toolCallId only", () => {
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
      convertCommandCodeMessages(model, { messages: [assistant] }),
    ).toThrow("Duplicate Pi ToolCall id");

    assistant.content = [toolCall("same", "alpha", {})];
    const converted = convertCommandCodeMessages(model, {
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
          toolName: "",
          output: { type: "text", value: "ok" },
        },
      ],
    });
  });

  it("rejects non-lossless arguments, namespaces, and required opaque continuity", () => {
    const convertCall = (call: ToolCall, sameTarget = false): (() => unknown) => () =>
      convertCommandCodeMessages(model, {
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
      ),
    ).toThrow("continuity");
  });

  it("rejects redacted thinking regardless of target identity", () => {
    const convertThinking = (sameTarget: boolean): (() => unknown) => () =>
      convertCommandCodeMessages(model, {
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

    expect(convertThinking(true)).toThrow("redacted");
    expect(convertThinking(false)).toThrow("redacted");
  });
});
