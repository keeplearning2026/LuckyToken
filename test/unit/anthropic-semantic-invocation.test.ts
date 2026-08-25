import { describe, expect, it } from "vitest";

import { parseAnthropicTextInvocation } from "../../src/protocols/anthropic/request.js";

describe("Anthropic-owned Semantic Invocation", () => {
  it("retains top-level request controls outside Pi IR without losing Pi input", () => {
    const converted = parseAnthropicTextInvocation(
      {
        model: "client-selector",
        max_tokens: 4_096,
        messages: [{ role: "user", content: "hello" }],
        temperature: 0.4,
        top_p: 0.8,
        top_k: 32,
        stop_sequences: ["END", "STOP"],
        tool_choice: {
          type: "tool",
          name: "lookup",
          disable_parallel_tool_use: true,
        },
        thinking: {
          type: "enabled",
          budget_tokens: 1_024,
          display: null,
        },
        output_config: {
          effort: "high",
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: { answer: { type: "string" } },
              required: ["answer"],
              additionalProperties: false,
            },
          },
        },
        metadata: { user_id: "user-123" },
        service_tier: "auto",
        inference_geo: "us",
        container: "container-123",
        cache_control: { type: "ephemeral", ttl: "1h" },
        tools: [
          {
            name: "lookup",
            description: "Lookup a value",
            input_schema: { type: "object", properties: {} },
          },
        ],
      },
      10,
    );

    expect(converted.selector).toBe("client-selector");
    expect(converted.invocation.pi.context.messages).toHaveLength(1);
    expect(converted.invocation.pi.options).toMatchObject({
      maxTokens: 4_096,
      temperature: 0.4,
    });
    expect(converted.invocation.reasoning).toEqual({
      activation: {
        kind: "enabled",
        budgetTokens: 1_024,
        display: { kind: "explicit-null" },
      },
      effort: { kind: "specified", level: "high" },
      history: [],
      continuity: [],
    });
    expect(converted.invocation.supplement).toEqual({
      outputTokenCeiling: 4_096,
      sampling: { temperature: 0.4, topP: 0.8, topK: 32 },
      stopSequences: ["END", "STOP"],
      toolChoice: {
        kind: "named",
        name: "lookup",
        disableParallelToolUse: true,
      },
      outputFormat: {
        kind: "specified",
        value: {
          kind: "json-schema",
          schema: {
            type: "object",
            properties: { answer: { type: "string" } },
            required: ["answer"],
            additionalProperties: false,
          },
        },
      },
      metadataUserId: { kind: "specified", value: "user-123" },
      serviceTier: { kind: "specified", value: "auto" },
      inferenceGeo: { kind: "specified", value: "us" },
      container: { kind: "specified", value: "container-123" },
      cacheControl: { kind: "specified", value: { ttl: "1h" } },
      messageFrames: [
        {
          sourceMessageIndex: 0,
          role: "user",
          entries: [{ sourceContentIndex: 0, ownership: "pi" }],
        },
      ],
      content: [],
      tools: [],
    });
    expect(converted.invocation.pi.options.samplingParams).toEqual({
      top_p: 0.8,
      top_k: 32,
    });
    expect(converted.invocation.pi.options.metadata).toEqual({
      user_id: "user-123",
    });
    expect(converted.client).toEqual({
      renderState: {
        selector: "client-selector",
        stream: false,
        directToolNames: ["lookup"],
        thinkingDisplay: { kind: "explicit-null" },
      },
      notices: [],
    });
  });

  it("keeps omission, explicit null, disable, and adaptive states distinct", () => {
    const omitted = parseAnthropicTextInvocation(
      {
        model: "model",
        max_tokens: 2_048,
        messages: [{ role: "user", content: "hello" }],
      },
      1,
    );
    const disabled = parseAnthropicTextInvocation(
      {
        model: "model",
        max_tokens: 2_048,
        messages: [{ role: "user", content: "hello" }],
        thinking: { type: "disabled" },
        output_config: { effort: null, format: null },
        metadata: { user_id: null },
        service_tier: "standard_only",
        inference_geo: null,
        container: null,
        cache_control: null,
      },
      1,
    );
    const adaptive = parseAnthropicTextInvocation(
      {
        model: "model",
        max_tokens: 2_048,
        messages: [{ role: "user", content: "hello" }],
        thinking: { type: "adaptive", display: "omitted" },
      },
      1,
    );

    expect(omitted.invocation.reasoning.activation).toEqual({ kind: "omitted" });
    expect(omitted.invocation.reasoning.effort).toEqual({ kind: "omitted" });
    expect(disabled.invocation.reasoning).toMatchObject({
      activation: { kind: "disabled" },
      effort: { kind: "explicit-null" },
    });
    expect(disabled.invocation.supplement).toMatchObject({
      outputFormat: { kind: "explicit-null" },
      metadataUserId: { kind: "explicit-null" },
      serviceTier: { kind: "specified", value: "standard_only" },
      inferenceGeo: { kind: "explicit-null" },
      container: { kind: "explicit-null" },
      cacheControl: { kind: "explicit-null" },
    });
    expect(adaptive.invocation.reasoning.activation).toEqual({
      kind: "adaptive",
      display: { kind: "specified", value: "omitted" },
    });
  });

  it("rejects an enabled thinking budget that reaches the output ceiling", () => {
    expect(() =>
      parseAnthropicTextInvocation(
        {
          model: "model",
          max_tokens: 1_024,
          messages: [{ role: "user", content: "hello" }],
          thinking: { type: "enabled", budget_tokens: 1_024 },
        },
        1,
      ),
    ).toThrow(/less than max_tokens/u);
  });

  it("rejects a named tool choice when the named tool is absent", () => {
    expect(() =>
      parseAnthropicTextInvocation(
        {
          model: "model",
          max_tokens: 1_024,
          messages: [{ role: "user", content: "hello" }],
          tools: [
            {
              name: "available",
              input_schema: { type: "object", properties: {} },
            },
          ],
          tool_choice: { type: "tool", name: "missing" },
        },
        1,
      ),
    ).toThrow(/tool_choice.*missing.*not present|named tool.*missing/iu);
  });

  it("maps a direct tool caller into the ordinary Pi tool-call relationship", () => {
    const converted = parseAnthropicTextInvocation(
      {
        model: "client-selector",
        max_tokens: 64,
        messages: [
          { role: "user", content: "use the tool" },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "call-1",
                name: "lookup",
                input: { q: "x" },
                caller: { type: "direct" },
              },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "call-1", content: "done" },
            ],
          },
        ],
        tools: [
          {
            name: "lookup",
            input_schema: { type: "object", properties: {} },
          },
        ],
      },
      1,
    );

    expect(converted.invocation.supplement.content).toEqual([]);
    expect(converted.invocation.pi.context.messages[1]).toMatchObject({
      role: "assistant",
      content: [
        { type: "toolCall", id: "call-1", name: "lookup", arguments: { q: "x" } },
      ],
    });
  });
});

