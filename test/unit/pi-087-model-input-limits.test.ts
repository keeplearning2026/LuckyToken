import type { Model, Provider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { composeConfiguredProvider } from "../../src/providers/effective-composition.js";

const inputLimits = Object.freeze({
  maxRequestBytes: 20_000_000,
  images: Object.freeze({
    resize: Object.freeze({
      maxWidth: 2048,
      maxHeight: 2048,
      maxBytes: 5_000_000,
      jpegQuality: 85,
    }),
    maxPerMessage: 8,
    maxPerRequest: 16,
  }),
});

function baseProvider(): Provider {
  const model: Model<"openai-responses"> = {
    id: "vision-model",
    name: "Vision Model",
    api: "openai-responses",
    provider: "vision-provider",
    baseUrl: "https://provider.test/v1",
    reasoning: false,
    input: ["text", "image"],
    inputLimits,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
  return {
    id: "vision-provider",
    name: "Vision Provider",
    baseUrl: "https://provider.test/v1",
    getModels: () => [model],
  } as unknown as Provider;
}

describe("Pi 0.87 model input limits preservation", () => {
  it("preserves built-in inputLimits through Token provider composition", () => {
    const composition = composeConfiguredProvider(
      "vision-provider",
      baseProvider(),
      undefined,
    );

    expect(composition.models[0]?.inputLimits).toEqual(inputLimits);
  });

  it("preserves inputLimits when models.json upserts the same built-in model", () => {
    const composition = composeConfiguredProvider(
      "vision-provider",
      baseProvider(),
      {
        models: [{ id: "vision-model", name: "Renamed Vision" }],
      },
    );

    expect(composition.models[0]?.name).toBe("Renamed Vision");
    expect(composition.models[0]?.inputLimits).toEqual(inputLimits);
  });

  it("does not inherit inputLimits into a new custom model", () => {
    const composition = composeConfiguredProvider(
      "vision-provider",
      baseProvider(),
      {
        models: [{ id: "custom-model", name: "Custom" }],
      },
    );

    expect(composition.models.find((model) => model.id === "custom-model")?.inputLimits)
      .toBeUndefined();
  });
});
