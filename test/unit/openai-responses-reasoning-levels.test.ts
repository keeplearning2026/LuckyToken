import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { resolveResponsesEffortPlan } from "../../src/protocols/openai-responses/semantic/reasoning/levels.js";

function reasoningModel(
  thinkingLevelMap: NonNullable<Model<string>["thinkingLevelMap"]>,
): Model<string> {
  return {
    id: "reasoning-model",
    name: "Reasoning Model",
    api: "test-api",
    provider: "test-provider",
    baseUrl: "https://provider.test",
    reasoning: true,
    thinkingLevelMap,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 32_000,
  };
}

const fullMap = (
  supported: Readonly<Record<string, string>>,
): NonNullable<Model<string>["thinkingLevelMap"]> => ({
  off: null,
  minimal: supported.minimal ?? null,
  low: supported.low ?? null,
  medium: supported.medium ?? null,
  high: supported.high ?? null,
  xhigh: supported.xhigh ?? null,
  max: supported.max ?? null,
});

describe("Responses effort plan", () => {
  it("selects the nearest higher Pi level while preserving the request", () => {
    const plan = resolveResponsesEffortPlan(
      reasoningModel({
        off: null,
        minimal: null,
        low: null,
        medium: null,
        high: "high",
        xhigh: null,
        max: "max",
      }),
      { kind: "enabled", level: "low" },
    );

    expect(plan).toEqual({
      kind: "enabled",
      requested: "low",
      selection: { kind: "selected", level: "high" },
    });
  });

  it.each([
    [{ high: "high", max: "max" }, "xhigh", "max"],
    [{ low: "low", high: "high" }, "max", "high"],
    [{ low: "low", high: "high", max: "max" }, "medium", "high"],
    [{ low: "low", high: "high" }, "high", "high"],
  ] as const)(
    "delegates Pi nearest-level selection for %j + %s",
    (supported, requested, selected) => {
      expect(
        resolveResponsesEffortPlan(
          reasoningModel(fullMap(supported)),
          { kind: "enabled", level: requested },
        ),
      ).toEqual({
        kind: "enabled",
        requested,
        selection: { kind: "selected", level: selected },
      });
    },
  );

  it("classifies a reasoning model with an all-null table as having no selectable level", () => {
    expect(
      resolveResponsesEffortPlan(
        reasoningModel(fullMap({})),
        { kind: "enabled", level: "high" },
      ),
    ).toEqual({
      kind: "enabled",
      requested: "high",
      selection: { kind: "no-selectable-level" },
    });
  });

  it("classifies an explicitly non-reasoning model without failing", () => {
    expect(
      resolveResponsesEffortPlan(
        { ...reasoningModel(fullMap({ high: "high" })), reasoning: false },
        { kind: "enabled", level: "high" },
      ),
    ).toEqual({
      kind: "enabled",
      requested: "high",
      selection: { kind: "non-reasoning" },
    });
  });

  it("preserves provider-default and disabled as structural plans", () => {
    const target = reasoningModel(fullMap({ high: "high" }));
    expect(resolveResponsesEffortPlan(target, { kind: "provider-default" })).toEqual({
      kind: "provider-default",
    });
    expect(resolveResponsesEffortPlan(target, { kind: "disabled" })).toEqual({
      kind: "disabled",
    });
  });

  it("freezes Pi defaults for an absent thinking-level table", () => {
    const target = reasoningModel(fullMap({}));
    Reflect.deleteProperty(target, "thinkingLevelMap");
    expect(
      resolveResponsesEffortPlan(target, { kind: "enabled", level: "max" }),
    ).toEqual({
      kind: "enabled",
      requested: "max",
      selection: { kind: "selected", level: "high" },
    });
  });
});
