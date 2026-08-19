import { describe, expect, it } from "vitest";

import {
  computeEffectiveAliasRegistry,
  parseAliasTarget,
  type AliasCatalogTarget,
} from "../../src/aliases/domain.js";

/**
 * Provider Activation Spec §23.4: alias target validation taxonomy over
 * Catalog-derived generated defaults. Every failure category — invalid,
 * ambiguous, unknown, duplicate — is distinguished so the Providers
 * surface can show precise, value-safe errors, and no rejected entry ever
 * becomes an effective alias.
 */

const catalogVersion = 3;

const catalogTargets: readonly AliasCatalogTarget[] = Object.freeze([
  { provider: "openai", model: "gpt-4o" },
  { provider: "openai", model: "gpt-4o-mini" },
  { provider: "anthropic", model: "claude-opus-4-8" },
  { provider: "anthropic", model: "claude-sonnet-4" },
]);

const knownTargets = new Set(
  catalogTargets.map(
    (target) => `${target.provider}\u0000${target.model}`,
  ),
);

function compute(userAliases: Record<string, unknown>) {
  return computeEffectiveAliasRegistry({
    userAliases,
    catalogTargets,
    catalogVersion,
    knownTargets,
  });
}

const defaultAliases = Object.freeze([
  "openai/gpt-4o",
  "openai/gpt-4o-mini",
  "anthropic/claude-opus-4-8",
  "anthropic/claude-sonnet-4",
]);

/** Every catalog target's literal generated default alias, sorted. */
function expectedDefaults(...overrides: readonly string[]): string[] {
  const suppressed = new Set(overrides);
  return defaultAliases.filter((alias) => !suppressed.has(alias)).sort();
}

