import { describe, expect, it } from "vitest";

import { InvalidRequest } from "../../src/protocols/anthropic/failures.js";
import {
  convertValidatedAnthropicRequest,
  validateAnthropicSourceRequest,
} from "../../src/protocols/anthropic/request.js";

function request(extras: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "model",
    max_tokens: 32,
    messages: [{ role: "user", content: "hello" }],
    ...extras,
  };
}

describe("Anthropic Pi invocation controls", () => {
  it("maps exact present controls and keeps stream render-only", () => {
    const invocation = convertValidatedAnthropicRequest(
      validateAnthropicSourceRequest(
        request({
          temperature: 0,
          stream: true,
          metadata: { user_id: "exact-user" },
          output_config: { effort: "high" },
          top_p: 0.5,
          top_k: 3,
        }),
      ),
      1,
    );

    expect(invocation.invocation.pi.options).toEqual({
      maxTokens: 32,
      temperature: 0,
    });
    expect(invocation.invocation.reasoning.effort).toEqual({
      kind: "specified",
      level: "high",
    });
    expect(invocation.client.renderState).toEqual({
      stream: true,
      selector: "model",
      directToolNames: [],
      thinkingDisplay: { kind: "omitted" },
    });
    expect(invocation.invocation.pi.options).not.toHaveProperty("stream");
    expect(invocation.client.notices).toEqual(expect.arrayContaining([
      expect.objectContaining({ jsonPath: "$.metadata", action: "ignore" }),
      expect.objectContaining({ jsonPath: "$.top_p", action: "ignore" }),
      expect.objectContaining({ jsonPath: "$.top_k", action: "ignore" }),
    ]));
  });

  it("preserves omission without materializing option containers", () => {
    const invocation = convertValidatedAnthropicRequest(
      validateAnthropicSourceRequest(request()),
      1,
    );

    expect(invocation.invocation.pi.options).toEqual({ maxTokens: 32 });
    expect(invocation.client.renderState.stream).toBe(false);
  });

  it("rejects a malformed consumed temperature", () => {
    expect(() =>
      validateAnthropicSourceRequest(request({ temperature: "0.5" })),
    ).toThrow(InvalidRequest);
  });

  it("leaves malformed unconsumed metadata unread and warns", () => {
    const invocation = convertValidatedAnthropicRequest(
      validateAnthropicSourceRequest(request({ metadata: { user_id: 1 } })),
      1,
    );
    expect(invocation.client.notices).toContainEqual(
      expect.objectContaining({ jsonPath: "$.metadata", action: "ignore" }),
    );
  });

  it.each([
    { name: "top p", extras: { top_p: 0.5 }, expected: {} },
    { name: "top k", extras: { top_k: 1 }, expected: {} },
    { name: "thinking disabled", extras: { thinking: { type: "disabled" } }, expected: {} },
    { name: "thinking adaptive", extras: { thinking: { type: "adaptive" } }, expected: {} },
    { name: "stop sequences", extras: { stop_sequences: ["stop"] }, expected: {} },
    { name: "metadata extension", extras: { metadata: { other: "value" } }, expected: {} },
    { name: "future top-level field", extras: { future_control: true }, expected: {} },
  ])("handles unconverted or mapped fields: $name", ({ extras, expected }) => {
    const invocation = convertValidatedAnthropicRequest(
      validateAnthropicSourceRequest(request(extras)),
      1,
    );
    expect(invocation.invocation.pi.options).toEqual({ maxTokens: 32, ...expected });
  });

  it("normalizes an unknown effort to max without rejecting the request", () => {
    const invocation = convertValidatedAnthropicRequest(
      validateAnthropicSourceRequest(
        request({ output_config: { effort: "super" } }),
      ),
      1,
    );

    expect(invocation.invocation.pi.options).not.toHaveProperty("reasoning");
    expect(invocation.invocation.reasoning.effort).toEqual({
      kind: "specified",
      level: "max",
      normalizedFromUnknown: "super",
    });
    expect(invocation.client.notices).toContainEqual(
      expect.objectContaining({
        code: "anthropic_unknown_effort_fallback",
        action: "degrade",
      }),
    );
  });

  it("does not validate an unconsumed output format and warns", () => {
    const invocation = convertValidatedAnthropicRequest(
      validateAnthropicSourceRequest(
        request({ output_config: { format: "text" } }),
      ),
      1,
    );
    expect(invocation.client.notices).toContainEqual(
      expect.objectContaining({
        jsonPath: "$.output_config.format",
        action: "ignore",
      }),
    );
  });

  it("rejects a non-string output_config.effort as malformed", () => {
    expect(() =>
      validateAnthropicSourceRequest(
        request({ output_config: { effort: 123 } }),
      ),
    ).toThrow(InvalidRequest);
  });
});
