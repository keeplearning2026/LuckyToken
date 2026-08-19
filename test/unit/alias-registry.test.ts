import { describe, expect, it } from "vitest";

import {
  computeEffectiveAliasRegistry,
  deriveDefaultModelNames,
  type AliasCatalogTarget,
} from "../../src/aliases/domain.js";

/**
 * Provider Activation Spec §23.4 A1-A6: the effective alias registry is
 * the deterministic overlay of Catalog-derived generated defaults (lower
 * layer) with the explicit user override file (authority layer). Tests use
 * fixed catalog snapshots; no filesystem or clock is involved.
 */

const catalogVersion = 7;

const catalogTargets: readonly AliasCatalogTarget[] = Object.freeze([
  { provider: "openai", model: "gpt-4o" },
  { provider: "openai", model: "gpt-4o-mini" },
  { provider: "openai", model: "gpt-4.1" },
  { provider: "anthropic", model: "claude-opus-4-8" },
  { provider: "anthropic", model: "claude-sonnet-4" },
  { provider: "deepseek", model: "deepseek-chat" },
]);

const knownTargets = new Set(
  catalogTargets.map(
    (target) => `${target.provider}\u0000${target.model}`,
  ),
);

function compute(userAliases: Record<string, unknown> = {}) {
  return computeEffectiveAliasRegistry({
    userAliases,
    catalogTargets,
    catalogVersion,
    knownTargets,
  });
}

const expectedDefaultAliasByTarget = new Map<string, string>([
  ["openai\u0000gpt-4o", "openai/gpt-4o"],
  ["openai\u0000gpt-4o-mini", "openai/gpt-4o-mini"],
  ["openai\u0000gpt-4.1", "openai/gpt-4.1"],
  ["anthropic\u0000claude-opus-4-8", "anthropic/claude-opus-4-8"],
  ["anthropic\u0000claude-sonnet-4", "anthropic/claude-sonnet-4"],
  ["deepseek\u0000deepseek-chat", "deepseek/deepseek-chat"],
]);

function defaultsFor(...overrides: readonly string[]): string[] {
  const suppressed = new Set(overrides);
  return [...expectedDefaultAliasByTarget.values()]
    .filter((alias) => !suppressed.has(alias))
    .sort();
}

