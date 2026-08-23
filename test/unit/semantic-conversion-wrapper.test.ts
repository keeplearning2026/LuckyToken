import type {
  AssistantMessage,
  Context,
  Model,
  Models,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import type { SemanticConversionInvocation } from "../../src/semantic-conversion/contract.js";
import {
  executeSemanticConversion,
  InvalidSemanticExecution,
} from "../../src/semantic-conversion/execution.js";

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
          requirement: "hard",
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
          temperature: { requirement: "preference", value: 0.4 },
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

  it("fails before dispatch when a hard reasoning control has no certified target mapping", async () => {
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

    await expect(
      executeSemanticConversion({
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
      }),
    ).rejects.toThrow(/certified reasoning payload Adapter/u);
    expect(dispatched).toBe(false);
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
          outcome: expect.objectContaining({ kind: "omitted" }),
        },
        {
          subject: "summary",
          outcome: expect.objectContaining({ kind: "omitted" }),
        },
      ]),
    );
    expect(notice).toHaveBeenCalledTimes(2);
    expect(notice).toHaveBeenCalledWith({
      adapter: "semantic-conversion",
      direction: "request",
      code: "semantic_projection_omitted",
      action: "degrade",
    });
  });

  it("does not dispatch when the target cannot satisfy a hard serial-tool requirement", async () => {
    const targetInvocation = invocation();
    const serialTools: SemanticConversionInvocation = {
      ...targetInvocation,
      supplement: {
        tools: {
          parallelCalls: { requirement: "hard", value: false },
        },
      },
    };
    let dispatched = false;

    await expect(
      executeSemanticConversion({
        models: {} as Models,
        model: googleModel,
        invocation: serialTools,
        infrastructure: {
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
      }),
    ).rejects.toThrow(/cannot guarantee serial tool calls/u);
    expect(dispatched).toBe(false);
  });

  it("does not dispatch a forced tool choice rejected by the certified GOAT thinking model", async () => {
    let dispatched = false;

    await expect(
      executeSemanticConversion({
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
      }),
    ).rejects.toThrow(/thinking mode does not support forced tool_choice/u);
    expect(dispatched).toBe(false);
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
      outcome: expect.objectContaining({ kind: "omitted" }),
    });
  });
});
