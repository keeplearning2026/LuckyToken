import type { Model, Models } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  ModelResolutionFailure,
  resolveModel,
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

describe("resolveModel", () => {
  it("resolves exact unique ids and exact provider-qualified selectors", () => {
    const first = model("first", "shared");
    const second = model("second", "unique");
    const models = catalog([first, second]);

    expect(resolveModel(models, "unique")).toBe(second);
    expect(resolveModel(models, "first/shared")).toBe(first);
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
