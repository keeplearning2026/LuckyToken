import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { convertAssistantMessageToAnthropicWithPolicy } from "../../src/protocols/anthropic/response.js";

function message(
  api: string,
  options: {
    readonly provider?: string;
    readonly model?: string;
    readonly includeTool?: boolean;
  } = {},
): AssistantMessage {
  const includeTool = options.includeTool ?? true;
  const provider = options.provider ??
    (api === "openai-completions"
      ? "opencode-go"
      : api === "commandcode-private"
        ? "commandcode-private"
        : api === "anthropic-messages"
          ? "anthropic"
          : "provider");
  const model = options.model ??
    (api === "openai-completions"
      ? "deepseek-v4-flash"
      : api === "commandcode-private"
        ? "deepseek/deepseek-v4-flash"
        : api === "anthropic-messages"
          ? "claude"
          : "model");
  return {
    role: "assistant",
    api,
    provider,
    model,
    content: [
      { type: "thinking", thinking: "summary", thinkingSignature: "thinking-state" },
      { type: "text", text: "answer" },
      ...(includeTool
        ? [{
            type: "toolCall" as const,
            id: "call-1",
            name: "lookup",
            arguments: {},
            thoughtSignature: "tool-state",
          }]
        : []),
    ],
    usage: {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: includeTool ? "toolUse" : "stop",
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

describe("Anthropic response continuity rendering", () => {
  it("keeps certified foreign signatures only in the owning extension envelope", () => {
    const converted = convert(message("openai-completions"));

    expect(converted.message.content[0]).toMatchObject({
      type: "thinking",
      thinking: "summary",
      signature: "",
      token_continuity: {
        source: { api: "openai-completions", model: "deepseek-v4-flash" },
        attachments: [{ target: "thinking", value: "thinking-state" }],
      },
    });
    expect(converted.message.content[1]).toEqual({
      citations: null,
      text: "answer",
      type: "text",
    });
    expect(converted.message.content[2]).toMatchObject({
      type: "tool_use",
      id: "call-1",
      caller: { type: "direct" },
      token_continuity: {
        attachments: [{ target: "toolCall", callId: "call-1", value: "tool-state" }],
      },
    });
    expect(JSON.stringify(converted.message.content)).not.toContain(
      '\"signature\":\"thinking-state\"',
    );
  });

  it("uses the standard signature plus provenance for real Anthropic thinking", () => {
    const converted = convert(message("anthropic-messages", { includeTool: false }));
    expect(converted.message.content[0]).toMatchObject({
      type: "thinking",
      signature: "thinking-state",
      token_continuity: {
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
    "pi-messages",
  ])(
    "keeps certified %s thinking state in the foreign continuity envelope",
    (api) => {
      const converted = convert(message(api));
      expect(converted.message.content[0]).toMatchObject({
        type: "thinking",
        signature: "",
        token_continuity: {
          source: { api },
          attachments: [{ target: "thinking", value: "thinking-state" }],
        },
      });
    },
  );

  it("keeps certified Bedrock Claude reasoning state in the foreign continuity envelope", () => {
    const converted = convert(message("bedrock-converse-stream", {
      provider: "amazon-bedrock",
      model: "us.anthropic.claude-sonnet-4-6",
    }));
    expect(converted.message.content[0]).toMatchObject({
      type: "thinking",
      signature: "",
      token_continuity: {
        source: {
          provider: "amazon-bedrock",
          api: "bedrock-converse-stream",
          model: "us.anthropic.claude-sonnet-4-6",
        },
        attachments: [{ target: "thinking", value: "thinking-state" }],
      },
    });
  });

  it.each([
    "commandcode-private",
    "mistral-conversations",
  ])("rejects %s continuity claims until its pinned Pi parser is certified", (api) => {
    expect(() => convert(message(api))).toThrow(/not certified/iu);
  });

  it("rejects Bedrock continuity for an uncertified model family", () => {
    expect(() => convert(message("bedrock-converse-stream", {
      provider: "amazon-bedrock",
      model: "amazon.nova-pro-v1:0",
    }))).toThrow(/not certified/iu);
  });
});
