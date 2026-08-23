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
      samplingParams: { top_p: 0.5, top_k: 3 },
      metadata: { user_id: "exact-user" },
      reasoning: "high",
    });
    expect(invocation.client.renderState).toEqual({
      stream: true,
      selector: "model",
    });
    expect(invocation.invocation.pi.options).not.toHaveProperty("stream");
  });

  it("preserves omission without materializing option containers", () => {
    const invocation = convertValidatedAnthropicRequest(
      validateAnthropicSourceRequest(request()),
      1,
    );

    expect(invocation.invocation.pi.options).toEqual({ maxTokens: 32 });
    expect(invocation.client.renderState.stream).toBe(false);
  });

  it.each([
    ["temperature string", { temperature: "0.5" }, InvalidRequest],
    ["metadata user id number", { metadata: { user_id: 1 } }, InvalidRequest],
  ])("rejects unsupported or malformed control: %s", (_name, extras, failure) => {
    expect(() => validateAnthropicSourceRequest(request(extras))).toThrow(failure);
  });

  it.each([
    { name: "top p", extras: { top_p: 0.5 }, expected: { samplingParams: { top_p: 0.5 } } },
    { name: "top k", extras: { top_k: 1 }, expected: { samplingParams: { top_k: 1 } } },
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

  it("rejects an unknown effort instead of changing it to Provider default", () => {
    expect(() =>
      validateAnthropicSourceRequest(
        request({ output_config: { effort: "super" } }),
      ),
    ).toThrow(InvalidRequest);
  });

  it("rejects a malformed known output format instead of ignoring it", () => {
    expect(() =>
      validateAnthropicSourceRequest(
        request({ output_config: { format: "text" } }),
      ),
    ).toThrow(InvalidRequest);
  });

  it("rejects a non-string output_config.effort as malformed", () => {
    expect(() =>
      validateAnthropicSourceRequest(
        request({ output_config: { effort: 123 } }),
      ),
    ).toThrow(InvalidRequest);
  });
});
