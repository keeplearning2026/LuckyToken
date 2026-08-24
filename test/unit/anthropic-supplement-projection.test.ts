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
  it("fails before dispatch when max_tokens=0 cannot survive the Pi Provider minimum", () => {
    const projection = projectionFor(requestWith({ max_tokens: 0 }));
    expect(projection.initialFailure).toMatch(/max_tokens=0|output-token ceiling/iu);
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

    expect(result.failure).toBeUndefined();
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
      request: requestWith({
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    },
  ])("fails $label before a non-Anthropic Provider dispatch", async ({ request }) => {
    const projection = projectionFor(request);
    expect(projection.initialFailure).toBeUndefined();
    const result = await projection.project(openAICandidate, {
      ...baseModel,
      api: "openai-completions",
    } as Model<string>);
    expect(result.failure).toMatch(/supplement|server tool|document|defer/iu);
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

    expect(result.failure).toBeUndefined();
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
    const result = await projection.project(openAICandidate, target);

    expect(result.failure).toBeUndefined();
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
    expect(projection.initialFailure).toBeUndefined();

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
    expect(projection.initialFailure).toBeUndefined();

    const result = await projection.project(openAICandidate, {
      ...baseModel,
      api: "openai-completions",
    } as Model<string>);

    expect(result.failure).toBeUndefined();
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
      expect(projection.initialFailure).toBeUndefined();
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
      expect(result.failure).toBeUndefined();
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
    expect(projection.initialFailure).toBeUndefined();
    const target = { ...baseModel, api: "openai-codex-responses" } as Model<string>;
    const result = await projection.project(
      { model: "target-model", input: [], stream: true },
      target,
    );
    expect(result.failure).toBeUndefined();
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
    expect(projection.initialFailure).toBeUndefined();
    const target = { ...baseModel, api: "openai-codex-responses" } as Model<string>;
    const result = await projection.project(
      { model: "target-model", input: [], stream: true },
      target,
    );
    expect(result.failure).toBeUndefined();
    expect(result.outcomes).toContainEqual({
      control: "maxTokens",
      outcome: expect.objectContaining({
        kind: "omitted",
        warning: expect.stringMatching(/max_output_tokens/iu),
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
    expect(projection.initialFailure).toBeUndefined();
    const candidate = { modelId: target.id, messages: [], opaque: true };
    const result = await projection.project(candidate, target);
    expect(result.payload).toEqual(candidate);
    expect(result.failure).toBeUndefined();
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
    expect(projection.initialFailure).toBeUndefined();
    const result = await projection.project({
      modelId: target.id,
      messages: [],
      inferenceConfig: { maxTokens: 1_024 },
    }, target);
    expect(result.failure).toBeUndefined();
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
    expect(projection.initialFailure).toBeUndefined();
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
    expect(result.failure).toBeUndefined();
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

    expect(result.failure).toBeUndefined();
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
