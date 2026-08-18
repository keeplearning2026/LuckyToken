import type { Model, Models } from "@earendil-works/pi-ai";

import { describe, expect, it } from "vitest";

import type { AliasResolverSnapshot } from "../../src/aliases/authority.js";
import { resolveAliasModel } from "../../src/alias-model-seam.js";

function model(id: string, provider = "fixture"): Model<string> {
  return {
    id,
    name: id,
    api: "commandcode-private",
    provider,
    baseUrl: "https://fixture.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64_000,
  };
}

function snapshot(
  mappings: Readonly<Record<string, { readonly providerId: string; readonly modelId: string }>>,
): AliasResolverSnapshot {
  const frozen = new Map(
    Object.entries(mappings).map(([alias, target]) => [
      alias,
      Object.freeze({ providerId: target.providerId, modelId: target.modelId }),
    ]),
  );
  const entries = Object.freeze(
    [...frozen].map(([alias, target]) => Object.freeze({ alias, target })),
  );
  return Object.freeze({
    version: 1,
    catalogVersion: 1,
    fileRevision: 0,
    resolve: (alias: string) => frozen.get(alias),
    entries: () => entries,
  });
}

const models: Pick<Models, "getModels"> = {
  getModels: () => [
    model("deepseek-v4-flash", "deepseek"),
    model("claude-sonnet", "anthropic"),
  ],
};

describe("Ticket 15 alias data plane resolution", () => {
  it("resolves a callable alias to the captured canonical model", () => {
    const result = resolveAliasModel(
      models,
      snapshot({
        flash: { providerId: "deepseek", modelId: "deepseek-v4-flash" },
      }),
      "flash",
    );
    expect(result.kind).toBe("model");
    if (result.kind !== "model") return;
    expect(result.alias).toBe("flash");
    expect(result.model.provider).toBe("deepseek");
    expect(result.model.id).toBe("deepseek-v4-flash");
  });

  it("classifies a selector the snapshot does not know as unknown", () => {
    const result = resolveAliasModel(models, snapshot({}), "gpt-4o");
    expect(result.kind).toBe("unknown");
  });

  it("classifies a configured alias whose target left the served catalog as unavailable", () => {
    const result = resolveAliasModel(
      models,
      snapshot({
        ghost: { providerId: "anthropic", modelId: "claude-opus" },
      }),
      "ghost",
    );
    expect(result.kind).toBe("unavailable");
  });
});
