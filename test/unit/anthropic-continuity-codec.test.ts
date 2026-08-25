import { describe, expect, it } from "vitest";

import {
  decodeAnthropicContinuity,
  encodeAnthropicContinuity,
} from "../../src/protocols/anthropic/semantic/reasoning/continuity.js";
import { parseAnthropicTextInvocation } from "../../src/protocols/anthropic/request.js";

const source = {
  provider: "google",
  api: "google-generative-ai",
  model: "gemini-3-pro",
} as const;

describe("Anthropic item-local continuity codec", () => {
  it("round-trips a text signature without making it model-visible", () => {
    const envelope = encodeAnthropicContinuity({
      source,
      attachments: [
        { target: "text", kind: "opaque-signature", value: "opaque-text" },
      ],
    });
    const decoded = decodeAnthropicContinuity({
      value: envelope,
      owner: { target: "text" },
      jsonPath: "$.messages[0].content[0].token_continuity",
    });
    expect(decoded).toMatchObject({ source, attachments: [{ value: "opaque-text" }] });
    expect(JSON.stringify(decoded.attachments)).not.toContain("visible text");
  });

  it("keeps a tool signature attached to the owning call ID", () => {
    const decoded = decodeAnthropicContinuity({
      value: {
        version: 1,
        source,
        attachments: [
          {
            target: "toolCall",
            callId: "call-1",
            kind: "opaque-reasoning-state",
            value: "opaque-tool-state",
          },
        ],
      },
      owner: { target: "toolCall", callId: "call-1" },
      jsonPath: "$.messages[0].content[0].token_continuity",
    });
    expect(decoded.attachments).toHaveLength(1);
    expect(decoded.notices).toHaveLength(0);
  });

  it("ignores duplicate, misplaced, malformed, and unknown-version state with notices", () => {
    const duplicate = {
      target: "text",
      kind: "opaque-signature",
      value: "opaque-text",
    } as const;
    const decoded = decodeAnthropicContinuity({
      value: {
        version: 1,
        source,
        attachments: [
          duplicate,
          duplicate,
          { target: "toolCall", callId: "wrong", kind: "opaque-signature", value: "x" },
          { target: "text", kind: "opaque-signature", value: "", extra: true },
        ],
      },
      owner: { target: "text" },
      jsonPath: "$.messages[0].content[0].token_continuity",
    });
    expect(decoded.attachments).toEqual([duplicate]);
    expect(decoded.notices).toHaveLength(3);

    const unknown = decodeAnthropicContinuity({
      value: { version: 2, source, attachments: [] },
      owner: { target: "text" },
      jsonPath: "$.content[0].token_continuity",
    });
    expect(unknown.attachments).toEqual([]);
    expect(unknown.notices).toHaveLength(1);
  });

  it("requires native-field provenance to accompany a native thinking value", () => {
    const value = {
      version: 1,
      source: { provider: "anthropic", api: "anthropic-messages", model: "claude" },
      attachments: [{ target: "thinking", kind: "native-field-provenance" }],
    };
    expect(
      decodeAnthropicContinuity({
        value,
        owner: { target: "thinking", representation: "thinking", hasNativeValue: false },
        jsonPath: "$.content[0].token_continuity",
      }).attachments,
    ).toEqual([]);
  });

  it("does not count supplement-only assistant blocks when locating Pi continuity", () => {
    const converted = parseAnthropicTextInvocation(
      {
        model: "client-model",
        max_tokens: 2_048,
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "server_tool_use",
                id: "srv-1",
                name: "web_search",
                input: { query: "Token" },
              },
              {
                type: "thinking",
                thinking: "summary",
                signature: "native-signature",
                token_continuity: {
                  version: 1,
                  source,
                  attachments: [
                    { target: "thinking", kind: "opaque-signature", value: "foreign-state" },
                  ],
                },
              },
            ],
          },
          { role: "user", content: "continue" },
        ],
      },
      1,
    );

    expect(converted.invocation.pi.context.messages[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "thinking", thinking: "summary" }],
    });
    expect(converted.invocation.reasoning.history).toContainEqual(
      expect.objectContaining({ piMessageIndex: 0, piContentIndex: 0 }),
    );
    expect(converted.invocation.reasoning.continuity).toContainEqual(
      expect.objectContaining({ piMessageIndex: 0, piContentIndex: 0 }),
    );
  });

  it("resolves item-local continuity to the exact Pi history attachment", () => {
    const converted = parseAnthropicTextInvocation(
      {
        model: "client-model",
        max_tokens: 2_048,
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: "summary",
                signature: "native-signature",
                token_continuity: {
                  version: 1,
                  source: {
                    provider: "anthropic",
                    api: "anthropic-messages",
                    model: "claude-source",
                  },
                  attachments: [
                    { target: "thinking", kind: "native-field-provenance" },
                  ],
                },
              },
              {
                type: "text",
                text: "answer",
                token_continuity: {
                  version: 1,
                  source,
                  attachments: [
                    { target: "text", kind: "opaque-signature", value: "text-state" },
                  ],
                },
              },
            ],
          },
          { role: "user", content: "continue" },
        ],
      },
      1,
    );
    expect(converted.invocation.reasoning.history).toEqual([
      expect.objectContaining({
        piMessageIndex: 0,
        piContentIndex: 0,
        representation: "thinking",
      }),
    ]);
    expect(converted.invocation.reasoning.continuity).toEqual([
      expect.objectContaining({ target: "thinking", piMessageIndex: 0, piContentIndex: 0 }),
      expect.objectContaining({ target: "text", piMessageIndex: 0, piContentIndex: 1 }),
    ]);
  });
});
