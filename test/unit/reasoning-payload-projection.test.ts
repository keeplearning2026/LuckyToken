import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import type {
  PreparedReasoning,
  ReasoningEffortIntent,
  ReasoningSummaryIntent,
} from "../../src/semantic-conversion/reasoning/contract.js";
import {
  InvalidReasoningProjection,
} from "../../src/semantic-conversion/reasoning/adapters/payload.js";
import { projectReasoningPayload } from "../../src/semantic-conversion/reasoning/request.js";

function model(
  api: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Model<string> {
  return {
    id: "model-test",
    name: "model-test",
    api,
    provider: "provider-test",
    baseUrl: "https://provider.test/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 1_024,
    ...overrides,
  } as Model<string>;
}

function prepared(
  effort: ReasoningEffortIntent,
  summary: ReasoningSummaryIntent = { kind: "provider-default" },
): PreparedReasoning {
  return {
    context: { messages: [] },
    options: {},
    request: { effort, summary },
    outcomes: [],
  };
}

describe("reasoning Provider payload projection", () => {
  it("restores provider-default omission after Pi emitted an OpenAI off value", () => {
    const base = {
      model: "model-test",
      messages: [],
      stream: true,
      reasoning_effort: "none",
    };
    const result = projectReasoningPayload({
      model: model("openai-completions", {
        compat: { supportsReasoningEffort: true, thinkingFormat: "openai" },
      }),
      prepared: prepared({ kind: "provider-default" }),
      payload: base,
    });

    expect(result.payload).not.toHaveProperty("reasoning_effort");
    expect(base).toHaveProperty("reasoning_effort", "none");
    expect(result.outcomes).toContainEqual({
      subject: "effort",
      outcome: {
        kind: "payload-projected",
        projector: "openai-completions",
        warning: "pi-native-mapping-repaired",
      },
    });
  });

  it("requires a concrete OpenAI Completions off field for explicit disable", () => {
    expect(() =>
      projectReasoningPayload({
        model: model("openai-completions", {
          compat: { supportsReasoningEffort: true, thinkingFormat: "openai" },
        }),
        prepared: prepared({ kind: "disabled" }),
        payload: { model: "model-test", messages: [], stream: true },
      }),
    ).toThrow(InvalidReasoningProjection);
  });

  it("repairs an incorrect Pi-native OpenAI Completions off value with a warning", () => {
    const result = projectReasoningPayload({
      model: model("openai-completions", {
        compat: { supportsReasoningEffort: true, thinkingFormat: "openai" },
        thinkingLevelMap: { off: "none" },
      }),
      prepared: prepared({ kind: "disabled" }),
      payload: {
        model: "model-test",
        messages: [],
        stream: true,
        reasoning_effort: "high",
      },
    });

    expect(result.payload).toHaveProperty("reasoning_effort", "none");
    expect(result.outcomes).toContainEqual({
      subject: "effort",
      outcome: {
        kind: "payload-projected",
        projector: "openai-completions",
        warning: "pi-native-mapping-repaired",
      },
    });
  });

  it("repairs an incorrect Pi-native OpenAI Completions enabled effort with a warning", () => {
    const result = projectReasoningPayload({
      model: model("openai-completions", {
        compat: { supportsReasoningEffort: true, thinkingFormat: "openai" },
      }),
      prepared: prepared({ kind: "enabled", level: "high" }),
      payload: {
        model: "model-test",
        messages: [],
        stream: true,
        reasoning_effort: "low",
      },
    });

    expect(result.payload).toHaveProperty("reasoning_effort", "high");
    expect(result.outcomes).toContainEqual({
      subject: "effort",
      outcome: {
        kind: "payload-projected",
        projector: "openai-completions",
        warning: "pi-native-mapping-repaired",
      },
    });
  });

  it.each([
    [
      "deepseek",
      { supportsReasoningEffort: true },
      { thinking: { type: "enabled" }, reasoning_effort: "high" },
    ],
    [
      "zai",
      { supportsReasoningEffort: false },
      { thinking: { type: "enabled", clear_thinking: false } },
    ],
    [
      "qwen",
      { supportsReasoningEffort: true },
      { enable_thinking: true, reasoning_effort: "high" },
    ],
    [
      "qwen-chat-template",
      {},
      { chat_template_kwargs: { enable_thinking: true, preserve_thinking: true } },
    ],
    ["openrouter", {}, { reasoning: { effort: "high" } }],
    ["together", { supportsReasoningEffort: false }, { reasoning: { enabled: true } }],
    ["string-thinking", {}, { thinking: "high" }],
    ["ant-ling", {}, { reasoning: { effort: "high" } }],
  ] as const)(
    "repairs the %s OpenAI Completions thinking format",
    (thinkingFormat, compat, expected) => {
      const result = projectReasoningPayload({
        model: model("openai-completions", {
          compat: { thinkingFormat, ...compat },
          thinkingLevelMap:
            thinkingFormat === "ant-ling" ? { high: "high" } : undefined,
        }),
        prepared: prepared({ kind: "enabled", level: "high" }),
        payload: { model: "model-test", messages: [], stream: true },
      });

      expect(result.payload).toMatchObject(expected);
      expect(result.outcomes).toContainEqual({
        subject: "effort",
        outcome: {
          kind: "payload-projected",
          projector: "openai-completions",
          warning: "pi-native-mapping-repaired",
        },
      });
    },
  );

  it.each([
    [
      "chat-template",
      { chatTemplateKwargs: { enabled: { $var: "thinking.enabled" } } },
      { chat_template_kwargs: { enabled: true } },
    ],
    [
      "baseten",
      {
        supportsReasoningEffort: true,
        chatTemplateArgs: { effort: { $var: "thinking.effort" } },
      },
      { chat_template_args: { effort: "high" }, reasoning_effort: "high" },
    ],
  ] as const)(
    "repairs configured %s OpenAI Completions template fields",
    (thinkingFormat, compat, expected) => {
      const result = projectReasoningPayload({
        model: model("openai-completions", {
          compat: { thinkingFormat, ...compat },
        }),
        prepared: prepared({ kind: "enabled", level: "high" }),
        payload: { model: "model-test", messages: [], stream: true },
      });
      expect(result.payload).toMatchObject(expected);
    },
  );

  it("projects independent Responses summary while preserving effort omission", () => {
    const result = projectReasoningPayload({
      model: model("openai-responses"),
      prepared: prepared(
        { kind: "provider-default" },
        { kind: "requested", value: "detailed" },
      ),
      payload: { model: "model-test", input: [], stream: true },
    });

    expect(result.payload).toMatchObject({ reasoning: { summary: "detailed" } });
    expect((result.payload as { reasoning: object }).reasoning).not.toHaveProperty(
      "effort",
    );
  });

  it("warns when provider-default omission repairs a Responses effort", () => {
    const result = projectReasoningPayload({
      model: model("openai-responses"),
      prepared: prepared({ kind: "provider-default" }),
      payload: {
        model: "model-test",
        input: [],
        stream: true,
        reasoning: { effort: "none" },
      },
    });

    expect(result.payload).not.toHaveProperty("reasoning");
    expect(result.outcomes).toContainEqual({
      subject: "effort",
      outcome: {
        kind: "payload-projected",
        projector: "openai-responses",
        warning: "pi-native-mapping-repaired",
      },
    });
  });

  it("projects an explicit Responses off rather than collapsing it to omission", () => {
    const result = projectReasoningPayload({
      model: model("azure-openai-responses"),
      prepared: prepared({ kind: "disabled" }),
      payload: { model: "model-test", input: [], stream: true },
    });

    expect(result.payload).toMatchObject({ reasoning: { effort: "none" } });
  });

  it("repairs an incorrect Pi-native Responses enabled effort with a warning", () => {
    const result = projectReasoningPayload({
      model: model("openai-responses"),
      prepared: prepared({ kind: "enabled", level: "high" }),
      payload: {
        model: "model-test",
        input: [],
        stream: true,
        reasoning: { effort: "low" },
      },
    });

    expect(result.payload).toMatchObject({ reasoning: { effort: "high" } });
    expect(result.outcomes).toContainEqual({
      subject: "effort",
      outcome: {
        kind: "payload-projected",
        projector: "openai-responses",
        warning: "pi-native-mapping-repaired",
      },
    });
  });

  it("removes Pi's implicit disable for provider-default Anthropic and Google", () => {
    const anthropic = projectReasoningPayload({
      model: model("anthropic-messages"),
      prepared: prepared({ kind: "provider-default" }),
      payload: {
        model: "model-test",
        messages: [],
        stream: true,
        thinking: { type: "disabled" },
      },
    });
    const google = projectReasoningPayload({
      model: model("google-generative-ai"),
      prepared: prepared({ kind: "provider-default" }),
      payload: {
        model: "model-test",
        contents: [],
        config: { thinkingConfig: { thinkingBudget: 0 } },
      },
    });

    expect(anthropic.payload).not.toHaveProperty("thinking");
    expect((google.payload as { config: object }).config).not.toHaveProperty(
      "thinkingConfig",
    );
    for (const result of [anthropic, google]) {
      expect(result.outcomes).toContainEqual({
        subject: "effort",
        outcome: {
          kind: "payload-projected",
          projector: expect.any(String),
          warning: "pi-native-mapping-repaired",
        },
      });
    }
  });

  it("warns when provider-default omission repairs a Pi Messages value", () => {
    const result = projectReasoningPayload({
      model: model("pi-messages"),
      prepared: prepared({ kind: "provider-default" }),
      payload: {
        model: "model-test",
        context: { messages: [] },
        options: { reasoning: "off" },
      },
    });

    expect(result.payload).toMatchObject({ options: {} });
    expect(result.outcomes).toContainEqual({
      subject: "effort",
      outcome: {
        kind: "payload-projected",
        projector: "pi-messages",
        warning: "pi-native-mapping-repaired",
      },
    });
  });

  it("rejects explicit reasoning off when the Google model cannot disable thinking", () => {
    expect(() =>
      projectReasoningPayload({
        model: model("google-generative-ai", { id: "gemini-3-flash" }),
        prepared: prepared({ kind: "disabled" }),
        payload: {
          model: "gemini-3-flash",
          contents: [],
          config: { thinkingConfig: { thinkingLevel: "MINIMAL" } },
        },
      }),
    ).toThrow(/cannot disable reasoning/u);
  });

  it("repairs incorrect adaptive Anthropic reasoning fields", () => {
    const result = projectReasoningPayload({
      model: model("anthropic-messages", {
        compat: { forceAdaptiveThinking: true },
      }),
      prepared: prepared({ kind: "enabled", level: "high" }),
      payload: {
        model: "model-test",
        messages: [],
        stream: true,
        max_tokens: 2_048,
        thinking: { type: "disabled" },
      },
    });

    expect(result.payload).toMatchObject({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
    });
    expect(result.outcomes).toContainEqual({
      subject: "effort",
      outcome: {
        kind: "payload-projected",
        projector: "anthropic-messages",
        warning: "pi-native-mapping-repaired",
      },
    });
  });

  it("repairs an incorrect enabled Google thinking config", () => {
    const result = projectReasoningPayload({
      model: model("google-generative-ai", { id: "gemini-2.5-flash" }),
      prepared: prepared({ kind: "enabled", level: "medium" }),
      payload: {
        model: "gemini-2.5-flash",
        contents: [],
        config: { thinkingConfig: { thinkingBudget: 0 } },
      },
    });

    expect(result.payload).toMatchObject({
      config: {
        thinkingConfig: { includeThoughts: true, thinkingBudget: 8_192 },
      },
    });
  });

  it("repairs an incorrect Mistral reasoning field", () => {
    const result = projectReasoningPayload({
      model: model("mistral-conversations", {
        id: "mistral-small-latest",
      }),
      prepared: prepared({ kind: "enabled", level: "medium" }),
      payload: {
        model: "mistral-small-latest",
        messages: [],
        stream: true,
        promptMode: "reasoning",
      },
    });

    expect(result.payload).toMatchObject({ reasoningEffort: "high" });
    expect(result.payload).not.toHaveProperty("promptMode");
  });

  it("fails an uncertified Bedrock reasoning payload instead of guessing", () => {
    expect(() =>
      projectReasoningPayload({
        model: model("bedrock-converse-stream", {
          id: "anthropic.claude-test",
          name: "Claude test",
        }),
        prepared: prepared({ kind: "enabled", level: "high" }),
        payload: {
          modelId: "anthropic.claude-test",
          messages: [],
          inferenceConfig: {},
          additionalModelRequestFields: { thinking: { type: "mystery" } },
        },
      }),
    ).toThrow(/uncertified Bedrock reasoning shape/u);
  });

  it("repairs CommandCode Private reasoning effort to its certified mapping", () => {
    const result = projectReasoningPayload({
      model: model("commandcode-private"),
      prepared: prepared({ kind: "enabled", level: "medium" }),
      payload: {
        params: { reasoning_effort: "low" },
      },
    });

    expect(result.payload).toMatchObject({
      params: { reasoning_effort: "medium" },
    });
    expect(result.outcomes).toContainEqual({
      subject: "effort",
      outcome: {
        kind: "payload-projected",
        projector: "commandcode-private",
        warning: "pi-native-mapping-repaired",
      },
    });
  });

  it("repairs Pi Messages reasoning when the final option differs", () => {
    const result = projectReasoningPayload({
      model: model("pi-messages"),
      prepared: prepared({ kind: "enabled", level: "high" }),
      payload: {
        model: "model-test",
        context: { messages: [] },
        options: { reasoning: "low" },
      },
    });

    expect(result.payload).toMatchObject({ options: { reasoning: "high" } });
    expect(result.outcomes).toContainEqual({
      subject: "effort",
      outcome: {
        kind: "payload-projected",
        projector: "pi-messages",
        warning: "pi-native-mapping-repaired",
      },
    });
  });

  it("fails payload-shape drift before projection", () => {
    expect(() =>
      projectReasoningPayload({
        model: model("openai-responses"),
        prepared: prepared({ kind: "provider-default" }),
        payload: { model: "model-test", messages: [], stream: true },
      }),
    ).toThrow(/payload shape mismatch at input/u);
  });

  it("does not mutate unknown APIs and reports non-default controls", () => {
    const base = { model: "model-test", request: "opaque" };
    const result = projectReasoningPayload({
      model: model("future-text-api"),
      prepared: prepared(
        { kind: "enabled", level: "high" },
        { kind: "requested", value: "auto" },
      ),
      payload: base,
    });

    expect(result.payload).toEqual(base);
    expect(result.outcomes).toEqual([
      expect.objectContaining({
        subject: "effort",
        outcome: { kind: "omitted", warning: expect.any(String) },
      }),
      expect.objectContaining({
        subject: "summary",
        outcome: { kind: "omitted", warning: expect.any(String) },
      }),
    ]);
  });
});
