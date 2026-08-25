import { streamSimple as streamOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as streamAnthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as streamGoogleGenerativeAI } from "@earendil-works/pi-ai/api/google-generative-ai";
import { streamSimple as streamGoogleVertex } from "@earendil-works/pi-ai/api/google-vertex";
import { streamSimple as streamMistral } from "@earendil-works/pi-ai/api/mistral-conversations";
import { streamSimple as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as streamAzureOpenAIResponses } from "@earendil-works/pi-ai/api/azure-openai-responses";
import { streamSimple as streamBedrock } from "@earendil-works/pi-ai/api/bedrock-converse-stream";
import { streamSimple as streamPiMessages } from "@earendil-works/pi-ai/api/pi-messages";
import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { createCommandCodePrivateProvider } from "../../packages/provider-commandcode-private/src/provider.js";

import { parseAnthropicTextInvocation } from "../../src/protocols/anthropic/request.js";
import type { AnthropicSemanticInvocation } from "../../src/protocols/anthropic/semantic/invocation.js";
import { prepareAnthropicPayloadProjection } from "../../src/protocols/anthropic/semantic/projection/request.js";
import { prepareAnthropicReasoning } from "../../src/protocols/anthropic/semantic/reasoning/request.js";
import { captureFinalPiPayload } from "../support/pi-final-payload.js";
import { captureJsonProviderRequest } from "../support/provider-request-capture.js";

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function prepareAnthropicFinalPipeline(
  model: Model<string>,
  invocation: AnthropicSemanticInvocation,
) {
  const prepared = prepareAnthropicReasoning({ model, invocation });
  return Object.freeze({
    pi: prepared.invocation.pi,
    projection: prepareAnthropicPayloadProjection({
      model,
      invocation: prepared.invocation,
      effortPlan: prepared.effortPlan,
    }),
  });
}

const baseModelFields = {
  baseUrl: "https://provider.invalid/v1",
  input: ["text"] as ("text" | "image")[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_768,
  maxTokens: 8_192,
};

const model: Model<"openai-completions"> = {
  ...baseModelFields,
  id: "deepseek-v4-flash",
  name: "DeepSeek V4 Flash",
  api: "openai-completions",
  provider: "opencode-go",
  reasoning: false,
};

const commandCodePrivateModel: Model<"commandcode-private"> = {
  ...baseModelFields,
  id: "deepseek/deepseek-v4-flash",
  name: "DeepSeek V4 Flash",
  api: "commandcode-private",
  provider: "commandcode-private",
  reasoning: true,
  thinkingLevelMap: {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: "high",
    xhigh: null,
    max: "max",
  },
};

describe("Anthropic Client Wire to final CommandCode Private payload", () => {
  it("validates and projects against the custom Provider's actual onPayload shape", async () => {
    const converted = parseAnthropicTextInvocation({
      model: "client-selector",
      max_tokens: 2_048,
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.4,
      top_p: 0.8,
      top_k: 12,
      output_config: { effort: "high" },
    }, 1);
    const pipeline = prepareAnthropicFinalPipeline(commandCodePrivateModel, converted.invocation);
    const projection = pipeline.projection;
    const provider = createCommandCodePrivateProvider({
      apiKey: "test-only-key",
      model: commandCodePrivateModel,
      now: () => 1,
      fetch: async () => {
        throw new Error("capture must stop before transport");
      },
    });
    const payload = await captureFinalPiPayload((capture) =>
      provider.streamSimple(
        commandCodePrivateModel,
        pipeline.pi.context,
        {
          ...pipeline.pi.options,
          sessionId: "00000000-0000-4000-8000-000000000123",
          async onPayload(basePayload) {
            const projected = await projection.project(basePayload, commandCodePrivateModel);
            return capture(projected.payload);
          },
        },
      ),
    );

    expect(payload).toMatchObject({
      params: {
        model: "deepseek/deepseek-v4-flash",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        max_tokens: 2_048,
        temperature: 0.4,
        reasoning_effort: "high",
        stream: true,
      },
    });
    expect(payload).not.toHaveProperty("params.top_p");
    expect(payload).not.toHaveProperty("params.top_k");
  });

  it("normalizes an unknown Anthropic effort to Pi max and emits only the model's legal max wire value", async () => {
    const converted = parseAnthropicTextInvocation({
      model: "client-selector",
      max_tokens: 2_048,
      messages: [{ role: "user", content: "hello" }],
      output_config: { effort: "super" },
    }, 1);
    const pipeline = prepareAnthropicFinalPipeline(
      commandCodePrivateModel,
      converted.invocation,
    );
    const provider = createCommandCodePrivateProvider({
      apiKey: "test-only-key",
      model: commandCodePrivateModel,
      now: () => 1,
      fetch: async () => {
        throw new Error("capture must stop before transport");
      },
    });

    const payload = await captureFinalPiPayload((capture) =>
      provider.streamSimple(
        commandCodePrivateModel,
        pipeline.pi.context,
        {
          ...pipeline.pi.options,
          sessionId: "00000000-0000-4000-8000-000000000123",
          async onPayload(basePayload) {
            const projected = await pipeline.projection.project(
              basePayload,
              commandCodePrivateModel,
            );
            return capture(projected.payload);
          },
        },
      ),
    );

    expect(converted.client.notices).toContainEqual(
      expect.objectContaining({
        code: "anthropic_unknown_effort_fallback",
        action: "degrade",
      }),
    );
    expect(pipeline.pi.options.reasoning).toBe("max");
    expect(payload).toHaveProperty("params.reasoning_effort", "max");
  });

  it("dispatches an all-null reasoning model without any effort field", async () => {
    const noSelectableModel: Model<"commandcode-private"> = {
      ...commandCodePrivateModel,
      id: "no-selectable-level",
      name: "No selectable level",
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: null,
        medium: null,
        high: null,
        xhigh: null,
        max: null,
      },
    };
    const converted = parseAnthropicTextInvocation({
      model: "client-selector",
      max_tokens: 2_048,
      messages: [{ role: "user", content: "hello" }],
      output_config: { effort: "high" },
    }, 1);
    const pipeline = prepareAnthropicFinalPipeline(
      noSelectableModel,
      converted.invocation,
    );
    const provider = createCommandCodePrivateProvider({
      apiKey: "test-only-key",
      model: noSelectableModel,
      now: () => 1,
      fetch: async () => {
        throw new Error("capture must stop before transport");
      },
    });
    let outcomes: Awaited<ReturnType<typeof pipeline.projection.project>>["outcomes"] = [];

    const payload = await captureFinalPiPayload((capture) =>
      provider.streamSimple(noSelectableModel, pipeline.pi.context, {
        ...pipeline.pi.options,
        sessionId: "00000000-0000-4000-8000-000000000123",
        async onPayload(basePayload) {
          const projected = await pipeline.projection.project(
            basePayload,
            noSelectableModel,
          );
          outcomes = projected.outcomes;
          return capture(projected.payload);
        },
      }),
    );

    expect(pipeline.pi.options).not.toHaveProperty("reasoning");
    expect(payload).not.toHaveProperty("params.reasoning_effort");
    expect(outcomes).toContainEqual({
      control: "reasoning.effort",
      outcome: {
        kind: "degraded",
        warning: expect.stringMatching(
          /no selectable reasoning level.*Provider default was retained/iu,
        ),
      },
    });
  });
});
const anthropicModel: Model<"anthropic-messages"> = {
  ...baseModelFields,
  id: "claude-semantic-target",
  name: "Claude semantic target",
  api: "anthropic-messages",
  provider: "custom-anthropic",
  reasoning: true,
};

