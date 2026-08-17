import { describe, expect, it } from "vitest";

import { extractResponsesPassthroughUsage } from "../../src/protocols/openai-responses/passthrough-usage.js";

function responseObject(usage: unknown): Record<string, unknown> {
  return {
    id: "resp_1",
    object: "response",
    status: "completed",
    model: "model",
    output: [],
    usage,
  };
}

const usage = {
  input_tokens: 10,
  input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
  output_tokens: 4,
  output_tokens_details: { reasoning_tokens: 1 },
  total_tokens: 14,
};

describe("Responses passthrough terminal usage extraction", () => {
  it("normalizes a JSON Responses terminal with OpenAI cache partition semantics", () => {
    const snapshot = extractResponsesPassthroughUsage(
      new TextEncoder().encode(JSON.stringify(responseObject(usage))),
      "application/json",
      "openai-codex-responses",
    );

    expect(snapshot).toEqual({
      api: "openai-codex-responses",
      input: 5,
      cacheRead: 3,
      cacheWrite: 2,
      output: 4,
      reasoning: 1,
      normalizedTotal: 14,
      cacheHitRate: 0.3,
      completeness: "complete",
      evidence: "responses-terminal-usage-v1",
    });
  });

  it("uses the last full Response carrying usage in an SSE stream", () => {
    const early = responseObject({
      input_tokens: 2,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 2,
    });
    const terminal = responseObject(usage);
    const sse = [
      "event: response.created",
      `data: ${JSON.stringify(early)}`,
      "",
      "event: response.output_text.delta",
      'data: {"delta":"hello"}',
      "",
      "event: response.completed",
      `data: ${JSON.stringify(terminal)}`,
      "",
      "",
    ].join("\n");

    const snapshot = extractResponsesPassthroughUsage(
      new TextEncoder().encode(sse),
      "text/event-stream",
      "openai-responses",
    );

    expect(snapshot).toMatchObject({
      api: "openai-responses",
      completeness: "complete",
      input: 5,
      cacheRead: 3,
      cacheWrite: 2,
      output: 4,
      reasoning: 1,
      normalizedTotal: 14,
    });
  });

  it("records a truthful partial snapshot when a successful terminal omits usage", () => {
    const snapshot = extractResponsesPassthroughUsage(
      new TextEncoder().encode(JSON.stringify(responseObject(undefined))),
      "application/json",
      "openai-responses",
    );

    expect(snapshot).toEqual({
      api: "openai-responses",
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      completeness: "partial",
      reason: "usage_absent",
      evidence: "responses-terminal-usage-v1",
    });
  });

  it("does not claim complete usage when required terminal components are missing", () => {
    const snapshot = extractResponsesPassthroughUsage(
      new TextEncoder().encode(
        JSON.stringify(
          responseObject({ input_tokens: 10, output_tokens: 4 }),
        ),
      ),
      "application/json",
      "openai-responses",
    );

    expect(snapshot).toMatchObject({
      completeness: "partial",
      reason: "component_unreported",
      input: 10,
      output: 4,
    });
    expect(snapshot?.normalizedTotal).toBeUndefined();
  });
});
