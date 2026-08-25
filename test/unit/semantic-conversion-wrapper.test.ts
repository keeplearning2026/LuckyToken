import type {
  AssistantMessage,
  Context,
  Model,
  Models,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import type { ResponsesSemanticInvocation as SemanticConversionInvocation } from "../../src/protocols/openai-responses/semantic/invocation.js";
import {
  executeOpenAIResponsesSemanticInvocation as executeSemanticConversion,
  InvalidResponsesSemanticExecution as InvalidSemanticExecution,
} from "../../src/protocols/openai-responses/semantic/execution.js";

const model: Model<"openai-completions"> = {
  id: "model-test",
  name: "model-test",
  api: "openai-completions",
  provider: "provider-test",
  baseUrl: "https://provider.test/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_192,
  maxTokens: 1_024,
};

const context: Context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

const unknownApiModel: Model<string> = {
  id: "model-test",
  name: "model-test",
  api: "future-uncertified-api",
  provider: "provider-test",
  baseUrl: "https://provider.test/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_192,
  maxTokens: 1_024,
};

const googleModel: Model<"google-generative-ai"> = {
  id: "gemini-3-test",
  name: "gemini-3-test",
  api: "google-generative-ai",
  provider: "provider-test",
  baseUrl: "https://provider.test/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_192,
  maxTokens: 1_024,
};

const anthropicModel: Model<"anthropic-messages"> = {
  ...model,
  api: "anthropic-messages",
};

const codexResponsesModel: Model<"openai-codex-responses"> = {
  ...model,
  api: "openai-codex-responses",
};

const goatThinkingModel: Model<"openai-completions"> = {
  ...model,
  id: "deepseek/deepseek-v4-flash",
  name: "DeepSeek V4 Flash",
  provider: "commandcode-goat",
  thinkingLevelMap: {
    off: null,
    high: "high",
    max: "max",
  },
};

const openCodeThinkingModel: Model<"openai-completions"> = {
  ...goatThinkingModel,
  id: "deepseek-v4-flash",
  provider: "opencode-go",
};

function invocation(): SemanticConversionInvocation {
  return {
    pi: { context, options: {} },
    reasoning: {
      request: {
        effort: { kind: "provider-default" },
        summary: { kind: "provider-default" },
      },
      history: [],
      continuity: [],
    },
    supplement: {
      tools: {
        choice: {
          value: { kind: "required" },
        },
      },
    },
  };
}

const terminal: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "done" }],
  api: "openai-completions",
  provider: "provider-test",
  model: "model-test",
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

