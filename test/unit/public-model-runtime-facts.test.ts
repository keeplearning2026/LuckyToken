import { describe, expect, it } from "vitest";

import type {
  CatalogSnapshotProjection,
  CredentialProjection,
} from "@luckytoken/application-control-plane/control-plane";

import { publicModelRuntimeFacts } from "../../src/public-models/runtime-facts.js";

describe("Public Model runtime facts", () => {
  it("takes Provider login usability from Credential Authority while Catalog supplies only current target ids", () => {
    const catalog = {
      version: 7,
      modelsJsonValid: true,
      refreshErrors: [],
      providers: [
        {
          providerId: "anthropic",
          name: "Anthropic",
          dynamic: true,
          state: "succeeded",
          models: [
            { id: "opus", dynamic: true, availability: "available" },
            { id: "sonnet", dynamic: true, availability: "available" },
          ],
        },
        {
          providerId: "google",
          name: "Google",
          dynamic: false,
          state: "known",
          models: [
            { id: "gemini", dynamic: false, availability: "unavailable" },
          ],
        },
      ],
    } as CatalogSnapshotProjection;

    const credentials = {
      revision: 3,
      path: "C:\\app\\auth.json",
      present: true,
      valid: true,
      providers: [
        {
          providerId: "anthropic",
          stored: false,
          environment: false,
          modelsJson: false,
          commandDerived: false,
          expired: false,
          unavailable: true,
          effectiveSource: "none",
        },
        {
          providerId: "google",
          stored: true,
          storedType: "api_key",
          environment: false,
          modelsJson: false,
          commandDerived: false,
          expired: false,
          unavailable: false,
          effectiveSource: "stored",
        },
      ],
    } as CredentialProjection;

    expect(publicModelRuntimeFacts(catalog, credentials)).toEqual({
      version: 7,
      providers: [
        {
          providerId: "anthropic",
          usable: false,
          models: ["opus", "sonnet"],
        },
        {
          providerId: "google",
          usable: true,
          models: ["gemini"],
        },
      ],
    });
  });
});
