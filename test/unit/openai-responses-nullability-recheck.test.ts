import { describe, expect, it } from "vitest";

import {
  convertResponsesRequest,
  type ResponseRequestConversionPolicy,
} from "../../src/protocols/openai-responses/request.js";

function policy(): ResponseRequestConversionPolicy {
  return {
    privilegedMessages: "first",
    unknownInputItem: "error",
    orphanToolOutput: "error",
    unresolvedToolCall: "xrepair",
    futureReasoningEffort: "max",
  };
}

describe("13 recheck: null means absence per frozen contract", () => {
  it("accepts reasoning: null and reasoning.effort: null as omission", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", reasoning: null },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.options.reasoning).toBeUndefined();
    const effortNull = convertResponsesRequest(
      { model: "m", input: "x", reasoning: { effort: null } },
      1,
      policy(),
    );
    expect(effortNull.invocation.pi.options.reasoning).toBeUndefined();
  });

  it("accepts temperature: null and top_p: null as target-default absence", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", temperature: null, top_p: null },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.options.temperature).toBeUndefined();
    expect(invocation.invocation.pi.options.samplingParams).toBeUndefined();
  });

  it("accepts instructions: null as absence", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", instructions: null },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.context.systemPrompt).toBeUndefined();
  });

  it("accepts safety_identifier: null and user: null as absence", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", safety_identifier: null, user: null },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.options.metadata).toBeUndefined();
  });

  it("accepts stream: null as false", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", stream: null },
      1,
      policy(),
    );
    expect(invocation.client.renderState.stream).toBe(false);
  });

  it("still rejects wrong non-null types", () => {
    expect(() =>
      convertResponsesRequest(
        { model: "m", input: "x", temperature: "hot" },
        1,
        policy(),
      ),
    ).toThrow(/temperature/);
    expect(() =>
      convertResponsesRequest(
        { model: "m", input: "x", stream: "yes" },
        1,
        policy(),
      ),
    ).toThrow(/stream/);
  });
});

describe("13 recheck: max_output_tokens and prompt_cache_retention nullability", () => {
  it("accepts max_output_tokens: null as absence", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", max_output_tokens: null },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.options.maxTokens).toBeUndefined();
  });

  it("accepts prompt_cache_retention: null as absence (already covered)", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", prompt_cache_retention: null },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.options.cacheRetention).toBeUndefined();
  });
});

describe("13 recheck: store nullability", () => {
  it("accepts store: null as absence (normal storage policy)", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", store: null },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.options).toBeDefined();
  });
});

describe("13 recheck: previous_response_id nullability", () => {
  it("accepts previous_response_id: null as absence", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", previous_response_id: null },
      1,
      policy(),
    );
    expect(invocation.selector).toBe("m");
  });

  it("accepts background: null as synchronous absence", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", background: null },
      1,
      policy(),
    );
    expect(invocation.client.renderState.stream).toBe(false);
  });

  it("accepts tool_choice: null as auto", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: "x",
        tools: [{ type: "function", name: "a", parameters: { type: "object" } }],
        tool_choice: null,
      },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.context.tools?.map((t) => t.name)).toEqual(["a"]);
  });
});

describe("13 recheck: max_output_tokens must be positive", () => {
  it("rejects max_output_tokens: 0 as a client invalid request", () => {
    expect(() =>
      convertResponsesRequest(
        { model: "m", input: "x", max_output_tokens: 0 },
        1,
        policy(),
      ),
    ).toThrow(/max_output_tokens/);
  });

  it("rejects negative max_output_tokens", () => {
    expect(() =>
      convertResponsesRequest(
        { model: "m", input: "x", max_output_tokens: -1 },
        1,
        policy(),
      ),
    ).toThrow(/max_output_tokens/);
  });

  it("accepts a positive max_output_tokens", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", max_output_tokens: 512 },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.options.maxTokens).toBe(512);
  });
});