describe("LuckyToken Pi execution wrapper", () => {
  it.each([
    ["Codex Responses", codexResponsesModel, { model: "model-test", input: [], stream: true }],
    ["an uncertified API", unknownApiModel, { model: "model-test", request: [] }],
  ] as const)("dispatches with a warning when %s cannot guarantee max_output_tokens", async (
    _label,
    targetModel,
    providerPayload,
  ) => {
    const target = invocation();
    const constrained: SemanticConversionInvocation = {
      ...target,
      pi: { ...target.pi, options: { ...target.pi.options, maxTokens: 512 } },
      supplement: {
        sampling: {
          maxOutputTokens: { value: 512 },
        },
      },
    };
    const operation = vi.fn(async (_models, _model, _context, options) => {
      await options.onPayload?.(providerPayload, targetModel);
      return terminal;
    });

    const result = await executeSemanticConversion({
      models: {} as Models,
      model: targetModel,
      invocation: constrained,
      infrastructure: { executeOperation: operation },
    });
    expect(operation).toHaveBeenCalledOnce();
    expect(result.supplementOutcomes).toContainEqual({
      control: "sampling.maxOutputTokens",
      outcome: expect.objectContaining({
        kind: "omitted",
        warning: expect.stringMatching(/max_output_tokens|output.*token/iu),
      }),
    });
  });

  it("owns onPayload and composes reasoning before supplement projection", async () => {
    let finalPayload: unknown;
    const operation = vi.fn(async (_models, _model, _context, options) => {
      finalPayload = await options.onPayload?.(
        {
          model: "model-test",
          messages: [],
          stream: true,
          reasoning_effort: "none",
        },
        model,
      );
      return terminal;
    });
    const result = await executeSemanticConversion({
      models: {} as Models,
      model,
      invocation: invocation(),
      infrastructure: { executeOperation: operation },
    });

    expect(finalPayload).toEqual({
      model: "model-test",
      messages: [],
      stream: true,
      tool_choice: "required",
    });
    expect(result.message).toBe(terminal);
    expect(result.supplementOutcomes).toContainEqual({
      control: "tools.choice",
      outcome: {
        kind: "payload-projected",
        projector: "openai-completions",
      },
    });
  });

  it("publishes a bounded warning when it repairs a Pi-native reasoning mapping", async () => {
    const notice = vi.fn();
    const target = invocation();
    const withReasoning: SemanticConversionInvocation = {
      ...target,
      reasoning: {
        ...target.reasoning,
        request: {
          effort: { kind: "enabled", level: "high" },
          summary: { kind: "provider-default" },
        },
      },
      supplement: {},
    };
    let finalPayload: unknown;
    await executeSemanticConversion({
      models: {} as Models,
      model,
      invocation: withReasoning,
      infrastructure: {
        factsSink: { notice, attempt: vi.fn() },
        executeOperation: async (_models, _model, _context, options) => {
          finalPayload = await options.onPayload?.(
            {
              model: "model-test",
              messages: [],
              stream: true,
              reasoning_effort: "low",
            },
            model,
          );
          return terminal;
        },
      },
    });

    expect(finalPayload).toHaveProperty("reasoning_effort", "high");
    expect(notice).toHaveBeenCalledWith({
      adapter: "openai-completions",
      direction: "request",
      code: "semantic_reasoning_pi_native_mapping_repaired",
      action: "xrepair",
    });
  });

  it("repairs a certified exact sampling field and publishes a developer warning", async () => {
    const notice = vi.fn();
    const target = invocation();
    const withTemperature: SemanticConversionInvocation = {
      ...target,
      supplement: {
        sampling: {
          temperature: { value: 0.4 },
        },
      },
    };
    let finalPayload: unknown;

    const result = await executeSemanticConversion({
      models: {} as Models,
      model,
      invocation: withTemperature,
      infrastructure: {
        factsSink: { notice, attempt: vi.fn() },
        executeOperation: async (_models, _model, _context, options) => {
          finalPayload = await options.onPayload?.(
            {
              model: "model-test",
              messages: [],
              stream: true,
              temperature: 1.2,
            },
            model,
          );
          return terminal;
        },
      },
    });

    expect(finalPayload).toHaveProperty("temperature", 0.4);
    expect(result.supplementOutcomes).toContainEqual({
      control: "sampling.temperature",
      outcome: {
        kind: "payload-projected",
        projector: "openai-completions",
        warning: "pi-native-mapping-repaired",
      },
    });
    expect(notice).toHaveBeenCalledWith({
      adapter: "openai-completions",
      direction: "request",
      code: "semantic_supplement_pi_native_mapping_repaired",
      action: "xrepair",
    });
  });

  it("rejects an externally supplied payload callback", async () => {
    const target = invocation();
    const withCallback: SemanticConversionInvocation = {
      ...target,
      pi: { ...target.pi, options: { onPayload: () => undefined } },
    };
    await expect(
      executeSemanticConversion({
        models: {} as Models,
        model,
        invocation: withCallback,
        infrastructure: { executeOperation: vi.fn() },
      }),
    ).rejects.toBeInstanceOf(InvalidSemanticExecution);
  });

  it("fails when an uncertified Pi API bypasses onPayload", async () => {
    await expect(
      executeSemanticConversion({
        models: {} as Models,
        model,
        invocation: invocation(),
        infrastructure: { executeOperation: async () => terminal },
      }),
    ).rejects.toThrow(/without invoking/u);
  });

  it("keeps dispatch available when explicit disable has no certified target mapping", async () => {
    const target = invocation();
    const withDisabledReasoning: SemanticConversionInvocation = {
      ...target,
      reasoning: {
        ...target.reasoning,
        request: {
          effort: { kind: "disabled" },
          summary: { kind: "provider-default" },
        },
      },
      supplement: {},
    };
    let dispatched = false;

    const result = await executeSemanticConversion({
      models: {} as Models,
      model: unknownApiModel,
      invocation: withDisabledReasoning,
      infrastructure: {
        executeOperation: async (_models, _model, _context, options) => {
          await options.onPayload?.(
            { model: "model-test", messages: [] },
            unknownApiModel,
          );
          dispatched = true;
          return terminal;
        },
      },
    });

    expect(dispatched).toBe(true);
    expect(result.reasoningOutcomes).toContainEqual({
      subject: "effort",
      outcome: expect.objectContaining({
        kind: "degraded",
        fallback: "reasoning-disable-to-provider-default",
      }),
    });
  });

  it("continues with a developer warning when an uncertified API omits a reasoning preference", async () => {
    const notice = vi.fn();
    const target = invocation();
    const withReasoningPreference: SemanticConversionInvocation = {
      ...target,
      reasoning: {
        ...target.reasoning,
        request: {
          effort: { kind: "enabled", level: "high" },
          summary: { kind: "requested", value: "concise" },
        },
      },
      supplement: {},
    };

    const result = await executeSemanticConversion({
      models: {} as Models,
      model: unknownApiModel,
      invocation: withReasoningPreference,
      infrastructure: {
        factsSink: { notice, attempt: vi.fn() },
        executeOperation: async (_models, _model, _context, options) => {
          await options.onPayload?.(
            { model: "model-test", messages: [] },
            unknownApiModel,
          );
          return terminal;
        },
      },
    });

    expect(result.reasoningOutcomes).toEqual(
      expect.arrayContaining([
        {
          subject: "effort",
          outcome: expect.objectContaining({ kind: "degraded" }),
        },
        {
          subject: "summary",
          outcome: expect.objectContaining({ kind: "omitted" }),
        },
      ]),
    );
    expect(notice).toHaveBeenCalledTimes(2);
    expect(notice).toHaveBeenCalledWith({
      adapter: "future-uncertified-api",
      direction: "request",
      code: "semantic_projection_degraded",
      action: "degrade",
    });
  });

  it("dispatches with a warning when the target cannot project serial-tool intent", async () => {
    const targetInvocation = invocation();
    const serialTools: SemanticConversionInvocation = {
      ...targetInvocation,
      supplement: {
        tools: {
          parallelCalls: { value: false },
        },
      },
    };
    const notice = vi.fn();
    let dispatched = false;

    const result = await executeSemanticConversion({
      models: {} as Models,
      model: googleModel,
      invocation: serialTools,
      infrastructure: {
        factsSink: { notice, attempt: vi.fn() },
        executeOperation: async (_models, _model, _context, options) => {
          await options.onPayload?.(
            {
              model: "gemini-3-test",
              contents: [],
              config: {},
            },
            googleModel,
          );
          dispatched = true;
          return terminal;
        },
      },
    });

    expect(dispatched).toBe(true);
    expect(result.supplementOutcomes).toContainEqual({
      control: "tools.parallelCalls",
      outcome: expect.objectContaining({ kind: "omitted" }),
    });
    expect(notice).toHaveBeenCalledWith({
      adapter: "openai-responses",
      direction: "request",
      code: "semantic_projection_omitted",
      action: "degrade",
    });
  });

  it("dispatches after omitting a forced tool choice rejected by the GOAT target", async () => {
    let dispatched = false;

    const result = await executeSemanticConversion({
      models: {} as Models,
      model: goatThinkingModel,
      invocation: invocation(),
      infrastructure: {
        executeOperation: async (_models, _model, _context, options) => {
          await options.onPayload?.(
            {
              model: "deepseek/deepseek-v4-flash",
              messages: [],
              stream: true,
            },
            goatThinkingModel,
          );
          dispatched = true;
          return terminal;
        },
      },
    });

    expect(dispatched).toBe(true);
    expect(result.supplementOutcomes).toContainEqual({
      control: "tools.choice",
      outcome: expect.objectContaining({ kind: "omitted" }),
    });
  });

  it("publishes a degraded notice for a verified Anthropic cache fallback", async () => {
    const target = invocation();
    const notice = vi.fn();
    const result = await executeSemanticConversion({
      models: {} as Models,
      model: anthropicModel,
      invocation: {
        ...target,
        supplement: {
          cache: {
            retention: { value: "24h" },
          },
        },
      },
      infrastructure: {
        factsSink: { notice, attempt: vi.fn() },
        executeOperation: async (_models, _model, _context, options) => {
          await options.onPayload?.(
            {
              model: "model-test",
              messages: [
                {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: "hello",
                      cache_control: { type: "ephemeral", ttl: "1h" },
                    },
                  ],
                },
              ],
              stream: true,
            },
            anthropicModel,
          );
          return terminal;
        },
      },
    });

    expect(result.supplementOutcomes).toContainEqual({
      control: "cache.retention",
      outcome: expect.objectContaining({ kind: "degraded" }),
    });
    expect(notice).toHaveBeenCalledWith({
      adapter: "anthropic-messages",
      direction: "request",
      code: "semantic_projection_degraded",
      action: "degrade",
    });
  });

  it("does not apply GOAT's forced-tool restriction to OpenCode GO", async () => {
    let finalPayload: unknown;

    await executeSemanticConversion({
      models: {} as Models,
      model: openCodeThinkingModel,
      invocation: invocation(),
      infrastructure: {
        executeOperation: async (_models, _model, _context, options) => {
          finalPayload = await options.onPayload?.(
            {
              model: "deepseek-v4-flash",
              messages: [],
              stream: true,
            },
            openCodeThinkingModel,
          );
          return terminal;
        },
      },
    });

    expect(finalPayload).toHaveProperty("tool_choice", "required");
  });

  it("does not dispatch when Pi changes an audited payload shape", async () => {
    let dispatched = false;

    await expect(
      executeSemanticConversion({
        models: {} as Models,
        model,
        invocation: invocation(),
        infrastructure: {
          executeOperation: async (_models, _model, _context, options) => {
            await options.onPayload?.(
              {
                model: "model-test",
                messages: "unexpected-shape",
                stream: true,
              },
              model,
            );
            dispatched = true;
            return terminal;
          },
        },
      }),
    ).rejects.toThrow(/payload shape mismatch/u);
    expect(dispatched).toBe(false);
  });

  it("keeps projection warnings fail-open when the diagnostics sink throws", async () => {
    const targetInvocation = invocation();
    const preference: SemanticConversionInvocation = {
      ...targetInvocation,
      reasoning: {
        ...targetInvocation.reasoning,
        request: {
          effort: { kind: "enabled", level: "low" },
          summary: { kind: "provider-default" },
        },
      },
      supplement: {},
    };

    const result = await executeSemanticConversion({
      models: {} as Models,
      model: unknownApiModel,
      invocation: preference,
      infrastructure: {
        factsSink: {
          attempt: vi.fn(),
          notice: vi.fn(() => {
            throw new Error("diagnostics unavailable");
          }),
        },
        executeOperation: async (_models, _model, _context, options) => {
          await options.onPayload?.(
            { model: "model-test", messages: [] },
            unknownApiModel,
          );
          return terminal;
        },
      },
    });

    expect(result.message).toBe(terminal);
    expect(result.reasoningOutcomes).toContainEqual({
      subject: "effort",
      outcome: expect.objectContaining({ kind: "degraded" }),
    });
  });
});
