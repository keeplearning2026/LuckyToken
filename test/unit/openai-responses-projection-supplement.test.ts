import { describe, expect, it } from "vitest";

import { convertResponsesRequest } from "../../src/protocols/openai-responses/request.js";

describe("OpenAI Responses complete projection supplement", () => {
  it("captures every recognized Pi-unrepresentable request control before target resolution", () => {
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
          requirement: "hard",
          value: { type: "json_schema", name: "answer", strict: true },
        },
        verbosity: { requirement: "preference", value: "high" },
        include: {
          requirement: "preference",
          value: ["reasoning.encrypted_content"],
        },
        topLogprobs: { requirement: "hard", value: 3 },
      },
      tools: {
        parallelCalls: { requirement: "hard", value: false },
        choice: {
          requirement: "hard",
          value: { kind: "named", toolType: "function", name: "lookup" },
        },
      },
      sampling: {
        maxOutputTokens: { requirement: "hard", value: 512 },
        temperature: { requirement: "preference", value: 0.4 },
        topP: { requirement: "preference", value: 0.8 },
      },
      cache: {
        key: { requirement: "preference", value: "cache-key" },
        retention: { requirement: "preference", value: "24h" },
      },
      identity: {
        safetyIdentifier: { requirement: "preference", value: "safe-user" },
        deprecatedUser: { requirement: "preference", value: "deprecated-user" },
      },
      lifecycle: {
        serviceTier: { requirement: "preference", value: "priority" },
        truncation: { requirement: "hard", value: "disabled" },
        background: { requirement: "preference", value: false },
        store: { requirement: "preference", value: false },
        contextManagement: {
          requirement: "hard",
          value: [{ type: "compaction", compact_threshold: 1_000 }],
        },
        streamOptions: {
          requirement: "preference",
          value: { include_obfuscation: false },
        },
      },
    });
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
        context_management: [
          { type: "compaction", settings: { threshold: 1_000 } },
        ],
      },
      1,
    );

    const schema = result.invocation.supplement.output?.format?.value;
    expect(schema?.type).toBe("json_schema");
    if (schema?.type !== "json_schema") throw new Error("expected schema");
    expect(Object.isFrozen(schema.schema)).toBe(true);
    expect(Object.isFrozen(schema.schema.properties)).toBe(true);
    expect(
      Object.isFrozen(
        result.invocation.supplement.lifecycle?.contextManagement?.value[0]
          ?.settings,
      ),
    ).toBe(true);
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
