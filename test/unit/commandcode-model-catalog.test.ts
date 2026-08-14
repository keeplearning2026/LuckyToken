import { describe, expect, it } from "vitest";

import {
  COMMANDCODE_MODELS,
  findCommandCodeModel,
} from "../../packages/provider-commandcode-private/src/models.js";

describe("CommandCode model catalog", () => {
  it("ships every model from the source table", () => {
    expect(COMMANDCODE_MODELS.length).toBe(33);
  });

  it("keeps the built-in default model present with its known id", () => {
    const model = findCommandCodeModel("deepseek/deepseek-v4-flash");
    expect(model).toBeDefined();
    expect(model?.reasoning).toBe(true);
    expect(model?.input).toEqual(["text"]);
    expect(model?.maxTokens).toBe(64_000);
  });

  it("uses a model-specific output limit when the official catalog provides one", () => {
    const model = findCommandCodeModel("poolside/laguna-s-2.1-free");
    expect(model?.maxTokens).toBe(32_000);
  });

  it("maps T-only caps to text-only input and no reasoning", () => {
    const model = findCommandCodeModel("zai-org/GLM-5.2-Fast");
    expect(model?.input).toEqual(["text"]);
    expect(model?.reasoning).toBe(false);
  });

  it("maps V caps to image input", () => {
    const model = findCommandCodeModel("meta/muse-spark-1.2");
    expect(model?.input).toEqual(["text", "image"]);
  });

  it("maps R caps to reasoning with the official effort map", () => {
    const model = findCommandCodeModel("deepseek/deepseek-v4-pro");
    expect(model?.reasoning).toBe(true);
    expect(model?.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    });
  });

  it("keeps a full effort map when the official table lists no efforts", () => {
    const model = findCommandCodeModel("moonshotai/Kimi-K3");
    expect(model?.reasoning).toBe(true);
    expect(model?.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    });
  });

  it("uses the official pricing values", () => {
    const model = findCommandCodeModel("deepseek/deepseek-v4-pro");
    expect(model?.cost).toEqual({
      input: 0.435,
      output: 0.87,
      cacheRead: 0.003625,
      cacheWrite: 0,
    });
  });

  it("treats Free and unsupported cache write as zero", () => {
    const free = findCommandCodeModel("poolside/laguna-s-2.1-free");
    expect(free?.cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("freezes every model and its nested state", () => {
    for (const model of COMMANDCODE_MODELS) {
      expect(Object.isFrozen(model)).toBe(true);
      expect(Object.isFrozen(model.cost)).toBe(true);
      expect(Object.isFrozen(model.input)).toBe(true);
    }
  });
});
