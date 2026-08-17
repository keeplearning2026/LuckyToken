import { describe, expect, it } from "vitest";

import {
  computeEffectiveAliasRegistry,
  parseAliasTarget,
} from "../../src/aliases/domain.js";

/**
 * Ticket 14 domain seam: target validation taxonomy. Every failure category
 * — invalid, ambiguous, unknown, duplicate — is distinguished so the Models
 * & Aliases surface can show precise, value-safe errors, and no rejected
 * entry ever becomes an effective alias.
 */

const catalogVersion = 3;

const knownTargets = new Set([
  "openai\u0000gpt-4o",
  "openai\u0000gpt-4o-mini",
  "anthropic\u0000claude-opus-4-8",
  "anthropic\u0000claude-sonnet-4",
]);

const defaults = [
  { alias: "gpt-4o", provider: "openai", model: "gpt-4o" },
  { alias: "claude-opus-4", provider: "anthropic", model: "claude-opus-4-8" },
];

function compute(userAliases: Record<string, unknown>) {
  return computeEffectiveAliasRegistry({
    userAliases,
    defaults,
    defaultsVersion: 1,
    catalogVersion,
    knownTargets,
  });
}

describe("alias target validation taxonomy", () => {
  it("rejects an unknown Provider/model target with a distinguished unknown error", () => {
    const registry = compute({
      "my-model": { provider: "openai", model: "gpt-5-not-real" },
    });
    // The rejected entry never becomes effective; untouched curated
    // defaults stay.
    expect(registry.aliases.map((entry) => entry.alias)).toEqual([
      "gpt-4o",
      "claude-opus-4",
    ]);
    expect(registry.errors).toHaveLength(1);
    expect(registry.errors[0]).toMatchObject({
      alias: "my-model",
      code: "unknown",
    });
    expect(registry.errors[0]?.message).toContain("gpt-5-not-real");
  });

  it("rejects an unknown Provider even when the model id exists elsewhere", () => {
    const registry = compute({
      "my-model": { provider: "nonexistent-provider", model: "gpt-4o" },
    });
    expect(registry.errors[0]?.code).toBe("unknown");
  });

  it("rejects a bare model-id target as ambiguous without guessing a Provider", () => {
    const registry = compute({
      "my-model": "gpt-4o",
    });
    expect(registry.aliases.map((entry) => entry.alias)).toEqual([
      "gpt-4o",
      "claude-opus-4",
    ]);
    expect(registry.errors[0]?.code).toBe("ambiguous");
    // Even though exactly one provider serves gpt-4o in this catalog, the
    // target does not name one canonical model.
    expect(registry.errors[0]?.message).toContain("Provider");
  });

  it("rejects an alias using the canonical provider/model separator as ambiguous", () => {
    const registry = compute({
      "openai/gpt-4o": { provider: "openai", model: "gpt-4o" },
    });
    expect(registry.aliases.map((entry) => entry.alias)).toEqual([
      "gpt-4o",
      "claude-opus-4",
    ]);
    expect(registry.errors[0]?.code).toBe("ambiguous");
  });

  it("rejects malformed aliases and targets as invalid", () => {
    const registry = compute({
      "": { provider: "openai", model: "gpt-4o" },
      " padded ": { provider: "openai", model: "gpt-4o" },
      "toooo-long": { provider: "openai", model: " padded " },
      "not-an-object": 42,
      "missing-model": { provider: "openai" },
    });
    expect(registry.aliases.map((entry) => entry.alias)).toEqual([
      "gpt-4o",
      "claude-opus-4",
    ]);
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
      "first": { provider: "openai", model: "gpt-4o" },
      "second": "openai/gpt-4o",
    });
    expect(registry.aliases.map((entry) => entry.alias)).toEqual([
      "first",
      "claude-opus-4",
    ]);
    expect(registry.errors[0]).toMatchObject({
      alias: "second",
      code: "duplicate",
    });
  });

  it("lets a user alias take a canonical target over a curated default", () => {
    const registry = compute({
      "my-opus": { provider: "anthropic", model: "claude-opus-4-8" },
    });
    // User mappings always win: the explicit alias claims the canonical
    // target and the curated default is demoted with a duplicate error
    // (never two effective aliases for one target).
    expect(registry.aliases.map((entry) => entry.alias)).toEqual([
      "my-opus",
      "gpt-4o",
    ]);
    expect(registry.errors[0]).toMatchObject({
      alias: "claude-opus-4",
      code: "duplicate",
    });
    expect(
      registry.aliases.find((entry) => entry.alias === "my-opus")?.target,
    ).toEqual({ provider: "anthropic", model: "claude-opus-4-8" });
  });

  it("rejects a default whose target is unknown in the current catalog", () => {
    const registry = computeEffectiveAliasRegistry({
      userAliases: {},
      defaults: [
        { alias: "gpt-4o", provider: "openai", model: "gpt-4o" },
        // This default's target left the active catalog.
        { alias: "old-default", provider: "openai", model: "gpt-3.5-turbo" },
      ],
      defaultsVersion: 1,
      catalogVersion,
      knownTargets,
    });
    expect(registry.aliases.map((entry) => entry.alias)).toEqual(["gpt-4o"]);
    expect(registry.errors).toEqual([
      expect.objectContaining({ alias: "old-default", code: "unknown" }),
    ]);
  });

  it("accepts string and object targets with identical canonical identity", () => {
    const asString = compute({ "a": "openai/gpt-4o-mini" });
    const asObject = compute({ "a": { provider: "openai", model: "gpt-4o-mini" } });
    expect(asString.aliases).toEqual(asObject.aliases);
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
    expect(parseAliasTarget("openai/gpt-4o/extra")).toMatchObject({
      error: { code: "invalid" },
    });
    expect(parseAliasTarget("openai/gpt-4o")).toEqual({
      target: { provider: "openai", model: "gpt-4o" },
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
