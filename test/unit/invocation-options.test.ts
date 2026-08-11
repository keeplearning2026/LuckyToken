import { describe, expect, it } from "vitest";

import { InvalidRequest, UnsupportedFeature } from "../../src/protocols/anthropic/failures.js";
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
        }),
      ),
      1,
    );

    expect(invocation.options).toEqual({
      maxTokens: 32,
      temperature: 0,
      metadata: { user_id: "exact-user" },
      reasoning: "high",
    });
    expect(invocation.renderState).toEqual({
      stream: true,
      clientModel: "model",
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
    ["metadata escape hatch", { metadata: { other: "value" } }, UnsupportedFeature],
    ["top p", { top_p: 0.5 }, UnsupportedFeature],
    ["top k", { top_k: 1 }, UnsupportedFeature],
    ["stop sequences", { stop_sequences: ["stop"] }, UnsupportedFeature],
    ["thinking", { thinking: { type: "enabled" } }, UnsupportedFeature],
    ["unknown output effort", { output_config: { effort: "super" } }, UnsupportedFeature],
    ["unknown output field", { output_config: { format: "text" } }, UnsupportedFeature],
  ])("rejects unsupported or malformed control: %s", (_name, extras, failure) => {
    expect(() => validateAnthropicSourceRequest(request(extras))).toThrow(failure);
  });
});
