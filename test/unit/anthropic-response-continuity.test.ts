import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { convertAssistantMessageToAnthropicWithPolicy } from "../../src/protocols/anthropic/response.js";

function message(
  api: string,
  overrides: Partial<Pick<AssistantMessage, "provider" | "model">> = {},
): AssistantMessage {
  return {
    role: "assistant",
    api,
    provider: overrides.provider ?? (api === "anthropic-messages" ? "anthropic" : "provider"),
    model: overrides.model ?? (
      api === "anthropic-messages"
        ? "claude"
        : api === "google-generative-ai"
          ? "gemini"
          : "model"
    ),
    content: [
      { type: "thinking", thinking: "summary", thinkingSignature: "thinking-state" },
      { type: "text", text: "answer", textSignature: "text-state" },
      {
        type: "toolCall",
        id: "call-1",
        name: "lookup",
        arguments: {},
        thoughtSignature: "tool-state",
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
}

describe("Anthropic response continuity rendering", () => {
  it("keeps foreign signatures only in the owning extension envelope", () => {
    const converted = convertAssistantMessageToAnthropicWithPolicy(
      message("google-generative-ai"),
      { selector: "client-model", createMessageId: () => "msg-1" },
      { unknownPiContent: "error" },
    );
    expect(converted.message.content[0]).toMatchObject({
      type: "thinking",
      thinking: "summary",
      signature: "",
      luckytoken_continuity: {
        source: { api: "google-generative-ai", model: "gemini" },
        attachments: [{ target: "thinking", value: "thinking-state" }],
      },
    });
    expect(converted.message.content[1]).toMatchObject({
      type: "text",
      text: "answer",
      luckytoken_continuity: {
        attachments: [{ target: "text", value: "text-state" }],
      },
    });
    expect(converted.message.content[2]).toMatchObject({
      type: "tool_use",
      id: "call-1",
      luckytoken_continuity: {
        attachments: [{ target: "toolCall", callId: "call-1", value: "tool-state" }],
      },
    });
    expect(JSON.stringify(converted.message.content)).not.toContain(
      '"signature":"thinking-state"',
    );
  });

  it("uses the standard signature plus provenance for native Anthropic thinking", () => {
    const converted = convertAssistantMessageToAnthropicWithPolicy(
      message("anthropic-messages"),
      { selector: "client-model", createMessageId: () => "msg-1" },
      { unknownPiContent: "error" },
    );
    expect(converted.message.content[0]).toMatchObject({
      type: "thinking",
      signature: "thinking-state",
      luckytoken_continuity: {
        attachments: [{ target: "thinking", kind: "native-field-provenance" }],
      },
    });
  });

  it("uses the standard Anthropic signature for a certified Bedrock Claude source", () => {
    const converted = convertAssistantMessageToAnthropicWithPolicy(
      message("bedrock-converse-stream", {
        provider: "amazon-bedrock",
        model: "us.anthropic.claude-sonnet-4-20250514-v1:0",
      }),
      { selector: "client-model", createMessageId: () => "msg-1" },
      { unknownPiContent: "error" },
    );
    expect(converted.message.content[0]).toMatchObject({
      type: "thinking",
      signature: "thinking-state",
      luckytoken_continuity: {
        attachments: [{ target: "thinking", kind: "native-field-provenance" }],
      },
    });
  });

  it.each([
    "openai-completions",
    "openai-responses",
    "azure-openai-responses",
    "openai-codex-responses",
    "google-generative-ai",
    "google-vertex",
    "mistral-conversations",
    "pi-messages",
    "commandcode-private",
  ])("keeps %s thinking state in the foreign continuity envelope", (api) => {
    const converted = convertAssistantMessageToAnthropicWithPolicy(
      message(api),
      { selector: "client-model", createMessageId: () => "msg-1" },
      { unknownPiContent: "error" },
    );
    expect(converted.message.content[0]).toMatchObject({
      type: "thinking",
      signature: "",
      luckytoken_continuity: {
        source: { api },
        attachments: [{ target: "thinking", value: "thinking-state" }],
      },
    });
  });

  it("does not mislabel a non-Claude Bedrock signature as native Anthropic state", () => {
    const converted = convertAssistantMessageToAnthropicWithPolicy(
      message("bedrock-converse-stream", {
        provider: "amazon-bedrock",
        model: "amazon.nova-pro-v1:0",
      }),
      { selector: "client-model", createMessageId: () => "msg-1" },
      { unknownPiContent: "error" },
    );
    expect(converted.message.content[0]).toMatchObject({
      signature: "",
      luckytoken_continuity: {
        attachments: [{ kind: "opaque-signature", value: "thinking-state" }],
      },
    });
  });
});
