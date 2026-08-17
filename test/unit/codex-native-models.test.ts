import type { Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";

import { createCodexNativeModelSource } from "../../src/integrations/codex/native-models.js";

function fakeProvider(input: {
  id: string;
  api: string;
  modelIds: readonly string[];
}): Provider {
  const models = input.modelIds.map((id) => ({
    id,
    name: id,
    api: input.api,
    provider: input.id,
    baseUrl: "https://example.test",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 32_000,
  }));
  return {
    id: input.id,
    name: input.id,
    baseUrl: "https://example.test",
    auth: {},
    getModels: () => models,
    stream: () => {
      throw new Error("unused");
    },
    streamSimple: () => {
      throw new Error("unused");
    },
  } as unknown as Provider;
}

describe("Codex native model source", () => {
  it("accepts only bare models from the Pi builtin openai-codex provider with the Codex Responses api", () => {
    const source = createCodexNativeModelSource([
      fakeProvider({
        id: "openai-codex",
        api: "openai-codex-responses",
        modelIds: ["gpt-native", "vendor/nested"],
      }),
      fakeProvider({
        id: "openai",
        api: "openai-responses",
        modelIds: ["gpt-native"],
      }),
      fakeProvider({
        id: "openai-codex",
        api: "openai-responses",
        modelIds: ["wrong-wire"],
      }),
    ]);

    expect(source.has("gpt-native")).toBe(true);
    expect(source.has("vendor/nested")).toBe(false);
    expect(source.has("wrong-wire")).toBe(false);
    expect(source.has("missing")).toBe(false);
    expect(source.models().map((model) => model.id)).toEqual(["gpt-native"]);
  });

  it("derives the production native set from Pi AI rather than a LuckyToken hardcoded list", () => {
    const piCodex = builtinProviders().find((provider) => provider.id === "openai-codex");
    expect(piCodex).toBeDefined();

    const expected = (piCodex?.getModels() ?? [])
      .filter(
        (model) =>
          model.api === "openai-codex-responses" && !model.id.includes("/"),
      )
      .map((model) => model.id)
      .sort();
    const source = createCodexNativeModelSource();

    expect(source.models().map((model) => model.id).sort()).toEqual(expected);
  });
});
