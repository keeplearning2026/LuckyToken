import type {
  AssistantMessageEventStream,
  Context,
  Model,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimple as streamAnthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as streamAzureOpenAIResponses } from "@earendil-works/pi-ai/api/azure-openai-responses";
import { streamSimple as streamBedrockConverse } from "@earendil-works/pi-ai/api/bedrock-converse-stream";
import { streamSimple as streamGoogleGenerativeAI } from "@earendil-works/pi-ai/api/google-generative-ai";
import { streamSimple as streamGoogleVertex } from "@earendil-works/pi-ai/api/google-vertex";
import { streamSimple as streamMistralConversations } from "@earendil-works/pi-ai/api/mistral-conversations";
import { streamSimple as streamOpenAICodexResponses } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { streamSimple as streamOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as streamPiMessages } from "@earendil-works/pi-ai/api/pi-messages";
import { describe, expect, it } from "vitest";

import { convertResponsesRequest } from "../../src/protocols/openai-responses/request.js";
import {
  prepareReasoning,
  projectReasoningPayload,
} from "../../src/semantic-conversion/reasoning/request.js";
import { projectSupplementPayload } from "../../src/semantic-conversion/supplement/request.js";
import { captureFinalPiPayload } from "../support/pi-final-payload.js";
import {
  captureJsonGlobalProviderRequest,
  captureJsonProviderRequest,
} from "../support/provider-request-capture.js";

type PinnedApi =
  | "anthropic-messages"
  | "azure-openai-responses"
  | "bedrock-converse-stream"
  | "google-generative-ai"
  | "google-vertex"
  | "mistral-conversations"
  | "openai-codex-responses"
  | "openai-completions"
  | "openai-responses"
  | "pi-messages";

function target<TApi extends PinnedApi>(api: TApi): Model<TApi> {
  const baseUrl =
    api === "azure-openai-responses"
      ? "https://resource.openai.azure.com/openai"
      : api === "openai-codex-responses"
        ? "https://chatgpt.com/backend-api/codex"
        : api === "bedrock-converse-stream"
          ? "https://bedrock-runtime.us-east-1.amazonaws.com"
          : "https://provider.test/v1";
  const id =
    api === "google-generative-ai" || api === "google-vertex"
      ? "gemini-3-test"
      : "model-test";
  const compat =
    api === "anthropic-messages"
      ? { supportsStrictTools: true }
      : api === "openai-completions" ||
          api === "openai-responses" ||
          api === "azure-openai-responses" ||
          api === "openai-codex-responses" ||
          api === "bedrock-converse-stream"
        ? { supportsStrictMode: true }
        : undefined;
  const resolved = {
    id,
    name: id,
    api,
    provider: "provider-test",
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 1_024,
    ...(compat === undefined ? {} : { compat }),
  };
  return resolved as Model<TApi>;
}

const codexToken = `x.${Buffer.from(
  JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" },
  }),
).toString("base64url")}.x`;

function start(
  api: PinnedApi,
  model: Model<PinnedApi>,
  context: Context,
  options: ModelsSimpleStreamOptions,
): AssistantMessageEventStream {
  switch (api) {
    case "anthropic-messages":
      return streamAnthropicMessages(model as Model<"anthropic-messages">, context, {
        ...options,
        apiKey: "test-only-key",
      });
    case "azure-openai-responses":
      return streamAzureOpenAIResponses(
        model as Model<"azure-openai-responses">,
        context,
        { ...options, apiKey: "test-only-key" },
      );
    case "bedrock-converse-stream":
      return streamBedrockConverse(
        model as Model<"bedrock-converse-stream">,
        context,
        {
          ...options,
          env: {
            ...options.env,
            AWS_BEDROCK_SKIP_AUTH: "1",
            AWS_REGION: "us-east-1",
          },
        },
      );
    case "google-generative-ai":
      return streamGoogleGenerativeAI(
        model as Model<"google-generative-ai">,
        context,
        { ...options, apiKey: "test-only-key" },
      );
    case "google-vertex":
      return streamGoogleVertex(model as Model<"google-vertex">, context, {
        ...options,
        apiKey: "test-only-key",
      });
    case "mistral-conversations":
      return streamMistralConversations(
        model as Model<"mistral-conversations">,
        context,
        { ...options, apiKey: "test-only-key" },
      );
    case "openai-codex-responses":
      return streamOpenAICodexResponses(
        model as Model<"openai-codex-responses">,
        context,
        { ...options, apiKey: codexToken },
      );
    case "openai-completions":
      return streamOpenAICompletions(
        model as Model<"openai-completions">,
        context,
        { ...options, apiKey: "test-only-key" },
      );
    case "openai-responses":
      return streamOpenAIResponses(model as Model<"openai-responses">, context, {
        ...options,
        apiKey: "test-only-key",
      });
    case "pi-messages":
      return streamPiMessages(model as Model<"pi-messages">, context, {
        ...options,
        apiKey: "test-only-key",
      });
  }
}

