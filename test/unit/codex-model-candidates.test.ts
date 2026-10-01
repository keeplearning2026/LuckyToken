import { describe, expect, it } from "vitest";

import {
  buildCodexModelCandidates,
  type CodexPiModelCost,
  type CodexPiModelLike,
} from "../../src/integrations/codex/codex-model-candidates.js";
import type {
  CodexNativeCatalogEntry,
  CodexNativeCatalogSnapshot,
} from "../../src/integrations/codex/native-catalog-source.js";

const PI_API = "openai-codex-responses";
const PI_BASE_URL = "https://chatgpt.com/backend-api";

interface NativeEntryOverrides {
  readonly display_name?: string;
  readonly visibility?: string;
  readonly supported_in_api?: boolean;
  readonly input_modalities?: readonly unknown[];
  readonly context_window?: unknown;
  readonly max_context_window?: unknown;
  readonly supported_reasoning_levels?: readonly unknown[];
}

interface PiModelOptions {
  readonly api?: string;
  readonly baseUrl?: string;
  readonly cost?: CodexPiModelCost;
  readonly maxTokens?: number;
  readonly compat?: object;
}

function nativeEntry(
  slug: string,
  overrides: NativeEntryOverrides = {},
): CodexNativeCatalogEntry {
  return {
    slug,
    display_name: overrides.display_name ?? `${slug} display`,
    visibility: overrides.visibility ?? "list",
    supported_in_api: overrides.supported_in_api ?? true,
    input_modalities: overrides.input_modalities ?? ["text"],
    context_window: overrides.context_window ?? 200_000,
    max_context_window: overrides.max_context_window ?? 200_000,
    supported_reasoning_levels:
      overrides.supported_reasoning_levels ?? [{ effort: "low", description: "Fast" }],
  };
}

function nativeSnapshot(
  entries: readonly CodexNativeCatalogEntry[],
  overrides: {
    readonly source?: CodexNativeCatalogSnapshot["source"];
    readonly warnings?: readonly string[];
    readonly generation?: string;
  } = {},
): CodexNativeCatalogSnapshot {
  return {
    source: overrides.source ?? "bundled",
    entries,
    warnings: overrides.warnings ?? [],
    generation: overrides.generation ?? "native-generation",
  };
}

