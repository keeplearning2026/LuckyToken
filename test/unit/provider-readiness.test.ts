import { describe, expect, it } from "vitest";

import type { CatalogSnapshotProjection } from "@token/application-control-plane/control-plane";

import { providerReadiness } from "../../src/providers/readiness.js";

function snapshot(
  availability: readonly (readonly ["available" | "unavailable" | "unknown", string])[],
): CatalogSnapshotProjection {
  const byProvider = new Map<
    string,
    Array<{
      readonly id: string;
      readonly dynamic: boolean;
      readonly availability: "available" | "unavailable" | "unknown";
    }>
  >();
  for (const [value, providerId] of availability) {
    const list = byProvider.get(providerId) ?? [];
    list.push({
      id: `model-${list.length}`,
      dynamic: false,
      availability: value,
    });
    byProvider.set(providerId, list);
  }
  return Object.freeze({
    version: 1,
    modelsJsonValid: true,
    providers: Object.freeze(
      [...byProvider.entries()].map(([providerId, models]) =>
        Object.freeze({
          providerId,
          name: providerId,
          dynamic: false,
          state: "known" as const,
          models: Object.freeze(models.map((model) => Object.freeze(model))),
        }),
      ),
    ),
    refreshErrors: Object.freeze([]),
  });
}

describe("Provider readiness derivation (Ticket 06)", () => {
  it("is unconfigured when provider configuration exists but no Catalog model is available", () => {
    expect(
      providerReadiness(
        snapshot([
          ["unavailable", "anthropic"],
          ["unknown", "commandcode-private"],
        ]),
      ),
    ).toBe("unconfigured");
  });

  it("is configured when at least one Catalog model is available", () => {
    expect(
      providerReadiness(
        snapshot([
          ["unavailable", "anthropic"],
          ["available", "commandcode-private"],
        ]),
      ),
    ).toBe("configured");
  });

  it("is configured when any provider has an available model, even with other failures", () => {
    expect(
      providerReadiness(
        snapshot([
          ["available", "anthropic"],
          ["unavailable", "openai"],
        ]),
      ),
    ).toBe("configured");
  });

  it("is unconfigured for an empty catalog snapshot", () => {
    expect(providerReadiness(snapshot([]))).toBe("unconfigured");
  });

  it("is unconfigured when every model is unavailable or unknown", () => {
    expect(
      providerReadiness(
        snapshot([
          ["unavailable", "anthropic"],
          ["unknown", "openai"],
        ]),
      ),
    ).toBe("unconfigured");
  });
});
