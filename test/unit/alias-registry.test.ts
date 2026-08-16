import { describe, expect, it } from "vitest";

import {
  computeEffectiveAliasRegistry,
  type CuratedAliasDefault,
} from "../../src/aliases/domain.js";

/**
 * Ticket 14 domain seam: the effective alias registry is the deterministic
 * overlay of curated defaults (lower layer) with the explicit user mapping
 * file (authority layer). Tests use fixed catalog snapshots and fixed
 * defaults versions; no filesystem or clock is involved.
 */

const catalogVersion = 7;

/** Deterministic Ticket 11 catalog snapshot facts: canonical
 *  provider/model keys that exist in the active catalog. */
function knownTargets(entries: readonly [string, string][]): ReadonlySet<string> {
  return new Set(entries.map(([provider, model]) => `${provider}\u0000${model}`));
}

const catalog = knownTargets([
  ["openai", "gpt-4o"],
  ["openai", "gpt-4o-mini"],
  ["openai", "gpt-4.1"],
  ["anthropic", "claude-opus-4-8"],
  ["anthropic", "claude-sonnet-4"],
  ["deepseek", "deepseek-chat"],
]);

const defaultsV1: readonly CuratedAliasDefault[] = [
  { alias: "gpt-4o", provider: "openai", model: "gpt-4o" },
  { alias: "claude-opus-4", provider: "anthropic", model: "claude-opus-4-8" },
  { alias: "deepseek-chat", provider: "deepseek", model: "deepseek-chat" },
];

/** A default upgrade (v2) changes one untouched curated target and leaves
 *  the rest identical. */
const defaultsV2: readonly CuratedAliasDefault[] = [
  { alias: "gpt-4o", provider: "openai", model: "gpt-4.1" },
  { alias: "claude-opus-4", provider: "anthropic", model: "claude-opus-4-8" },
  { alias: "deepseek-chat", provider: "deepseek", model: "deepseek-chat" },
];

