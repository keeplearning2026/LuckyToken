import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";

import { bundledProviderIds } from "../../../src/providers/bundled.js";
import { providerIconDefinitions } from "../src/renderer/providers/provider-icons.js";

describe("provider card icon coverage", () => {
  it("covers every Provider shipped by the pinned Pi runtime and Token bundles", () => {
    const shipped = [
      ...builtinProviders().map((provider) => provider.id),
      ...bundledProviderIds,
    ].sort();
    expect(shipped.length).toBeGreaterThan(0);
    const missing = shipped.filter(
      (providerId) => providerIconDefinitions[providerId] === undefined,
    );
    expect(missing).toEqual([]);
  });

  it("does not keep glyphs for Providers the pinned runtime no longer ships", () => {
    const shipped = new Set([
      ...builtinProviders().map((provider) => provider.id),
      ...bundledProviderIds,
    ]);
    const stale = Object.keys(providerIconDefinitions).filter(
      (providerId) => !shipped.has(providerId),
    );
    expect(stale).toEqual([]);
  });
});
