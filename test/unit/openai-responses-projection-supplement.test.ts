import { describe, expect, it } from "vitest";

import { convertResponsesRequest } from "../../src/protocols/openai-responses/request.js";

describe("OpenAI Responses Provider projection supplement", () => {
  it("captures only request controls with a certified Provider projection", () => {
    const result = convertResponsesRequest(
      {
        model: "client-selector",
        input: "hello",
        max_output_tokens: 512,
        temperature: 0.4,
        top_p: 0.8,
        text: {
          format: {
            type: "json_schema",
            name: "answer",
            description: "Structured answer",
            schema: { type: "object", properties: { answer: { type: "string" } } },
            strict: true,
          },
          verbosity: "high",
        },
        parallel_tool_calls: false,
        tool_choice: { type: "function", name: "lookup" },
        tools: [
          {
            type: "function",
            name: "lookup",
            description: "Lookup",
            parameters: { type: "object", properties: {} },
          },
        ],
        include: ["reasoning.encrypted_content"],
        top_logprobs: 3,
        prompt_cache_key: "cache-key",
        prompt_cache_retention: "24h",
        safety_identifier: "safe-user",
        user: "deprecated-user",
        service_tier: "priority",
        truncation: "disabled",
        background: false,
        store: false,
        context_management: [{ type: "compaction", compact_threshold: 1_000 }],
        stream_options: { include_obfuscation: false },
      },
      1,
    );

    expect(result.invocation.supplement).toMatchObject({
      output: {
        format: {
          value: { type: "json_schema", name: "answer", strict: true },
        },
        verbosity: { value: "high" },
        include: { value: ["reasoning.encrypted_content"] },
      },
      tools: {
        parallelCalls: { value: false },
        choice: {
          value: { kind: "named", toolType: "function", name: "lookup" },
        },
      },
      sampling: {
        maxOutputTokens: { value: 512 },
        temperature: { value: 0.4 },
        topP: { value: 0.8 },
      },
      cache: {
        key: { value: "cache-key" },
        retention: { value: "24h" },
      },
      identity: {
        safetyIdentifier: { value: "safe-user" },
        deprecatedUser: { value: "deprecated-user" },
      },
      lifecycle: {
        serviceTier: { value: "priority" },
        truncation: { value: "disabled" },
      },
    });
    expect(result.client.notices.map((notice) => notice.code)).toEqual(
      expect.arrayContaining([
        "openai-responses_top_logprobs_omitted",
        "openai-responses_context_management_omitted",
        "openai-responses_stream_options_omitted",
      ]),
    );
  });

  it("emits an empty immutable supplement when no extra controls are present", () => {
    const result = convertResponsesRequest(
      { model: "client-selector", input: "hello" },
      1,
    );

    expect(result.invocation.supplement).toEqual({});
    expect(Object.isFrozen(result.invocation.supplement)).toBe(true);
  });

  it("deep-freezes nested supplement values", () => {
    const result = convertResponsesRequest(
      {
        model: "client-selector",
        input: "hello",
        text: {
          format: {
            type: "json_schema",
            name: "answer",
            schema: {
              type: "object",
              properties: { answer: { type: "string" } },
            },
          },
        },
      },
      1,
    );

    const schema = result.invocation.supplement.output?.format?.value;
    expect(schema?.type).toBe("json_schema");
    if (schema?.type !== "json_schema") throw new Error("expected schema");
    expect(Object.isFrozen(schema.schema)).toBe(true);
    expect(Object.isFrozen(schema.schema.properties)).toBe(true);
  });

  it("accepts current SDK null absence and in_memory cache spelling", () => {
    const result = convertResponsesRequest(
      {
        model: "client-selector",
        instructions: "answer",
        conversation: null,
        prompt: null,
        prompt_cache_retention: "in_memory",
      },
      1,
    );

    expect(result.invocation.pi.context.systemPrompt).toBe("answer");
    expect(result.invocation.pi.options.cacheRetention).toBe("short");
    expect(result.invocation.supplement.cache?.retention?.value).toBe("in_memory");
  });

  it("parses the current allowed_tools tool-choice shape and preserves required mode", () => {
    const result = convertResponsesRequest(
      {
        model: "client-selector",
        input: "hello",
        tools: [
          {
            type: "function",
            name: "lookup",
            description: "Lookup",
            parameters: { type: "object", properties: {} },
          },
        ],
        tool_choice: {
          type: "allowed_tools",
          mode: "required",
          tools: [{ type: "function", name: "lookup" }],
        },
      },
      1,
    );

    expect(result.invocation.supplement.tools?.choice?.value).toEqual({
      kind: "allowed",
      mode: "required",
      tools: [{ toolType: "function", name: "lookup" }],
    });
    expect(result.client.renderState.toolChoice).toBe("required");
  });
});
