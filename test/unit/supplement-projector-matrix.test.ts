import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { projectSupplementPayload } from "../../src/semantic-conversion/supplement/request.js";
import { InvalidSupplementProjection } from "../../src/semantic-conversion/supplement/projectors/contract.js";
import type { ProjectionSupplement } from "../../src/semantic-conversion/supplement/contract.js";
import type { SupplementControlPath } from "../../src/semantic-conversion/supplement/contract.js";

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
      requirement: "preference",
      value: { type: "json_schema", name: "answer", schema: { type: "object" } },
    },
    verbosity: { requirement: "preference", value: "high" },
    include: { requirement: "preference", value: [] },
    topLogprobs: { requirement: "preference", value: 0 },
  },
  tools: {
    parallelCalls: { requirement: "preference", value: false },
    choice: { requirement: "preference", value: { kind: "auto" } },
  },
  sampling: {
    maxOutputTokens: { requirement: "preference", value: 512 },
    temperature: { requirement: "preference", value: 0.4 },
    topP: { requirement: "preference", value: 0.8 },
  },
  cache: {
    key: { requirement: "preference", value: "cache-key" },
    retention: { requirement: "preference", value: "24h" },
  },
  identity: {
    safetyIdentifier: { requirement: "preference", value: "safe-user" },
    deprecatedUser: { requirement: "preference", value: "legacy-user" },
  },
  lifecycle: {
    serviceTier: { requirement: "preference", value: "priority" },
    truncation: { requirement: "preference", value: "disabled" },
    background: { requirement: "preference", value: false },
    store: { requirement: "preference", value: false },
    contextManagement: { requirement: "preference", value: [] },
    streamOptions: { requirement: "preference", value: {} },
  },
};

const everyControlPath: readonly SupplementControlPath[] = [
  "output.format",
  "output.verbosity",
  "output.include",
  "output.topLogprobs",
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
  "lifecycle.background",
  "lifecycle.store",
  "lifecycle.contextManagement",
  "lifecycle.streamOptions",
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
    expect(result.outcomes.every((entry) => entry.outcome.kind !== "failed")).toBe(
      true,
    );
    expect(basePayload).toEqual(original);
  });

  it("maps Responses controls to Chat Completions fields", () => {
    const supplement: ProjectionSupplement = {
      output: {
        format: {
          requirement: "hard",
          value: {
            type: "json_schema",
            name: "answer",
            schema: { type: "object" },
            strict: true,
          },
        },
      },
      tools: {
        parallelCalls: { requirement: "hard", value: false },
        choice: {
          requirement: "hard",
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

  it("treats max_output_tokens as a response-output upper bound", () => {
    const supplement: ProjectionSupplement = {
      sampling: {
        maxOutputTokens: { requirement: "hard", value: 512 },
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
    expect(() =>
      projectSupplementPayload({
        model: model("openai-completions"),
        supplement,
        reasoning: defaultReasoning,
        payload: {
          model: "model-test",
          messages: [],
          stream: true,
          max_completion_tokens: 1_024,
        },
      }),
    ).toThrow(/equivalent sampling\.maxOutputTokens/u);
  });

  it("maps required plus serial tool use to Anthropic any", () => {
    const result = projectSupplementPayload({
      model: model("anthropic-messages"),
      supplement: {
        tools: {
          parallelCalls: { requirement: "hard", value: false },
          choice: {
            requirement: "hard",
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

  it("maps named Google choice to ANY plus allowedFunctionNames", () => {
    const result = projectSupplementPayload({
      model: model("google-vertex"),
      supplement: {
        tools: {
          choice: {
            requirement: "hard",
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
          format: { requirement: "hard", value: { type: "json_object" } },
        },
        tools: {
          parallelCalls: { requirement: "hard", value: false },
        },
        sampling: {
          topP: { requirement: "preference", value: 0.7 },
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

  it("fails hard controls unsupported by the resolved target", () => {
    expect(() =>
      projectSupplementPayload({
        model: model("bedrock-converse-stream"),
        supplement: {
          output: {
            format: {
              requirement: "hard",
              value: { type: "json_schema", name: "x", schema: {} },
            },
          },
        },
        reasoning: defaultReasoning,
        payload: {
          modelId: "model-test",
          messages: [],
          inferenceConfig: {},
        },
      }),
    ).toThrow(InvalidSupplementProjection);
  });

  it("fails background true even on an otherwise wire-capable Responses API", () => {
    expect(() =>
      projectSupplementPayload({
        model: model("openai-responses"),
        supplement: {
          lifecycle: {
            background: { requirement: "hard", value: true },
          },
        },
        reasoning: defaultReasoning,
        payload: { model: "model-test", input: [], stream: true },
      }),
    ).toThrow(/deferred fetch\/cancel lifecycle/u);
  });

  it("leaves unknown payloads untouched only when every remaining control is preferential", () => {
    const payload = { model: "future", request: [] };
    const result = projectSupplementPayload({
      model: model("future-text-api"),
      supplement: {
        output: {
          verbosity: { requirement: "preference", value: "high" },
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
