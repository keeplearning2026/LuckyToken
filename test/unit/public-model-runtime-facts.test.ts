import { describe, expect, it } from "vitest";

import type {
  CatalogSnapshotProjection,
  CredentialProfilesProjectionV1,
} from "@token/application-control-plane/control-plane";

import { publicModelRuntimeFacts } from "../../src/public-models/runtime-facts.js";

describe("Public Model runtime facts", () => {
  it("takes Provider login usability from Profile management while Catalog supplies only current target ids", () => {
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
      providers: [
        {
          providerId: "anthropic",
          implementationAvailable: true,
          ambient: {
            kind: "external",
            status: "unknown",
            message: "Resolved only when used",
          },
          profiles: [],
        },
        {
          providerId: "google",
          implementationAvailable: true,
          revision: "revision-google",
          selectionGeneration: "selection-google",
          activeCredentialId: "credential-google",
          switchPolicy: { apiKeyOn429: false, oauthOn429: false },
          profiles: [{
            credentialId: "credential-google",
            authType: "api_key",
            authMethodLabel: "Google Cloud credentials",
            displayName: "Production",
            enabled: true,
            health: "ready",
            priority: 0,
            createdAt: 1,
            updatedAt: 1,
          }],
        },
      ],
    } as CredentialProfilesProjectionV1;

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

  it("keeps locally configured ambient auth usable without treating unknown ambient auth as verified", () => {
    const catalog = {
      version: 1,
      modelsJsonValid: true,
      refreshErrors: [],
      providers: [{
        providerId: "fixture",
        name: "Fixture",
        dynamic: false,
        state: "known",
        models: [{ id: "model", dynamic: false, availability: "available" }],
      }],
    } as CatalogSnapshotProjection;
    const credentials = {
      providers: [{
        providerId: "fixture",
        implementationAvailable: true,
        ambient: {
          kind: "external",
          status: "configured",
          message: "External auth is configured",
        },
        profiles: [],
      }],
    } as CredentialProfilesProjectionV1;

    expect(publicModelRuntimeFacts(catalog, credentials).providers[0]).toEqual({
      providerId: "fixture",
      usable: true,
      models: ["model"],
    });
  });
});
