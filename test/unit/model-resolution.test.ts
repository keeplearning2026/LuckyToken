import type { Model, Models } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  ModelResolutionFailure,
  resolveModel,
  selectorTool,
} from "../../src/model-resolution.js";

function model(provider: string, id: string): Model<string> {
  return {
    id,
    name: id,
    api: "fixture",
    provider,
    baseUrl: "https://fixture.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  };
}

function catalog(models: readonly Model<string>[]): Pick<Models, "getModels"> {
  return { getModels: () => models };
}

describe("selectorTool.parse", () => {
  it("splits on the first slash, keeping remaining slashes in the model id", () => {
    expect(selectorTool.parse("commandcode-private/deepseek/deepseek-v4-flash")).toEqual({
      provider: "commandcode-private",
      modelId: "deepseek/deepseek-v4-flash",
    });
    expect(selectorTool.parse("deepseek/deepseek-v4-flash")).toEqual({
      provider: "deepseek",
      modelId: "deepseek-v4-flash",
    });
  });

  it("returns a bare selector with no provider", () => {
    expect(selectorTool.parse("deepseek-v4-flash")).toEqual({
      provider: undefined,
      modelId: "deepseek-v4-flash",
    });
  });

  it("trims surrounding whitespace on both parts", () => {
    expect(selectorTool.parse("  deepseek  /  deepseek-v4-flash  ")).toEqual({
      provider: "deepseek",
      modelId: "deepseek-v4-flash",
    });
  });

  it("keeps empty parts visible instead of guessing", () => {
    expect(selectorTool.parse("/deepseek-v4-flash")).toEqual({
      provider: "",
      modelId: "deepseek-v4-flash",
    });
    expect(selectorTool.parse("deepseek/")).toEqual({
      provider: "deepseek",
      modelId: "",
    });
    expect(selectorTool.parse("")).toEqual({
      provider: undefined,
      modelId: "",
    });
  });
});

describe("selectorTool.format", () => {
  it("joins provider and model id with the canonical separator", () => {
    expect(selectorTool.format("commandcode-private", "deepseek/deepseek-v4-flash")).toBe(
      "commandcode-private/deepseek/deepseek-v4-flash",
    );
    expect(selectorTool.format("deepseek", "deepseek-v4-flash")).toBe(
      "deepseek/deepseek-v4-flash",
    );
  });

  it("round-trips with selectorTool.parse: parse(format(p, m)) === {p, m}", () => {
    for (const [provider, modelId] of [
      ["commandcode-private", "deepseek/deepseek-v4-flash"],
      ["deepseek", "deepseek-v4-flash"],
      ["openai", "gpt-5"],
      ["a", "b/c/d"],
    ] as const) {
      expect(selectorTool.parse(selectorTool.format(provider, modelId))).toEqual({
        provider,
        modelId,
      });
    }
  });

  it("round-trips the other way: format(parse(x)) canonicalizes x", () => {
    for (const selector of [
      "commandcode-private/deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-flash",
    ]) {
      const { provider, modelId } = selectorTool.parse(selector);
      expect(selectorTool.format(provider as string, modelId)).toBe(selector);
    }
  });
});

describe("resolveModel", () => {
  it("resolves exact unique ids and exact provider-qualified selectors", () => {
    const first = model("first", "shared");
    const second = model("second", "unique");
    const models = catalog([first, second]);

    expect(resolveModel(models, "unique")).toBe(second);
    expect(resolveModel(models, "first/shared")).toBe(first);
  });

  it("resolves a provider-qualified selector against a model id containing slashes", () => {
    const commandCode = model("commandcode-private", "deepseek/deepseek-v4-flash");
    const models = catalog([commandCode]);

    expect(
      resolveModel(models, "commandcode-private/deepseek/deepseek-v4-flash"),
    ).toBe(commandCode);
  });

  it("distinguishes providers sharing a bare model id", () => {
    const commandCode = model("commandcode-private", "deepseek/deepseek-v4-flash");
    const piDeepseek = model("deepseek", "deepseek-v4-flash");
    const models = catalog([commandCode, piDeepseek]);

    expect(resolveModel(models, "deepseek/deepseek-v4-flash")).toBe(piDeepseek);
    expect(
      resolveModel(models, "commandcode-private/deepseek/deepseek-v4-flash"),
    ).toBe(commandCode);
  });

  it("rejects unknown and ambiguous selectors without fuzzy fallback", () => {
    const models = catalog([
      model("first", "shared"),
      model("second", "shared"),
      model("third", "prefix-match"),
    ]);

    expect(() => resolveModel(models, "shared")).toThrow(ModelResolutionFailure);
    expect(() => resolveModel(models, "prefix")).toThrow(ModelResolutionFailure);
    expect(() => resolveModel(models, "missing")).toThrow(ModelResolutionFailure);
  });
});
