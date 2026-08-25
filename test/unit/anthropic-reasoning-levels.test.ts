import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { resolveAnthropicEffortPlan } from "../../src/protocols/anthropic/semantic/reasoning/levels.js";

function model(overrides: Partial<Model<"openai-completions">> = {}) {
  return {
    id: "reasoning-test",
    name: "Reasoning test",
    api: "openai-completions",
    provider: "test",
    baseUrl: "https://provider.invalid/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 2_048,
    ...overrides,
  } as Model<"openai-completions">;
}

describe("Anthropic reasoning effort selection", () => {
  it.each(["low", "medium", "high", "xhigh", "max"] as const)(
    "maps the Anthropic %s effort to the identical supported Pi key",
    (requested) => {
      expect(resolveAnthropicEffortPlan(
        model({
          thinkingLevelMap: {
            off: null,
            minimal: null,
            low: "provider-low",
            medium: "provider-medium",
            high: "provider-high",
            xhigh: "provider-extra-high",
            max: "provider-ultra",
          },
        }),
        { kind: "specified", level: requested },
      )).toEqual({
        kind: "specified",
        requested,
        selection: { kind: "selected", level: requested },
      });
    },
  );

  it.each([
    [
      "prefers the nearest higher level",
      {
        off: null,
        minimal: null,
        low: null,
        medium: null,
        high: "high",
        xhigh: null,
        max: "max",
      },
      "low",
      "high",
    ],
    [
      "falls back to the nearest lower level",
      {
        off: null,
        minimal: null,
        low: "low",
        medium: null,
        high: "high",
        xhigh: null,
        max: null,
      },
      "max",
      "high",
    ],
    [
      "maps a client low request back to a minimal-only model",
      {
        off: null,
        minimal: "minimal",
        low: null,
        medium: null,
        high: null,
        xhigh: null,
        max: null,
      },
      "low",
      "minimal",
    ],
  ] as const)("%s", (_label, thinkingLevelMap, requested, selected) => {
    expect(resolveAnthropicEffortPlan(
      model({ thinkingLevelMap }),
      { kind: "specified", level: requested },
    )).toEqual({
      kind: "specified",
      requested,
      selection: { kind: "selected", level: selected },
    });
  });

  it("classifies a reasoning model whose complete level table is all null", () => {
    expect(resolveAnthropicEffortPlan(
      model({
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: null,
          medium: null,
          high: null,
          xhigh: null,
          max: null,
        },
      }),
      { kind: "specified", level: "high" },
    )).toEqual({
      kind: "specified",
      requested: "high",
      selection: { kind: "no-selectable-level" },
    });
  });

  it("classifies a non-reasoning model without rejecting the requested level", () => {
    expect(resolveAnthropicEffortPlan(
      model({ reasoning: false }),
      { kind: "specified", level: "high" },
    )).toEqual({
      kind: "specified",
      requested: "high",
      selection: { kind: "non-reasoning" },
    });
  });

  it.each(["omitted", "explicit-null"] as const)(
    "preserves structural %s intent without selecting a level",
    (kind) => {
      expect(resolveAnthropicEffortPlan(model(), { kind })).toEqual({ kind });
    },
  );
});
