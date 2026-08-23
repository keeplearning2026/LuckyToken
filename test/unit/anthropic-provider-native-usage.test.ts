import { describe, expect, it } from "vitest";

import { extractAnthropicNativeTerminalUsage } from "../../src/provider-native-anthropic/usage.js";

const encoder = new TextEncoder();

function sse(...events: readonly unknown[]): Uint8Array {
  return encoder.encode(
    events
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(""),
  );
}

const messageStart = {
  type: "message_start",
  message: {
    usage: {
      input_tokens: 5,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
      output_tokens: 1,
    },
  },
} as const;

describe("Anthropic Provider Native terminal usage extraction", () => {
  it("merges only reported stream usage after a terminal message_stop", () => {
    const usage = extractAnthropicNativeTerminalUsage(
      sse(
        messageStart,
        {
          type: "message_delta",
          usage: {
            output_tokens: 7,
            output_tokens_details: { thinking_tokens: 2 },
          },
        },
        { type: "message_stop" },
      ),
      "text/event-stream; charset=utf-8",
    );

    expect(usage).toEqual({
      api: "anthropic-messages",
      input: 5,
      cacheRead: 3,
      cacheWrite: 2,
      output: 7,
      reasoning: 2,
      normalizedTotal: 17,
      cacheHitRate: 3 / 10,
      completeness: "complete",
      evidence: "anthropic-provider-native-terminal-usage-v1",
    });
  });

  it("does not construct Complete usage from a non-terminal stream", () => {
    expect(
      extractAnthropicNativeTerminalUsage(
        sse(messageStart, {
          type: "message_delta",
          usage: { output_tokens: 7 },
        }),
        "text/event-stream",
      ),
    ).toBeUndefined();
  });

  it("does not invent missing cache components or reasoning", () => {
    const completeWithoutReasoning = extractAnthropicNativeTerminalUsage(
      sse(messageStart, {
        type: "message_stop",
      }),
      "text/event-stream",
    );
    expect(completeWithoutReasoning).toMatchObject({
      completeness: "complete",
      input: 5,
      cacheRead: 3,
      cacheWrite: 2,
      output: 1,
    });
    expect(completeWithoutReasoning).not.toHaveProperty("reasoning");

    expect(
      extractAnthropicNativeTerminalUsage(
        sse(
          {
            type: "message_start",
            message: {
              usage: {
                input_tokens: 5,
                cache_read_input_tokens: 3,
                output_tokens: 1,
              },
            },
          },
          { type: "message_stop" },
        ),
        "text/event-stream",
      ),
    ).toBeUndefined();
  });

  it("rejects malformed reported components instead of repairing them", () => {
    expect(
      extractAnthropicNativeTerminalUsage(
        sse(
          messageStart,
          {
            type: "message_delta",
            usage: { output_tokens: "7" },
          },
          { type: "message_stop" },
        ),
        "text/event-stream",
      ),
    ).toBeUndefined();
  });
});