function piModel(id: string, options: PiModelOptions = {}): CodexPiModelLike {
  return {
    id,
    api: options.api ?? PI_API,
    baseUrl: options.baseUrl ?? PI_BASE_URL,
    cost: options.cost ?? { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
    maxTokens: options.maxTokens ?? 128_000,
    compat: options.compat ?? { supportsStrictMode: true },
  };
}

describe("Codex model candidates", () => {
  it("filters native rows and appends only Pi-missing listable API models in source order", () => {
    const snapshot = nativeSnapshot([
      nativeEntry("gpt-native-second"),
      nativeEntry("gpt-pi"),
      nativeEntry("gpt-hidden", { visibility: "hidden" }),
      nativeEntry("gpt-not-api", { supported_in_api: false }),
      nativeEntry("gpt-native-first"),
    ]);

    const result = buildCodexModelCandidates({
      snapshot,
      piModels: [piModel("gpt-pi")],
    });

    expect(result.candidates.map((candidate) => candidate.id)).toEqual([
      "gpt-native-second",
      "gpt-native-first",
    ]);
    expect(result.evidence.map((entry) => entry.id)).toEqual([
      "gpt-native-second",
      "gpt-native-first",
    ]);
    expect(snapshot.entries.map((entry) => entry.slug)).toEqual([
      "gpt-native-second",
      "gpt-pi",
      "gpt-hidden",
      "gpt-not-api",
      "gpt-native-first",
    ]);
  });

  it("skips rows with unusable identity and never mutates Pi models", () => {
    const piModels = [piModel("gpt-pi")];
    const snapshot = nativeSnapshot([
      nativeEntry(""),
      nativeEntry("gpt-no-name", { display_name: "" }),
      nativeEntry("openai/gpt-slash"),
      nativeEntry("gpt-valid"),
    ]);

    const result = buildCodexModelCandidates({ snapshot, piModels });

    expect(result.candidates.map((candidate) => candidate.id)).toEqual(["gpt-valid"]);
    expect(piModels).toEqual([piModel("gpt-pi")]);
    expect(result.candidates[0]?.api).toBe(PI_API);
    expect(result.candidates[0]?.baseUrl).toBe(PI_BASE_URL);
  });

  it("maps input modalities and defaults invalid context windows with a bounded warning", () => {
    const snapshot = nativeSnapshot([
      nativeEntry("gpt-image", {
        input_modalities: ["audio", "image"],
        context_window: 123_456,
      }),
      nativeEntry("gpt-audio", {
        input_modalities: ["audio"],
        context_window: 0,
      }),
      nativeEntry("gpt-context", { context_window: "not-a-number" }),
    ]);

    const result = buildCodexModelCandidates({
      snapshot,
      piModels: [piModel("gpt-pi")],
    });

    expect(result.candidates[0]).toMatchObject({
      input: ["image"],
      contextWindow: 123_456,
    });
    expect(result.candidates[1]).toMatchObject({
      input: ["text"],
      contextWindow: 128_000,
    });
    expect(result.candidates[2]).toMatchObject({
      contextWindow: 128_000,
    });
    expect(result.warnings.filter((warning) => warning.includes("context_window"))).toEqual([
      'Native model "gpt-audio" has invalid context_window; using 128000.',
      'Native model "gpt-context" has invalid context_window; using 128000.',
    ]);
  });

  it("builds an explicit reasoning map and uses native context_window rather than max_context_window", () => {
    const snapshot = nativeSnapshot([
      nativeEntry("gpt-reasoning", {
        context_window: 111_000,
        max_context_window: 999_000,
        supported_reasoning_levels: [
          { effort: "low", description: "Fast" },
          { effort: "high", description: "Deep" },
        ],
      }),
      nativeEntry("gpt-non-reasoning", {
        supported_reasoning_levels: [],
      }),
      nativeEntry("gpt-medium", {
        supported_reasoning_levels: [{ effort: "medium", description: "Balanced" }],
      }),
    ]);

    const result = buildCodexModelCandidates({
      snapshot,
      piModels: [piModel("gpt-pi")],
    });

    expect(result.candidates[0]).toMatchObject({
      id: "gpt-reasoning",
      reasoning: true,
      contextWindow: 111_000,
      thinkingLevelMap: {
        off: null,
        minimal: "low",
        low: "low",
        medium: null,
        high: "high",
        xhigh: null,
        max: null,
      },
    });
    expect(result.candidates[1]).toMatchObject({
      id: "gpt-non-reasoning",
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
    });
    expect(result.candidates[2]).toMatchObject({
      id: "gpt-medium",
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: null,
        medium: "medium",
        high: null,
        xhigh: null,
        max: null,
      },
    });
  });

  it("copies cost, maxTokens, and compat only from a same-generation Pi sibling with evidence", () => {
    const siblingCost = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };
    const siblingCompat = {
      supportsStrictMode: true,
      supportsAdditionalTools: true,
      supportsToolSearch: true,
    };
    const piModels = [
      piModel("gpt-5.6-sol", {
        cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
        maxTokens: 127_000,
        compat: { supportsStrictMode: true },
      }),
      piModel("gpt-6-astra", {
        cost: siblingCost,
        maxTokens: 999,
        compat: siblingCompat,
      }),
    ];
    const snapshot = nativeSnapshot([
      nativeEntry("gpt-6-sol"),
      nativeEntry("gpt-6.1-sol"),
    ]);

    const result = buildCodexModelCandidates({ snapshot, piModels });
    const siblingCandidate = result.candidates[0];
    const conservativeCandidate = result.candidates[1];

    expect(siblingCandidate).toMatchObject({
      id: "gpt-6-sol",
      cost: siblingCost,
      maxTokens: 999,
      compat: siblingCompat,
    });
    expect(siblingCandidate?.cost).not.toBe(siblingCost);
    expect(siblingCandidate?.compat).not.toBe(siblingCompat);
    expect(result.evidence[0]).toEqual({
      id: "gpt-6-sol",
      source: "same-generation-sibling",
      siblingId: "gpt-6-astra",
    });

    expect(conservativeCandidate).toMatchObject({
      id: "gpt-6.1-sol",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      maxTokens: 16_384,
      compat: {
        supportsStrictMode: false,
        supportsDeveloperRole: false,
        supportsLongCacheRetention: false,
        supportsAdditionalTools: false,
        supportsToolSearch: false,
        supportsOpenAIGrammarTools: false,
      },
    });
    expect(result.evidence[1]).toEqual({
      id: "gpt-6.1-sol",
      source: "conservative-default",
    });
    expect(result.warnings).toContain(
      'No same-generation Pi sibling with compat for native model "gpt-6.1-sol"; using conservative cost/maxTokens/compat.',
    );
  });

  it("treats a same-generation sibling without compat as a conservative fallback", () => {
    const snapshot = nativeSnapshot([nativeEntry("gpt-7-sol")]);
    const result = buildCodexModelCandidates({
      snapshot,
      piModels: [
        {
          id: "gpt-7-astra",
          api: PI_API,
          baseUrl: PI_BASE_URL,
          cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
          maxTokens: 128_000,
        },
      ],
    });

    expect(result.candidates[0]).toMatchObject({
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      maxTokens: 16_384,
      compat: {
        supportsStrictMode: false,
        supportsOpenAIGrammarTools: false,
      },
    });
    expect(result.evidence[0]).toEqual({
      id: "gpt-7-sol",
      source: "conservative-default",
    });
  });

  it("returns an empty candidate set for an unavailable native source and preserves snapshot warnings", () => {
    const result = buildCodexModelCandidates({
      snapshot: nativeSnapshot([nativeEntry("gpt-stale")], {
        source: "unavailable",
        warnings: ["Codex native model metadata is unavailable."],
      }),
      piModels: [piModel("gpt-pi")],
    });

    expect(result.candidates).toEqual([]);
    expect(result.evidence).toEqual([]);
    expect(result.warnings).toEqual(["Codex native model metadata is unavailable."]);
  });

  it("keeps duplicate native slugs to one candidate and records a bounded warning", () => {
    const snapshot = nativeSnapshot([
      nativeEntry("gpt-duplicate", { display_name: "First" }),
      nativeEntry("gpt-duplicate", { display_name: "Second" }),
    ]);

    const result = buildCodexModelCandidates({
      snapshot,
      piModels: [piModel("gpt-pi")],
    });

    expect(result.candidates.map((candidate) => candidate.name)).toEqual(["First"]);
    expect(result.warnings).toContain(
      'Native model catalog contains duplicate slug "gpt-duplicate"; keeping the first row.',
    );
  });

  it("is deterministic for identical inputs and changes with candidate content", () => {
    const first = buildCodexModelCandidates({
      snapshot: nativeSnapshot([nativeEntry("gpt-native")]),
      piModels: [piModel("gpt-pi")],
    });
    const second = buildCodexModelCandidates({
      snapshot: nativeSnapshot([nativeEntry("gpt-native")]),
      piModels: [piModel("gpt-pi")],
    });
    const changed = buildCodexModelCandidates({
      snapshot: nativeSnapshot([nativeEntry("gpt-native", { context_window: 300_000 })]),
      piModels: [piModel("gpt-pi")],
    });

    expect(second.generation).toBe(first.generation);
    expect(second.candidates).toEqual(first.candidates);
    expect(changed.generation).not.toBe(first.generation);
  });

  it("deep-freezes the public candidate generation", () => {
    const result = buildCodexModelCandidates({
      snapshot: nativeSnapshot([nativeEntry("gpt-native")]),
      piModels: [piModel("gpt-pi")],
    });
    const candidate = result.candidates[0];

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.candidates)).toBe(true);
    expect(Object.isFrozen(result.warnings)).toBe(true);
    expect(Object.isFrozen(result.evidence)).toBe(true);
    expect(Object.isFrozen(candidate)).toBe(true);
    expect(Object.isFrozen(candidate?.thinkingLevelMap)).toBe(true);
    expect(Object.isFrozen(candidate?.input)).toBe(true);
    expect(Object.isFrozen(candidate?.cost)).toBe(true);
    expect(Object.isFrozen(candidate?.compat)).toBe(true);
  });
});