describe("effective alias registry layering over generated defaults", () => {
  it("A1: every catalog model receives exactly one generated default with no user file", () => {
    const registry = compute({});
    expect(registry.errors).toEqual([]);
    expect(registry.aliases.map((entry) => entry.alias).sort()).toEqual(
      defaultsFor(),
    );
    // Exactly one effective alias per canonical target, using the literal
    // worked defaults above rather than recomputing the production rule.
    for (const target of catalogTargets) {
      const entry = registry.aliases.find(
        (candidate) =>
          candidate.target.provider === target.provider &&
          candidate.target.model === target.model,
      );
      expect(entry).toBeDefined();
      expect(entry?.alias).toBe(
        expectedDefaultAliasByTarget.get(`${target.provider}\u0000${target.model}`),
      );
      expect(entry?.layer).toBe("default");
    }
    expect(new Set(registry.aliases.map((entry) => entry.alias)).size).toBe(
      registry.aliases.length,
    );
  });

  it("A2: slash-containing canonical model ids receive slash-free default model names", () => {
    const registry = computeEffectiveAliasRegistry({
      userAliases: {},
      catalogTargets: [
        { provider: "commandcode-private", model: "deepseek/deepseek-v4-flash" },
      ],
      catalogVersion,
      knownTargets: new Set(["commandcode-private\u0000deepseek/deepseek-v4-flash"]),
    });
    expect(registry.aliases).toEqual([
      {
        alias: "commandcode-private/deepseek-deepseek-v4-flash",
        target: { provider: "commandcode-private", model: "deepseek/deepseek-v4-flash" },
        layer: "default",
      },
    ]);
  });

  it("derives the final Provider-scoped default model name from canonical Catalog identity", () => {
    const targets: readonly AliasCatalogTarget[] = [
      { provider: "p", model: "a/b" },
      { provider: "p", model: "a-b" },
      { provider: "p", model: "a-b-2" },
    ];
    const names = deriveDefaultModelNames(targets);
    expect(names.get({ provider: "p", model: "a/b" })).toBe("a-b-3");
    expect(names.get({ provider: "p", model: "a-b" })).toBe("a-b");
    expect(names.get({ provider: "p", model: "a-b-2" })).toBe("a-b-2");
  });

  it("shortens an overlong normalized default so the model keeps a valid external alias", () => {
    const modelId = "x".repeat(140);
    const registry = computeEffectiveAliasRegistry({
      userAliases: {},
      catalogTargets: [{ provider: "p", model: modelId }],
      catalogVersion,
      knownTargets: new Set([`p\u0000${modelId}`]),
    });

    expect(registry.errors).toEqual([]);
    expect(registry.aliases).toEqual([
      {
        alias: `p/${"x".repeat(126)}`,
        target: { provider: "p", model: modelId },
        layer: "default",
      },
    ]);
  });

  it("numbers colliding default model names within one Provider without stealing another model's natural name", () => {
    const registry = computeEffectiveAliasRegistry({
      userAliases: {},
      catalogTargets: [
        { provider: "p", model: "a/b" },
        { provider: "p", model: "a-b" },
        { provider: "p", model: "a-b-2" },
      ],
      catalogVersion,
      knownTargets: new Set(["p\u0000a/b", "p\u0000a-b", "p\u0000a-b-2"]),
    });
    expect(registry.errors).toEqual([]);
    expect(
      Object.fromEntries(
        registry.aliases.map((entry) => [entry.target.model, entry.alias]),
      ),
    ).toEqual({
      "a/b": "p/a-b-3",
      "a-b": "p/a-b",
      "a-b-2": "p/a-b-2",
    });
  });

  it("lets an explicit namespaced user mapping override one target and marks it user-owned", () => {
    const registry = compute({
      "openai/routed": { provider: "openai", model: "gpt-4.1" },
    });
    expect(registry.errors).toEqual([]);
    const byAlias = new Map(
      registry.aliases.map((entry) => [entry.alias, entry]),
    );
    expect(byAlias.get("openai/routed")).toEqual({
      alias: "openai/routed",
      target: { provider: "openai", model: "gpt-4.1" },
      layer: "user",
    });
    // The target gpt-4.1's generated default is suppressed (claimed by the
    // user alias), and the target gpt-4o gets its own generated default.
    expect(byAlias.get("openai/gpt-4o")?.layer).toBe("default");
    expect(byAlias.get("openai/gpt-4.1")).toBeUndefined();
  });

  it("A3: a custom model name replaces, not supplements, the generated default", () => {
    const registry = compute({
      "anthropic/sonnet": {
        provider: "anthropic",
        model: "claude-sonnet-4",
      },
    });
    expect(registry.errors).toEqual([]);
    const byAlias = new Map(
      registry.aliases.map((entry) => [entry.alias, entry]),
    );
    expect(byAlias.get("anthropic/sonnet")?.target).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4",
    });
    // The generated default is suppressed: exactly one effective alias
    // for the target, no duplicate error.
    expect(byAlias.get("anthropic/claude-sonnet-4")).toBeUndefined();
    expect(
      registry.aliases.filter(
        (entry) =>
          entry.target.provider === "anthropic" &&
          entry.target.model === "claude-sonnet-4",
      ),
    ).toHaveLength(1);
  });

  it("A6: a custom model name reserves its Provider-local name and conflicting defaults are renumbered", () => {
    const registry = compute({
      "openai/gpt-4o-mini": { provider: "openai", model: "gpt-4.1" },
    });
    expect(registry.errors).toEqual([]);
    expect(registry.aliases).toContainEqual({
      alias: "openai/gpt-4o-mini",
      target: { provider: "openai", model: "gpt-4.1" },
      layer: "user",
    });
    expect(registry.aliases).toContainEqual({
      alias: "openai/gpt-4o-mini-2",
      target: { provider: "openai", model: "gpt-4o-mini" },
      layer: "default",
    });
  });

  it("a broken user mapping blocks the generated default for that alias without silent repair", () => {
    const registry = compute({
      "openai/gpt-4o": "gpt-4o", // bare model id: cannot name one provider
    });
    // The user owns the alias key: the generated default for openai/gpt-4o
    // must not silently reappear; the registry reports the ambiguity.
    expect(
      registry.aliases.find((entry) => entry.alias === "openai/gpt-4o"),
    ).toBeUndefined();
    expect(registry.errors.map((entry) => entry.alias)).toEqual(["openai/gpt-4o"]);
    expect(registry.errors[0]?.code).toBe("ambiguous");
    // Untouched defaults still apply.
    expect(
      registry.aliases.some((entry) => entry.alias === "anthropic/claude-opus-4-8"),
    ).toBe(true);
  });

  it("every effective alias maps to exactly one canonical target", () => {
    const registry = compute({
      "openai/a": "openai/gpt-4o",
      "openai/b": { provider: "openai", model: "gpt-4o-mini" },
    });
    for (const entry of registry.aliases) {
      expect(typeof entry.target.provider).toBe("string");
      expect(typeof entry.target.model).toBe("string");
      expect(entry.target.provider.length).toBeGreaterThan(0);
      expect(entry.target.model.length).toBeGreaterThan(0);
    }
    expect(new Set(registry.aliases.map((entry) => entry.alias)).size).toBe(
      registry.aliases.length,
    );
  });
});