async function projectClientWire(
  api: PinnedApi,
  body: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const resolved = target(api);
  const converted = convertResponsesRequest(body, 1);
  const prepared = prepareReasoning({
    model: resolved,
    context: converted.invocation.pi.context,
    options: converted.invocation.pi.options,
    semantics: converted.invocation.reasoning,
  });

  return captureFinalPiPayload((capture) =>
    start(api, resolved, prepared.context, {
      ...prepared.options,
      onPayload(basePayload) {
        const reasoning = projectReasoningPayload({
          model: resolved,
          prepared,
          payload: basePayload,
        });
        const supplement = projectSupplementPayload({
          model: resolved,
          payload: reasoning.payload,
          supplement: converted.invocation.supplement,
          reasoning: converted.invocation.reasoning.request,
        });
        return capture(supplement.payload);
      },
    }),
  );
}

const functionTool = {
  type: "function",
  name: "lookup",
  description: "Lookup",
  parameters: { type: "object", properties: {} },
} as const;

const toolChoiceCases = [
  ["openai-completions", { tool_choice: { type: "function", function: { name: "lookup" } } }],
  ["openai-responses", { tool_choice: { type: "function", name: "lookup" } }],
  ["azure-openai-responses", { tool_choice: { type: "function", name: "lookup" } }],
  ["anthropic-messages", { tool_choice: { type: "tool", name: "lookup" } }],
  [
    "google-generative-ai",
    {
      config: {
        toolConfig: {
          functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["lookup"] },
        },
      },
    },
  ],
  [
    "google-vertex",
    {
      config: {
        toolConfig: {
          functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["lookup"] },
        },
      },
    },
  ],
  ["mistral-conversations", { toolChoice: { type: "function", function: { name: "lookup" } } }],
  ["bedrock-converse-stream", { toolConfig: { toolChoice: { tool: { name: "lookup" } } } }],
  ["pi-messages", { options: { toolChoice: { type: "function", function: { name: "lookup" } } } }],
] as const satisfies readonly (readonly [PinnedApi, Readonly<Record<string, unknown>>])[];

const requiredChoiceCases = [
  ["openai-completions", { tool_choice: "required" }],
  ["openai-responses", { tool_choice: "required" }],
  ["azure-openai-responses", { tool_choice: "required" }],
  ["openai-codex-responses", { tool_choice: "required" }],
  ["anthropic-messages", { tool_choice: { type: "any" } }],
  [
    "google-generative-ai",
    { config: { toolConfig: { functionCallingConfig: { mode: "ANY" } } } },
  ],
  [
    "google-vertex",
    { config: { toolConfig: { functionCallingConfig: { mode: "ANY" } } } },
  ],
  ["mistral-conversations", { toolChoice: "required" }],
  ["bedrock-converse-stream", { toolConfig: { toolChoice: { any: {} } } }],
  ["pi-messages", { options: { toolChoice: "required" } }],
] as const satisfies readonly (readonly [PinnedApi, Readonly<Record<string, unknown>>])[];

const parallelCases = [
  ["openai-completions", { parallel_tool_calls: false }],
  ["openai-responses", { parallel_tool_calls: false }],
  ["azure-openai-responses", { parallel_tool_calls: false }],
  [
    "anthropic-messages",
    { tool_choice: { type: "auto", disable_parallel_tool_use: true } },
  ],
  ["mistral-conversations", { parallelToolCalls: false }],
] as const satisfies readonly (readonly [PinnedApi, Readonly<Record<string, unknown>>])[];

const formatCases = [
  [
    "openai-completions",
    { response_format: { type: "json_schema", json_schema: { name: "answer" } } },
  ],
  ["openai-responses", { text: { format: { type: "json_schema", name: "answer" } } }],
  [
    "azure-openai-responses",
    { text: { format: { type: "json_schema", name: "answer" } } },
  ],
  [
    "anthropic-messages",
    { output_config: { format: { type: "json_schema", schema: { type: "object" } } } },
  ],
  [
    "google-generative-ai",
    { config: { responseMimeType: "application/json", responseJsonSchema: { type: "object" } } },
  ],
  [
    "google-vertex",
    { config: { responseMimeType: "application/json", responseJsonSchema: { type: "object" } } },
  ],
  [
    "mistral-conversations",
    { responseFormat: { type: "json_schema", json_schema: { name: "answer" } } },
  ],
] as const satisfies readonly (readonly [PinnedApi, Readonly<Record<string, unknown>>])[];

