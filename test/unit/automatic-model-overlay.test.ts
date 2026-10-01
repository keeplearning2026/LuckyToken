import { describe, expect, it } from "vitest";

import type { CodexModelCandidateGeneration } from "../../src/integrations/codex/codex-model-candidates.js";
import { applyAutomaticModelOverlay } from "../../src/providers/automatic-model-overlay.js";
import type { ModelsJsonModelDefinition } from "../../src/providers/models-json.js";

const PROVIDER_ID = "openai-codex";

function candidate(id: string): ModelsJsonModelDefinition {
  return {
    id,
    name: id,
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: false,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: null,
      max: null,
    },
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    compat: { supportsStrictMode: false },
  };
}

function overlay(
  candidates: readonly ModelsJsonModelDefinition[],
): CodexModelCandidateGeneration {
  return {
    generation: "candidate-generation",
    candidates,
    warnings: [],
    evidence: [],
  };
}

function entryFor(
  providers: Readonly<Record<string, unknown>>,
  providerId: string,
): Readonly<Record<string, unknown>> {
  const entry = providers[providerId];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error(`Expected provider entry ${providerId}.`);
  }
  return entry as Readonly<Record<string, unknown>>;
}

function modelIds(entry: Readonly<Record<string, unknown>>): readonly unknown[] {
  const models = entry.models;
  if (!Array.isArray(models)) throw new Error("Expected models array.");
  return models.map((model) => {
    if (typeof model !== "object" || model === null || Array.isArray(model)) {
      throw new Error("Expected model object.");
    }
    return model.id;
  });
}

describe("automatic model overlay", () => {
  it("returns the input unchanged when the overlay is absent or empty", () => {
    const providers = Object.freeze({
      other: Object.freeze({ models: Object.freeze([]) }),
    });

    expect(
      applyAutomaticModelOverlay({ providers, overlay: undefined, providerId: PROVIDER_ID }),
    ).toBe(providers);
    expect(
      applyAutomaticModelOverlay({
        providers,
        overlay: overlay([]),
        providerId: PROVIDER_ID,
      }),
    ).toBe(providers);
  });

  it("synthesizes a provider entry when the view has none", () => {
    const appended = candidate("gpt-native");
    const providers = Object.freeze({ anthropic: Object.freeze({ models: Object.freeze([]) }) });

    const result = applyAutomaticModelOverlay({
      providers,
      overlay: overlay([appended]),
      providerId: PROVIDER_ID,
    });

    expect(result).not.toBe(providers);
    expect(entryFor(result, PROVIDER_ID)).toEqual({ models: [appended] });
    expect(providers).toEqual({ anthropic: { models: [] } });
  });

  it("drops candidates defined by models[].id and modelOverrides keys", () => {
    const userModel = { id: "gpt-model-defined", name: "User model" };
    const userOverride = { reasoning: true };
    const appended = candidate("gpt-new");
    const providers = Object.freeze({
      [PROVIDER_ID]: Object.freeze({
        baseUrl: "https://user.example/v1",
        apiKey: "user-key",
        models: Object.freeze([userModel, { id: "gpt-existing" }]),
        modelOverrides: Object.freeze({
          "gpt-override-defined": userOverride,
        }),
      }),
    });

    const result = applyAutomaticModelOverlay({
      providers,
      overlay: overlay([
        candidate("gpt-model-defined"),
        candidate("gpt-override-defined"),
        appended,
      ]),
      providerId: PROVIDER_ID,
    });

    const entry = entryFor(result, PROVIDER_ID);
    expect(entry.baseUrl).toBe("https://user.example/v1");
    expect(entry.apiKey).toBe("user-key");
    expect(modelIds(entry)).toEqual([
      "gpt-model-defined",
      "gpt-existing",
      "gpt-new",
    ]);
    expect(entry.modelOverrides).toEqual({ "gpt-override-defined": userOverride });
    expect(providers[PROVIDER_ID]).toEqual({
      baseUrl: "https://user.example/v1",
      apiKey: "user-key",
      models: [userModel, { id: "gpt-existing" }],
      modelOverrides: { "gpt-override-defined": userOverride },
    });
  });

  it("keeps one definition per id and never reorders existing definitions", () => {
    const providers = Object.freeze({
      [PROVIDER_ID]: Object.freeze({
        models: Object.freeze([
          { id: "gpt-existing-first" },
          { id: "gpt-native" },
          { id: "gpt-existing-last" },
        ]),
      }),
    });

    const result = applyAutomaticModelOverlay({
      providers,
      overlay: overlay([
        candidate("gpt-native"),
        candidate("gpt-native"),
        candidate("gpt-appended"),
      ]),
      providerId: PROVIDER_ID,
    });

    expect(modelIds(entryFor(result, PROVIDER_ID))).toEqual([
      "gpt-existing-first",
      "gpt-native",
      "gpt-existing-last",
      "gpt-appended",
    ]);
  });

  it("returns the input unchanged when every candidate is user-defined", () => {
    const providers = Object.freeze({
      [PROVIDER_ID]: Object.freeze({
        models: Object.freeze([{ id: "gpt-native" }]),
      }),
    });

    expect(
      applyAutomaticModelOverlay({
        providers,
        overlay: overlay([candidate("gpt-native")]),
        providerId: PROVIDER_ID,
      }),
    ).toBe(providers);
  });

  it("fails open for invalid provider entries without throwing", () => {
    const invalidEntries: readonly unknown[] = [
      null,
      "not-an-object",
      [],
      { models: "not-an-array" },
      { models: [null] },
      { models: [{ name: "missing-id" }] },
      { modelOverrides: [] },
    ];

    for (const invalid of invalidEntries) {
      const providers = Object.freeze({ [PROVIDER_ID]: invalid });
      expect(
        applyAutomaticModelOverlay({
          providers,
          overlay: overlay([candidate("gpt-native")]),
          providerId: PROVIDER_ID,
        }),
      ).toBe(providers);
    }
  });

  it("does not mutate the input providers record or its arrays", () => {
    const providers = {
      [PROVIDER_ID]: {
        models: [{ id: "gpt-existing" }],
      },
    };
    const before = structuredClone(providers);

    const result = applyAutomaticModelOverlay({
      providers,
      overlay: overlay([candidate("gpt-new")]),
      providerId: PROVIDER_ID,
    });

    expect(providers).toEqual(before);
    expect(result).not.toBe(providers);
    expect(modelIds(entryFor(result, PROVIDER_ID))).toEqual(["gpt-existing", "gpt-new"]);
  });
});
