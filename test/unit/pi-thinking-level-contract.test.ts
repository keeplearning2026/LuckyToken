import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Model,
  type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

function model(input: {
  readonly reasoning: boolean;
  readonly thinkingLevelMap?: ThinkingLevelMap;
}): Model<"openai-completions"> {
  return {
    id: "pi-level-contract",
    name: "Pi level contract",
    api: "openai-completions",
    provider: "test",
    baseUrl: "https://provider.invalid/v1",
    reasoning: input.reasoning,
    ...(input.thinkingLevelMap === undefined
      ? {}
      : { thinkingLevelMap: input.thinkingLevelMap }),
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 2_048,
  };
}

describe("pinned Pi thinking-level contract", () => {
  it("uses the four ordinary Pi defaults when a reasoning model has no map", () => {
    const target = model({ reasoning: true });

    expect(getSupportedThinkingLevels(target)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(clampThinkingLevel(target, "max")).toBe("high");
  });

  it("excludes null keys while retaining absent ordinary defaults and explicit extended keys", () => {
    const target = model({
      reasoning: true,
      thinkingLevelMap: {
        low: null,
        high: "provider-high",
        max: "provider-max",
      },
    });

    expect(getSupportedThinkingLevels(target)).toEqual([
      "off",
      "minimal",
      "medium",
      "high",
      "max",
    ]);
    expect(clampThinkingLevel(target, "low")).toBe("medium");
    expect(clampThinkingLevel(target, "xhigh")).toBe("max");
  });

  it("uses exact, upward, then downward selection for a complete explicit map", () => {
    const target = model({
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "provider-low",
        medium: null,
        high: "provider-high",
        xhigh: null,
        max: "provider-max",
      },
    });

    expect(getSupportedThinkingLevels(target)).toEqual(["low", "high", "max"]);
    expect(clampThinkingLevel(target, "low")).toBe("low");
    expect(clampThinkingLevel(target, "medium")).toBe("high");
    expect(clampThinkingLevel(target, "xhigh")).toBe("max");
    expect(clampThinkingLevel(target, "max")).toBe("max");
  });

  it("exposes no selectable level for a complete all-null map", () => {
    const target = model({
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
    });

    expect(getSupportedThinkingLevels(target)).toEqual([]);
    expect(clampThinkingLevel(target, "high")).toBe("off");
  });

  it("exposes only off for a non-reasoning model regardless of map omission", () => {
    const target = model({ reasoning: false });

    expect(getSupportedThinkingLevels(target)).toEqual(["off"]);
    expect(clampThinkingLevel(target, "high")).toBe("off");
  });
});
