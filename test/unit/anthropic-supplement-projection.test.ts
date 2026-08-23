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

describe("Anthropic supplement target disposition", () => {
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
    {
      label: "deferred custom tool",
      request: requestWith({
        tools: [{
          name: "lookup",
          input_schema: { type: "object", properties: {} },
          defer_loading: true,
        }],
      }),
    },
    {
      label: "final assistant prefill",
      request: requestWith({
        messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "prefix" }],
      }),
    },
  ])("fails $label before a non-Anthropic Provider dispatch", ({ request }) => {
    expect(projectionFor(request).initialFailure).toMatch(/supplement|prefill|server tool|document|defer/iu);
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

  it("fails the Codex Responses target before dispatch because max_tokens has no certified wire control", () => {
    expect(projectionFor(
      requestWith({ max_tokens: 2_048 }),
      "openai-codex-responses",
    ).initialFailure).toMatch(/max_output_tokens/u);
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

  it.each([
    [{ stop_sequences: ["END"] }, /stop sequence/u],
    [{
      tools: [{ name: "lookup", input_schema: { type: "object", properties: {} } }],
      tool_choice: { type: "tool", name: "lookup" },
    }, /tool choice/u],
    [{
      output_config: {
        format: { type: "json_schema", schema: { type: "object", properties: {} } },
      },
    }, /structured output/u],
  ])("fails an unsupported hard CommandCode Private control %# before dispatch", (control, pattern) => {
    const invocation = parseAnthropicTextInvocation(requestWith(control), 1).invocation;
    const target = {
      ...baseModel,
      api: "commandcode-private",
      provider: "commandcode-private",
      id: "deepseek/deepseek-v4-flash",
      reasoning: true,
    } as Model<string>;
    expect(prepareAnthropicPayloadProjection({ model: target, invocation }).initialFailure)
      .toMatch(pattern);
  });
});
