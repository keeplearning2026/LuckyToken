import type {
  AssistantMessage,
  Context,
  Model,
  Models,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { executeWithResponsesPi } from "../../src/protocols/openai-responses/semantic/pi-execution.js";

const model: Model<"openai-completions"> = {
  id: "responses-pi-model",
  name: "Responses Pi model",
  api: "openai-completions",
  provider: "responses-pi-provider",
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

describe("OpenAI Responses-owned Pi execution", () => {
  it("owns onPayload and returns Responses projection outcomes", async () => {
    const project = vi.fn((payload: unknown) => ({
      payload: { ...(payload as object), projected: true },
      outcomes: [{ control: "responses-owned", state: "projected" }] as const,
    }));
    let outbound: unknown;

    const result = await executeWithResponsesPi({
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
    expect(result).toEqual({
      message: terminal,
      outcomes: [{ control: "responses-owned", state: "projected" }],
    });
  });

  it("publishes the final projected Provider payload through a fail-open protocol-local seam", async () => {
    const providerPayloads: unknown[] = [];
    const providerResponses: unknown[] = [];
    const result = await executeWithResponsesPi({
      models: {} as Models,
      model,
      pi: { context, options: {} },
      projection: {
        initialOutcomes: [],
        project: () => ({ payload: { final: "provider-wire" }, outcomes: [] }),
      },
      infrastructure: {
        providerEvidence: {
          request(payload) {
            providerPayloads.push(payload);
            throw new Error("diagnostics observer crashed");
          },
          response(response) {
            providerResponses.push(response);
            throw new Error("diagnostics response observer crashed");
          },
        },
        executeOperation: async (_models, _model, _context, options) => {
          await options.onPayload?.({ draft: true }, model);
          await options.onResponse?.(
            { status: 200, headers: { "request-id": "response-1" } },
            model,
          );
          return terminal;
        },
      },
    });

    expect(providerPayloads).toEqual([{ final: "provider-wire" }]);
    expect(providerResponses).toEqual([
      { status: 200, headers: { "request-id": "response-1" } },
    ]);
    expect(result.message).toBe(terminal);
  });
});