describe("alias target validation taxonomy over generated defaults", () => {
  it("rejects an unknown Provider/model target with a distinguished unknown error", () => {
    const registry = compute({
      "openai/my-model": { provider: "openai", model: "gpt-5-not-real" },
    });
    // The rejected entry never becomes effective; every untouched catalog
    // target keeps its generated default.
    expect(registry.aliases.map((entry) => entry.alias).sort()).toEqual(
      expectedDefaults(),
    );
    expect(registry.errors).toHaveLength(1);
    expect(registry.errors[0]).toMatchObject({
      alias: "openai/my-model",
      code: "unknown",
    });
    expect(registry.errors[0]?.message).toContain("gpt-5-not-real");
  });

  it("rejects an unknown Provider even when the model id exists elsewhere", () => {
    const registry = compute({
      "nonexistent-provider/my-model": {
        provider: "nonexistent-provider",
        model: "gpt-4o",
      },
    });
    expect(registry.errors[0]?.code).toBe("unknown");
  });

  it("rejects a bare model-id target as ambiguous without guessing a Provider", () => {
    const registry = compute({
      "openai/my-model": "gpt-4o",
    });
    expect(registry.aliases.map((entry) => entry.alias).sort()).toEqual(
      expectedDefaults(),
    );
    expect(registry.errors[0]?.code).toBe("ambiguous");
    expect(registry.errors[0]?.message).toContain("Provider");
  });

  it("accepts a user model name inside the target Provider namespace", () => {
    const registry = compute({
      "openai/gpt-4o-mini": { provider: "openai", model: "gpt-4o-mini" },
    });
    expect(registry.aliases.map((entry) => entry.alias).sort()).toEqual(
      [
        ...expectedDefaults().filter(
          (alias) => alias !== "openai/gpt-4o-mini",
        ),
        "openai/gpt-4o-mini",
      ].sort(),
    );
    expect(registry.errors).toEqual([]);
    expect(
      registry.aliases.find((entry) => entry.alias === "openai/gpt-4o-mini"),
    ).toMatchObject({
      alias: "openai/gpt-4o-mini",
      target: { provider: "openai", model: "gpt-4o-mini" },
      layer: "user",
    });
  });

  it("rejects alias keys whose model-name suffix contains '/'", () => {
    const registry = compute({
      "openai/team/gpt": { provider: "openai", model: "gpt-4o" },
    });
    expect(registry.aliases.some((entry) => entry.alias === "openai/team/gpt")).toBe(false);
    expect(registry.errors).toEqual([
      expect.objectContaining({ alias: "openai/team/gpt", code: "invalid" }),
    ]);
  });

  it("rejects malformed aliases and targets as invalid", () => {
    const registry = compute({
      "": { provider: "openai", model: "gpt-4o" },
      " padded ": { provider: "openai", model: "gpt-4o" },
      "openai/toooo-long": { provider: "openai", model: " padded " },
      "openai/not-an-object": 42,
      "openai/missing-model": { provider: "openai" },
    });
    expect(registry.aliases.map((entry) => entry.alias).sort()).toEqual(
      expectedDefaults(),
    );
    expect(registry.errors.map((entry) => entry.code)).toEqual([
      "invalid",
      "invalid",
      "invalid",
      "invalid",
      "invalid",
    ]);
  });

  it("rejects a duplicate canonical target between two user aliases", () => {
    const registry = compute({
      "openai/first": { provider: "openai", model: "gpt-4o" },
      "openai/second": "openai/gpt-4o",
    });
    expect(registry.aliases.map((entry) => entry.alias).sort()).toEqual(
      [...expectedDefaults("openai/gpt-4o"), "openai/first"].sort(),
    );
    expect(registry.errors[0]).toMatchObject({
      alias: "openai/second",
      code: "duplicate",
    });
  });

  it("lets a user alias take a canonical target over its generated default without a duplicate error", () => {
    const registry = compute({
      "anthropic/my-opus": {
        provider: "anthropic",
        model: "claude-opus-4-8",
      },
    });
    // The user mapping claims the target; the generated default is
    // suppressed (the normal override path, never a duplicate error).
    expect(registry.aliases.map((entry) => entry.alias).sort()).toEqual(
      [
        ...expectedDefaults("anthropic/claude-opus-4-8"),
        "anthropic/my-opus",
      ].sort(),
    );
    expect(registry.errors).toEqual([]);
    expect(
      registry.aliases.find((entry) => entry.alias === "anthropic/my-opus")?.target,
    ).toEqual({ provider: "anthropic", model: "claude-opus-4-8" });
    expect(
      registry.aliases.find((entry) => entry.alias === "anthropic/my-opus")?.layer,
    ).toBe("user");
  });

  it("accepts string and object targets with identical canonical identity", () => {
    const asString = compute({ "openai/a": "openai/gpt-4o-mini" });
    const asObject = compute({
      "openai/a": { provider: "openai", model: "gpt-4o-mini" },
    });
    expect(asString.aliases).toEqual(asObject.aliases);
  });

  it("parseAliasTarget accepts model ids containing slashes", () => {
    expect(parseAliasTarget("openai/gpt-4o")).toEqual({
      target: { provider: "openai", model: "gpt-4o" },
    });
    // A model id with an internal slash is valid canonical identity
    // (e.g. commandcode-private/deepseek/deepseek-v4-flash).
    expect(parseAliasTarget("commandcode-private/deepseek/deepseek-v4-flash")).toEqual({
      target: {
        provider: "commandcode-private",
        model: "deepseek/deepseek-v4-flash",
      },
    });
  });

  it("parseAliasTarget rejects structurally broken targets", () => {
    expect(parseAliasTarget(undefined)).toMatchObject({ error: { code: "invalid" } });
    expect(parseAliasTarget(null)).toMatchObject({ error: { code: "invalid" } });
    expect(parseAliasTarget(["openai", "gpt-4o"])).toMatchObject({
      error: { code: "invalid" },
    });
    expect(parseAliasTarget({ provider: "", model: "gpt-4o" })).toMatchObject({
      error: { code: "invalid" },
    });
    expect(parseAliasTarget({ provider: "openai", model: "" })).toMatchObject({
      error: { code: "invalid" },
    });
  });

  it("a rejected proposal never produces an effective alias", () => {
    for (const [alias, ref] of Object.entries({
      "x": "bare-id",
      "y": { provider: "openai", model: "missing" },
      "z": { provider: "openai" },
    })) {
      const registry = compute({ [alias]: ref });
      expect(
        registry.aliases.some((entry) => entry.alias === alias),
      ).toBe(false);
    }
  });
});
