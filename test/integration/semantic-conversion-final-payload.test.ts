import { streamSimple as streamAnthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as streamOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { captureFinalPiPayload } from "../support/pi-final-payload.js";
import { convertResponsesRequest } from "../../src/protocols/openai-responses/request.js";
import { convertAssistantMessageToResponses } from "../../src/protocols/openai-responses/response.js";
import {
  prepareResponsesReasoning as prepareReasoning,
  projectResponsesReasoningPayload as projectReasoningPayload,
} from "../../src/protocols/openai-responses/semantic/reasoning/request.js";
import { projectResponsesPayload as projectSupplementPayload } from "../../src/protocols/openai-responses/semantic/projection/request.js";

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

const responsesModel: Model<"openai-responses"> = {
  ...model,
  api: "openai-responses",
  compat: { supportsStrictMode: true },
};

const anthropicModel: Model<"anthropic-messages"> = {
  ...model,
  api: "anthropic-messages",
};

const context: Context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

describe("Semantic Conversion final Provider payload tracer", () => {
  it("captures the OpenAI Completions body at Pi's public onPayload seam", async () => {
    const payload = await captureFinalPiPayload((onPayload) =>
      streamOpenAICompletions(model, context, {
        apiKey: "test-only-key",
        maxTokens: 64,
        onPayload,
      }),
    );

    expect(payload).toMatchObject({
      model: "model-test",
      messages: [{ role: "user", content: "hello" }],
      max_completion_tokens: 64,
      stream: true,
    });
  });

  it("restores Responses history to the final OpenAI Completions reasoning field", async () => {
    const converted = convertResponsesRequest(
      {
        model: "client-selector",
        input: [
          {
            type: "reasoning",
            id: "rs_prior",
            summary: [{ type: "summary_text", text: "visible summary" }],
            luckytoken_continuity: {
              version: 1,
              source: {
                provider: "provider-test",
                api: "openai-completions",
                model: "model-test",
              },
              attachments: [
                {
                  target: "thinking",
                  kind: "reasoning-field-selector",
                  value: "reasoning_content",
                },
              ],
            },
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "answer" }],
          },
          { type: "message", role: "user", content: "continue" },
        ],
      },
      1,
    );
    const prepared = prepareReasoning({
      model,
      context: converted.invocation.pi.context,
      options: converted.invocation.pi.options,
      semantics: converted.invocation.reasoning,
    });

    const payload = await captureFinalPiPayload((onPayload) =>
      streamOpenAICompletions(model, prepared.context, {
        ...prepared.options,
        apiKey: "test-only-key",
        onPayload,
      }),
    );

    expect(payload).toMatchObject({
      messages: [
        {
          role: "assistant",
          content: "answer",
          reasoning_content: "visible summary",
        },
        {
          role: "user",
          content: [{ type: "text", text: "continue" }],
        },
      ],
    });
  });

  it("projects the complete Responses controls after Pi builds Chat Completions", async () => {
    const converted = convertResponsesRequest(
      {
        model: "client-selector",
        input: "hello",
        text: {
          format: {
            type: "json_schema",
            name: "answer",
            schema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              additionalProperties: false,
            },
            strict: true,
          },
        },
        tools: [
          {
            type: "function",
            name: "lookup",
            description: "Lookup",
            parameters: { type: "object", properties: {} },
          },
        ],
        tool_choice: { type: "function", name: "lookup" },
        parallel_tool_calls: false,
        top_p: 0.7,
        service_tier: "priority",
        safety_identifier: "safe-user",
      },
      1,
    );
    const prepared = prepareReasoning({
      model,
      context: converted.invocation.pi.context,
      options: converted.invocation.pi.options,
      semantics: converted.invocation.reasoning,
    });

    const payload = await captureFinalPiPayload((capture) =>
      streamOpenAICompletions(model, prepared.context, {
        ...prepared.options,
        apiKey: "test-only-key",
        onPayload(basePayload) {
          const reasoning = projectReasoningPayload({
            model,
            prepared,
            payload: basePayload,
          });
          const supplement = projectSupplementPayload({
            model,
            payload: reasoning.payload,
            supplement: converted.invocation.supplement,
            reasoning: converted.invocation.reasoning.request,
          });
          return capture(supplement.payload);
        },
      }),
    );

    expect(payload).toMatchObject({
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "answer",
          strict: true,
          schema: {
            type: "object",
            required: ["value"],
            additionalProperties: false,
          },
        },
      },
      tool_choice: { type: "function", function: { name: "lookup" } },
      parallel_tool_calls: false,
      top_p: 0.7,
      service_tier: "priority",
      safety_identifier: "safe-user",
    });
  });

  it("projects a named function into the final Responses tool-choice shape", async () => {
    const converted = convertResponsesRequest(
      {
        model: "client-selector",
        input: "hello",
        tools: [
          {
            type: "function",
            name: "lookup",
            description: "Lookup",
            parameters: { type: "object", properties: {} },
          },
        ],
        tool_choice: { type: "function", name: "lookup" },
      },
      1,
    );
    const prepared = prepareReasoning({
      model: responsesModel,
      context: converted.invocation.pi.context,
      options: converted.invocation.pi.options,
      semantics: converted.invocation.reasoning,
    });

    const payload = await captureFinalPiPayload((capture) =>
      streamOpenAIResponses(responsesModel, prepared.context, {
        ...prepared.options,
        apiKey: "test-only-key",
        onPayload(basePayload) {
          const reasoning = projectReasoningPayload({
            model: responsesModel,
            prepared,
            payload: basePayload,
          });
          const supplement = projectSupplementPayload({
            model: responsesModel,
            payload: reasoning.payload,
            supplement: converted.invocation.supplement,
            reasoning: converted.invocation.reasoning.request,
          });
          return capture(supplement.payload);
        },
      }),
    );

    expect(payload).toMatchObject({
      tool_choice: { type: "function", name: "lookup" },
    });
  });

  it("replays Anthropic redacted thinking as redacted_thinking after a Responses history round trip", async () => {
    const providerResponse: AssistantMessage = {
      role: "assistant",
      provider: anthropicModel.provider,
      api: anthropicModel.api,
      model: anthropicModel.id,
      content: [
        {
          type: "thinking",
          thinking: "[Reasoning redacted]",
          thinkingSignature: "opaque-redacted-data",
          redacted: true,
        },
        { type: "text", text: "answer" },
      ],
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    };
    const clientResponse = convertAssistantMessageToResponses(
      providerResponse,
      { clientModel: "client-selector", stream: false, notices: [] },
      "resp_redacted",
      1,
      undefined,
    );
    const converted = convertResponsesRequest(
      {
        model: "client-selector",
        input: [
          ...clientResponse.output,
          { type: "message", role: "user", content: "continue" },
        ],
      },
      2,
    );
    const prepared = prepareReasoning({
      model: anthropicModel,
      context: converted.invocation.pi.context,
      options: converted.invocation.pi.options,
      semantics: converted.invocation.reasoning,
    });

    const payload = await captureFinalPiPayload((onPayload) =>
      streamAnthropicMessages(anthropicModel, prepared.context, {
        ...prepared.options,
        apiKey: "test-only-key",
        onPayload,
      }),
    );

    expect(payload).toMatchObject({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "redacted_thinking", data: "opaque-redacted-data" },
            { type: "text", text: "answer" },
          ],
        },
        { role: "user", content: [{ type: "text", text: "continue" }] },
      ],
    });
  });
});
