import { describe, expect, it } from "vitest";

import { applyAutomaticModelOverlay } from "../../src/providers/automatic-model-overlay.js";
import type { CodexModelCandidateGeneration } from "../../src/integrations/codex/codex-model-candidates.js";
import type { ModelsJsonModel } from "../../src/providers/models-json-schema.js";

const PROVIDER_ID = "openai-codex";

function overlay(): CodexModelCandidateGeneration {
  const candidate: ModelsJsonModel = {
    id: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
    },
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_050_000,
    maxTokens: 16_384,
    compat: { supportsStrictMode: false },
  };
  return Object.freeze({
    generation: "generation-a",
    warnings: Object.freeze([]),
    evidence: Object.freeze([]),
    candidates: Object.freeze([Object.freeze(candidate)]),
  });
}

describe("automatic overlay views", () => {
  const startupProviders = Object.freeze({
    [PROVIDER_ID]: Object.freeze({ models: Object.freeze([]) }),
  });

  it("appends the candidate to the startup-effective served view", () => {
    const served = applyAutomaticModelOverlay({
      providers: startupProviders,
      overlay: overlay(),
      providerId: PROVIDER_ID,
    });
    const entry = served[PROVIDER_ID] as { readonly models: readonly { readonly id: string }[] };

    expect(entry.models.map((model) => model.id)).toEqual(["gpt-6.1-sol"]);
  });

  it("keeps the startup view unchanged when the disk edit defines the same id", () => {
    // The edit preview composes the current-disk configuration against the
    // SAME acquisition generation; the user's definition wins and no
    // duplicate id is created. The served view is untouched.
    const diskProviders = Object.freeze({
      [PROVIDER_ID]: Object.freeze({
        models: Object.freeze([
          Object.freeze({
            id: "gpt-6.1-sol",
            name: "User-defined 6.1",
            headers: Object.freeze({ "x-user": "1" }),
          }),
        ]),
      }),
    });
    const preview = applyAutomaticModelOverlay({
      providers: diskProviders,
      overlay: overlay(),
      providerId: PROVIDER_ID,
    });
    const entry = preview[PROVIDER_ID] as {
      readonly models: readonly { readonly id: string; readonly name?: string }[];
    };

    expect(entry.models.map((model) => model.id)).toEqual(["gpt-6.1-sol"]);
    expect(entry.models.filter((model) => model.id === "gpt-6.1-sol")).toHaveLength(1);
    expect(entry.models[0]?.name).toBe("User-defined 6.1");
    expect(
      (applyAutomaticModelOverlay({
        providers: startupProviders,
        overlay: overlay(),
        providerId: PROVIDER_ID,
      })[PROVIDER_ID] as { readonly models: readonly { readonly name: string }[] })
        .models[0]?.name,
    ).toBe("GPT-6.1 Sol");
  });

  it("removes the candidate from the preview when a disk edit previously defined it", () => {
    // Deleting the user definition restores the automatic candidate in the
    // preview; the served view keeps the startup-effective composition.
    const withoutDefinition = applyAutomaticModelOverlay({
      providers: Object.freeze({ [PROVIDER_ID]: Object.freeze({ models: Object.freeze([]) }) }),
      overlay: overlay(),
      providerId: PROVIDER_ID,
    });
    const entry = withoutDefinition[PROVIDER_ID] as {
      readonly models: readonly { readonly id: string }[];
    };
    expect(entry.models.map((model) => model.id)).toEqual(["gpt-6.1-sol"]);
  });

  it("returns the view unchanged when no overlay generation exists", () => {
    const unchanged = applyAutomaticModelOverlay({
      providers: startupProviders,
      overlay: undefined,
      providerId: PROVIDER_ID,
    });
    expect(unchanged).toBe(startupProviders);
  });
});
