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

    expect(invocation.options).toEqual({
      maxTokens: 32,
      temperature: 0,
      samplingParams: { top_p: 0.5, top_k: 3 },
      metadata: { user_id: "exact-user" },
      reasoning: "high",
    });
    expect(invocation.renderState).toEqual({
      stream: true,
      selector: "model",
    });
    expect(invocation.options).not.toHaveProperty("stream");
  });

  it("preserves omission without materializing option containers", () => {
    const invocation = convertValidatedAnthropicRequest(
      validateAnthropicSourceRequest(request()),
      1,
    );

    expect(invocation.options).toEqual({ maxTokens: 32 });
    expect(invocation.renderState.stream).toBe(false);
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
    { name: "thinking enabled", extras: { thinking: { type: "enabled", budget_tokens: 4096 } }, expected: { thinkingBudgets: { low: 4096 } } },
    { name: "thinking disabled", extras: { thinking: { type: "disabled" } }, expected: {} },
    { name: "thinking adaptive", extras: { thinking: { type: "adaptive" } }, expected: {} },
    { name: "stop sequences", extras: { stop_sequences: ["stop"] }, expected: {} },
    { name: "metadata extension", extras: { metadata: { other: "value" } }, expected: {} },
    { name: "unknown output field", extras: { output_config: { format: "text" } }, expected: {} },
    { name: "future top-level field", extras: { future_control: true }, expected: {} },
  ])("handles unconverted or mapped fields: $name", ({ extras, expected }) => {
    const invocation = convertValidatedAnthropicRequest(
      validateAnthropicSourceRequest(request(extras)),
      1,
    );
    expect(invocation.options).toEqual({ maxTokens: 32, ...expected });
  });

  it("falls back to Pi reasoning default for an unknown effort", () => {
    const invocation = convertValidatedAnthropicRequest(
      validateAnthropicSourceRequest(
        request({ output_config: { effort: "super" } }),
      ),
      1,
    );
    expect(invocation.options.reasoning).toBeUndefined();
  });

  it("rejects a non-string output_config.effort as malformed", () => {
    expect(() =>
      validateAnthropicSourceRequest(
        request({ output_config: { effort: 123 } }),
      ),
    ).toThrow(InvalidRequest);
  });
});
