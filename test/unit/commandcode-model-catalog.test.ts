import { describe, expect, it } from "vitest";

import {
  COMMANDCODE_MODELS,
  findCommandCodeModel,
} from "../../packages/provider-commandcode-private/src/models.js";
import { COMMANDCODE_GOAT_MODELS } from "../../packages/provider-commandcode-goat/src/models.js";

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

  it("does not track volatile upstream prices", () => {
    for (const model of COMMANDCODE_MODELS) {
      expect(model.cost).toEqual({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
    }
  });

  it("projects the same capability catalog for CommandCode Goat", () => {
    expect(COMMANDCODE_GOAT_MODELS).toHaveLength(33);
    expect(
      COMMANDCODE_GOAT_MODELS.map((model) => ({
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        thinkingLevelMap: model.thinkingLevelMap,
        input: model.input,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      })),
    ).toEqual(
      COMMANDCODE_MODELS.map((model) => ({
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        thinkingLevelMap: model.thinkingLevelMap,
        input: model.input,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      })),
    );
    expect(COMMANDCODE_GOAT_MODELS[0]).toMatchObject({
      provider: "commandcode-goat",
      api: "openai-completions",
      baseUrl: "https://api.commandcode.ai/provider/v1",
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
