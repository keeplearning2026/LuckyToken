import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { projectResponsesPayload as projectSupplementPayload } from "../../src/protocols/openai-responses/semantic/projection/request.js";
import type { ResponsesProjectionSupplement as ProjectionSupplement } from "../../src/protocols/openai-responses/semantic/supplement/contract.js";
import type { ResponsesProjectionControlPath as SupplementControlPath } from "../../src/protocols/openai-responses/semantic/supplement/contract.js";

function model(api: string): Model<string> {
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
  };
}

const defaultReasoning = {
  effort: { kind: "provider-default" as const },
  summary: { kind: "provider-default" as const },
};

const everyControl: ProjectionSupplement = {
  output: {
    format: {
      value: { type: "json_schema", name: "answer", schema: { type: "object" } },
    },
    verbosity: { value: "high" },
    include: { value: [] },
  },
  tools: {
    parallelCalls: { value: false },
    choice: { value: { kind: "auto" } },
  },
  sampling: {
    maxOutputTokens: { value: 512 },
    temperature: { value: 0.4 },
    topP: { value: 0.8 },
  },
  cache: {
    key: { value: "cache-key" },
    retention: { value: "24h" },
  },
  identity: {
    safetyIdentifier: { value: "safe-user" },
    deprecatedUser: { value: "legacy-user" },
  },
  lifecycle: {
    serviceTier: { value: "priority" },
    truncation: { value: "disabled" },
  },
};

const everyControlPath: readonly SupplementControlPath[] = [
  "output.format",
  "output.verbosity",
  "output.include",
  "tools.parallelCalls",
  "tools.choice",
  "sampling.maxOutputTokens",
  "sampling.temperature",
  "sampling.topP",
  "cache.key",
  "cache.retention",
  "identity.safetyIdentifier",
  "identity.deprecatedUser",
  "lifecycle.serviceTier",
  "lifecycle.truncation",
];

const accountingCases = [
  [
    "anthropic-messages",
    { model: "model-test", messages: [], stream: true, max_tokens: 256 },
  ],
  [
    "openai-completions",
    {
      model: "model-test",
      messages: [],
      stream: true,
      max_completion_tokens: 256,
    },
  ],
  [
    "openai-responses",
    { model: "model-test", input: [], stream: true, max_output_tokens: 256 },
  ],
  [
    "azure-openai-responses",
    { model: "model-test", input: [], stream: true, max_output_tokens: 256 },
  ],
  ["openai-codex-responses", { model: "model-test", input: [], stream: true }],
  [
    "google-generative-ai",
    { model: "model-test", contents: [], config: { maxOutputTokens: 256 } },
  ],
  [
    "google-vertex",
    { model: "model-test", contents: [], config: { maxOutputTokens: 256 } },
  ],
  [
    "mistral-conversations",
    { model: "model-test", messages: [], stream: true, maxTokens: 256 },
  ],
  [
    "bedrock-converse-stream",
    { modelId: "model-test", messages: [], inferenceConfig: { maxTokens: 256 } },
  ],
  ["pi-messages", { model: "model-test", context: {}, options: { maxTokens: 256 } }],
  ["commandcode-private", { params: { max_tokens: 256 } }],
  ["future-text-api", { model: "model-test", request: [] }],
] as const;