describe("Client Responses to Provider payload certification", () => {
  it.each(toolChoiceCases)("projects named tool choice for %s", async (api, expected) => {
    const payload = await projectClientWire(api, {
      model: "client-selector",
      input: "hello",
      tools: [functionTool],
      tool_choice: { type: "function", name: "lookup" },
    });

    expect(payload).toMatchObject(expected);
  });

  it.each(requiredChoiceCases)("projects required tool choice for %s", async (api, expected) => {
    const payload = await projectClientWire(api, {
      model: "client-selector",
      input: "hello",
      tools: [functionTool],
      tool_choice: "required",
    });

    expect(payload).toMatchObject(expected);
  });

  it.each(parallelCases)("projects serial tool use for %s", async (api, expected) => {
    const payload = await projectClientWire(api, {
      model: "client-selector",
      input: "hello",
      tools: [functionTool],
      parallel_tool_calls: false,
    });

    expect(payload).toMatchObject(expected);
  });

  it.each(formatCases)("projects JSON Schema output for %s", async (api, expected) => {
    const payload = await projectClientWire(api, {
      model: "client-selector",
      input: "hello",
      text: {
        format: {
          type: "json_schema",
          name: "answer",
          schema: { type: "object", properties: {} },
          strict: true,
        },
      },
    });

    expect(payload).toMatchObject(expected);
  });

  it("certifies Mistral's post-callback HTTP wire serialization", async () => {
    const resolved = target("mistral-conversations");
    const converted = convertResponsesRequest(
      {
        model: "client-selector",
        input: "hello",
        tools: [functionTool],
        tool_choice: { type: "function", name: "lookup" },
        parallel_tool_calls: false,
        top_p: 0.7,
        text: {
          format: {
            type: "json_schema",
            name: "answer",
            schema: { type: "object", properties: {} },
            strict: true,
          },
        },
      },
      1,
    );
    const prepared = prepareReasoning({
      model: resolved,
      context: converted.invocation.pi.context,
      options: converted.invocation.pi.options,
      semantics: converted.invocation.reasoning,
    });

    const request = await captureJsonProviderRequest((fetch) =>
      streamMistralConversations(resolved, prepared.context, {
        ...prepared.options,
        apiKey: "test-only-key",
        fetch,
        onPayload(basePayload) {
          const reasoning = projectReasoningPayload({
            model: resolved,
            prepared,
            payload: basePayload,
          });
          return projectSupplementPayload({
            model: resolved,
            payload: reasoning.payload,
            supplement: converted.invocation.supplement,
            reasoning: converted.invocation.reasoning.request,
          }).payload;
        },
      }),
    );

    expect(request).toMatchObject({
      method: "POST",
      body: {
        response_format: {
          type: "json_schema",
          json_schema: { name: "answer" },
        },
        parallel_tool_calls: false,
        tool_choice: { type: "function", function: { name: "lookup" } },
        top_p: 0.7,
      },
    });
  });

  it("certifies Google's post-callback HTTP wire serialization", async () => {
    const resolved = target("google-generative-ai");
    const converted = convertResponsesRequest(
      {
        model: "client-selector",
        input: "hello",
        tools: [functionTool],
        tool_choice: { type: "function", name: "lookup" },
        top_p: 0.7,
        text: {
          format: {
            type: "json_schema",
            name: "answer",
            schema: { type: "object", properties: {} },
            strict: true,
          },
        },
      },
      1,
    );
    const prepared = prepareReasoning({
      model: resolved,
      context: converted.invocation.pi.context,
      options: converted.invocation.pi.options,
      semantics: converted.invocation.reasoning,
    });

    const request = await captureJsonGlobalProviderRequest(() =>
      streamGoogleGenerativeAI(resolved, prepared.context, {
        ...prepared.options,
        apiKey: "test-only-key",
        onPayload(basePayload) {
          const reasoning = projectReasoningPayload({
            model: resolved,
            prepared,
            payload: basePayload,
          });
          return projectSupplementPayload({
            model: resolved,
            payload: reasoning.payload,
            supplement: converted.invocation.supplement,
            reasoning: converted.invocation.reasoning.request,
          }).payload;
        },
      }),
    );

    expect(request).toMatchObject({
      method: "POST",
      body: {
        generationConfig: {
          responseMimeType: "application/json",
          responseJsonSchema: { type: "object" },
          topP: 0.7,
        },
        toolConfig: {
          functionCallingConfig: {
            mode: "ANY",
            allowedFunctionNames: ["lookup"],
          },
        },
      },
    });
  });
});
