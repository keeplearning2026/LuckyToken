import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  convertAssistantMessageToAnthropicWithPolicy,
  OutboundResponseFidelityFailure,
} from "../../src/protocols/anthropic/response.js";

function message(input: {
  api: string;
  rawStopReason?: string;
  stopReason?: AssistantMessage["stopReason"];
  tool?: boolean;
}): AssistantMessage {
  return {
    role: "assistant",
    api: input.api,
    provider: "provider",
    model: "model",
    content: input.tool
      ? [{ type: "toolCall", id: "call-1", name: "lookup", arguments: {} }]
      : [{ type: "text", text: "answer" }],
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: input.stopReason ?? "stop",
    ...(input.rawStopReason === undefined ? {} : { rawStopReason: input.rawStopReason }),
    timestamp: 1,
  };
}

function convert(value: AssistantMessage) {
  return convertAssistantMessageToAnthropicWithPolicy(
    value,
    { selector: "client-model", createMessageId: () => "msg-1" },
    { unknownPiContent: "error" },
  );
}

describe("target-aware Anthropic response interpretation", () => {
  it.each([
    ["anthropic-messages", "end_turn", "stop", "end_turn"],
    ["anthropic-messages", "max_tokens", "length", "max_tokens"],
    ["openai-completions", "length", "length", "max_tokens"],
    ["mistral-conversations", "model_length", "length", "max_tokens"],
    ["google-generative-ai", "MAX_TOKENS", "length", "max_tokens"],
    ["google-vertex", "STOP", "stop", "end_turn"],
    ["openai-responses", "incomplete.max_output_tokens", "length", "max_tokens"],
    ["azure-openai-responses", "completed", "stop", "end_turn"],
    ["openai-codex-responses", "completed", "stop", "end_turn"],
    ["bedrock-converse-stream", "max_tokens", "length", "max_tokens"],
    ["commandcode-private", "length", "length", "max_tokens"],
  ] as const)("maps %s raw terminal %s", (api, rawStopReason, stopReason, expected) => {
    expect(convert(message({ api, rawStopReason, stopReason })).message.stop_reason).toBe(expected);
  });

  it("uses tool_use only when the committed content contains a valid tool call", () => {
    expect(convert(message({
      api: "openai-completions",
      rawStopReason: "tool_calls",
      stopReason: "toolUse",
      tool: true,
    })).message.stop_reason).toBe("tool_use");
    expect(() => convert(message({
      api: "openai-completions",
      rawStopReason: "tool_calls",
      stopReason: "toolUse",
    }))).toThrow(OutboundResponseFidelityFailure);
  });

  it.each(["stop_sequence", "pause_turn"])(
    "fails native Anthropic %s because Pi discarded its required detail or continuation state",
    (rawStopReason) => {
      expect(() => convert(message({
        api: "anthropic-messages",
        rawStopReason,
        stopReason: "stop",
      }))).toThrow(OutboundResponseFidelityFailure);
    },
  );

  it("fails an unknown raw terminal instead of fabricating end_turn", () => {
    expect(() => convert(message({
      api: "bedrock-converse-stream",
      rawStopReason: "future_reason",
      stopReason: "stop",
    }))).toThrow(OutboundResponseFidelityFailure);
  });

  it("warns when an actual Anthropic response field is unavailable after Pi parsing", () => {
    const converted = convert(message({
      api: "anthropic-messages",
      rawStopReason: "end_turn",
    }));
    expect(converted.notices).toContainEqual(expect.objectContaining({
      code: "anthropic_provider_response_field_unavailable",
      jsonPath: "$.content[0].citations",
    }));
  });
});
