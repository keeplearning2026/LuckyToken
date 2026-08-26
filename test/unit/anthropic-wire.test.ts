import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  convertAssistantMessageToAnthropic,
  convertAssistantMessageToAnthropicResponse,
} from "../../src/protocols/anthropic/response.js";
import {
  renderAnthropicError,
  renderAnthropicJsonSuccess,
} from "../../src/protocols/anthropic/wire.js";

function message(): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "opencode-go",
    model: "deepseek-v4-flash",
    content: [
      { type: "text", text: "first \ud800" },
      { type: "toolCall", id: "call", name: "tool", arguments: { x: 1 } },
    ],
    usage: {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 1,
  };
}

describe("Anthropic atomic wire rendering", () => {
  it("schema-validates and UTF-8 serializes the exact constructed target", () => {
    const target = convertAssistantMessageToAnthropic(
      message(),
      "client-model",
      "msg_client",
      ["tool"],
    );
    const rendered = renderAnthropicJsonSuccess(target);

    expect(rendered).toMatchObject({
      status: 200,
      contentType: "application/json",
    });
    expect(new TextDecoder("utf-8", { fatal: true }).decode(rendered.body)).toBe(
      JSON.stringify(target),
    );
  });

  it("freezes the converted target so post-conversion mutation cannot reach the wire", () => {
    const target = convertAssistantMessageToAnthropic(
      message(),
      "client-model",
      "msg_client",
      ["tool"],
    );
    expect(() => {
      const later = target.content[1] as unknown as {
        input: Record<string, unknown>;
      };
      later.input = {
        unsafe: {
          toJSON: () => ({ silently: "repaired" }),
        },
      };
    }).toThrow();
    expect(Object.isFrozen(target.content)).toBe(true);
  });

  it("rejects non-lossless tool arguments at conversion time", () => {
    const unsafe = {
      toJSON: () => ({ silently: "repaired" }),
    };
    const source: AssistantMessage = {
      role: "assistant",
      api: "openai-completions",
      provider: "opencode-go",
      model: "deepseek-v4-flash",
      content: [
        {
          type: "toolCall",
          id: "call",
          name: "tool",
          arguments: { unsafe },
        },
      ],
      usage: {
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 3,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 1,
    };
    const converted = convertAssistantMessageToAnthropicResponse(
      source,
      {
        selector: "client-model",
        createMessageId: () => "msg_client",
        directToolNames: ["tool"],
      },
    );
    expect(converted.message.content).toEqual([]);
    expect(converted.message.stop_reason).toBe("end_turn");
    expect(converted.notices).toContainEqual(expect.objectContaining({
      code: "anthropic_response_block_omitted",
    }));
  });

  it("renders documented error families as complete UTF-8 JSON", () => {
    const rendered = renderAnthropicError(
      404,
      "not_found_error",
      "Model was not found",
    );

    expect(rendered.contentType).toBe("application/json");
    expect(JSON.parse(new TextDecoder().decode(rendered.body))).toEqual({
      type: "error",
      error: { type: "not_found_error", message: "Model was not found" },
    });
  });
});