describe("effective alias registry layering", () => {
  it("applies curated defaults as the lower layer with no user file", () => {
    const registry = computeEffectiveAliasRegistry({
      userAliases: {},
      defaults: defaultsV1,
      defaultsVersion: 1,
      catalogVersion,
      knownTargets: catalog,
    });
    expect(registry.defaultsVersion).toBe(1);
    expect(registry.errors).toEqual([]);
    expect(registry.aliases).toEqual([
      {
        alias: "gpt-4o",
        target: { provider: "openai", model: "gpt-4o" },
        layer: "default",
      },
      {
        alias: "claude-opus-4",
        target: { provider: "anthropic", model: "claude-opus-4-8" },
        layer: "default",
      },
      {
        alias: "deepseek-chat",
        target: { provider: "deepseek", model: "deepseek-chat" },
        layer: "default",
      },
    ]);
  });

  it("lets an explicit user mapping override the same alias and marks it user-owned", () => {
    const registry = computeEffectiveAliasRegistry({
      userAliases: {
        "gpt-4o": { provider: "openai", model: "gpt-4.1" },
      },
      defaults: defaultsV1,
      defaultsVersion: 1,
      catalogVersion,
      knownTargets: catalog,
    });
    expect(registry.errors).toEqual([]);
    expect(registry.aliases).toEqual([
      {
        alias: "gpt-4o",
        target: { provider: "openai", model: "gpt-4.1" },
        layer: "user",
      },
      {
        alias: "claude-opus-4",
        target: { provider: "anthropic", model: "claude-opus-4-8" },
        layer: "default",
      },
      {
        alias: "deepseek-chat",
        target: { provider: "deepseek", model: "deepseek-chat" },
        layer: "default",
      },
    ]);
  });

  it("applies user mappings on top of untouched curated defaults", () => {
    const registry = computeEffectiveAliasRegistry({
      userAliases: {
        "my-sonnet": { provider: "anthropic", model: "claude-sonnet-4" },
        "fast-chat": "openai/gpt-4o-mini",
      },
      defaults: defaultsV1,
      defaultsVersion: 1,
      catalogVersion,
      knownTargets: catalog,
    });
    expect(registry.errors).toEqual([]);
    const byAlias = new Map(
      registry.aliases.map((entry) => [entry.alias, entry]),
    );
    expect(byAlias.get("my-sonnet")).toEqual({
      alias: "my-sonnet",
      target: { provider: "anthropic", model: "claude-sonnet-4" },
      layer: "user",
    });
    expect(byAlias.get("fast-chat")).toEqual({
      alias: "fast-chat",
      target: { provider: "openai", model: "gpt-4o-mini" },
      layer: "user",
    });
    // The curated defaults for untouched aliases still apply.
    expect(byAlias.get("gpt-4o")?.layer).toBe("default");
    expect(byAlias.get("claude-opus-4")?.layer).toBe("default");
  });

  it("an upgrade of an untouched curated default changes its effective target", () => {
    const upgraded = computeEffectiveAliasRegistry({
      userAliases: {},
      defaults: defaultsV2,
      defaultsVersion: 2,
      catalogVersion,
      knownTargets: catalog,
    });
    const byAlias = new Map(
      upgraded.aliases.map((entry) => [entry.alias, entry]),
    );
    expect(byAlias.get("gpt-4o")?.target).toEqual({
      provider: "openai",
      model: "gpt-4.1",
    });
    expect(byAlias.get("gpt-4o")?.layer).toBe("default");
  });

  it("a default upgrade never replaces a user-modified mapping", () => {
    const before = computeEffectiveAliasRegistry({
      userAliases: {
        "gpt-4o": { provider: "openai", model: "gpt-4o-mini" },
      },
      defaults: defaultsV1,
      defaultsVersion: 1,
      catalogVersion,
      knownTargets: catalog,
    });
    const after = computeEffectiveAliasRegistry({
      // The user file is untouched across the upgrade: it stores only the
      // explicit mapping, so the same bytes compose over the new defaults.
      userAliases: {
        "gpt-4o": { provider: "openai", model: "gpt-4o-mini" },
      },
      defaults: defaultsV2,
      defaultsVersion: 2,
      catalogVersion,
      knownTargets: catalog,
    });
    const beforeAlias = before.aliases.find((entry) => entry.alias === "gpt-4o");
    const afterAlias = after.aliases.find((entry) => entry.alias === "gpt-4o");
    expect(afterAlias?.target).toEqual(beforeAlias?.target);
    expect(afterAlias?.target).toEqual({
      provider: "openai",
      model: "gpt-4o-mini",
    });
    expect(afterAlias?.layer).toBe("user");
  });

  it("a broken user mapping blocks the curated default for that alias without silent repair", () => {
    const registry = computeEffectiveAliasRegistry({
      userAliases: {
        "gpt-4o": "gpt-4o", // bare model id: cannot name one provider
      },
      defaults: defaultsV1,
      defaultsVersion: 1,
      catalogVersion,
      knownTargets: catalog,
    });
    // The default for "gpt-4o" must not silently reappear: the user owns
    // the alias, so the effective registry has no alias for it and reports
    // the ambiguity instead.
    expect(registry.aliases.find((entry) => entry.alias === "gpt-4o")).toBeUndefined();
    expect(registry.errors.map((entry) => entry.alias)).toEqual(["gpt-4o"]);
    expect(registry.errors[0]?.code).toBe("ambiguous");
    // Untouched defaults still apply.
    expect(registry.aliases.some((entry) => entry.alias === "claude-opus-4")).toBe(true);
  });

  it("every effective alias maps to exactly one canonical target", () => {
    const registry = computeEffectiveAliasRegistry({
      userAliases: {
        "a": "openai/gpt-4o",
        "b": { provider: "openai", model: "gpt-4o-mini" },
      },
      defaults: defaultsV1,
      defaultsVersion: 1,
      catalogVersion,
      knownTargets: catalog,
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
