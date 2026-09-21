import type { AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { parseAnthropicTextInvocation } from "../../src/protocols/anthropic/request.js";
import { executeAnthropicSemanticInvocation } from "../../src/protocols/anthropic/semantic/execution.js";

const target: Model<string> = {
  id: "custom-model",
  name: "Custom model",
  api: "custom-api",
  provider: "custom-provider",
  baseUrl: "https://provider.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_768,
  maxTokens: 8_192,
};

function terminal(): AssistantMessage {
  return {
    role: "assistant",
    api: target.api,
    provider: target.provider,
    model: target.id,
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

describe("Anthropic semantic execution boundary", () => {
  it("dispatches only Pi Context/options and does not install a payload callback", async () => {
    const invocation = parseAnthropicTextInvocation({
      model: "client-selector",
      max_tokens: 1_024,
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.4,
      tool_choice: { type: "auto" },
    }, 1).invocation;
    const executeOperation = vi.fn(async (_models, resolved, context, options) => {
      expect(resolved).toBe(target);
      expect(context.messages).toHaveLength(1);
      expect(options).toMatchObject({
        maxTokens: 1_024,
        temperature: 0.4,
        toolChoice: "auto",
      });
      expect(options).not.toHaveProperty("onPayload");
      expect(options).not.toHaveProperty("onResponse");
      return terminal();
    });

    const result = await executeAnthropicSemanticInvocation({
      models: {} as Models,
      model: target,
      invocation,
      execution: { executeOperation },
    });

    expect(result.message.content).toEqual([
      { type: "text", text: "executed through Pi" },
    ]);
    expect(executeOperation).toHaveBeenCalledOnce();
  });

  it("passes Provider-wire observation as infrastructure, not protocol semantics", async () => {
    const invocation = parseAnthropicTextInvocation({
      model: "client-selector",
      max_tokens: 64,
      messages: [{ role: "user", content: "hello" }],
    }, 1).invocation;
    const request = vi.fn();
    const executeOperation = vi.fn(async (
      _models,
      _resolved,
      _context,
      _options,
      _facts,
      observation,
    ) => {
      observation?.providerRequest?.({ provider: "owned-wire" });
      return terminal();
    });

    await executeAnthropicSemanticInvocation({
      models: {} as Models,
      model: target,
      invocation,
      execution: { executeOperation, providerEvidence: { request } },
    });

    expect(request).toHaveBeenCalledWith({ provider: "owned-wire" });
  });
});