describe("Provider supplement projector matrix", () => {
  it.each(accountingCases)("accounts for every supplement control exactly once for %s", (api, basePayload) => {
    const original = structuredClone(basePayload);
    const result = projectSupplementPayload({
      model: model(api),
      supplement: everyControl,
      reasoning: defaultReasoning,
      payload: basePayload,
    });
    const controls = result.outcomes.map((entry) => entry.control);

    expect([...controls].sort()).toEqual([...everyControlPath].sort());
    expect(new Set(controls).size).toBe(everyControlPath.length);
    expect(basePayload).toEqual(original);
  });

  it("maps Responses controls to Chat Completions fields", () => {
    const supplement: ProjectionSupplement = {
      output: {
        format: {
          value: {
            type: "json_schema",
            name: "answer",
            schema: { type: "object" },
            strict: true,
          },
        },
      },
      tools: {
        parallelCalls: { value: false },
        choice: {
          value: { kind: "named", toolType: "function", name: "lookup" },
        },
      },
    };
    const result = projectSupplementPayload({
      model: model("openai-completions"),
      supplement,
      reasoning: defaultReasoning,
      payload: { model: "model-test", messages: [], stream: true },
    });

    expect(result.payload).toMatchObject({
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "answer",
          schema: { type: "object" },
          strict: true,
        },
      },
      parallel_tool_calls: false,
      tool_choice: { type: "function", function: { name: "lookup" } },
    });
  });

  it("records an equivalent Pi-built Chat payload as pi-native without rewriting it", () => {
    const payload = {
      model: "model-test",
      messages: [],
      stream: true,
      parallel_tool_calls: false,
      tool_choice: { type: "function", function: { name: "lookup" } },
    };
    const result = projectSupplementPayload({
      model: model("openai-completions"),
      supplement: {
        tools: {
          parallelCalls: { value: false },
          choice: {
            value: { kind: "named", toolType: "function", name: "lookup" },
          },
        },
      },
      reasoning: defaultReasoning,
      payload,
    });

    expect(result.payload).toEqual(payload);
    expect(result.outcomes).toEqual([
      { control: "tools.parallelCalls", outcome: { kind: "pi-native" } },
      { control: "tools.choice", outcome: { kind: "pi-native" } },
    ]);
  });

  it("marks a conflicting certified Chat field as a repaired Pi mapping", () => {
    const result = projectSupplementPayload({
      model: model("openai-completions"),
      supplement: {
        tools: {
          parallelCalls: { value: false },
        },
      },
      reasoning: defaultReasoning,
      payload: {
        model: "model-test",
        messages: [],
        stream: true,
        parallel_tool_calls: true,
      },
    });

    expect(result.payload).toHaveProperty("parallel_tool_calls", false);
    expect(result.outcomes).toEqual([
      {
        control: "tools.parallelCalls",
        outcome: {
          kind: "payload-projected",
          projector: "openai-completions",
          warning: "pi-native-mapping-repaired",
        },
      },
    ]);
  });

  it("centrally omits an unrepresentable allowed_tools fact", () => {
    const payload = { model: "future", request: [] };
    const result = projectSupplementPayload({
      model: model("future-text-api"),
      supplement: {
        tools: {
          choice: {
            value: {
              kind: "allowed",
              mode: "required",
              tools: [{ toolType: "function", name: "lookup" }],
            },
          },
        },
      },
      reasoning: defaultReasoning,
      payload,
    });

    expect(result.payload).toEqual(payload);
    expect(result.outcomes).toEqual([
      {
        control: "tools.choice",
        outcome: {
          kind: "omitted",
          warning: expect.stringMatching(/certified mapping/u),
        },
      },
    ]);
  });

  it.each([
    [
      "OpenAI Responses structured output",
      "openai-responses",
      {
        model: "model-test",
        input: [],
        stream: true,
        text: {
          format: {
            type: "json_schema",
            name: "answer",
            schema: { type: "object" },
          },
        },
      },
      {
        output: {
          format: {
            value: {
              type: "json_schema",
              name: "answer",
              schema: { type: "object" },
            },
          },
        },
      },
      "output.format",
    ],
    [
      "Azure Responses cache key",
      "azure-openai-responses",
      {
        model: "model-test",
        input: [],
        stream: true,
        prompt_cache_key: "cache-key",
      },
      { cache: { key: { value: "cache-key" } } },
      "cache.key",
    ],
    [
      "Codex Responses verbosity",
      "openai-codex-responses",
      {
        model: "model-test",
        input: [],
        stream: true,
        text: { verbosity: "high" },
      },
      { output: { verbosity: { value: "high" } } },
      "output.verbosity",
    ],
    [
      "Anthropic structured output",
      "anthropic-messages",
      {
        model: "model-test",
        messages: [],
        stream: true,
        output_config: {
          format: { type: "json_schema", schema: { type: "object" } },
        },
      },
      {
        output: {
          format: {
            value: {
              type: "json_schema",
              name: "answer",
              schema: { type: "object" },
            },
          },
        },
      },
      "output.format",
    ],
    [
      "Bedrock required tool choice",
      "bedrock-converse-stream",
      {
        modelId: "model-test",
        messages: [],
        inferenceConfig: {},
        toolConfig: { tools: [], toolChoice: { any: {} } },
      },
      {
        tools: {
          choice: { value: { kind: "required" } },
        },
      },
      "tools.choice",
    ],
    [
      "Google named tool choice",
      "google-generative-ai",
      {
        model: "model-test",
        contents: [],
        config: {
          toolConfig: {
            functionCallingConfig: {
              mode: "ANY",
              allowedFunctionNames: ["lookup"],
            },
          },
        },
      },
      {
        tools: {
          choice: {
            value: { kind: "named", toolType: "function", name: "lookup" },
          },
        },
      },
      "tools.choice",
    ],
    [
      "Mistral parallel tool calls",
      "mistral-conversations",
      {
        model: "model-test",
        messages: [],
        stream: true,
        parallelToolCalls: false,
      },
      {
        tools: {
          parallelCalls: { value: false },
        },
      },
      "tools.parallelCalls",
    ],
    [
      "Pi Messages required tool choice",
      "pi-messages",
      {
        model: "model-test",
        context: {},
        options: { toolChoice: "required" },
      },
      {
        tools: {
          choice: { value: { kind: "required" } },
        },
      },
      "tools.choice",
    ],
  ] as const)("records an equivalent %s mapping as pi-native", (_name, api, payload, supplement, control) => {
    const result = projectSupplementPayload({
      model: model(api),
      supplement: supplement as ProjectionSupplement,
      reasoning: defaultReasoning,
      payload,
    });

    expect(result.payload).toEqual(payload);
    expect(result.outcomes).toContainEqual({
      control,
      outcome: { kind: "pi-native" },
    });
  });

  it("treats every already-equivalent OpenAI Responses target field as Pi-native", () => {
    const payload = {
      model: "model-test",
      input: [],
      stream: true,
      text: {
        format: { type: "json_object" },
        verbosity: "high",
      },
      include: ["reasoning.encrypted_content"],
      parallel_tool_calls: false,
      tool_choice: "required",
      max_output_tokens: 256,
      temperature: 0.4,
      top_p: 0.8,
      prompt_cache_key: "cache-key",
      prompt_cache_retention: "24h",
      safety_identifier: "safe-user",
      user: "legacy-user",
      service_tier: "priority",
      truncation: "disabled",
    };
    const supplement: ProjectionSupplement = {
      output: {
        format: { value: { type: "json_object" } },
        verbosity: { value: "high" },
        include: {
          value: ["reasoning.encrypted_content"],
        },
      },
      tools: {
        parallelCalls: { value: false },
        choice: { value: { kind: "required" } },
      },
      sampling: {
        maxOutputTokens: { value: 512 },
        temperature: { value: 0.4 },
        topP: { value: 0.8 },
      },
      cache: {
        key: { value: "cache-key" },
        retention: { value: "24h" },
      },
      identity: {
        safetyIdentifier: { value: "safe-user" },
        deprecatedUser: { value: "legacy-user" },
      },
      lifecycle: {
        serviceTier: { value: "priority" },
        truncation: { value: "disabled" },
      },
    };
    const result = projectSupplementPayload({
      model: model("openai-responses"),
      supplement,
      reasoning: defaultReasoning,
      payload,
    });

    expect(result.payload).toEqual(payload);
    expect(result.outcomes).toHaveLength(14);
    expect(result.outcomes.every((entry) => entry.outcome.kind === "pi-native")).toBe(
      true,
    );
  });

  it("treats every already-equivalent Codex Responses target field as Pi-native", () => {
    const payload = {
      model: "model-test",
      input: [],
      stream: true,
      text: { verbosity: "high" },
      include: ["reasoning.encrypted_content"],
      parallel_tool_calls: true,
      tool_choice: "required",
      prompt_cache_key: "cache-key",
      service_tier: "priority",
    };
    const result = projectSupplementPayload({
      model: model("openai-codex-responses"),
      supplement: {
        output: {
          verbosity: { value: "high" },
          include: {
            value: ["reasoning.encrypted_content"],
          },
        },
        tools: {
          parallelCalls: { value: true },
          choice: { value: { kind: "required" } },
        },
        cache: {
          key: { value: "cache-key" },
        },
        lifecycle: {
          serviceTier: { value: "priority" },
        },
      },
      reasoning: defaultReasoning,
      payload,
    });

    expect(result.payload).toEqual(payload);
    expect(result.outcomes).toHaveLength(6);
    expect(result.outcomes.every((entry) => entry.outcome.kind === "pi-native")).toBe(
      true,
    );
  });

  it("treats every already-equivalent Chat Completions target field as Pi-native", () => {
    const payload = {
      model: "model-test",
      messages: [],
      stream: true,
      response_format: { type: "json_object" },
      parallel_tool_calls: false,
      tool_choice: "required",
      max_completion_tokens: 256,
      temperature: 0.4,
      top_p: 0.8,
      prompt_cache_key: "cache-key",
      prompt_cache_retention: "24h",
      safety_identifier: "safe-user",
      user: "legacy-user",
      service_tier: "priority",
    };
    const result = projectSupplementPayload({
      model: model("openai-completions"),
      supplement: {
        output: {
          format: { value: { type: "json_object" } },
        },
        tools: {
          parallelCalls: { value: false },
          choice: { value: { kind: "required" } },
        },
        sampling: {
          maxOutputTokens: { value: 512 },
          temperature: { value: 0.4 },
          topP: { value: 0.8 },
        },
        cache: {
          key: { value: "cache-key" },
          retention: { value: "24h" },
        },
        identity: {
          safetyIdentifier: { value: "safe-user" },
          deprecatedUser: { value: "legacy-user" },
        },
        lifecycle: {
          serviceTier: { value: "priority" },
        },
      },
      reasoning: defaultReasoning,
      payload,
    });

    expect(result.payload).toEqual(payload);
    expect(result.outcomes).toHaveLength(11);
    expect(result.outcomes.every((entry) => entry.outcome.kind === "pi-native")).toBe(
      true,
    );
  });

  it("treats every already-equivalent Anthropic target field as Pi-native", () => {
    const payload = {
      model: "model-test",
      messages: [],
      stream: true,
      output_config: {
        format: { type: "json_schema", schema: { type: "object" } },
      },
      tool_choice: { type: "any", disable_parallel_tool_use: true },
      metadata: { user_id: "safe-user", trace: "keep-me" },
      service_tier: "auto",
    };
    const result = projectSupplementPayload({
      model: model("anthropic-messages"),
      supplement: {
        output: {
          format: { value: { type: "json_object" } },
        },
        tools: {
          parallelCalls: { value: false },
          choice: { value: { kind: "required" } },
        },
        identity: {
          safetyIdentifier: { value: "safe-user" },
        },
        lifecycle: {
          serviceTier: { value: "auto" },
        },
      },
      reasoning: defaultReasoning,
      payload,
    });

    expect(result.payload).toEqual(payload);
    expect(result.outcomes).toHaveLength(5);
    expect(result.outcomes.every((entry) => entry.outcome.kind === "pi-native")).toBe(
      true,
    );
  });

  it.each(["google-generative-ai", "google-vertex"])(
    "treats an equivalent %s structured-output mapping as Pi-native",
    (api) => {
      const payload = {
        model: "model-test",
        contents: [],
        config: {
          responseMimeType: "application/json",
          responseJsonSchema: { type: "object" },
        },
      };
      const result = projectSupplementPayload({
        model: model(api),
        supplement: {
          output: {
            format: {
              value: {
                type: "json_schema",
                name: "answer",
                schema: { type: "object" },
              },
            },
          },
        },
        reasoning: defaultReasoning,
        payload,
      });

      expect(result.payload).toEqual(payload);
      expect(result.outcomes).toEqual([
        { control: "output.format", outcome: { kind: "pi-native" } },
      ]);
    },
  );

  it("projects a missing Google structured-output field without calling it a repair", () => {
    const result = projectSupplementPayload({
      model: model("google-generative-ai"),
      supplement: {
        output: {
          format: { value: { type: "json_object" } },
        },
      },
      reasoning: defaultReasoning,
      payload: { model: "model-test", contents: [], config: {} },
    });

    expect(result.payload).toMatchObject({
      config: { responseMimeType: "application/json" },
    });
    expect(result.outcomes).toEqual([
      {
        control: "output.format",
        outcome: {
          kind: "payload-projected",
          projector: "google-generative-ai",
        },
      },
    ]);
  });

  it("treats every already-equivalent Mistral target field as Pi-native", () => {
    const payload = {
      model: "model-test",
      messages: [],
      stream: true,
      responseFormat: { type: "json_object" },
      toolChoice: "required",
      promptCacheKey: "cache-key",
    };
    const result = projectSupplementPayload({
      model: model("mistral-conversations"),
      supplement: {
        output: {
          format: { value: { type: "json_object" } },
        },
        tools: {
          choice: { value: { kind: "required" } },
        },
        cache: {
          key: { value: "cache-key" },
        },
      },
      reasoning: defaultReasoning,
      payload,
    });

    expect(result.payload).toEqual(payload);
    expect(result.outcomes).toHaveLength(3);
    expect(result.outcomes.every((entry) => entry.outcome.kind === "pi-native")).toBe(
      true,
    );
  });

  it("treats an already absent Bedrock tool configuration as native none", () => {
    const payload = {
      modelId: "model-test",
      messages: [],
      inferenceConfig: {},
    };
    const result = projectSupplementPayload({
      model: model("bedrock-converse-stream"),
      supplement: {
        tools: {
          choice: { value: { kind: "none" } },
        },
      },
      reasoning: defaultReasoning,
      payload,
    });

    expect(result.payload).toEqual(payload);
    expect(result.outcomes).toEqual([
      { control: "tools.choice", outcome: { kind: "pi-native" } },
    ]);
  });

  it("treats max_output_tokens as a response-output upper bound", () => {
    const supplement: ProjectionSupplement = {
      sampling: {
        maxOutputTokens: { value: 512 },
      },
    };
    const lower = projectSupplementPayload({
      model: model("openai-completions"),
      supplement,
      reasoning: defaultReasoning,
      payload: {
        model: "model-test",
        messages: [],
        stream: true,
        max_completion_tokens: 256,
      },
    });

    expect(lower.outcomes).toContainEqual({
      control: "sampling.maxOutputTokens",
      outcome: { kind: "pi-native" },
    });
    const tooHigh = projectSupplementPayload({
      model: model("openai-completions"),
      supplement,
      reasoning: defaultReasoning,
      payload: {
        model: "model-test",
        messages: [],
        stream: true,
        max_completion_tokens: 1_024,
      },
    });

    expect(tooHigh.payload).toHaveProperty("max_completion_tokens", 512);
    expect(tooHigh.outcomes).toContainEqual({
      control: "sampling.maxOutputTokens",
      outcome: {
        kind: "payload-projected",
        projector: "openai-completions",
        warning: "pi-native-mapping-repaired",
      },
    });
  });

  it.each([
    ["anthropic-messages", { model: "model-test", messages: [], stream: true, max_tokens: 1_024 }, { max_tokens: 512 }],
    ["openai-responses", { model: "model-test", input: [], stream: true, max_output_tokens: 1_024 }, { max_output_tokens: 512 }],
    ["azure-openai-responses", { model: "model-test", input: [], stream: true, max_output_tokens: 1_024 }, { max_output_tokens: 512 }],
    ["google-generative-ai", { model: "model-test", contents: [], config: { maxOutputTokens: 1_024 } }, { config: { maxOutputTokens: 512 } }],
    ["google-vertex", { model: "model-test", contents: [], config: { maxOutputTokens: 1_024 } }, { config: { maxOutputTokens: 512 } }],
    ["mistral-conversations", { model: "model-test", messages: [], stream: true, maxTokens: 1_024 }, { maxTokens: 512 }],
    ["bedrock-converse-stream", { modelId: "model-test", messages: [], inferenceConfig: { maxTokens: 1_024 } }, { inferenceConfig: { maxTokens: 512 } }],
    ["pi-messages", { model: "model-test", context: {}, options: { maxTokens: 1_024 } }, { options: { maxTokens: 512 } }],
    ["commandcode-private", { params: { max_tokens: 1_024 } }, { params: { max_tokens: 512 } }],
  ] as const)("repairs an excessive Pi-native output ceiling for %s", (api, payload, expected) => {
    const result = projectSupplementPayload({
      model: model(api),
      supplement: {
        sampling: {
          maxOutputTokens: { value: 512 },
        },
      },
      reasoning: defaultReasoning,
      payload,
    });

    expect(result.payload).toMatchObject(expected);
    expect(result.outcomes).toContainEqual({
      control: "sampling.maxOutputTokens",
      outcome: {
        kind: "payload-projected",
        projector: api,
        warning: "pi-native-mapping-repaired",
      },
    });
  });

  it("maps required plus serial tool use to Anthropic any", () => {
    const result = projectSupplementPayload({
      model: model("anthropic-messages"),
      supplement: {
        tools: {
          parallelCalls: { value: false },
          choice: {
            value: { kind: "required" },
          },
        },
      },
      reasoning: defaultReasoning,
      payload: {
        model: "model-test",
        messages: [],
        stream: true,
        max_tokens: 128,
      },
    });

    expect(result.payload).toMatchObject({
      tool_choice: { type: "any", disable_parallel_tool_use: true },
    });
  });

  it("omits Anthropic temperature while extended thinking is enabled", () => {
    const result = projectSupplementPayload({
      model: model("anthropic-messages"),
      supplement: {
        sampling: {
          temperature: { value: 0.4 },
        },
      },
      reasoning: {
        effort: { kind: "enabled", level: "high" },
        summary: { kind: "provider-default" },
      },
      payload: {
        model: "model-test",
        messages: [],
        stream: true,
        max_tokens: 128,
        thinking: { type: "enabled", budget_tokens: 1_024 },
      },
    });

    expect(result.payload).not.toHaveProperty("temperature");
    expect(result.outcomes).toEqual([
      {
        control: "sampling.temperature",
        outcome: {
          kind: "omitted",
          warning: expect.stringMatching(/no certified mapping/u),
        },
      },
    ]);
  });

  it("omits Anthropic temperature when the resolved model disables it", () => {
    const result = projectSupplementPayload({
      model: ({
        ...(model("anthropic-messages") as Model<"anthropic-messages">),
        compat: { supportsTemperature: false },
      } as unknown as Model<string>),
      supplement: {
        sampling: {
          temperature: { value: 0.4 },
        },
      },
      reasoning: defaultReasoning,
      payload: {
        model: "model-test",
        messages: [],
        stream: true,
        max_tokens: 128,
      },
    });

    expect(result.payload).not.toHaveProperty("temperature");
    expect(result.outcomes).toEqual([
      {
        control: "sampling.temperature",
        outcome: {
          kind: "omitted",
          warning: expect.stringMatching(/no certified mapping/u),
        },
      },
    ]);
  });

  it("maps named Google choice to ANY plus allowedFunctionNames", () => {
    const result = projectSupplementPayload({
      model: model("google-vertex"),
      supplement: {
        tools: {
          choice: {
            value: { kind: "named", toolType: "function", name: "lookup" },
          },
        },
      },
      reasoning: defaultReasoning,
      payload: { model: "model-test", contents: [], config: {} },
    });

    expect(result.payload).toMatchObject({
      config: {
        toolConfig: {
          functionCallingConfig: {
            mode: "ANY",
            allowedFunctionNames: ["lookup"],
          },
        },
      },
    });
  });

  it("maps Mistral fields in Pi's audited pre-serialization payload shape", () => {
    const result = projectSupplementPayload({
      model: model("mistral-conversations"),
      supplement: {
        output: {
          format: { value: { type: "json_object" } },
        },
        tools: {
          parallelCalls: { value: false },
        },
        sampling: {
          topP: { value: 0.7 },
        },
      },
      reasoning: defaultReasoning,
      payload: { model: "model-test", messages: [], stream: true },
    });

    expect(result.payload).toMatchObject({
      responseFormat: { type: "json_object" },
      parallelToolCalls: false,
      topP: 0.7,
    });
  });

  it("centrally omits controls unsupported by the resolved target", () => {
    const payload = {
      modelId: "model-test",
      messages: [],
      inferenceConfig: {},
    };
    const result = projectSupplementPayload({
      model: model("bedrock-converse-stream"),
      supplement: {
        output: {
          format: {
            value: { type: "json_schema", name: "x", schema: {} },
          },
        },
      },
      reasoning: defaultReasoning,
      payload,
    });

    expect(result.payload).toEqual(payload);
    expect(result.outcomes).toContainEqual({
      control: "output.format",
      outcome: {
        kind: "omitted",
        warning: expect.stringMatching(/no certified mapping/u),
      },
    });
  });

  it("records a verified Anthropic one-hour cache fallback as degraded", () => {
    const payload = {
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
    };
    const result = projectSupplementPayload({
      model: model("anthropic-messages"),
      supplement: {
        cache: {
          retention: { value: "24h" },
        },
      },
      reasoning: defaultReasoning,
      payload,
    });

    expect(result.payload).toEqual(payload);
    expect(result.outcomes).toContainEqual({
      control: "cache.retention",
      outcome: {
        kind: "degraded",
        projector: "anthropic-messages",
        fallback: "cache-retention-24h-to-1h",
        warning: expect.stringMatching(/one hour/u),
      },
    });
  });

  it("records a verified Bedrock one-hour cache fallback as degraded", () => {
    const payload = {
      modelId: "model-test",
      messages: [
        {
          role: "user",
          content: [{ cachePoint: { type: "default", ttl: "1h" } }],
        },
      ],
      inferenceConfig: {},
    };
    const result = projectSupplementPayload({
      model: model("bedrock-converse-stream"),
      supplement: {
        cache: {
          retention: { value: "24h" },
        },
      },
      reasoning: defaultReasoning,
      payload,
    });

    expect(result.payload).toEqual(payload);
    expect(result.outcomes).toContainEqual({
      control: "cache.retention",
      outcome: {
        kind: "degraded",
        projector: "bedrock-converse-stream",
        fallback: "cache-retention-24h-to-1h",
        warning: expect.stringMatching(/one hour/u),
      },
    });
  });

  it("leaves unknown payloads untouched only when every remaining control is preferential", () => {
    const payload = { model: "future", request: [] };
    const result = projectSupplementPayload({
      model: model("future-text-api"),
      supplement: {
        output: {
          verbosity: { value: "high" },
        },
      },
      reasoning: defaultReasoning,
      payload,
    });

    expect(result.payload).toEqual(payload);
    expect(result.outcomes).toEqual([
      expect.objectContaining({
        control: "output.verbosity",
        outcome: { kind: "omitted", warning: expect.any(String) },
      }),
    ]);
  });
});
