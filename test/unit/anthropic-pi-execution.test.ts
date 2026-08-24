import type {
  AssistantMessage,
  Context,
  Model,
  Models,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import {
  executeWithAnthropicPi,
  InvalidAnthropicPiExecution,
} from "../../src/protocols/anthropic/semantic/pi-execution.js";

const model: Model<"openai-completions"> = {
  id: "anthropic-pi-model",
  name: "Anthropic Pi model",
  api: "openai-completions",
  provider: "anthropic-pi-provider",
  baseUrl: "https://fixture.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_192,
  maxTokens: 1_024,
};

const context: Context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

const terminal: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "done" }],
  api: model.api,
  provider: model.provider,
  model: model.id,
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

const projectedOutcome = Object.freeze({
  control: "outputTokenCeiling",
  outcome: Object.freeze({
    kind: "payload-projected" as const,
    projector: "anthropic-test",
  }),
});

describe("Anthropic-owned Pi execution", () => {
  it("owns onPayload and returns Anthropic projection outcomes", async () => {
    const project = vi.fn((payload: unknown) => ({
      payload: { ...(payload as object), projected: true },
      outcomes: [projectedOutcome],
    }));
    let outbound: unknown;
    const result = await executeWithAnthropicPi({
      models: {} as Models,
      model,
      pi: { context, options: { maxTokens: 32 } },
      projection: { initialOutcomes: [], project },
      infrastructure: {
        executeOperation: async (_models, _model, _context, options) => {
          outbound = await options.onPayload?.({ model: model.id }, model);
          return terminal;
        },
      },
    });

    expect(outbound).toEqual({ model: model.id, projected: true });
    expect(project).toHaveBeenCalledOnce();
    expect(result).toEqual({ message: terminal, outcomes: [projectedOutcome] });
  });

  it("rejects a caller-owned payload callback", async () => {
    await expect(executeWithAnthropicPi({
      models: {} as Models,
      model,
      pi: { context, options: { onPayload: (payload) => payload } },
      projection: { initialOutcomes: [], project: (payload) => ({ payload, outcomes: [] }) },
      infrastructure: {},
    })).rejects.toBeInstanceOf(InvalidAnthropicPiExecution);
  });

  it("preserves a projection exception from a direct execution operation", async () => {
    const expected = new Error("Anthropic projection rejected the request");
    await expect(executeWithAnthropicPi({
      models: {} as Models,
      model,
      pi: { context, options: {} },
      projection: {
        initialOutcomes: [],
        project: () => {
          throw expected;
        },
      },
      infrastructure: {
        executeOperation: async (_models, _model, _context, options) => {
          await options.onPayload?.({}, model);
          return terminal;
        },
      },
    })).rejects.toBe(expected);
  });

  it("fails with the retained projection exception when a Provider swallows it", async () => {
    const expected = new Error("Anthropic projection must not be swallowed");
    await expect(executeWithAnthropicPi({
      models: {} as Models,
      model,
      pi: { context, options: {} },
      projection: {
        initialOutcomes: [],
        project: () => {
          throw expected;
        },
      },
      infrastructure: {
        executeOperation: async (_models, _model, _context, options) => {
          await Promise.resolve(options.onPayload?.({}, model)).catch(
            () => undefined,
          );
          return terminal;
        },
      },
    })).rejects.toBe(expected);
  });

  it("rejects when Pi skips the Anthropic payload seam", async () => {
    await expect(executeWithAnthropicPi({
      models: {} as Models,
      model,
      pi: { context, options: {} },
      projection: {
        initialOutcomes: [],
        project: (payload) => ({ payload, outcomes: [] }),
      },
      infrastructure: {
        executeOperation: async () => terminal,
      },
    })).rejects.toThrow(/without invoking/iu);
  });

  it("rejects when Pi invokes the Anthropic payload seam twice", async () => {
    await expect(executeWithAnthropicPi({
      models: {} as Models,
      model,
      pi: { context, options: {} },
      projection: {
        initialOutcomes: [],
        project: (payload) => ({ payload, outcomes: [] }),
      },
      infrastructure: {
        executeOperation: async (_models, _model, _context, options) => {
          await options.onPayload?.({}, model);
          await options.onPayload?.({}, model);
          return terminal;
        },
      },
    })).rejects.toThrow(/more than once/iu);
  });
});