const googleModel: Model<"google-generative-ai"> = {
  ...baseModelFields,
  id: "gemini-2.5-pro",
  name: "Gemini 2.5 Pro",
  api: "google-generative-ai",
  provider: "google-test",
  reasoning: true,
};

const vertexModel: Model<"google-vertex"> = {
  ...googleModel,
  api: "google-vertex",
  provider: "google-vertex-test",
};

const mistralModel: Model<"mistral-conversations"> = {
  ...baseModelFields,
  id: "magistral-medium-latest",
  name: "Magistral Medium",
  api: "mistral-conversations",
  provider: "mistral-test",
  reasoning: true,
  thinkingLevelMap: {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: null,
    xhigh: null,
    max: null,
  },
};

const responsesModel: Model<"openai-responses"> = {
  ...baseModelFields,
  id: "gpt-semantic-target",
  name: "GPT semantic target",
  api: "openai-responses",
  provider: "openai-test",
  reasoning: false,
};

const azureResponsesModel: Model<"azure-openai-responses"> = {
  ...baseModelFields,
  id: "azure-semantic-target",
  name: "Azure semantic target",
  api: "azure-openai-responses",
  provider: "azure-test",
  baseUrl: "https://resource.openai.azure.com/openai",
  reasoning: false,
};

const bedrockClaudeModel: Model<"bedrock-converse-stream"> = {
  ...baseModelFields,
  id: "us.anthropic.claude-sonnet-4-6",
  name: "Claude Sonnet 4.6",
  api: "bedrock-converse-stream",
  provider: "amazon-bedrock",
  baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
  reasoning: true,
  thinkingLevelMap: {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: "high",
    xhigh: null,
    max: null,
  },
};

const bedrockNovaModel: Model<"bedrock-converse-stream"> = {
  ...baseModelFields,
  id: "amazon.nova-pro-v1:0",
  name: "Amazon Nova Pro",
  api: "bedrock-converse-stream",
  provider: "amazon-bedrock",
  baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
  reasoning: false,
};

const piMessagesModel: Model<"pi-messages"> = {
  ...baseModelFields,
  id: "pi-semantic-target",
  name: "Pi Messages semantic target",
  api: "pi-messages",
  provider: "pi-test",
  reasoning: true,
};

