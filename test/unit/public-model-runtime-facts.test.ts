import { describe, expect, it } from "vitest";

import type {
  CatalogSnapshotProjection,
  CredentialProfileProjectionV1,
  CredentialProfilesProjectionV1,
  ProviderCredentialProfilesProjectionV1,
} from "@token/application-control-plane/control-plane";

import { publicModelRuntimeFacts } from "../../src/public-models/runtime-facts.js";

const SELECTION_PROVIDER_ID = "selection";

function selectionCatalog(): CatalogSnapshotProjection {
  return {
    version: 1,
    modelsJsonValid: true,
    refreshErrors: [],
    providers: [{
      providerId: SELECTION_PROVIDER_ID,
      name: "Selection",
      dynamic: false,
      state: "known",
      models: [{
        id: "model",
        api: "fixture-api",
        dynamic: false,
        availability: "available",
      }],
    }],
  } as CatalogSnapshotProjection;
}

function selectionProfile(
  health: CredentialProfileProjectionV1["health"] = "ready",
): CredentialProfileProjectionV1 {
  return Object.freeze({
    credentialId: "managed-profile",
    authType: "oauth" as const,
    authMethodLabel: "Fixture account",
    displayName: "Managed Profile",
    enabled: true,
    health,
    priority: 0,
    createdAt: 1,
    updatedAt: 1,
  });
}

function selectionProvider(input: {
  readonly activeCredentialId?: string;
  readonly declaredExternalSource: boolean;
  readonly externalStatus: "connected" | "configured" | "unknown";
  readonly profiles?: readonly CredentialProfileProjectionV1[];
}): ProviderCredentialProfilesProjectionV1 {
  return Object.freeze({
    providerId: SELECTION_PROVIDER_ID,
    implementationAvailable: true,
    ...(input.activeCredentialId === undefined
      ? {}
      : { activeCredentialId: input.activeCredentialId }),
    ambient: Object.freeze({
      kind: "external" as const,
      status: input.externalStatus,
      ...(input.declaredExternalSource ? { displayName: "Codex login" } : {}),
      message: "Fixture external source",
    }),
    profiles: Object.freeze(input.profiles ?? []),
  });
}

function selectionUsable(
  provider: ProviderCredentialProfilesProjectionV1,
): boolean {
  return publicModelRuntimeFacts(
    selectionCatalog(),
    Object.freeze({ providers: Object.freeze([provider]) }),
  ).providers[0]!.usable;
}

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
            { id: "opus", api: "anthropic-messages", dynamic: true, availability: "available" },
            { id: "sonnet", api: "anthropic-messages", dynamic: true, availability: "available" },
          ],
        },
        {
          providerId: "google",
          name: "Google",
          dynamic: false,
          state: "known",
          models: [
            { id: "gemini", api: "google-generative-ai", dynamic: false, availability: "unavailable" },
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
        models: [{ id: "model", api: "fixture-api", dynamic: false, availability: "available" }],
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

describe("Public Model runtime facts and credential selection", () => {
  it("uses the selected Profile rather than a connected external source", () => {
    expect(selectionUsable(selectionProvider({
      activeCredentialId: "managed-profile",
      declaredExternalSource: true,
      externalStatus: "unknown",
      profiles: Object.freeze([selectionProfile()]),
    }))).toBe(true);
    expect(selectionUsable(selectionProvider({
      activeCredentialId: "managed-profile",
      declaredExternalSource: true,
      externalStatus: "connected",
      profiles: Object.freeze([selectionProfile("reconnect_required")]),
    }))).toBe(false);
  });

  it("fails closed when Profiles exist without a selection", () => {
    expect(selectionUsable(selectionProvider({
      declaredExternalSource: true,
      externalStatus: "connected",
      profiles: Object.freeze([selectionProfile()]),
    }))).toBe(false);
  });

  it("preserves configured ambient auth without a declared external source", () => {
    expect(selectionUsable(selectionProvider({
      declaredExternalSource: false,
      externalStatus: "configured",
    }))).toBe(true);
  });
});
