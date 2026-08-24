import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  convertAssistantMessageToAnthropicWithPolicy,
  OutboundResponseFidelityFailure,
} from "../../src/protocols/anthropic/response.js";

function message(input: {
  api: string;
  provider?: string;
  model?: string;
  rawStopReason?: string;
  stopReason?: AssistantMessage["stopReason"];
  tool?: boolean;
}): AssistantMessage {
  const provider = input.provider ??
    (input.api === "openai-completions"
      ? "opencode-go"
      : input.api === "commandcode-private"
        ? "commandcode-private"
        : "provider");
  const model = input.model ??
    (input.api === "openai-completions"
      ? "deepseek-v4-flash"
      : input.api === "commandcode-private"
        ? "deepseek/deepseek-v4-flash"
        : "model");
  return {
    role: "assistant",
    api: input.api,
    provider,
    model,
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
    {
      selector: "client-model",
      createMessageId: () => "msg-1",
      directToolNames: ["lookup"],
    },
    { unknownPiContent: "error" },
  );
}

describe("target-aware Anthropic response interpretation", () => {
  it.each([
    ["anthropic-messages", "end_turn", "stop", "end_turn"],
    ["anthropic-messages", "max_tokens", "length", "max_tokens"],
    ["openai-completions", "length", "length", "max_tokens"],
    ["commandcode-private", "length", "length", "max_tokens"],
  ] as const)("maps %s raw terminal %s", (api, rawStopReason, stopReason, expected) => {
    expect(convert(message({ api, rawStopReason, stopReason })).message.stop_reason).toBe(expected);
  });

  it.each([
    "openai-responses",
    "azure-openai-responses",
    "openai-codex-responses",
    "google-generative-ai",
    "google-vertex",
    "mistral-conversations",
    "bedrock-converse-stream",
  ])("renders %s from portable Pi AssistantMessage semantics", (api) => {
    expect(convert(message({ api })).message.stop_reason).toBe("end_turn");
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

  it("falls back from native Anthropic stop_sequence when Pi discarded only the optional matched sequence", () => {
    const converted = convert(message({
      api: "anthropic-messages",
      rawStopReason: "stop_sequence",
      stopReason: "stop",
    }));
    expect(converted.message.stop_reason).toBe("end_turn");
    expect(converted.notices).toContainEqual(expect.objectContaining({
      code: "anthropic_stop_reason_normalized",
    }));
  });

  it("still fails pause_turn because the next-turn continuation state is critical", () => {
    expect(() => convert(message({
      api: "anthropic-messages",
      rawStopReason: "pause_turn",
      stopReason: "stop",
    }))).toThrow(OutboundResponseFidelityFailure);
  });

  it("uses the retained Pi terminal for an unknown optional raw terminal and warns", () => {
    const converted = convert(message({
      api: "openai-completions",
      rawStopReason: "future_reason",
      stopReason: "stop",
    }));
    expect(converted.message.stop_reason).toBe("end_turn");
    expect(converted.notices).toContainEqual(expect.objectContaining({
      code: "anthropic_stop_reason_normalized",
    }));
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