describe("Anthropic Client Wire to final OpenAI Completions payload", () => {
  it("preserves Pi's stricter context-clamped output ceiling", async () => {
    const constrainedModel: Model<"openai-completions"> = {
      ...model,
      contextWindow: 4_097,
    };
    const converted = parseAnthropicTextInvocation(
      {
        model: "client-selector",
        max_tokens: 2_048,
        messages: [{ role: "user", content: "hello" }],
      },
      1,
    );
    const pipeline = prepareAnthropicFinalPipeline(constrainedModel, converted.invocation);
    const projection = pipeline.projection;

    const payload = await captureFinalPiPayload((capture) =>
      streamOpenAICompletions(
        constrainedModel,
        pipeline.pi.context,
        {
          ...pipeline.pi.options,
          apiKey: "test-only-key",
          async onPayload(basePayload) {
            const projected = await projection.project(basePayload, constrainedModel);
            return capture(projected.payload);
          },
        },
      ),
    );

    expect(payload).toMatchObject({ max_completion_tokens: 1 });
  });

  it("mirrors Pi 0.84.2 compatibility detection when explicit OpenAI compat is absent", async () => {
    const target: Model<"openai-completions"> = {
      ...model,
      id: "deepseek/deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      provider: "commandcode-goat",
      baseUrl: "https://api.commandcode.ai/provider/v1",
      reasoning: true,
      thinkingLevelMap: { off: null, high: "high", max: "max" },
    };
    const converted = parseAnthropicTextInvocation(
      {
        model: "client-selector",
        max_tokens: 2_048,
        messages: [{ role: "user", content: "hello" }],
        output_config: { effort: "high" },
      },
      1,
    );
    const pipeline = prepareAnthropicFinalPipeline(target, converted.invocation);
    const projection = pipeline.projection;
    let effortOutcome: string | undefined;
    const payload = await captureFinalPiPayload((capture) =>
      streamOpenAICompletions(target, pipeline.pi.context, {
        ...pipeline.pi.options,
        apiKey: "test-only-key",
        async onPayload(basePayload) {
          const projected = await projection.project(basePayload, target);
          effortOutcome = projected.outcomes.find(
            (entry) => entry.control === "reasoning.effort",
          )?.outcome.kind;
          return capture(projected.payload);
        },
      }),
    );

    expect(payload).toMatchObject({ reasoning_effort: "high" });
    expect(payload).not.toHaveProperty("reasoning");
    expect(payload).not.toHaveProperty("thinking");
    expect(effortOutcome).toBe("pi-native");
  });

  it.each([
    {
      format: "openrouter" as const,
      compat: { thinkingFormat: "openrouter" as const },
      expected: { reasoning: { effort: "high" } },
      effortOutcome: "pi-native" as const,
      forbidden: ["reasoning_effort", "thinking", "enable_thinking", "chat_template_kwargs"],
    },
    {
      format: "qwen" as const,
      compat: { thinkingFormat: "qwen" as const, supportsReasoningEffort: true },
      expected: { enable_thinking: true, reasoning_effort: "high" },
      effortOutcome: "pi-native" as const,
      forbidden: ["reasoning", "thinking", "chat_template_kwargs"],
    },
    {
      format: "together-without-effort" as const,
      compat: { thinkingFormat: "together" as const, supportsReasoningEffort: false },
      expected: {},
      effortOutcome: "degraded" as const,
      forbidden: ["reasoning_effort", "reasoning", "thinking", "enable_thinking", "chat_template_kwargs"],
    },
    {
      format: "qwen-chat-template-without-effort" as const,
      compat: { thinkingFormat: "qwen-chat-template" as const },
      expected: {},
      effortOutcome: "degraded" as const,
      forbidden: ["reasoning_effort", "reasoning", "thinking", "enable_thinking", "chat_template_kwargs"],
    },
    {
      format: "deepseek-without-effort" as const,
      compat: { thinkingFormat: "deepseek" as const, supportsReasoningEffort: false },
      expected: {},
      effortOutcome: "degraded" as const,
      forbidden: ["reasoning_effort", "reasoning", "thinking", "enable_thinking", "chat_template_kwargs"],
    },
    {
      format: "zai-without-effort" as const,
      compat: { thinkingFormat: "zai" as const, supportsReasoningEffort: false },
      expected: {},
      effortOutcome: "degraded" as const,
      forbidden: ["reasoning_effort", "reasoning", "thinking", "enable_thinking", "chat_template_kwargs"],
    },
    {
      format: "qwen-without-effort" as const,
      compat: { thinkingFormat: "qwen" as const, supportsReasoningEffort: false },
      expected: {},
      effortOutcome: "degraded" as const,
      forbidden: ["reasoning_effort", "reasoning", "thinking", "enable_thinking", "chat_template_kwargs"],
    },
    {
      format: "chat-template-enable-only" as const,
      compat: {
        thinkingFormat: "chat-template" as const,
        chatTemplateKwargs: {
          enable_thinking: { $var: "thinking.enabled" as const },
          literal: "fixed",
        },
      },
      expected: { chat_template_kwargs: { literal: "fixed" } },
      effortOutcome: "degraded" as const,
      forbidden: ["reasoning_effort", "reasoning", "thinking", "enable_thinking"],
    },
    {
      format: "baseten-enable-only" as const,
      compat: {
        thinkingFormat: "baseten" as const,
        supportsReasoningEffort: false,
        chatTemplateArgs: {
          enable_thinking: { $var: "thinking.enabled" as const },
          literal: "fixed",
        },
      },
      expected: { chat_template_args: { literal: "fixed" } },
      effortOutcome: "degraded" as const,
      forbidden: ["reasoning_effort", "reasoning", "thinking", "enable_thinking"],
    },
    {
      format: "chat-template" as const,
      compat: {
        thinkingFormat: "chat-template" as const,
        chatTemplateKwargs: {
          enable_thinking: { $var: "thinking.enabled" as const },
          reasoning_effort: { $var: "thinking.effort" as const },
          literal: "fixed",
        },
      },
      expected: {
        chat_template_kwargs: {
          enable_thinking: true,
          reasoning_effort: "high",
          literal: "fixed",
        },
      },
      effortOutcome: "pi-native" as const,
      forbidden: ["reasoning_effort", "reasoning", "thinking", "enable_thinking"],
    },
  ])("preserves Pi's explicit $format reasoning wire shape without adding generic fields", async ({ compat, expected, effortOutcome, forbidden }) => {
    const target: Model<"openai-completions"> = {
      ...model,
      id: `reasoning-${compat.thinkingFormat}`,
      name: `Reasoning ${compat.thinkingFormat}`,
      provider: "explicit-compat-test",
      reasoning: true,
      thinkingLevelMap: { off: "none", high: "high" },
      compat,
    };
    const converted = parseAnthropicTextInvocation(
      {
        model: "client-selector",
        max_tokens: 2_048,
        messages: [{ role: "user", content: "hello" }],
        output_config: { effort: "high" },
      },
      1,
    );
    const pipeline = prepareAnthropicFinalPipeline(target, converted.invocation);
    const projection = pipeline.projection;
    let projectedOutcomes: readonly { readonly control: string; readonly outcome: { readonly kind: string } }[] = [];
    const payload = await captureFinalPiPayload((capture) =>
      streamOpenAICompletions(target, pipeline.pi.context, {
        ...pipeline.pi.options,
        apiKey: "test-only-key",
        async onPayload(basePayload) {
          const projected = await projection.project(basePayload, target);
          projectedOutcomes = projected.outcomes;
          return capture(projected.payload);
        },
      }),
    );

    expect(payload).toMatchObject(expected);
    expect(projectedOutcomes.find((entry) => entry.control === "reasoning.effort")?.outcome.kind)
      .toBe(effortOutcome);
    for (const field of forbidden) expect(payload).not.toHaveProperty(field);
  });

  it.each([
    ["qwen", { thinkingFormat: "qwen" as const }, ["enable_thinking", "reasoning_effort"]],
    ["together", { thinkingFormat: "together" as const }, ["reasoning", "reasoning_effort"]],
    ["openrouter", { thinkingFormat: "openrouter" as const }, ["reasoning", "reasoning_effort"]],
    ["qwen-chat-template", { thinkingFormat: "qwen-chat-template" as const }, ["chat_template_kwargs", "reasoning_effort"]],
  ] as const)("preserves omitted reasoning as omission for the $0 compat shape", async (_label, compat, forbidden) => {
    const target: Model<"openai-completions"> = {
      ...model,
      id: `omitted-${compat.thinkingFormat}`,
      name: `Omitted ${compat.thinkingFormat}`,
      provider: "explicit-compat-test",
      reasoning: true,
      thinkingLevelMap: { off: "none", high: "high" },
      compat,
    };
    const converted = parseAnthropicTextInvocation(
      {
        model: "client-selector",
        max_tokens: 2_048,
        messages: [{ role: "user", content: "hello" }],
      },
      1,
    );
    const pipeline = prepareAnthropicFinalPipeline(target, converted.invocation);
    const projection = pipeline.projection;
    const payload = await captureFinalPiPayload((capture) =>
      streamOpenAICompletions(target, pipeline.pi.context, {
        ...pipeline.pi.options,
        apiKey: "test-only-key",
        async onPayload(basePayload) {
          const projected = await projection.project(basePayload, target);
          return capture(projected.payload);
        },
      }),
    );

    for (const field of forbidden) expect(payload).not.toHaveProperty(field);
  });

  it.each([
    ["openai", { thinkingFormat: "openai" as const }, { reasoning_effort: "none" }],
    ["deepseek", { thinkingFormat: "deepseek" as const }, { thinking: { type: "disabled" } }],
    ["zai", { thinkingFormat: "zai" as const }, { thinking: { type: "disabled" } }],
    ["qwen", { thinkingFormat: "qwen" as const }, { enable_thinking: false }],
    [
      "qwen-chat-template",
      { thinkingFormat: "qwen-chat-template" as const },
      { chat_template_kwargs: { enable_thinking: false, preserve_thinking: true } },
    ],
    [
      "chat-template",
      {
        thinkingFormat: "chat-template" as const,
        chatTemplateKwargs: {
          enable_thinking: { $var: "thinking.enabled" as const },
          reasoning_effort: { $var: "thinking.effort" as const },
          literal: "fixed",
        },
      },
      {
        chat_template_kwargs: {
          enable_thinking: false,
          reasoning_effort: "none",
          literal: "fixed",
        },
      },
    ],
    [
      "baseten",
      {
        thinkingFormat: "baseten" as const,
        chatTemplateArgs: {
          enable_thinking: { $var: "thinking.enabled" as const },
          reasoning_effort: { $var: "thinking.effort" as const },
          literal: "fixed",
        },
      },
      {
        chat_template_args: {
          enable_thinking: false,
          reasoning_effort: "none",
          literal: "fixed",
        },
        reasoning_effort: "none",
      },
    ],
    ["together", { thinkingFormat: "together" as const }, { reasoning: { enabled: false } }],
    ["openrouter", { thinkingFormat: "openrouter" as const }, { reasoning: { effort: "none" } }],
    ["string-thinking", { thinkingFormat: "string-thinking" as const }, { thinking: "none" }],
  ] as const)("preserves explicit disabled reasoning using the $0 compat shape", async (_label, compat, expected) => {
    const target: Model<"openai-completions"> = {
      ...model,
      id: `disabled-${compat.thinkingFormat}`,
      name: `Disabled ${compat.thinkingFormat}`,
      provider: "explicit-compat-test",
      reasoning: true,
      thinkingLevelMap: { off: "none", high: "high" },
      compat,
    };
    const converted = parseAnthropicTextInvocation(
      {
        model: "client-selector",
        max_tokens: 2_048,
        messages: [{ role: "user", content: "hello" }],
        thinking: { type: "disabled" },
      },
      1,
    );
    const pipeline = prepareAnthropicFinalPipeline(target, converted.invocation);
    const projection = pipeline.projection;
    const payload = await captureFinalPiPayload((capture) =>
      streamOpenAICompletions(target, pipeline.pi.context, {
        ...pipeline.pi.options,
        apiKey: "test-only-key",
        async onPayload(basePayload) {
          const projected = await projection.project(basePayload, target);
          return capture(projected.payload);
        },
      }),
    );

    expect(payload).toMatchObject(expected);
    if (!Object.hasOwn(expected, "reasoning_effort")) {
      expect(payload).not.toHaveProperty("reasoning_effort");
    }
  });

  it("treats OpenCode Go deepseek-v4-flash reasoning disable as an online-certified degradation", async () => {
    const target: Model<"openai-completions"> = {
      ...model,
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      provider: "opencode-go",
      reasoning: true,
      thinkingLevelMap: { off: "none", high: "high" },
      compat: { thinkingFormat: "deepseek" },
    };
    const converted = parseAnthropicTextInvocation({
      model: "client-selector",
      max_tokens: 2_048,
      messages: [{ role: "user", content: "hello" }],
      thinking: { type: "disabled" },
    }, 1);
    const pipeline = prepareAnthropicFinalPipeline(target, converted.invocation);
    const projection = pipeline.projection;
    const result = await projection.project({
      model: target.id,
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      max_tokens: 2_048,
      thinking: { type: "disabled" },
    }, target);

    expect(result.payload).not.toHaveProperty("thinking");
    expect(result.outcomes).toContainEqual({
      control: "reasoning.activation",
      outcome: {
        kind: "degraded",
        warning: expect.stringMatching(/OpenCode Go.*does not guarantee reasoning disable/iu),
      },
    });
  });

  it("treats CommandCode GOAT deepseek-v4-flash reasoning disable as an online-certified degradation", async () => {
    const target: Model<"openai-completions"> = {
      ...model,
      id: "deepseek/deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      provider: "commandcode-goat",
      reasoning: true,
      thinkingLevelMap: { off: "none", high: "high" },
      compat: { thinkingFormat: "deepseek" },
    };
    const converted = parseAnthropicTextInvocation({
      model: "client-selector",
      max_tokens: 2_048,
      messages: [{ role: "user", content: "hello" }],
      thinking: { type: "disabled" },
    }, 1);
    const pipeline = prepareAnthropicFinalPipeline(target, converted.invocation);
    const projection = pipeline.projection;
    const result = await projection.project({
      model: target.id,
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      max_tokens: 2_048,
      thinking: { type: "disabled" },
    }, target);

    expect(result.payload).not.toHaveProperty("thinking");
    expect(result.outcomes).toContainEqual({
      control: "reasoning.activation",
      outcome: {
        kind: "degraded",
        warning: expect.stringMatching(/CommandCode GOAT.*does not guarantee reasoning disable/iu),
      },
    });
  });

  it("projects exact top-level output, sampling, stop, and tool controls", async () => {
    const converted = parseAnthropicTextInvocation(
      {
        model: "client-selector",
        max_tokens: 4_096,
        messages: [{ role: "user", content: "hello" }],
        temperature: 0.4,
        top_p: 0.8,
        top_k: 32,
        stop_sequences: ["END", "STOP"],
        output_config: {
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: { answer: { type: "string" } },
              required: ["answer"],
              additionalProperties: false,
            },
          },
        },
        metadata: { user_id: "user-123" },
        service_tier: "standard_only",
        tools: [
          {
            name: "lookup",
            description: "Lookup",
            input_schema: { type: "object", properties: {} },
          },
        ],
        tool_choice: {
          type: "tool",
          name: "lookup",
          disable_parallel_tool_use: true,
        },
      },
      1,
    );
    const pipeline = prepareAnthropicFinalPipeline(model, converted.invocation);
    const projection = pipeline.projection;

    const payload = await captureFinalPiPayload((capture) =>
      streamOpenAICompletions(
        model,
        pipeline.pi.context,
        {
          ...pipeline.pi.options,
          apiKey: "test-only-key",
          async onPayload(basePayload) {
            const projected = await projection.project(basePayload, model);
            return capture(projected.payload);
          },
        },
      ),
    );

    expect(payload).toMatchObject({
      model: "deepseek-v4-flash",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      ],
      max_completion_tokens: 4_096,
      temperature: 0.4,
      top_p: 0.8,
      top_k: 32,
      stop: ["END", "STOP"],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "anthropic_output",
          strict: true,
          schema: {
            type: "object",
            required: ["answer"],
            additionalProperties: false,
          },
        },
      },
      tool_choice: { type: "function", function: { name: "lookup" } },
      parallel_tool_calls: false,
      user: "user-123",
      service_tier: "default",
    });
  });
});

