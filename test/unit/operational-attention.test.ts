import { describe, expect, it } from "vitest";

import type {
  ApplicationStatus,
  CredentialProfilesProjectionV1,
  ProviderCredentialProfilesProjectionV1,
} from "@token/application-control-plane/control-plane";
import { decodeAttentionProjection } from "@token/application-control-plane/control-plane";
import { createOperationalAttentionAuthority } from "../../src/operational-attention/index.js";

const running: ApplicationStatus = Object.freeze({
  modelDataPlane: "running",
  provider: "configured",
  dataPlane: Object.freeze({
    configuredOrigin: "http://127.0.0.1:4010",
    configuredPort: 4010,
  }),
});

function credentials(
  providers: readonly ProviderCredentialProfilesProjectionV1[],
): CredentialProfilesProjectionV1 {
  return Object.freeze({ providers: Object.freeze(providers) });
}

describe("operational attention authority", () => {
  it("derives only actionable gateway episodes and coalesces unchanged facts", () => {
    let now = 1_700_000_000_000;
    const authority = createOperationalAttentionAuthority({
      now: () => now,
      credentials: () => undefined,
      requestFailureCount: () => 0,
    });

    expect(authority.project(running)).toBeUndefined();

    const startFailed: ApplicationStatus = {
      ...running,
      modelDataPlane: "failed",
      dataPlane: {
        ...running.dataPlane!,
        failure: { code: "start_failed", message: "untrusted detail" },
      },
    };
    const first = authority.project(startFailed);
    expect(first?.conditions).toEqual([
      {
        id: "gateway-start-failed",
        category: "gateway-start-failed",
        since: now,
        page: "dashboard",
      },
    ]);
    now += 5_000;
    expect(authority.project(startFailed)?.conditions[0]?.since).toBe(
      1_700_000_000_000,
    );
    expect(authority.project(running)).toBeUndefined();

    const portConflict: ApplicationStatus = {
      ...running,
      modelDataPlane: "failed",
      dataPlane: {
        ...running.dataPlane!,
        failure: { code: "port_in_use", message: "ignored" },
      },
    };
    expect(authority.project(portConflict)?.conditions[0]?.category).toBe(
      "port-conflict",
    );

    const stopFailed: ApplicationStatus = {
      ...running,
      modelDataPlane: "failed",
      dataPlane: {
        ...running.dataPlane!,
        failure: { code: "stop_failed", message: "ignored" },
      },
    };
    expect(authority.project(stopFailed)).toBeUndefined();

  });

  it("activates provider invalidation only after a previously effective credential becomes invalid", () => {
    let now = 100;
    let projection = credentials([
      {
        providerId: "never-configured",
        implementationAvailable: true,
        profiles: [],
      },
      {
        providerId: "working-provider",
        implementationAvailable: true,
        revision: "revision-a",
        selectionGeneration: "selection-a",
        activeCredentialId: "credential-a",
        switchPolicy: { apiKeyOn429: false, oauthOn429: false },
        profiles: [{
          credentialId: "credential-a",
          authType: "oauth",
          authMethodLabel: "Fixture account",
          displayName: "Production",
          enabled: true,
          health: "ready",
          priority: 0,
          createdAt: 1,
          updatedAt: 1,
        }],
      },
    ]);
    const authority = createOperationalAttentionAuthority({
      now: () => now,
      credentials: () => projection,
      requestFailureCount: () => 0,
    });

    expect(authority.project(running)).toBeUndefined();
    now = 200;
    projection = credentials([
      projection.providers[0]!,
      {
        ...projection.providers[1]!,
        profiles: [{
          ...projection.providers[1]!.profiles[0]!,
          health: "reconnect_required",
        }],
      },
    ]);
    expect(authority.project(running)?.conditions).toEqual([
      {
        id: "provider-login-invalid:working-provider",
        category: "provider-login-invalid",
        providerId: "working-provider",
        since: 200,
        page: "providers",
      },
    ]);

    projection = credentials([
      projection.providers[0]!,
      {
        ...projection.providers[1]!,
        profiles: [{
          ...projection.providers[1]!.profiles[0]!,
          health: "ready",
        }],
      },
    ]);
    expect(authority.project(running)).toBeUndefined();
  });

  it("reports recent request failures as an aggregate without creating notification conditions", () => {
    const authority = createOperationalAttentionAuthority({
      now: () => 3_600_100,
      credentials: () => undefined,
      requestFailureCount: (from, to) => {
        expect(from).toBe(100);
        expect(to).toBe(3_600_101);
        return 7;
      },
    });

    expect(authority.project(running)).toEqual({
      conditions: [],
      requestFailures: { count: 7, windowMs: 3_600_000 },
    });
  });

  it("projects diagnostics unavailability as one stable actionable episode", () => {
    let unavailable = true;
    let now = 500;
    const authority = createOperationalAttentionAuthority({
      now: () => now,
      credentials: () => undefined,
      diagnosticsAvailable: () => !unavailable,
      requestFailureCount: () => 0,
    });

    expect(authority.project(running)?.conditions).toEqual([
      {
        id: "persistence-critical",
        category: "persistence-critical",
        since: 500,
        page: "diagnostics",
      },
    ]);
    now = 900;
    expect(authority.project(running)?.conditions[0]?.since).toBe(500);
    unavailable = false;
    expect(authority.project(running)).toBeUndefined();
  });

  it("rejects unknown fields, malformed identities, and secret-bearing additions", () => {
    expect(
      decodeAttentionProjection({
        conditions: [
          {
            id: "provider-login-invalid:provider-a",
            category: "provider-login-invalid",
            providerId: "provider-a",
            since: 1,
            page: "providers",
          },
        ],
        requestFailures: { count: 2, windowMs: 3_600_000 },
      }),
    ).toBeDefined();
    expect(
      decodeAttentionProjection({
        conditions: [],
        requestFailures: { count: 2, windowMs: 3_600_000 },
        realModelId: "secret-model-canary",
      }),
    ).toBeUndefined();
    expect(
      decodeAttentionProjection({
        conditions: [
          {
            id: "provider-login-invalid:provider/a",
            category: "provider-login-invalid",
            providerId: "provider/a",
            since: 1,
            page: "providers",
          },
        ],
      }),
    ).toBeUndefined();
  });
});
