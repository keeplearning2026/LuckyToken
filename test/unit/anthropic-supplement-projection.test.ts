import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { parseAnthropicTextInvocation } from "../../src/protocols/anthropic/request.js";
import { prepareAnthropicPayloadProjection } from "../../src/protocols/anthropic/semantic/projection/request.js";

const baseModel = {
  id: "target-model",
  name: "Target model",
  provider: "target-provider",
  baseUrl: "https://provider.invalid/v1",
  reasoning: false,
  input: ["text"] as ("text" | "image")[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_768,
  maxTokens: 8_192,
};

function projectionFor(
  request: Record<string, unknown>,
  api = "openai-completions",
) {
  const invocation = parseAnthropicTextInvocation(request, 1).invocation;
  const model = { ...baseModel, api } as Model<string>;
  return prepareAnthropicPayloadProjection({ model, invocation });
}

function requestWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    model: "client-selector",
    max_tokens: 1_024,
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

const openAICandidate = {
  model: "target-model",
  messages: [{ role: "user", content: "hello" }],
  stream: true,
  max_completion_tokens: 1_024,
};

describe("Anthropic supplement target disposition", () => {
  it("keeps an unknown target payload unchanged and omits each present candidate exactly once", async () => {
    const invocation = parseAnthropicTextInvocation(requestWith({
      temperature: 0.4,
      top_p: 0.8,
      top_k: 12,
      stop_sequences: ["END"],
      tools: [{
        name: "lookup",
        input_schema: { type: "object", properties: {} },
      }],
      tool_choice: {
        type: "tool",
        name: "lookup",
        disable_parallel_tool_use: true,
      },
      output_config: {
        format: {
          type: "json_schema",
          schema: { type: "object", properties: {} },
        },
      },
      metadata: { user_id: "user-123" },
      service_tier: "auto",
      container: "container-123",
      cache_control: { type: "ephemeral" },
    }), 1).invocation;
    const target = {
      ...baseModel,
      api: "custom-unknown-api",
    } as Model<string>;
    const projection = prepareAnthropicPayloadProjection({ model: target, invocation });
    const candidate = Object.freeze({ opaque: true, nested: { value: 1 } });

    const result = await projection.project(candidate, target);

    expect(result.payload).toEqual(candidate);
    const controls = result.outcomes.map((entry) => entry.control);
    expect(controls).toEqual([
      "maxTokens",
      "sampling.temperature",
      "sampling.topP",
      "sampling.topK",
      "stopSequences",
      "toolChoice",
      "toolChoice.disableParallelToolUse",
      "outputFormat",
      "metadataUserId",
      "serviceTier",
      "container",
      "cacheControl",
    ]);
    expect(new Set(controls).size).toBe(controls.length);
    expect(result.outcomes.every((entry) => entry.outcome.kind === "omitted")).toBe(true);
  });

  it("keeps an unknown reasoning target usable with explicit reasoning outcomes", async () => {
    const invocation = parseAnthropicTextInvocation(requestWith({
      max_tokens: 2_048,
      thinking: { type: "enabled", budget_tokens: 1_024 },
      output_config: { effort: "high" },
    }), 1).invocation;
    const target = {
      ...baseModel,
      api: "custom-unknown-api",
      reasoning: true,
    } as Model<string>;
    const candidate = Object.freeze({ opaque: true });

    const result = await prepareAnthropicPayloadProjection({
      model: target,
      invocation,
    }).project(candidate, target);

    expect(result.payload).toEqual(candidate);
    expect(result.outcomes).toContainEqual({
      control: "reasoning.activation",
      outcome: expect.objectContaining({ kind: "degraded" }),
    });
    expect(result.outcomes).toContainEqual({
      control: "reasoning.effort",
      outcome: expect.objectContaining({ kind: "omitted" }),
    });
  });

  it("rejects a selected Adapter payload shape instead of guessing a mutation", async () => {
    const target = {
      ...baseModel,
      api: "openai-completions",
    } as Model<string>;
    const projection = prepareAnthropicPayloadProjection({
      model: target,
      invocation: parseAnthropicTextInvocation(requestWith({}), 1).invocation,
    });

    await expect(projection.project({ opaque: true }, target)).rejects.toThrow(
      /payload shape|messages/iu,
    );
  });

  it("treats unsupported inference geography as main-call policy rather than a Supplement failure", async () => {
    const invocation = parseAnthropicTextInvocation(requestWith({
      inference_geo: "us",
    }), 1).invocation;
    const target = {
      ...baseModel,
      api: "custom-unknown-api",
    } as Model<string>;
    const projection = prepareAnthropicPayloadProjection({ model: target, invocation });

    const result = await projection.project({ opaque: true }, target);
    expect(result.outcomes).toContainEqual({
      control: "inferenceGeo",
      outcome: expect.objectContaining({ kind: "omitted" }),
    });
  });

  it("accounts for Anthropic-native structured candidates by their candidate identities", async () => {
    const invocation = parseAnthropicTextInvocation(requestWith({
      system: [{
        type: "text",
        text: "system",
        cache_control: { type: "ephemeral" },
      }],
      messages: [{
        role: "user",
        content: [{
          type: "text",
          text: "hello",
          cache_control: { type: "ephemeral" },
        }],
      }],
      tools: [{
        type: "custom",
        name: "lookup",
        input_schema: { type: "object", properties: {} },
        defer_loading: true,
      }],
    }), 1).invocation;
    const target = {
      ...baseModel,
      api: "anthropic-messages",
    } as Model<string>;
    const projection = prepareAnthropicPayloadProjection({ model: target, invocation });

    const result = await projection.project({
      model: target.id,
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      system: "system",
      tools: [{ name: "lookup", input_schema: { type: "object", properties: {} } }],
      stream: true,
      max_tokens: 1_024,
    }, target);

    const controls = result.outcomes.map((entry) => entry.control);
    expect(controls).toEqual([
      "maxTokens",
      "system",
      "system.cacheControl",
      "content[0:0]",
      "tools[0]",
    ]);
    expect(new Set(controls).size).toBe(controls.length);
  });

  it("gives every scalar candidate an exact Anthropic-native outcome", async () => {
    const invocation = parseAnthropicTextInvocation(requestWith({
      temperature: 0.4,
      top_p: 0.8,
      top_k: 12,
      stop_sequences: ["END"],
      tools: [{ name: "lookup", input_schema: { type: "object" } }],
      tool_choice: {
        type: "tool",
        name: "lookup",
        disable_parallel_tool_use: true,
      },
      output_config: {
        format: { type: "json_schema", schema: { type: "object" } },
      },
      metadata: { user_id: "user-123" },
      service_tier: "auto",
      inference_geo: "us",
      container: "container-123",
      cache_control: { type: "ephemeral", ttl: "1h" },
    }), 1).invocation;
    const target = {
      ...baseModel,
      api: "anthropic-messages",
    } as Model<string>;

    const result = await prepareAnthropicPayloadProjection({
      model: target,
      invocation,
    }).project({
      model: target.id,
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [{ name: "lookup", input_schema: { type: "object" } }],
      stream: true,
      max_tokens: 1_024,
      temperature: 0.4,
      top_p: 0.8,
      top_k: 12,
      stop_sequences: ["END"],
      metadata: { user_id: "user-123" },
    }, target);

    expect(result.outcomes.map((entry) => entry.control)).toEqual([
      "maxTokens",
      "sampling.temperature",
      "sampling.topP",
      "sampling.topK",
      "stopSequences",
      "toolChoice",
      "toolChoice.disableParallelToolUse",
      "outputFormat",
      "metadataUserId",
      "serviceTier",
      "inferenceGeo",
      "container",
      "cacheControl",
    ]);
    expect(result.outcomes.some((entry) => entry.outcome.kind === "omitted")).toBe(false);
  });

  it("does not use a target Adapter initial failure for unsupported inference geography", async () => {
    const projection = projectionFor(requestWith({ inference_geo: "us" }));

    const result = await projection.project(openAICandidate, {
      ...baseModel,
      api: "openai-completions",
    } as Model<string>);
    expect(result.outcomes).toContainEqual({
      control: "inferenceGeo",
      outcome: expect.objectContaining({ kind: "omitted" }),
    });
  });

  it("verifies but does not rewrite Pi-owned temperature when the final wire differs", async () => {
    const target = {
      ...baseModel,
      api: "openai-completions",
    } as Model<string>;
    const result = await prepareAnthropicPayloadProjection({
      model: target,
      invocation: parseAnthropicTextInvocation(requestWith({ temperature: 0.4 }), 1)
        .invocation,
    }).project({ ...openAICandidate, temperature: 0.9 }, target);

    expect(result.payload).toMatchObject({ temperature: 0.9 });
    expect(result.outcomes).toContainEqual({
      control: "sampling.temperature",
      outcome: expect.objectContaining({ kind: "omitted" }),
    });
  });

  it.each([
    ["auto", "auto"],
    ["any", "required"],
  ] as const)("does not invent a serial-tool candidate for %s tool choice", async (
    sourceChoice,
    providerChoice,
  ) => {
    const target = {
      ...baseModel,
      api: "openai-completions",
    } as Model<string>;
    const invocation = parseAnthropicTextInvocation(requestWith({
      tools: [{ name: "lookup", input_schema: { type: "object" } }],
      tool_choice: { type: sourceChoice },
    }), 1).invocation;

    const result = await prepareAnthropicPayloadProjection({
      model: target,
      invocation,
    }).project({
      ...openAICandidate,
      tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
      tool_choice: providerChoice,
      parallel_tool_calls: true,
    }, target);

    expect(result.outcomes.map((entry) => entry.control)).toEqual([
      "maxTokens",
      "toolChoice",
    ]);
    expect(result.payload).toMatchObject({ parallel_tool_calls: true });
  });

  it.each([
    {
      api: "anthropic-messages",
      provider: "custom-anthropic",
      candidate: {
        model: "target-model",
        messages: [],
        stream: true,
        max_tokens: 1_024,
      },
    },
    {
      api: "bedrock-converse-stream",
      provider: "amazon-bedrock",
      id: "us.anthropic.claude-sonnet-4-6",
      candidate: {
        modelId: "us.anthropic.claude-sonnet-4-6",
        messages: [],
        inferenceConfig: { maxTokens: 1_024 },
      },
    },
  ])("keeps $api usable when context clamping leaves no room above the exact thinking budget", async ({
    api,
    provider,
    id,
    candidate,
  }) => {
    const invocation = parseAnthropicTextInvocation(requestWith({
      max_tokens: 2_048,
      thinking: { type: "enabled", budget_tokens: 1_024 },
    }), 1).invocation;
    const target = {
      ...baseModel,
      api,
      provider,
      id: id ?? baseModel.id,
      reasoning: true,
    } as Model<string>;
    const result = await prepareAnthropicPayloadProjection({
      model: target,
      invocation,
    }).project(candidate, target);
    expect(result.outcomes).toContainEqual({
      control: "reasoning.activation",
      outcome: expect.objectContaining({
        kind: "degraded",
        warning: expect.stringMatching(/budget.*ceiling/iu),
      }),
    });
  });

  it.each([
    {
      label: "URL document",
      control: "content[0:0]",
      request: requestWith({
        messages: [{
          role: "user",
          content: [{
            type: "document",
            source: { type: "url", url: "https://example.test/a.pdf" },
          }],
        }],
      }),
    },
    {
      label: "typed server tool",
      control: "tools[0]",
      request: requestWith({
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    },
  ])("does not turn $label main-call policy into a Supplement failure", async ({ request, control }) => {
    const projection = projectionFor(request);
    const result = await projection.project(openAICandidate, {
      ...baseModel,
      api: "openai-completions",
    } as Model<string>);
    expect(result.outcomes).toContainEqual({
      control,
      outcome: expect.objectContaining({ kind: "omitted" }),
    });
  });

  it("keeps a deferred custom tool usable and warns when defer_loading cannot be projected", async () => {
    const request = requestWith({
      tools: [{
        name: "lookup",
        input_schema: { type: "object", properties: {} },
        defer_loading: true,
      }],
    });
    const projection = projectionFor(request);
    const result = await projection.project(openAICandidate, {
      ...baseModel,
      api: "openai-completions",
    } as Model<string>);
    expect(result.outcomes).toContainEqual({
      control: "tools[0]",
      outcome: expect.objectContaining({
        kind: "omitted",
        warning: expect.stringMatching(/defer_loading/iu),
      }),
    });
  });

  it("keeps final assistant prefill as visible history and reports a bounded degradation", async () => {
    const request = requestWith({
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "prefix" },
      ],
    });
    const invocation = parseAnthropicTextInvocation(request, 1).invocation;
    const target = { ...baseModel, api: "openai-completions" } as Model<string>;
    const projection = prepareAnthropicPayloadProjection({ model: target, invocation });
    const result = await projection.project({
      ...openAICandidate,
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "prefix" },
      ],
    }, target);
    expect(result.outcomes).toContainEqual({
      control: "finalAssistantPrefill",
      outcome: expect.objectContaining({ kind: "degraded" }),
    });

  });

  it("keeps visible fallback but reports every unprojected optional attachment", async () => {
    const projection = projectionFor(requestWith({
      messages: [{
        role: "user",
        content: [{
          type: "text",
          text: "hello",
          cache_control: { type: "ephemeral" },
        }],
      }],
    }));

    const result = await projection.project({
      model: "target-model",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      stream: true,
      max_completion_tokens: 1_024,
    }, { ...baseModel, api: "openai-completions" } as Model<string>);

    expect(result.outcomes).toContainEqual({
      control: "content[0:0]",
      outcome: {
        kind: "omitted",
        warning: expect.stringContaining("cache_control"),
      },
    });
  });

  it("warns instead of failing for optional citations and redundant custom tool type", async () => {
    const projection = projectionFor(requestWith({
      messages: [{
        role: "user",
        content: [{
          type: "text",
          text: "hello",
          citations: [{
            type: "char_location",
            cited_text: "hello",
            document_index: 0,
            document_title: null,
            start_char_index: 0,
            end_char_index: 5,
          }],
        }],
      }],
      tools: [{
        type: "custom",
        name: "lookup",
        input_schema: { type: "object", properties: {} },
      }],
    }));

    const result = await projection.project(openAICandidate, {
      ...baseModel,
      api: "openai-completions",
    } as Model<string>);
    expect(result.outcomes).toEqual(expect.arrayContaining([
      {
        control: "content[0:0]",
        outcome: expect.objectContaining({ kind: "omitted" }),
      },
      {
        control: "tools[0]",
        outcome: expect.objectContaining({ kind: "omitted" }),
      },
    ]));
  });

  it.each(["openai-responses", "azure-openai-responses", "pi-messages"])(
    "omits unsupported %s stop_sequences with a warning outcome",
    async (api) => {
      const projection = projectionFor(
        requestWith({ stop_sequences: ["END"] }),
        api,
      );
      const candidate = api === "pi-messages"
        ? { model: "target-model", context: {}, options: { maxTokens: 1_024 } }
        : {
            model: "target-model",
            input: [],
            stream: true,
            max_output_tokens: 1_024,
          };
      const result = await projection.project(candidate, {
        ...baseModel,
        api,
      } as Model<string>);
      expect(result.outcomes).toContainEqual({
        control: "stopSequences",
        outcome: expect.objectContaining({ kind: "omitted" }),
      });
    },
  );

  it("keeps Codex usable by omitting its uncertified output ceiling while preserving serial tools", async () => {
    const projection = projectionFor(
      requestWith({
        tools: [{
          name: "lookup",
          input_schema: { type: "object", properties: {} },
        }],
        tool_choice: {
          type: "tool",
          name: "lookup",
          disable_parallel_tool_use: true,
        },
      }),
      "openai-codex-responses",
    );
    const target = { ...baseModel, api: "openai-codex-responses" } as Model<string>;
    const result = await projection.project(
      { model: "target-model", input: [], stream: true },
      target,
    );
    expect(result.outcomes).toContainEqual({
      control: "maxTokens",
      outcome: expect.objectContaining({ kind: "omitted" }),
    });
    expect(result.outcomes).toContainEqual({
      control: "toolChoice.disableParallelToolUse",
      outcome: expect.objectContaining({ kind: "payload-projected" }),
    });
  });

  it("warns and dispatches Codex Responses when max_tokens has no certified wire control", async () => {
    const projection = projectionFor(
      requestWith({ max_tokens: 2_048 }),
      "openai-codex-responses",
    );
    const target = { ...baseModel, api: "openai-codex-responses" } as Model<string>;
    const result = await projection.project(
      { model: "target-model", input: [], stream: true },
      target,
    );
    expect(result.outcomes).toContainEqual({
      control: "maxTokens",
      outcome: expect.objectContaining({
        kind: "omitted",
        warning: expect.stringMatching(/omitted the final output-token ceiling/iu),
      }),
    });
  });

  it("uses Pi-only execution for an uncertified Bedrock family instead of selecting a guessed projector", async () => {
    const invocation = parseAnthropicTextInvocation(requestWith({}), 1).invocation;
    const target = {
      ...baseModel,
      api: "bedrock-converse-stream",
      provider: "amazon-bedrock",
      id: "custom-profile-123",
      name: "Claude Sonnet 4.6",
      reasoning: true,
    } as Model<string>;

    const projection = prepareAnthropicPayloadProjection({ model: target, invocation });
    const candidate = { modelId: target.id, messages: [], opaque: true };
    const result = await projection.project(candidate, target);
    expect(result.payload).toEqual(candidate);
  });

  it("degrades explicit thinking disable on Bedrock by default when no exact disable mapping exists", async () => {
    const invocation = parseAnthropicTextInvocation(requestWith({
      thinking: { type: "disabled" },
    }), 1).invocation;
    const target = {
      ...baseModel,
      api: "bedrock-converse-stream",
      provider: "amazon-bedrock",
      id: "us.anthropic.claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      reasoning: true,
    } as Model<string>;

    const projection = prepareAnthropicPayloadProjection({ model: target, invocation });
    const result = await projection.project({
      modelId: target.id,
      messages: [],
      inferenceConfig: { maxTokens: 1_024 },
    }, target);
    expect(result.outcomes).toContainEqual({
      control: "reasoning.activation",
      outcome: expect.objectContaining({ kind: "degraded" }),
    });
  });

  it("projects the independently registered CommandCode Private payload", async () => {
    const invocation = parseAnthropicTextInvocation(requestWith({
      max_tokens: 2_048,
      temperature: 0.4,
      top_p: 0.8,
      top_k: 12,
      output_config: { effort: "high" },
    }), 1).invocation;
    const target = {
      ...baseModel,
      api: "commandcode-private",
      provider: "commandcode-private",
      id: "deepseek/deepseek-v4-flash",
      reasoning: true,
    } as Model<string>;
    const projection = prepareAnthropicPayloadProjection({ model: target, invocation });
    const result = await projection.project({
      params: {
        model: target.id,
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        tools: [],
        stream: true,
        max_tokens: 2_048,
        temperature: 0.4,
        reasoning_effort: "high",
      },
    }, target);
    expect(result.payload).toMatchObject({
      params: {
        max_tokens: 2_048,
        temperature: 0.4,
        reasoning_effort: "high",
      },
    });
    expect(result.outcomes).toContainEqual(expect.objectContaining({
      control: "sampling.topP",
      outcome: expect.objectContaining({ kind: "omitted" }),
    }));
  });

  it("uses availability-preserving CommandCode Private fallbacks with explicit outcomes", async () => {
    const invocation = parseAnthropicTextInvocation(requestWith({
      stop_sequences: ["END"],
      tools: [
        { name: "lookup", input_schema: { type: "object", properties: {} } },
        { name: "other", input_schema: { type: "object", properties: {} } },
      ],
      tool_choice: { type: "tool", name: "lookup" },
      output_config: {
        format: { type: "json_schema", schema: { type: "object", properties: {} } },
      },
    }), 1).invocation;
    const target = {
      ...baseModel,
      api: "commandcode-private",
      provider: "commandcode-private",
      id: "deepseek/deepseek-v4-flash",
      reasoning: true,
    } as Model<string>;
    const projection = prepareAnthropicPayloadProjection({ model: target, invocation });
    const result = await projection.project({
      params: {
        model: target.id,
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        tools: [
          { name: "lookup", description: "", input_schema: { type: "object" } },
          { name: "other", description: "", input_schema: { type: "object" } },
        ],
        stream: true,
        max_tokens: 1_024,
      },
    }, target);
    expect(result.payload).toMatchObject({
      params: {
        tools: [{ name: "lookup" }],
        system: expect.stringContaining("Return one JSON value"),
      },
    });
    expect(result.outcomes).toEqual(expect.arrayContaining([
      { control: "stopSequences", outcome: expect.objectContaining({ kind: "omitted" }) },
      { control: "toolChoice", outcome: expect.objectContaining({ kind: "degraded" }) },
      { control: "outputFormat", outcome: expect.objectContaining({ kind: "degraded" }) },
    ]));
  });
});