describe("Anthropic Client Wire to final Anthropic Messages payload", () => {
  it("restores exact Anthropic controls after Pi construction", async () => {
    const converted = parseAnthropicTextInvocation(
      {
        model: "client-selector",
        max_tokens: 4_096,
        messages: [{ role: "user", content: "hello" }],
        top_p: 0.8,
        top_k: 32,
        stop_sequences: ["END"],
        thinking: {
          type: "enabled",
          budget_tokens: 1_024,
          display: "omitted",
        },
        output_config: {
          effort: "high",
          format: {
            type: "json_schema",
            schema: { type: "object", properties: {} },
          },
        },
        metadata: { user_id: "user-123" },
        service_tier: "standard_only",
        inference_geo: "us",
        container: "container-123",
        cache_control: { type: "ephemeral", ttl: "1h" },
        tools: [
          {
            name: "lookup",
            input_schema: { type: "object", properties: {} },
          },
        ],
        tool_choice: {
          type: "any",
          disable_parallel_tool_use: true,
        },
      },
      1,
    );
    const pipeline = prepareAnthropicFinalPipeline(anthropicModel, converted.invocation);
    const projection = pipeline.projection;
    let outcomes: Awaited<ReturnType<typeof projection.project>>["outcomes"] = [];

    const payload = await captureFinalPiPayload((capture) =>
      streamAnthropicMessages(
        anthropicModel,
        pipeline.pi.context,
        {
          ...pipeline.pi.options,
          apiKey: "test-only-key",
          async onPayload(basePayload) {
            const projected = await projection.project(basePayload, anthropicModel);
            outcomes = projected.outcomes;
            return capture(projected.payload);
          },
        },
      ),
    );

    expect(payload).toMatchObject({
      model: "claude-semantic-target",
      max_tokens: 4_096,
      top_p: 0.8,
      top_k: 32,
      stop_sequences: ["END"],
      thinking: {
        type: "enabled",
        budget_tokens: 1_024,
        display: "omitted",
      },
      output_config: {
        format: {
          type: "json_schema",
          schema: { type: "object", properties: {} },
        },
      },
      metadata: { user_id: "user-123" },
      service_tier: "standard_only",
      inference_geo: "us",
      container: "container-123",
      cache_control: { type: "ephemeral", ttl: "1h" },
      tool_choice: { type: "any", disable_parallel_tool_use: true },
    });
    expect(outcomes).toContainEqual({
      control: "reasoning.effort",
      outcome: expect.objectContaining({ kind: "payload-projected" }),
    });
  });

  it("restores Pi-unrepresentable Anthropic blocks and typed server tools", async () => {
    const converted = parseAnthropicTextInvocation(
      {
        model: "client-selector",
        max_tokens: 2_048,
        system: [
          { type: "text", text: "system", cache_control: { type: "ephemeral" } },
        ],
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "url", url: "https://example.test/image.png" },
              },
            ],
          },
          {
            role: "assistant",
            content: [
              {
                type: "server_tool_use",
                id: "srv-1",
                name: "web_search",
                input: { query: "LuckyToken" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "web_search_tool_result",
                tool_use_id: "srv-1",
                content: {
                  type: "web_search_tool_result_error",
                  error_code: "unavailable",
                },
              },
            ],
          },
          { role: "user", content: "continue" },
        ],
        tools: [
          { name: "lookup", input_schema: { type: "object", properties: {} } },
          { name: "web_search", type: "web_search_20250305", max_uses: 2 },
        ],
      },
      1,
    );
    const pipeline = prepareAnthropicFinalPipeline(anthropicModel, converted.invocation);
    const projection = pipeline.projection;
    const payload = await captureFinalPiPayload((capture) =>
      streamAnthropicMessages(anthropicModel, pipeline.pi.context, {
        ...pipeline.pi.options,
        apiKey: "test-only-key",
        async onPayload(basePayload) {
          const projected = await projection.project(basePayload, anthropicModel);
          return capture(projected.payload);
        },
      }),
    );

    expect(payload).toMatchObject({
      system: [
        { type: "text", text: "system", cache_control: { type: "ephemeral" } },
      ],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "url", url: "https://example.test/image.png" },
            },
          ],
        },
        { role: "assistant", content: [expect.objectContaining({ type: "server_tool_use" })] },
        { role: "user", content: [expect.objectContaining({ type: "web_search_tool_result" })] },
        { role: "user", content: [expect.objectContaining({ type: "text", text: "continue" })] },
      ],
      tools: [
        expect.objectContaining({ name: "lookup" }),
        expect.objectContaining({ name: "web_search", type: "web_search_20250305" }),
      ],
    });
    expect(JSON.stringify(payload)).not.toContain("[web search result]");
  });
});

