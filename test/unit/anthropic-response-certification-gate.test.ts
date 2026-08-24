import type { AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { parseAnthropicTextInvocation } from "../../src/protocols/anthropic/request.js";
import { executeAnthropicSemanticInvocation } from "../../src/protocols/anthropic/semantic/execution.js";

function createTerminal(model: Model<string>): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [{ type: "text", text: "executed through Pi" }],
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  };
}

function createInvocation() {
  return parseAnthropicTextInvocation({
    model: "client-selector",
    max_tokens: 1_024,
    messages: [{ role: "user", content: "hello" }],
  }, 1).invocation;
}

function createExecuteOperation(candidatePayload: Readonly<Record<string, unknown>>) {
  return vi.fn(async (_models, target: Model<string>, _context, options) => {
    const finalPayload = await options.onPayload?.(candidatePayload);
    expect(finalPayload).toEqual(candidatePayload);
    return createTerminal(target);
  });
}

describe("Anthropic semantic conversion Pi-only execution", () => {
  it("does not reject a valid Pi-only OpenAI-compatible target merely because its Provider/model has no projection profile", async () => {
    const target: Model<"openai-completions"> = {
      id: "custom-model",
      name: "Custom model",
      api: "openai-completions",
      provider: "custom-openai-compatible",
      baseUrl: "https://provider.invalid/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_768,
      maxTokens: 8_192,
    };
    const executeOperation = createExecuteOperation({
      model: target.id,
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 1_024,
      stream: true,
    });

    const result = await executeAnthropicSemanticInvocation({
      models: {} as Models,
      model: target,
      invocation: createInvocation(),
      execution: { executeOperation },
    });

    expect(result.message.content).toEqual([{ type: "text", text: "executed through Pi" }]);
    expect(executeOperation).toHaveBeenCalledOnce();
  });

  it("does not reject a valid Pi-only target merely because its Pi API has no supplement projector", async () => {
    const target: Model<string> = {
      id: "custom-pi-model",
      name: "Custom Pi model",
      api: "custom-pi-api",
      provider: "custom-provider",
      baseUrl: "https://provider.invalid/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_768,
      maxTokens: 8_192,
    };
    const executeOperation = createExecuteOperation({
      model: target.id,
      prompt: "hello",
    });

    const result = await executeAnthropicSemanticInvocation({
      models: {} as Models,
      model: target,
      invocation: createInvocation(),
      execution: { executeOperation },
    });

    expect(result.message.content).toEqual([{ type: "text", text: "executed through Pi" }]);
    expect(executeOperation).toHaveBeenCalledOnce();
  });

  it("applies model-visible named-tool and structured-output fallbacks before an unaudited Pi-only target builds its payload", async () => {
    const target: Model<string> = {
      id: "custom-pi-model",
      name: "Custom Pi model",
      api: "custom-pi-api",
      provider: "custom-provider",
      baseUrl: "https://provider.invalid/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_768,
      maxTokens: 8_192,
    };
    const invocation = parseAnthropicTextInvocation({
      model: "client-selector",
      max_tokens: 1_024,
      messages: [{ role: "user", content: "hello" }],
      tools: [
        { name: "lookup", input_schema: { type: "object", properties: {} } },
        { name: "other", input_schema: { type: "object", properties: {} } },
      ],
      tool_choice: { type: "tool", name: "lookup" },
      output_config: {
        format: {
          type: "json_schema",
          schema: { type: "object", properties: { answer: { type: "string" } } },
        },
      },
    }, 1).invocation;
    const candidate = { model: target.id, prompt: "hello" };
    const executeOperation = vi.fn(async (_models, resolved, context, options) => {
      expect(resolved).toBe(target);
      expect(context.tools?.map((tool: { readonly name: string }) => tool.name)).toEqual(["lookup"]);
      expect(context.systemPrompt).toContain("Return one JSON value");
      expect(await options.onPayload?.(candidate)).toEqual(candidate);
      return createTerminal(target);
    });

    const result = await executeAnthropicSemanticInvocation({
      models: {} as Models,
      model: target,
      invocation,
      execution: { executeOperation },
    });

    expect(result.outcomes).toEqual(expect.arrayContaining([
      { control: "toolChoice", outcome: expect.objectContaining({ kind: "degraded" }) },
      { control: "outputFormat", outcome: expect.objectContaining({ kind: "degraded" }) },
    ]));
  });
});
