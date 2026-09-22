import type {
  AssistantMessage,
  Context,
  Model,
  Models,
} from "@earendil-works/pi-ai";
import type { ExecutionFactsSink } from "@token/provider-contract/diagnostics";
import { describe, expect, it } from "vitest";

import type { ExecutionOperation } from "../../src/execution.js";
import { createPiContextCompatibleExecution } from "../../src/pi-context-compatibility-execution.js";
import { InvalidRequest as AnthropicInvalidRequest } from "../../src/protocols/anthropic/failures.js";
import { parseAnthropicTextInvocation } from "../../src/protocols/anthropic/request.js";
import { executeAnthropicSemanticInvocation } from "../../src/protocols/anthropic/semantic/execution.js";
import {
  InvalidRequest as ResponsesInvalidRequest,
  convertResponsesRequest,
} from "../../src/protocols/openai-responses/request.js";
import { executeOpenAIResponsesSemanticInvocation } from "../../src/protocols/openai-responses/semantic/execution.js";

function model(
  api: "openai-responses" | "anthropic-messages",
  supportsMidConvoSystemMessages?: boolean,
): Model<string> {
  return {
    id: "model",
    name: "model",
    api,
    provider: "test-provider",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
    ...(supportsMidConvoSystemMessages === undefined
      ? {}
      : { compat: { supportsMidConvoSystemMessages } }),
  } as Model<string>;
}

function assistant(api: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api,
    provider: "test-provider",
    model: "model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

function captureExecution(captured: Context[]): ExecutionOperation {
  return async (_models, model, context) => {
    captured.push(context);
    return assistant(model.api);
  };
}

const models = {} as Models;

describe("semantic execution Pi Context compatibility", () => {
  it("passes Responses mid-system through unchanged for a supported model", async () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          { type: "message", role: "user", content: "before" },
          { type: "message", role: "system", content: "later" },
          { type: "message", role: "user", content: "after" },
        ],
      },
      1,
    ).invocation;
    const captured: Context[] = [];

    await executeOpenAIResponsesSemanticInvocation({
      models,
      model: model("openai-responses", true),
      invocation,
      infrastructure: {
        executeOperation: createPiContextCompatibleExecution(captureExecution(captured)),
      },
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toStrictEqual(invocation.pi.context);
    expect(captured[0]?.messages.map((message) => message.role)).toEqual([
      "user",
      "system",
      "user",
    ]);
  });

  it("degrades Responses mid-system before execution and publishes one compatibility warning", async () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          { type: "message", role: "user", content: "before" },
          { type: "message", role: "developer", content: "later" },
          { type: "message", role: "user", content: "after" },
        ],
      },
      1,
    ).invocation;
    const captured: Context[] = [];
    const notices: Array<{ code?: string }> = [];
    const factsSink = {
      notice(value: { code?: string }) {
        notices.push(value);
      },
    } as unknown as ExecutionFactsSink;

    await executeOpenAIResponsesSemanticInvocation({
      models,
      model: model("openai-responses", false),
      invocation,
      infrastructure: {
        executeOperation: createPiContextCompatibleExecution(captureExecution(captured)),
        factsSink,
      },
    });

    expect(captured[0]?.messages.map((message) => message.role)).toEqual([
      "user",
      "user",
      "user",
    ]);
    expect(notices).toEqual([
      expect.objectContaining({ code: "pi_mid_system_degraded_to_user" }),
    ]);
  });

  it("maps an unsafe complex Responses mid-system compatibility failure to InvalidRequest before execution", async () => {
    const base = convertResponsesRequest(
      {
        model: "m",
        input: [
          { type: "message", role: "user", content: "before" },
          { type: "message", role: "system", content: "later" },
        ],
      },
      1,
    ).invocation;
    const midSystem = base.pi.context.messages[1];
    if (midSystem?.role !== "system") throw new Error("expected system fixture");
    const invocation = {
      ...base,
      pi: {
        ...base.pi,
        context: {
          ...base.pi.context,
          messages: [
            base.pi.context.messages[0]!,
            { ...midSystem, sections: { policy: "updated" } },
          ],
        },
      },
    };
    let executed = false;

    await expect(
      executeOpenAIResponsesSemanticInvocation({
        models,
        model: model("openai-responses", false),
        invocation,
        infrastructure: {
          executeOperation: createPiContextCompatibleExecution(async () => {
            executed = true;
            return assistant("openai-responses");
          }),
        },
      }),
    ).rejects.toBeInstanceOf(ResponsesInvalidRequest);
    expect(executed).toBe(false);
  });

  it("applies the same compatibility rule to Anthropic semantic execution", async () => {
    const conversion = parseAnthropicTextInvocation(
      {
        model: "m",
        max_tokens: 128,
        messages: [
          { role: "user", content: "before" },
          { role: "system", content: "later" },
        ],
      },
      1,
    );
    const captured: Context[] = [];

    await executeAnthropicSemanticInvocation({
      models,
      model: model("anthropic-messages", false),
      invocation: conversion.invocation,
      execution: {
        executeOperation: createPiContextCompatibleExecution(captureExecution(captured)),
      },
    });

    expect(captured[0]?.messages.map((message) => message.role)).toEqual([
      "user",
      "user",
    ]);
  });

  it("maps an unsafe complex Anthropic mid-system compatibility failure to InvalidRequest before execution", async () => {
    const base = parseAnthropicTextInvocation(
      {
        model: "m",
        max_tokens: 128,
        messages: [
          { role: "user", content: "before" },
          { role: "system", content: "later" },
        ],
      },
      1,
    ).invocation;
    const midSystem = base.pi.context.messages[1];
    if (midSystem?.role !== "system") throw new Error("expected system fixture");
    const invocation = {
      ...base,
      pi: {
        ...base.pi,
        context: {
          ...base.pi.context,
          messages: [
            base.pi.context.messages[0]!,
            { ...midSystem, toolsRemoved: [{ name: "lookup" }] },
          ],
        },
      },
    };
    let executed = false;

    await expect(
      executeAnthropicSemanticInvocation({
        models,
        model: model("anthropic-messages", false),
        invocation,
        execution: {
          executeOperation: createPiContextCompatibleExecution(async () => {
            executed = true;
            return assistant("anthropic-messages");
          }),
        },
      }),
    ).rejects.toBeInstanceOf(AnthropicInvalidRequest);
    expect(executed).toBe(false);
  });
});
