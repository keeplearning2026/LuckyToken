import { describe, expect, it } from "vitest";

import type {
  ApplicationStatus,
  CatalogSnapshotProjection,
  CredentialProfilesProjectionV1,
  ProviderCredentialProfilesProjectionV1,
} from "@token/application-control-plane/control-plane";

import { createOperationalAttentionAuthority } from "../../src/operational-attention/index.js";
import { publicModelRuntimeFacts } from "../../src/public-models/runtime-facts.js";

/**
 * Plan sections 6 and 9 items 13/14: an external-only Codex login
 * (`ambient.status === "connected"`) makes the Provider usable for Public
 * Model and keeps Operational Attention quiet.
 */

const PROVIDER_ID = "openai-codex";

const running: ApplicationStatus = Object.freeze({
  modelDataPlane: "running",
  provider: "configured",
  dataPlane: Object.freeze({
    configuredOrigin: "http://127.0.0.1:4010",
    configuredPort: 4010,
  }),
});

function externalProvider(
  status: "connected" | "configured" | "unknown",
): ProviderCredentialProfilesProjectionV1 {
  return Object.freeze({
    providerId: PROVIDER_ID,
    implementationAvailable: true,
    ambient: Object.freeze({
      kind: "external" as const,
      status,
      message: "Codex-owned login",
    }),
    profiles: Object.freeze([]),
  });
}

function credentialProjection(
  providers: readonly ProviderCredentialProfilesProjectionV1[],
): CredentialProfilesProjectionV1 {
  return Object.freeze({ providers: Object.freeze(providers) });
}

function catalog(): CatalogSnapshotProjection {
  return {
    version: 3,
    modelsJsonValid: true,
    refreshErrors: [],
    providers: [
      {
        providerId: PROVIDER_ID,
        name: "OpenAI Codex",
        dynamic: false,
        state: "known",
        models: [
          {
            id: "gpt-5.2-codex",
            api: "openai-codex-responses",
            dynamic: false,
            availability: "available",
          },
        ],
      },
    ],
  } as CatalogSnapshotProjection;
}

describe("Public Model runtime facts for the external Codex source", () => {
  it("treats a verified external login as usable without any managed Profile", () => {
    const facts = publicModelRuntimeFacts(
      catalog(),
      credentialProjection([externalProvider("connected")]),
    );
    expect(facts.providers).toEqual([
      {
        providerId: PROVIDER_ID,
        usable: true,
        models: ["gpt-5.2-codex"],
      },
    ]);
  });

  it("keeps configured ambient usable and unreported ambient unusable", () => {
    expect(
      publicModelRuntimeFacts(
        catalog(),
        credentialProjection([externalProvider("configured")]),
      ).providers[0]?.usable,
    ).toBe(true);
    expect(
      publicModelRuntimeFacts(
        catalog(),
        credentialProjection([externalProvider("unknown")]),
      ).providers[0]?.usable,
    ).toBe(false);
  });
});

describe("Operational Attention for the external Codex source", () => {
  it("never raises provider-login-invalid while the external login is connected", () => {
    let now = 100;
    const projection = credentialProjection([externalProvider("connected")]);
    const authority = createOperationalAttentionAuthority({
      now: () => now,
      credentials: () => projection,
      requestFailureCount: () => 0,
    });

    expect(authority.project(running)).toBeUndefined();
    now = 200;
    expect(authority.project(running)).toBeUndefined();
  });

  it("raises the episode only once a previously connected source is gone", () => {
    let now = 100;
    let projection = credentialProjection([externalProvider("connected")]);
    const authority = createOperationalAttentionAuthority({
      now: () => now,
      credentials: () => projection,
      requestFailureCount: () => 0,
    });

    expect(authority.project(running)).toBeUndefined();
    now = 200;
    projection = credentialProjection([externalProvider("unknown")]);
    expect(authority.project(running)?.conditions).toEqual([
      {
        id: `provider-login-invalid:${PROVIDER_ID}`,
        category: "provider-login-invalid",
        providerId: PROVIDER_ID,
        since: 200,
        page: "providers",
      },
    ]);

    now = 300;
    projection = credentialProjection([externalProvider("connected")]);
    expect(authority.project(running)).toBeUndefined();
  });

  it("still raises for a genuinely unavailable managed credential", () => {
    const managed: ProviderCredentialProfilesProjectionV1 = Object.freeze({
      providerId: "anthropic",
      implementationAvailable: true,
      revision: "revision-a",
      selectionGeneration: "selection-a",
      activeCredentialId: "credential-a",
      profiles: Object.freeze([
        Object.freeze({
          credentialId: "credential-a",
          authType: "oauth" as const,
          acquisitionKind: "oauth" as const,
          authMethodLabel: "Fixture account",
          displayName: "Production",
          enabled: true,
          health: "ready" as const,
          priority: 0,
          createdAt: 1,
          updatedAt: 1,
        }),
      ]),
    });
    let now = 100;
    let projection = credentialProjection([managed]);
    const authority = createOperationalAttentionAuthority({
      now: () => now,
      credentials: () => projection,
      requestFailureCount: () => 0,
    });

    expect(authority.project(running)).toBeUndefined();
    now = 200;
    projection = credentialProjection([
      {
        ...managed,
        profiles: Object.freeze([
          Object.freeze({ ...managed.profiles[0]!, health: "reconnect_required" as const }),
        ]),
      },
    ]);
    expect(authority.project(running)?.conditions[0]).toMatchObject({
      id: "provider-login-invalid:anthropic",
      category: "provider-login-invalid",
    });
  });
});

