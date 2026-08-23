import type {
  AssistantMessageEventStream,
  Context,
  Model,
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

import { captureFinalPiPayload } from "../support/pi-final-payload.js";

const context: Context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

function model<TApi extends string>(
  api: TApi,
  baseUrl = "https://provider.test/v1",
): Model<TApi> {
  return {
    id: "model-test",
    name: "model-test",
    api,
    provider: "provider-test",
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 1_024,
  };
}

const codexToken = `x.${Buffer.from(
  JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" },
  }),
).toString("base64url")}.x`;

interface PayloadShapeCase {
  readonly api: string;
  readonly start: (
    capture: (payload: unknown) => never,
  ) => AssistantMessageEventStream;
  readonly expected: Readonly<Record<string, unknown>>;
}

const cases: readonly PayloadShapeCase[] = [
  {
    api: "anthropic-messages",
    start: (onPayload) =>
      streamAnthropicMessages(model("anthropic-messages"), context, {
        apiKey: "test-only-key",
        maxTokens: 64,
        onPayload,
      }),
    expected: {
      model: "model-test",
      messages: expect.any(Array),
      stream: true,
      max_tokens: 64,
    },
  },
  {
    api: "openai-completions",
    start: (onPayload) =>
      streamOpenAICompletions(model("openai-completions"), context, {
        apiKey: "test-only-key",
        maxTokens: 64,
        onPayload,
      }),
    expected: { model: "model-test", messages: expect.any(Array), stream: true },
  },
  {
    api: "openai-responses",
    start: (onPayload) =>
      streamOpenAIResponses(model("openai-responses"), context, {
        apiKey: "test-only-key",
        maxTokens: 64,
        onPayload,
      }),
    expected: { model: "model-test", input: expect.any(Array), stream: true },
  },
  {
    api: "azure-openai-responses",
    start: (onPayload) =>
      streamAzureOpenAIResponses(
        model(
          "azure-openai-responses",
          "https://resource.openai.azure.com/openai",
        ),
        context,
        { apiKey: "test-only-key", maxTokens: 64, onPayload },
      ),
    expected: { model: "model-test", input: expect.any(Array), stream: true },
  },
  {
    api: "openai-codex-responses",
    start: (onPayload) =>
      streamOpenAICodexResponses(
        model(
          "openai-codex-responses",
          "https://chatgpt.com/backend-api/codex",
        ),
        context,
        { apiKey: codexToken, maxTokens: 64, onPayload },
      ),
    expected: { model: "model-test", input: expect.any(Array), stream: true },
  },
  {
    api: "google-generative-ai",
    start: (onPayload) =>
      streamGoogleGenerativeAI(model("google-generative-ai"), context, {
        apiKey: "test-only-key",
        maxTokens: 64,
        onPayload,
      }),
    expected: { model: "model-test", contents: expect.any(Array), config: {} },
  },
  {
    api: "google-vertex",
    start: (onPayload) =>
      streamGoogleVertex(model("google-vertex"), context, {
        apiKey: "test-only-key",
        maxTokens: 64,
        onPayload,
      }),
    expected: { model: "model-test", contents: expect.any(Array), config: {} },
  },
  {
    api: "mistral-conversations",
    start: (onPayload) =>
      streamMistralConversations(model("mistral-conversations"), context, {
        apiKey: "test-only-key",
        maxTokens: 64,
        onPayload,
      }),
    expected: { model: "model-test", messages: expect.any(Array), stream: true },
  },
  {
    api: "bedrock-converse-stream",
    start: (onPayload) =>
      streamBedrockConverse(
        model(
          "bedrock-converse-stream",
          "https://bedrock-runtime.us-east-1.amazonaws.com",
        ),
        context,
        {
          maxTokens: 64,
          env: { AWS_BEDROCK_SKIP_AUTH: "1", AWS_REGION: "us-east-1" },
          onPayload,
        },
      ),
    expected: {
      modelId: "model-test",
      messages: expect.any(Array),
      inferenceConfig: {},
    },
  },
  {
    api: "pi-messages",
    start: (onPayload) =>
      streamPiMessages(model("pi-messages"), context, {
        apiKey: "test-only-key",
        maxTokens: 64,
        onPayload,
      }),
    expected: { model: "model-test", context: {}, options: {} },
  },
];

describe("pinned Pi payload-shape certification", () => {
  it.each(cases)("certifies $api at the public onPayload seam", async (entry) => {
    const payload = await captureFinalPiPayload(entry.start);

    expect(payload).toMatchObject(entry.expected);
  });
});