describe("Anthropic Client Wire to final Google payloads", () => {
  const request = {
    model: "client-selector",
    max_tokens: 2_048,
    messages: [{ role: "user", content: "hello" }],
    temperature: 0.3,
    top_p: 0.7,
    top_k: 24,
    stop_sequences: ["END"],
    output_config: {
      format: {
        type: "json_schema",
        schema: { type: "object", properties: { answer: { type: "string" } } },
      },
    },
    tools: [
      {
        name: "lookup",
        input_schema: { type: "object", properties: {} },
      },
    ],
    tool_choice: { type: "tool", name: "lookup" },
  } as const;

  it("projects the independently registered Google Generative AI shape", async () => {
    const converted = parseAnthropicTextInvocation(request, 1);
    const pipeline = prepareAnthropicFinalPipeline(googleModel, converted.invocation);
    const projection = pipeline.projection;
    const payload = await captureFinalPiPayload((capture) =>
      streamGoogleGenerativeAI(googleModel, pipeline.pi.context, {
        ...pipeline.pi.options,
        apiKey: "test-only-key",
        async onPayload(basePayload) {
          const projected = await projection.project(basePayload, googleModel);
          return capture(projected.payload);
        },
      }),
    );

    expect(payload).toMatchObject({
      model: "gemini-2.5-pro",
      config: {
        maxOutputTokens: 2_048,
        temperature: 0.3,
        topP: 0.7,
        topK: 24,
        stopSequences: ["END"],
        responseMimeType: "application/json",
        responseJsonSchema: {
          type: "object",
          properties: { answer: { type: "string" } },
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

  it.each([
    ["Generative AI", googleModel, streamGoogleGenerativeAI],
    ["Vertex", vertexModel, streamGoogleVertex],
  ] as const)("maps Anthropic effort through the pinned Gemini 2.5 %s budget resolver", async (
    _label,
    target,
    start,
  ) => {
    const converted = parseAnthropicTextInvocation({
      model: "client-selector",
      max_tokens: 2_048,
      messages: [{ role: "user", content: "hello" }],
      output_config: { effort: "high" },
    }, 1);
    const pipeline = prepareAnthropicFinalPipeline(target, converted.invocation);
    const projection = pipeline.projection;
    let outcomes: Awaited<ReturnType<typeof projection.project>>["outcomes"] = [];
    const payload = await captureFinalPiPayload((capture) =>
      start(target as never, pipeline.pi.context, {
        ...pipeline.pi.options,
        apiKey: "test-only-key",
        async onPayload(basePayload: unknown) {
          const projected = await projection.project(basePayload, target);
          outcomes = projected.outcomes;
          return capture(projected.payload);
        },
      }),
    );

    expect(payload).toMatchObject({
      config: { thinkingConfig: { thinkingBudget: 32_768 } },
    });
    const googlePayload = requireRecord(payload, "Google payload");
    const googleConfig = requireRecord(googlePayload.config, "Google payload.config");
    expect(googleConfig.thinkingConfig).toHaveProperty("includeThoughts", true);
    expect(outcomes.find((entry) => entry.control === "reasoning.effort")?.outcome.kind)
      .not.toBe("omitted");
  });

  it.each([
    ["Generative AI", googleModel, streamGoogleGenerativeAI],
    ["Vertex", vertexModel, streamGoogleVertex],
  ] as const)("omits effort for a non-reasoning Google %s target", async (
    _label,
    sourceModel,
    start,
  ) => {
    const target = { ...sourceModel, reasoning: false };
    const converted = parseAnthropicTextInvocation({
      model: "client-selector",
      max_tokens: 2_048,
      messages: [{ role: "user", content: "hello" }],
      output_config: { effort: "high" },
    }, 1);
    const pipeline = prepareAnthropicFinalPipeline(target, converted.invocation);
    const projection = pipeline.projection;
    let outcomes: Awaited<ReturnType<typeof projection.project>>["outcomes"] = [];
    const payload = await captureFinalPiPayload((capture) =>
      start(target as never, pipeline.pi.context, {
        ...pipeline.pi.options,
        apiKey: "test-only-key",
        async onPayload(basePayload: unknown) {
          const projected = await projection.project(basePayload, target);
          outcomes = projected.outcomes;
          return capture(projected.payload);
        },
      }),
    );

    const googlePayload = requireRecord(payload, "Google payload");
    const googleConfig = requireRecord(googlePayload.config, "Google payload.config");
    expect(googleConfig.thinkingConfig).toBeUndefined();
    expect(outcomes.find((entry) => entry.control === "reasoning.effort")?.outcome.kind)
      .toBe("degraded");
  });

  it.each([
    ["google-generative-ai", "gemini-flash-latest"],
    ["google-generative-ai", "gemma-4-test"],
    ["google-vertex", "gemini-flash-lite-latest"],
  ] as const)("keeps requests available when %s model %s cannot exactly disable reasoning", (
    api,
    id,
  ) => {
    const target = {
      ...googleModel,
      api,
      id,
      name: id,
      provider: api === "google-vertex" ? "google-vertex-test" : "google-test",
    } as Model<string>;
    const converted = parseAnthropicTextInvocation({
      model: "client-selector",
      max_tokens: 2_048,
      messages: [{ role: "user", content: "hello" }],
      thinking: { type: "disabled" },
    }, 1);
    expect(() =>
      prepareAnthropicFinalPipeline(target, converted.invocation)
    ).not.toThrow();
  });

  it("keeps requests available when Gemini 3 can only use a nearest reasoning mode", () => {
    const target: Model<"google-generative-ai"> = {
      ...googleModel,
      id: "gemini-3.1-pro",
      name: "Gemini 3.1 Pro",
    };
    const converted = parseAnthropicTextInvocation({
      model: "client-selector",
      max_tokens: 4_096,
      messages: [{ role: "user", content: "hello" }],
      thinking: { type: "enabled", budget_tokens: 1_024 },
    }, 1);
    expect(() =>
      prepareAnthropicFinalPipeline(target, converted.invocation)
    ).not.toThrow();
  });

  it("projects the independently registered Google Vertex shape", async () => {
    const converted = parseAnthropicTextInvocation(request, 1);
    const pipeline = prepareAnthropicFinalPipeline(vertexModel, converted.invocation);
    const projection = pipeline.projection;
    const payload = await captureFinalPiPayload((capture) =>
      streamGoogleVertex(vertexModel, pipeline.pi.context, {
        ...pipeline.pi.options,
        apiKey: "test-only-key",
        async onPayload(basePayload) {
          const projected = await projection.project(basePayload, vertexModel);
          return capture(projected.payload);
        },
      }),
    );

    expect(payload).toMatchObject({
      model: "gemini-2.5-pro",
      config: {
        maxOutputTokens: 2_048,
        temperature: 0.3,
        topP: 0.7,
        topK: 24,
        stopSequences: ["END"],
        responseMimeType: "application/json",
        responseJsonSchema: {
          type: "object",
          properties: { answer: { type: "string" } },
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

describe("Anthropic Client Wire to final Mistral payload", () => {
  it("projects Mistral-native sampling, stop, format, and tool controls", async () => {
    const converted = parseAnthropicTextInvocation(
      {
        model: "client-selector",
        max_tokens: 2_048,
        messages: [{ role: "user", content: "hello" }],
        temperature: 0.25,
        top_p: 0.75,
        top_k: 20,
        stop_sequences: ["END"],
        output_config: {
          format: {
            type: "json_schema",
            schema: { type: "object", properties: { answer: { type: "string" } } },
          },
        },
        tools: [
          { name: "lookup", input_schema: { type: "object", properties: {} } },
        ],
        tool_choice: {
          type: "tool",
          name: "lookup",
          disable_parallel_tool_use: true,
        },
      },
      1,
    );
    const pipeline = prepareAnthropicFinalPipeline(mistralModel, converted.invocation);
    const projection = pipeline.projection;
    const payload = await captureFinalPiPayload((capture) =>
      streamMistral(mistralModel, pipeline.pi.context, {
        ...pipeline.pi.options,
        apiKey: "test-only-key",
        async onPayload(basePayload) {
          const projected = await projection.project(basePayload, mistralModel);
          return capture(projected.payload);
        },
      }),
    );

    expect(payload).toMatchObject({
      model: "magistral-medium-latest",
      maxTokens: 2_048,
      temperature: 0.25,
      topP: 0.75,
      stop: ["END"],
      responseFormat: {
        type: "json_schema",
        jsonSchema: {
          name: "anthropic_output",
          strict: true,
          schemaDefinition: {
            type: "object",
            properties: { answer: { type: "string" } },
          },
        },
      },
      toolChoice: { type: "function", function: { name: "lookup" } },
      parallelToolCalls: false,
    });
  });

  it.each([
    {
      label: "certified effort field",
      target: {
        ...mistralModel,
        id: "mistral-small-2603",
        name: "Mistral Small 2603",
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: null,
          medium: null,
          high: "high",
          xhigh: null,
          max: null,
        },
      } as Model<"mistral-conversations">,
      effort: "high" as const,
      expected: { reasoningEffort: "high" },
      outcome: "pi-native" as const,
    },
    {
      label: "uncertified coarse effort",
      target: {
        ...mistralModel,
        id: "mistral-small-2603",
        name: "Mistral Small 2603",
      } as Model<"mistral-conversations">,
      effort: "low" as const,
      expected: {},
      outcome: "degraded" as const,
    },
    {
      label: "prompt-mode-only reasoning",
      target: mistralModel,
      effort: "high" as const,
      expected: {},
      outcome: "degraded" as const,
    },
  ])("handles $label without converting effort into a different reasoning activation", async ({
    target,
    effort,
    expected,
    outcome,
  }) => {
    const converted = parseAnthropicTextInvocation({
      model: "client-selector",
      max_tokens: 2_048,
      messages: [{ role: "user", content: "hello" }],
      output_config: { effort },
    }, 1);
    const pipeline = prepareAnthropicFinalPipeline(target, converted.invocation);
    const projection = pipeline.projection;
    let outcomes: Awaited<ReturnType<typeof projection.project>>["outcomes"] = [];
    const payload = await captureFinalPiPayload((capture) =>
      streamMistral(target, pipeline.pi.context, {
        ...pipeline.pi.options,
        apiKey: "test-only-key",
        async onPayload(basePayload) {
          const projected = await projection.project(basePayload, target);
          outcomes = projected.outcomes;
          return capture(projected.payload);
        },
      }),
    );

    expect(payload).toMatchObject(expected);
    if (!Object.hasOwn(expected, "reasoningEffort")) {
      expect(payload).not.toHaveProperty("reasoningEffort");
      expect(payload).not.toHaveProperty("promptMode");
    }
    expect(outcomes.find((entry) => entry.control === "reasoning.effort")?.outcome.kind)
      .toBe(outcome);
  });

  it("certifies the post-callback HTTP wire rather than only Pi's internal payload", async () => {
    const converted = parseAnthropicTextInvocation(
      {
        model: "client-selector",
        max_tokens: 2_048,
        messages: [{ role: "user", content: "hello" }],
        top_p: 0.75,
        stop_sequences: ["END"],
        output_config: {
          format: {
            type: "json_schema",
            schema: { type: "object", properties: { answer: { type: "string" } } },
          },
        },
        tools: [
          { name: "lookup", input_schema: { type: "object", properties: {} } },
        ],
        tool_choice: {
          type: "tool",
          name: "lookup",
          disable_parallel_tool_use: true,
        },
      },
      1,
    );
    const pipeline = prepareAnthropicFinalPipeline(mistralModel, converted.invocation);
    const projection = pipeline.projection;
    const request = await captureJsonProviderRequest((fetch) =>
      streamMistral(mistralModel, pipeline.pi.context, {
        ...pipeline.pi.options,
        apiKey: "test-only-key",
        fetch,
        async onPayload(basePayload) {
          const projected = await projection.project(basePayload, mistralModel);
          return projected.payload;
        },
      }),
    );

    expect(request).toMatchObject({
      method: "POST",
      body: {
        model: "magistral-medium-latest",
        max_tokens: 2_048,
        top_p: 0.75,
        stop: ["END"],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "anthropic_output",
            strict: true,
            schema: {
              type: "object",
              properties: { answer: { type: "string" } },
            },
          },
        },
        tool_choice: { type: "function", function: { name: "lookup" } },
        parallel_tool_calls: false,
      },
    });
  });
});

describe.each([
  ["OpenAI", responsesModel, streamOpenAIResponses],
  ["Azure OpenAI", azureResponsesModel, streamAzureOpenAIResponses],
] as const)("Anthropic Client Wire to final %s Responses payload", (_name, targetModel, start) => {
  it("projects the independently registered Responses shape", async () => {
    const converted = parseAnthropicTextInvocation(
      {
        model: "client-selector",
        max_tokens: 2_048,
        messages: [{ role: "user", content: "hello" }],
        temperature: 0.2,
        top_p: 0.6,
        top_k: 12,
        output_config: {
          format: {
            type: "json_schema",
            schema: { type: "object", properties: { answer: { type: "string" } } },
          },
        },
        metadata: { user_id: "user-123" },
        service_tier: "standard_only",
        tools: [
          { name: "lookup", input_schema: { type: "object", properties: {} } },
        ],
        tool_choice: {
          type: "tool",
          name: "lookup",
          disable_parallel_tool_use: true,
        },
      },
      1,
    );
    const pipeline = prepareAnthropicFinalPipeline(targetModel, converted.invocation);
    const projection = pipeline.projection;
    const payload = await captureFinalPiPayload((capture) =>
      start(targetModel as never, pipeline.pi.context, {
        ...pipeline.pi.options,
        apiKey: "test-only-key",
        async onPayload(basePayload: unknown) {
          const projected = await projection.project(basePayload, targetModel);
          return capture(projected.payload);
        },
      }),
    );

    expect(payload).toMatchObject({
      max_output_tokens: 2_048,
      temperature: 0.2,
      top_p: 0.6,
      text: {
        format: {
          type: "json_schema",
          name: "anthropic_output",
          strict: true,
          schema: {
            type: "object",
            properties: { answer: { type: "string" } },
          },
        },
      },
      tool_choice: { type: "function", name: "lookup" },
      parallel_tool_calls: false,
      user: "user-123",
      service_tier: "default",
    });
  });

  it("omits effort instead of adding reasoning to a non-reasoning target model", async () => {
    const converted = parseAnthropicTextInvocation({
      model: "client-selector",
      max_tokens: 2_048,
      messages: [{ role: "user", content: "hello" }],
      output_config: { effort: "high" },
    }, 1);
    const pipeline = prepareAnthropicFinalPipeline(targetModel, converted.invocation);
    const projection = pipeline.projection;
    let outcomes: Awaited<ReturnType<typeof projection.project>>["outcomes"] = [];
    const payload = await captureFinalPiPayload((capture) =>
      start(targetModel as never, pipeline.pi.context, {
        ...pipeline.pi.options,
        apiKey: "test-only-key",
        async onPayload(basePayload: unknown) {
          const projected = await projection.project(basePayload, targetModel);
          outcomes = projected.outcomes;
          return capture(projected.payload);
        },
      }),
    );

    expect(payload).not.toHaveProperty("reasoning");
    expect(payload).not.toHaveProperty("include");
    expect(outcomes.find((entry) => entry.control === "reasoning.effort")?.outcome.kind)
      .toBe("degraded");
  });
});
describe("Anthropic Client Wire to final Bedrock payloads", () => {
  const bedrockOptions = {
    env: {
      AWS_BEDROCK_SKIP_AUTH: "1",
      AWS_REGION: "us-east-1",
    },
  } as const;

  it("restores Claude thinking and the original total output ceiling", async () => {
    const converted = parseAnthropicTextInvocation(
      {
        model: "client-selector",
        max_tokens: 4_096,
        messages: [{ role: "user", content: "hello" }],
        top_p: 0.7,
        top_k: 20,
        stop_sequences: ["END"],
        thinking: { type: "enabled", budget_tokens: 1_024, display: "omitted" },
        output_config: {
          effort: "high",
          format: {
            type: "json_schema",
            schema: { type: "object", properties: { answer: { type: "string" } } },
          },
        },
      },
      1,
    );
    const pipeline = prepareAnthropicFinalPipeline(bedrockClaudeModel, converted.invocation);
    const projection = pipeline.projection;
    const payload = await captureFinalPiPayload((capture) =>
      streamBedrock(bedrockClaudeModel, pipeline.pi.context, {
        ...pipeline.pi.options,
        ...bedrockOptions,
        async onPayload(basePayload) {
          const projected = await projection.project(basePayload, bedrockClaudeModel);
          return capture(projected.payload);
        },
      }),
    );

    expect(payload).toMatchObject({
      inferenceConfig: {
        maxTokens: 4_096,
        topP: 0.7,
        stopSequences: ["END"],
      },
      additionalModelRequestFields: {
        top_k: 20,
        thinking: { type: "enabled", budget_tokens: 1_024 },
        output_config: {
          format: {
            type: "json_schema",
            schema: { type: "object", properties: { answer: { type: "string" } } },
          },
        },
      },
    });
    const bedrockPayload = requireRecord(payload, "Bedrock payload");
    const additional = requireRecord(
      bedrockPayload.additionalModelRequestFields,
      "Bedrock payload.additionalModelRequestFields",
    );
    const outputConfig = requireRecord(
      additional.output_config,
      "Bedrock payload.additionalModelRequestFields.output_config",
    );
    expect(requireRecord(additional.thinking, "Bedrock thinking")).not.toHaveProperty("display");
    expect(outputConfig.effort).toBeUndefined();
  });

  it.each([
    {
      label: "Claude effort without activation",
      target: bedrockClaudeModel,
      thinking: undefined,
      expectEffort: false,
    },
    {
      label: "Claude adaptive effort",
      target: bedrockClaudeModel,
      thinking: { type: "adaptive" as const },
      expectEffort: true,
    },
    {
      label: "non-Claude effort",
      target: bedrockNovaModel,
      thinking: undefined,
      expectEffort: false,
    },
  ])("handles $label without inventing reasoning activation", async ({
    target,
    thinking,
    expectEffort,
  }) => {
    const converted = parseAnthropicTextInvocation({
      model: "client-selector",
      max_tokens: 2_048,
      messages: [{ role: "user", content: "hello" }],
      ...(thinking === undefined ? {} : { thinking }),
      output_config: { effort: "high" },
    }, 1);
    const pipeline = prepareAnthropicFinalPipeline(target, converted.invocation);
    const projection = pipeline.projection;
    let outcomes: Awaited<ReturnType<typeof projection.project>>["outcomes"] = [];
    const payload = await captureFinalPiPayload((capture) =>
      streamBedrock(target, pipeline.pi.context, {
        ...pipeline.pi.options,
        ...bedrockOptions,
        async onPayload(basePayload) {
          const projected = await projection.project(basePayload, target);
          outcomes = projected.outcomes;
          return capture(projected.payload);
        },
      }),
    );
    const bedrockPayload = requireRecord(payload, "Bedrock payload");
    const additionalValue = bedrockPayload.additionalModelRequestFields;
    const additional = additionalValue === undefined
      ? undefined
      : requireRecord(additionalValue, "Bedrock payload.additionalModelRequestFields");
    const outputConfigValue = additional?.output_config;
    const outputConfig = outputConfigValue === undefined
      ? undefined
      : requireRecord(
          outputConfigValue,
          "Bedrock payload.additionalModelRequestFields.output_config",
        );
    if (expectEffort) {
      expect(additional?.thinking).toMatchObject({ type: "adaptive" });
      expect(outputConfig?.effort).toBe("high");
      expect(outcomes.find((entry) => entry.control === "reasoning.effort")?.outcome.kind)
        .not.toBe("omitted");
    } else {
      expect(additional?.thinking).toBeUndefined();
      expect(outputConfig?.effort).toBeUndefined();
      expect(outcomes.find((entry) => entry.control === "reasoning.effort")?.outcome.kind)
        .toBe("degraded");
    }
  });

  it("uses the separately certified non-Claude Bedrock family", async () => {
    const converted = parseAnthropicTextInvocation(
      {
        model: "client-selector",
        max_tokens: 1_024,
        messages: [{ role: "user", content: "hello" }],
        temperature: 0.4,
        top_p: 0.8,
        stop_sequences: ["END"],
        tools: [
          { name: "lookup", input_schema: { type: "object", properties: {} } },
        ],
        tool_choice: { type: "tool", name: "lookup" },
      },
      1,
    );
    const pipeline = prepareAnthropicFinalPipeline(bedrockNovaModel, converted.invocation);
    const projection = pipeline.projection;
    const payload = await captureFinalPiPayload((capture) =>
      streamBedrock(bedrockNovaModel, pipeline.pi.context, {
        ...pipeline.pi.options,
        ...bedrockOptions,
        async onPayload(basePayload) {
          const projected = await projection.project(basePayload, bedrockNovaModel);
          return capture(projected.payload);
        },
      }),
    );

    expect(payload).toMatchObject({
      inferenceConfig: {
        maxTokens: 1_024,
        temperature: 0.4,
        topP: 0.8,
        stopSequences: ["END"],
      },
      toolConfig: { toolChoice: { tool: { name: "lookup" } } },
    });
  });
});

describe("Anthropic Client Wire to final Pi Messages payload", () => {
  it("projects only controls certified by the delegated Pi wire", async () => {
    const converted = parseAnthropicTextInvocation(
      {
        model: "client-selector",
        max_tokens: 2_048,
        messages: [{ role: "user", content: "hello" }],
        temperature: 0.3,
        top_p: 0.7,
        top_k: 16,
        output_config: { effort: "high" },
        tools: [
          { name: "lookup", input_schema: { type: "object", properties: {} } },
        ],
        tool_choice: { type: "tool", name: "lookup" },
      },
      1,
    );
    const pipeline = prepareAnthropicFinalPipeline(piMessagesModel, converted.invocation);
    const projection = pipeline.projection;
    const payload = await captureFinalPiPayload((capture) =>
      streamPiMessages(piMessagesModel, pipeline.pi.context, {
        ...pipeline.pi.options,
        apiKey: "test-only-key",
        async onPayload(basePayload) {
          const projected = await projection.project(basePayload, piMessagesModel);
          return capture(projected.payload);
        },
      }),
    );

    expect(payload).toMatchObject({
      model: "pi-semantic-target",
      options: {
        maxTokens: 2_048,
        temperature: 0.3,
        reasoning: "high",
        toolChoice: { type: "function", function: { name: "lookup" } },
      },
    });
  });

  it("omits effort for a non-reasoning Pi Messages target instead of failing the request", async () => {
    const target: Model<"pi-messages"> = {
      ...piMessagesModel,
      id: "pi-nonreasoning-target",
      name: "Pi non-reasoning target",
      reasoning: false,
    };
    const converted = parseAnthropicTextInvocation({
      model: "client-selector",
      max_tokens: 2_048,
      messages: [{ role: "user", content: "hello" }],
      output_config: { effort: "high" },
    }, 1);
    const pipeline = prepareAnthropicFinalPipeline(target, converted.invocation);
    const projection = pipeline.projection;
    let outcomes: Awaited<ReturnType<typeof projection.project>>["outcomes"] = [];
    const payload = await captureFinalPiPayload((capture) =>
      streamPiMessages(target, pipeline.pi.context, {
        ...pipeline.pi.options,
        apiKey: "test-only-key",
        async onPayload(basePayload) {
          const projected = await projection.project(basePayload, target);
          outcomes = projected.outcomes;
          return capture(projected.payload);
        },
      }),
    );

    expect(payload).not.toHaveProperty("options.reasoning");
    expect(outcomes.find((entry) => entry.control === "reasoning.effort")?.outcome.kind)
      .toBe("degraded");
  });
});
