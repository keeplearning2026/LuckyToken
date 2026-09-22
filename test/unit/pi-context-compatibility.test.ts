import type { Context, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  PiContextCompatibilityError,
  preparePiContextForModel,
} from "../../src/pi-context-compatibility.js";

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

  it("rejects a complex mid-conversation system message even when the model supports mid-system text", () => {
    const context: Context = {
      messages: [
        { role: "user", content: "before", timestamp: 1 },
        {
          role: "system",
          content: "later",
          sections: { policy: "new" },
          timestamp: 2,
        },
      ],
    };

    expect(() => preparePiContextForModel(model(true), context)).toThrow(
      PiContextCompatibilityError,
    );
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