describe("complete Anthropic protocol-owned supplement", () => {
  it("retains Pi-unrepresentable content and tool controls without placeholder text", () => {
    const converted = parseAnthropicTextInvocation(
      {
        model: "client-model",
        max_tokens: 2_048,
        system: [
          {
            type: "text",
            text: "system",
            cache_control: { type: "ephemeral", ttl: "1h" },
          },
        ],
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "url", url: "https://example.test/image.png" },
                cache_control: { type: "ephemeral" },
              },
              { type: "container_upload", file_id: "file-1" },
            ],
          },
          {
            role: "assistant",
            content: [
              {
                type: "server_tool_use",
                id: "srv-1",
                name: "web_search",
                input: { query: "Token" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "web_search_tool_result",
                tool_use_id: "srv-1",
                content: {
                  type: "web_search_tool_result_error",
                  error_code: "unavailable",
                },
              },
            ],
          },
        ],
        tools: [
          {
            name: "lookup",
            description: "Lookup",
            input_schema: { type: "object", properties: {} },
            strict: true,
            allowed_callers: ["direct"],
            defer_loading: true,
            eager_input_streaming: false,
            input_examples: [{ query: "example" }],
            cache_control: { type: "ephemeral", ttl: "5m" },
          },
          {
            name: "web_search",
            type: "web_search_20250305",
            max_uses: 2,
            allowed_domains: ["example.test"],
          },
        ],
      },
      1,
    );

    expect(converted.invocation.supplement.system).toEqual({
      kind: "blocks",
      blocks: [
        expect.objectContaining({
          text: "system",
          cache_control: { ttl: "1h", type: "ephemeral" },
        }),
      ],
    });
    expect(converted.invocation.supplement.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "image", piRepresentation: "none" }),
        expect.objectContaining({ kind: "container_upload", piRepresentation: "none" }),
        expect.objectContaining({ kind: "server_tool_use", piRepresentation: "none" }),
        expect.objectContaining({ kind: "web_search_tool_result", piRepresentation: "none" }),
      ]),
    );
    expect(converted.invocation.supplement.tools).toEqual([
      expect.objectContaining({ name: "lookup", kind: "custom", piRepresentation: "partial" }),
      expect.objectContaining({ name: "web_search", kind: "server", piRepresentation: "none" }),
    ]);
    expect(JSON.stringify(converted.invocation.pi.context.messages)).not.toContain(
      "[web search result]",
    );
    expect(JSON.stringify(converted.invocation.pi.context.messages)).not.toContain(
      "[server tool:",
    );
  });
});
