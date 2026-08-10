import { describe, expect, it } from "vitest";

import { UnsupportedFeature } from "../../src/protocols/anthropic/failures.js";
import {
  convertValidatedAnthropicRequest,
  SYNTHETIC_CLIENT_HISTORY_API,
  SYNTHETIC_CLIENT_HISTORY_PROVIDER,
  validateAnthropicSourceRequest,
} from "../../src/protocols/anthropic/request.js";

describe("Anthropic conversation conversion", () => {
  it("preserves system omission and the exact supported system forms", () => {
    const omitted = convertValidatedAnthropicRequest(
      validateAnthropicSourceRequest({
        model: "client-model",
        max_tokens: 32,
        messages: [{ role: "user", content: "hello" }],
      }),
      100,
    );
    expect(omitted.context).not.toHaveProperty("systemPrompt");

    const stringSystem = convertValidatedAnthropicRequest(
      validateAnthropicSourceRequest({
        model: "client-model",
        max_tokens: 32,
        system: " exact\t\n",
        messages: [{ role: "user", content: "hello" }],
      }),
      100,
    );
    expect(stringSystem.context.systemPrompt).toBe(" exact\t\n");

    const blockSystem = convertValidatedAnthropicRequest(
      validateAnthropicSourceRequest({
        model: "client-model",
        max_tokens: 32,
        system: [{ type: "text", text: "" }],
        messages: [{ role: "user", content: "hello" }],
      }),
      100,
    );
    expect(blockSystem.context.systemPrompt).toBe("");

    expect(() =>
      validateAnthropicSourceRequest({
        model: "client-model",
        max_tokens: 32,
        system: [
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ],
        messages: [{ role: "user", content: "hello" }],
      }),
    ).toThrow(UnsupportedFeature);
  });

  it("preserves exact text and coalesces only adjacent same-role turns", () => {
    const receivedAt = 1_786_400_000_123;
    const conversion = convertValidatedAnthropicRequest(
      validateAnthropicSourceRequest({
        model: "client-model",
        max_tokens: 32,
        messages: [
          { role: "user", content: "" },
          {
            role: "user",
            content: [
              { type: "text", text: " \t" },
              { type: "text", text: "\r\n" },
            ],
          },
          { role: "assistant", content: "first" },
          {
            role: "assistant",
            content: [{ type: "text", text: "second" }],
          },
          { role: "user", content: "tail" },
        ],
      }),
      receivedAt,
    );

    expect(conversion.context.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "" },
          { type: "text", text: " \t" },
          { type: "text", text: "\r\n" },
        ],
        timestamp: receivedAt,
      },
      {
        role: "assistant",
        api: SYNTHETIC_CLIENT_HISTORY_API,
        provider: SYNTHETIC_CLIENT_HISTORY_PROVIDER,
        model: "client-model",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: receivedAt,
      },
      {
        role: "user",
        content: [{ type: "text", text: "tail" }],
        timestamp: receivedAt,
      },
    ]);
  });

  it("preserves supported base64 image MIME and payload and rejects opaque/remote variants", () => {
    const conversion = convertValidatedAnthropicRequest(
      validateAnthropicSourceRequest({
        model: "client-model",
        max_tokens: 32,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "iVBORw0KGgo=",
                },
              },
            ],
          },
        ],
      }),
      100,
    );
    expect(conversion.context.messages[0]).toMatchObject({
      role: "user",
      content: [
        { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
      ],
    });

    expect(() =>
      validateAnthropicSourceRequest({
        model: "client-model",
        max_tokens: 32,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "url", url: "https://example.test/a.png" } },
            ],
          },
        ],
      }),
    ).toThrow(UnsupportedFeature);
    expect(() =>
      validateAnthropicSourceRequest({
        model: "client-model",
        max_tokens: 32,
        messages: [
          {
            role: "assistant",
            content: [{ type: "thinking", thinking: "opaque", signature: "secret" }],
          },
          { role: "user", content: "tail" },
        ],
      }),
    ).toThrow(UnsupportedFeature);
  });
});
