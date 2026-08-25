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
    );

    expect(snapshot).toEqual({
      input: 5,
      cacheRead: 3,
      output: 4,
      terminalClass: "done",
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
    );

    expect(snapshot).toMatchObject({
      input: 5,
      cacheRead: 3,
      output: 4,
      terminalClass: "done",
    });
  });

  it("returns no fact when a successful terminal omits usage", () => {
    const snapshot = extractResponsesPassthroughUsage(
      new TextEncoder().encode(JSON.stringify(responseObject(undefined))),
      "application/json",
    );

    expect(snapshot).toBeUndefined();
  });

  it("does not claim complete usage when required terminal components are missing", () => {
    const snapshot = extractResponsesPassthroughUsage(
      new TextEncoder().encode(
        JSON.stringify(
          responseObject({ input_tokens: 10, output_tokens: 4 }),
        ),
      ),
      "application/json",
    );

    expect(snapshot).toEqual({
      input: 10,
      cacheRead: 0,
      output: 4,
      terminalClass: "done",
    });
  });
});
