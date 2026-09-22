import type { Context, Model } from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { describe, expect, it } from "vitest";

import {
  PiContextCompatibilityError,
  preparePiContextForModel,
} from "../../src/pi-context-compatibility.js";

function toolAssistant(ids: readonly string[], timestamp = 1): Context["messages"][number] {
  return {
    role: "assistant",
    content: ids.map((id) => ({ type: "toolCall" as const, id, name: `tool_${id}`, arguments: {} })),
    api: "test",
    provider: "test",
    model: "model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp,
  };
}

function toolResult(id: string, timestamp: number): Context["messages"][number] {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: `tool_${id}`,
    content: [{ type: "text", text: `result_${id}` }],
    isError: false,
    timestamp,
  };
}

function model(supportsMidConvoSystemMessages?: boolean): Model<"openai-responses"> {
  return {
    id: "model",
    name: "model",
    api: "openai-responses",
    provider: "test-provider",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
    ...(supportsMidConvoSystemMessages === undefined
      ? {}
      : { compat: { supportsMidConvoSystemMessages } }),
  };
}

describe("Pi Context compatibility", () => {
  it("preserves the exact Context when the resolved model supports mid-conversation system messages", () => {
    const context: Context = {
      systemPrompt: "root",
      messages: [
        { role: "user", content: "before", timestamp: 1 },
        { role: "system", content: "later", timestamp: 2 },
        { role: "user", content: "after", timestamp: 3 },
      ],
    };

    const prepared = preparePiContextForModel(model(true), context);

    expect(prepared.context).toBe(context);
    expect(prepared.context.messages).toBe(context.messages);
    expect(prepared.outcomes).toEqual([]);
  });

  it("preserves supported complex mid-system state exactly for Pi to handle", () => {
    const context: Context = {
      messages: [
        { role: "user", content: "before", timestamp: 1 },
        {
          role: "system",
          content: "later",
          sections: { policy: "new" },
          toolsAdded: [{ name: "lookup", description: "lookup", parameters: { type: "object" } }],
          toolsRemoved: [{ name: "old_tool" }],
          timestamp: 2,
        },
      ],
    };

    const prepared = preparePiContextForModel(model(true), context);

    expect(prepared.context).toBe(context);
    expect(prepared.context.messages).toBe(context.messages);
    expect(prepared.outcomes).toEqual([]);
  });

  it("does not validate an unresolved tool span when the model supports mid-system directly", () => {
    const context: Context = {
      messages: [
        toolAssistant(["x"], 1),
        { role: "system", content: "later", timestamp: 2 },
      ],
    };

    const prepared = preparePiContextForModel(model(true), context);

    expect(prepared.context).toBe(context);
    expect(prepared.context.messages).toBe(context.messages);
    expect(prepared.outcomes).toEqual([]);
  });

  it("keeps leading system messages and preserves Context identity when no repair is needed", () => {
    const context: Context = {
      systemPrompt: "root",
      messages: [
        { role: "system", content: "leading-a", timestamp: 1 },
        { role: "system", content: "leading-b", timestamp: 2 },
        { role: "user", content: "after", timestamp: 3 },
      ],
    };

    const prepared = preparePiContextForModel(model(false), context);

    expect(prepared.context).toBe(context);
    expect(prepared.context.messages).toBe(context.messages);
    expect(prepared.outcomes).toEqual([]);
  });

  it("treats an undefined capability as unsupported and degrades every mid-system independently", () => {
    const context: Context = {
      systemPrompt: "root",
      messages: [
        { role: "system", content: "leading", timestamp: 1 },
        { role: "user", content: "u1", timestamp: 2 },
        { role: "system", content: "s1", timestamp: 3 },
        { role: "assistant", content: [], api: "test", provider: "test", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 4 },
        { role: "system", content: "s2", timestamp: 5 },
      ],
    };

    const prepared = preparePiContextForModel(model(), context);

    expect(prepared.context.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "user",
      "assistant",
      "user",
    ]);
    expect(prepared.outcomes).toEqual([
      { code: "pi_mid_system_degraded_to_user", messageIndex: 2 },
      { code: "pi_mid_system_degraded_to_user", messageIndex: 4 },
    ]);
  });

  it("relocates a degradable mid-system after the tool exchange instead of breaking call/result pairing", () => {
    const context: Context = {
      messages: [
        toolAssistant(["x"], 1),
        { role: "system", content: "later", timestamp: 2 },
        toolResult("x", 3),
        { role: "user", content: "continue", timestamp: 4 },
      ],
    };

    const prepared = preparePiContextForModel(model(false), context);

    expect(prepared.context.messages.map((message) => message.role)).toEqual([
      "assistant",
      "toolResult",
      "user",
      "user",
    ]);
    expect(prepared.context.messages[2]).toEqual({
      role: "user",
      content: "later",
      timestamp: 2,
    });
    expect(prepared.outcomes).toEqual([
      { code: "pi_mid_system_degraded_to_user", messageIndex: 1 },
    ]);
  });

  it("prevents Pi from synthesizing a duplicate missing tool result after relocation", () => {
    const context: Context = {
      messages: [
        toolAssistant(["x"], 1),
        { role: "system", content: "later", timestamp: 2 },
        toolResult("x", 3),
      ],
    };
    const target = model(false);
    const prepared = preparePiContextForModel(target, context);

    const transformed = transformMessages([...prepared.context.messages], target);
    const results = transformed.filter(
      (message) => message.role === "toolResult" && message.toolCallId === "x",
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ isError: false });
    expect(
      results.some(
        (message) =>
          message.role === "toolResult" &&
          message.content.some(
            (block) => block.type === "text" && block.text === "No result provided",
          ),
      ),
    ).toBe(false);
    expect(transformed.map((message) => message.role)).toEqual([
      "assistant",
      "toolResult",
      "user",
    ]);
  });

  it("waits for every call in the current exchange and preserves deferred system order", () => {
    const context: Context = {
      messages: [
        toolAssistant(["a", "b"], 1),
        { role: "system", content: "s1", timestamp: 2 },
        toolResult("a", 3),
        { role: "system", content: "s2", timestamp: 4 },
        toolResult("b", 5),
      ],
    };

    const prepared = preparePiContextForModel(model(false), context);

    expect(prepared.context.messages.map((message) => message.role)).toEqual([
      "assistant",
      "toolResult",
      "toolResult",
      "user",
      "user",
    ]);
    expect(prepared.context.messages.slice(3)).toEqual([
      { role: "user", content: "s1", timestamp: 2 },
      { role: "user", content: "s2", timestamp: 4 },
    ]);
  });

  it("fails only because relocation cannot be proven closed before end of input", () => {
    const context: Context = {
      messages: [
        toolAssistant(["x"], 1),
        { role: "system", content: "later", timestamp: 2 },
      ],
    };

    expect(() => preparePiContextForModel(model(false), context)).toThrow(
      /relocation.*tool exchange.*not complete/iu,
    );
  });

  it("fails relocation when a user or assistant boundary arrives before the exchange closes", () => {
    for (const boundary of [
      { role: "user" as const, content: "interrupt", timestamp: 3 },
      toolAssistant([], 3),
    ]) {
      const context: Context = {
        messages: [
          toolAssistant(["x"], 1),
          { role: "system", content: "later", timestamp: 2 },
          boundary,
          toolResult("x", 4),
        ],
      };

      expect(() => preparePiContextForModel(model(false), context)).toThrow(
        PiContextCompatibilityError,
      );
    }
  });

  it("degrades an unsupported mid-conversation system message to a user message in the same position", () => {
    const content = [{ type: "text" as const, text: "later" }];
    const before = { role: "user" as const, content: "before", timestamp: 1 };
    const after = { role: "user" as const, content: "after", timestamp: 3 };
    const context: Context = {
      systemPrompt: "root",
      messages: [
        before,
        { role: "system", content, timestamp: 2 },
        after,
      ],
    };

    const prepared = preparePiContextForModel(model(false), context);

    expect(prepared.context).not.toBe(context);
    expect(prepared.context.systemPrompt).toBe("root");
    expect(prepared.context.messages).toEqual([
      before,
      { role: "user", content, timestamp: 2 },
      after,
    ]);
    expect(prepared.context.messages[0]).toBe(before);
    expect(prepared.context.messages[2]).toBe(after);
    expect(prepared.outcomes).toEqual([
      { code: "pi_mid_system_degraded_to_user", messageIndex: 1 },
    ]);
  });
});
