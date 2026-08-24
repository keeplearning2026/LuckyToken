import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  convertAssistantMessageToAnthropicWithPolicy,
  OutboundResponseFidelityFailure,
  type AnthropicResponseConversionPolicy,
} from "../../src/protocols/anthropic/response.js";

function usage(overrides: Partial<Usage> = {}): Usage {
  return {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 3,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...overrides,
  };
}

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    api: "anthropic-messages",
    provider: "internal-provider",
    model: "internal-model",
    usage: usage(),
    stopReason: "stop",
    timestamp: 1,
    ...overrides,
  };
}

function policy(
  overrides: Partial<AnthropicResponseConversionPolicy> = {},
): AnthropicResponseConversionPolicy {
  return { unknownPiContent: "error", ...overrides };
}

describe("09: Pi-to-Anthropic response projection", () => {
  it("uses a valid responseId and falls back to generated identity", () => {
    const withId = convertAssistantMessageToAnthropicWithPolicy(
      message({ responseId: "msg_valid_1" }),
      { selector: "client-selector" },
      policy(),
    );
    expect(withId.message.id).toBe("msg_valid_1");

    const generated = convertAssistantMessageToAnthropicWithPolicy(
      message(),
      { selector: "client-selector", createMessageId: () => "msg_generated" },
      policy(),
    );
    expect(generated.message.id).toBe("msg_generated");

    const fallback = convertAssistantMessageToAnthropicWithPolicy(
      message(),
      { selector: "client-selector" },
      policy(),
    );
    expect(fallback.message.id).toMatch(/^msg_[A-Za-z0-9-]+$/u);
  });

  it("always echoes the client selector and never leaks responseModel", () => {
    const result = convertAssistantMessageToAnthropicWithPolicy(
      message({ responseModel: "provider-model-x", responseId: "msg_1" }),
      { selector: "client-selector" },
      policy(),
    );
    expect(result.message.model).toBe("client-selector");
    expect(JSON.stringify(result.message)).not.toContain("provider-model-x");
  });

  it("renders an unknown Pi Provider from retained AssistantMessage semantics without a response certification registry", () => {
    const result = convertAssistantMessageToAnthropicWithPolicy(
      message({
        api: "custom-pi-api",
        provider: "custom-provider",
        model: "custom-model",
        rawStopReason: "provider-specific-success",
        stopReason: "stop",
        content: [{ type: "text", text: "portable result" }],
      }),
      { selector: "client-selector" },
      policy(),
    );

    expect(result.message).toMatchObject({
      content: [{ type: "text", text: "portable result" }],
      stop_reason: "end_turn",
    });
    expect(result.notices).toContainEqual(expect.objectContaining({
      code: "anthropic_stop_reason_normalized",
      action: "degrade",
    }));
  });

  it("preserves text exactly and ordinary thinking with signature", () => {
    const result = convertAssistantMessageToAnthropicWithPolicy(
      message({
        content: [
          { type: "text", text: "A" },
          {
            type: "thinking",
            thinking: "reasoning",
            thinkingSignature: "sig",
          },
        ],
      }),
      { selector: "client-selector" },
      policy(),
    );
    expect(result.message.content).toMatchObject([
      { citations: null, text: "A", type: "text" },
      { signature: "sig", thinking: "reasoning", type: "thinking" },
    ]);
    expect(result.notices.some(
      (notice) => notice.code === "anthropic_missing_thinking_signature",
    )).toBe(false);
  });

  it("treats thinking.display omitted as a Client response rendering rule", () => {
    const result = convertAssistantMessageToAnthropicWithPolicy(
      message({
        content: [
          {
            type: "thinking",
            thinking: "must not be displayed",
            thinkingSignature: "sig",
          },
        ],
      }),
      {
        selector: "client-selector",
        thinkingDisplay: { kind: "specified", value: "omitted" },
      },
      policy(),
    );

    expect(result.message.content).toMatchObject([
      { signature: "sig", thinking: "", type: "thinking" },
    ]);
  });

  it("synthesizes an empty signature with a notice when ordinary thinking lacks one", () => {
    const result = convertAssistantMessageToAnthropicWithPolicy(
      message({
        content: [{ type: "thinking", thinking: "unsigned" }],
      }),
      { selector: "client-selector" },
      policy(),
    );
    expect(result.message.content).toMatchObject([
      { signature: "", thinking: "unsigned", type: "thinking" },
    ]);
    expect(
      result.notices.some(
        (notice) =>
          notice.code === "anthropic_missing_thinking_signature" &&
          notice.action === "degrade",
      ),
    ).toBe(true);
  });

  it("maps redacted thinking to redacted_thinking and requires opaque data", () => {
    const result = convertAssistantMessageToAnthropicWithPolicy(
      message({
        content: [
          {
            type: "thinking",
            thinking: "",
            thinkingSignature: "opaque-payload",
            redacted: true,
          },
        ],
      }),
      { selector: "client-selector" },
      policy(),
    );
    expect(result.message.content).toMatchObject([
      { data: "opaque-payload", type: "redacted_thinking" },
    ]);

    expect(() =>
      convertAssistantMessageToAnthropicWithPolicy(
        message({
          content: [
            { type: "thinking", thinking: "", redacted: true },
          ],
        }),
        { selector: "client-selector" },
        policy(),
      ),
    ).toThrow(OutboundResponseFidelityFailure);
  });

  it("maps an ordinary Pi toolCall to Anthropic's direct caller", () => {
    const renderState = {
      selector: "client-selector",
      directToolNames: ["tool"],
    };
    const result = convertAssistantMessageToAnthropicWithPolicy(
        message({
          api: "openai-completions",
          provider: "opencode-go",
          model: "deepseek-v4-flash",
          rawStopReason: "tool_use",
          stopReason: "toolUse",
          content: [
            { type: "toolCall", id: "call", name: "tool", arguments: {} },
          ],
        }),
        renderState,
        policy(),
      );
    expect(result.message.content).toMatchObject([
      { type: "tool_use", caller: { type: "direct" } },
    ]);
  });

  it("does not fabricate direct caller provenance for an unrecognized tool call", () => {
    const renderState = {
      selector: "client-selector",
      directToolNames: [] as string[],
    };
    expect(() =>
      convertAssistantMessageToAnthropicWithPolicy(
        message({
          rawStopReason: "tool_use",
          stopReason: "toolUse",
          content: [
            { type: "toolCall", id: "call", name: "server-owned", arguments: {} },
          ],
        }),
        renderState,
        policy(),
      ),
    ).toThrow(/caller provenance is unavailable/iu);
  });

  it("preserves a committed refusal terminal without relabeling it as success", () => {
    const result = convertAssistantMessageToAnthropicWithPolicy(
      message({
        rawStopReason: "refusal",
        stopReason: "stop",
        content: [{ type: "text", text: "I cannot help with that." }],
      }),
      { selector: "client-selector" },
      policy(),
    );

    expect(result.message.stop_reason).toBe("refusal");
    expect(result.message.stop_details).toBeNull();
    expect(result.notices).toContainEqual(expect.objectContaining({
      code: "anthropic_provider_response_field_unavailable",
      jsonPath: "$.stop_details",
      action: "degrade",
    }));
  });

  it("preserves empty projected content without inventing a text block", () => {
    const result = convertAssistantMessageToAnthropicWithPolicy(
      message({ content: [] }),
      { selector: "client-selector" },
      policy(),
    );
    expect(result.message.content).toEqual([]);
    expect(result.message.stop_reason).toBe("end_turn");
  });

  it("maps usage including thinking and cache breakdown", () => {
    const result = convertAssistantMessageToAnthropicWithPolicy(
      message({
        usage: usage({
          input: 10,
          output: 20,
          cacheRead: 3,
          cacheWrite: 5,
          cacheWrite1h: 2,
          reasoning: 7,
        }),
      }),
      { selector: "client-selector" },
      policy(),
    );
    expect(result.message.usage).toEqual({
      cache_creation: {
        ephemeral_1h_input_tokens: 2,
        ephemeral_5m_input_tokens: 3,
      },
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 3,
      inference_geo: null,
      input_tokens: 10,
      output_tokens: 20,
      output_tokens_details: { thinking_tokens: 7 },
      server_tool_use: null,
      service_tier: null,
    });
  });

  it("keeps length authoritative over toolCall content", () => {
    const result = convertAssistantMessageToAnthropicWithPolicy(
      message({
        api: "openai-completions",
        provider: "opencode-go",
        model: "deepseek-v4-flash",
        stopReason: "length",
        content: [
          { type: "toolCall", id: "call", name: "tool", arguments: {} },
        ],
      }),
      { selector: "client-selector", directToolNames: ["tool"] },
      policy(),
    );
    expect(result.message.stop_reason).toBe("max_tokens");
    expect(result.notices.some(
      (notice) => notice.code === "anthropic_stop_reason_normalized",
    )).toBe(true);
  });

  it("emits a non-model-visible notice when stop reason is normalized", () => {
    const result = convertAssistantMessageToAnthropicWithPolicy(
      message({
        api: "openai-completions",
        provider: "opencode-go",
        model: "deepseek-v4-flash",
        stopReason: "stop",
        content: [
          { type: "toolCall", id: "call", name: "tool", arguments: {} },
        ],
      }),
      { selector: "client-selector", directToolNames: ["tool"] },
      policy(),
    );
    expect(result.message.stop_reason).toBe("tool_use");
    expect(
      result.notices.some(
        (notice) => notice.code === "anthropic_stop_reason_normalized",
      ),
    ).toBe(true);
  });

  it("handles unknown Pi content with error/ignore policy", () => {
    expect(() =>
      convertAssistantMessageToAnthropicWithPolicy(
        message({
          content: [
            { type: "future_content", payload: 1 },
          ] as unknown as AssistantMessage["content"],
        }),
        { selector: "client-selector" },
        policy(),
      ),
    ).toThrow(/Unsupported Pi assistant content/u);

    const ignored = convertAssistantMessageToAnthropicWithPolicy(
      message({
        content: [
          { type: "future_content", payload: 1 },
        ] as unknown as AssistantMessage["content"],
      }),
      { selector: "client-selector" },
      policy({ unknownPiContent: "ignore" }),
    );
    expect(ignored.message.content).toEqual([]);
    expect(
      ignored.notices.some(
        (notice) => notice.code === "anthropic_unknown_pi_content_ignored",
      ),
    ).toBe(true);
  });

  it("rejects non-committed Pi stop reasons instead of fabricating success", () => {
    for (const stopReason of ["pending", "error", "aborted", "deferred"]) {
      expect(() =>
        convertAssistantMessageToAnthropicWithPolicy(
          message({ stopReason: stopReason as AssistantMessage["stopReason"] }),
          { selector: "client-selector" },
          policy(),
        ),
      ).toThrow(OutboundResponseFidelityFailure);
    }
  });

  it("never maps an unknown future stop reason to a successful terminal", () => {
    expect(() =>
      convertAssistantMessageToAnthropicWithPolicy(
        message({
          stopReason: "future-reason" as AssistantMessage["stopReason"],
        }),
        { selector: "client-selector" },
        policy({ unknownPiContent: "ignore" }),
      ),
    ).toThrow(OutboundResponseFidelityFailure);
  });
});
