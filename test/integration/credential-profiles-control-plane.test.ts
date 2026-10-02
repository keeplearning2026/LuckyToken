import { createModels } from "@earendil-works/pi-ai";
import type { AuthInteractionChannel } from "@token/application-control-plane/control-plane";
import { describe, expect, it } from "vitest";

import { createCredentialManagementGuard } from "../../src/credentials/management.js";
import { createProviderCredentialProfiles } from "../../src/credentials/profile-authority.js";
import { createCredentialProfilesControlPlaneHandlers } from "../../src/credentials/profile-control-plane.js";
import { createInMemoryProviderCredentialRecordStore } from "../../src/credentials/profile-record-store.js";
import { createFixtureProvider } from "../support/credential-fixture.js";

function interaction(answer: string): AuthInteractionChannel {
  return Object.freeze({
    signal: new AbortController().signal,
    notify: async () => undefined,
    prompt: async () => answer,
  });
}

function blockingInteraction(): AuthInteractionChannel {
  const controller = new AbortController();
  return Object.freeze({
    signal: controller.signal,
    notify: async () => undefined,
    prompt: () =>
      new Promise<string>((_resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(controller.signal.reason),
          { once: true },
        );
      }),
  });
}

function fixture() {
  let nextId = 0;
  let nextRevision = 0;
  const provider = createFixtureProvider();
  const profiles = createProviderCredentialProfiles({
    recordStore: createInMemoryProviderCredentialRecordStore({
      createRevision: () => "revision-" + String(++nextRevision),
    }),
    providers: () => [provider],
    createId: () => "id-" + String(++nextId),
    now: () => 1_000,
  });
  const models = createModels({ credentials: profiles.credentialStore });
  models.setProvider(provider);
  const postLoginCaptures: unknown[] = [];
  const handlers = createCredentialProfilesControlPlaneHandlers({
    models,
    management: profiles.management,
    binding: profiles.binding,
    managementGuard: createCredentialManagementGuard({
      createId: () => "operation-" + String(++nextId),
      now: () => 1_000,
    }),
    providerSource: () => "pi_builtin",
    postLoginProvider: (_providerId, capture) => {
      postLoginCaptures.push(capture.facts);
    },
  });
  return { provider, profiles, handlers, postLoginCaptures };
}

describe("Credential Profiles Control Plane", () => {
  it("creates new Profiles without acquisition-time activation", async () => {
    const value = fixture();

    const first = await value.handlers.auth(
      {
        command: "login",
        providerId: value.provider.id,
        acquisitionKind: "api_key",
        displayName: "Primary",
      },
      interaction("secret-primary"),
    );
    expect(first.outcome).toBe("ok");
    const firstState = first.state.providers[0]!;
    expect(firstState.profiles).toHaveLength(1);
    expect(firstState.activeCredentialId).toBe(
      firstState.profiles[0]?.credentialId,
    );
    expect(JSON.stringify(first)).not.toContain("secret-primary");

    const second = await value.handlers.auth(
      {
        command: "login",
        providerId: value.provider.id,
        acquisitionKind: "api_key",
        displayName: "Backup",
      },
      interaction("secret-backup"),
    );
    expect(second.outcome).toBe("ok");
    const secondState = second.state.providers[0]!;
    expect(secondState.profiles.map((profile) => profile.displayName)).toEqual([
      "Primary",
      "Backup",
    ]);
    expect(secondState.activeCredentialId).toBe(
      secondState.profiles[0]?.credentialId,
    );

    // Only the first acquisition becomes active immediately, so only it
    // schedules post-login catalog work.
    expect(value.postLoginCaptures).toHaveLength(1);
  });

  it("keeps ordinary Profile management revision-checked", async () => {
    const value = fixture();
    const login = await value.handlers.auth(
      {
        command: "login",
        providerId: value.provider.id,
        acquisitionKind: "api_key",
        displayName: "Primary",
      },
      interaction("secret-primary"),
    );
    const provider = login.state.providers[0]!;
    const credentialId = provider.profiles[0]!.credentialId;

    const renamed = await value.handlers.credentials({
      command: "update_metadata",
      providerId: value.provider.id,
      credentialId,
      displayName: "Renamed",
      expectedRevision: provider.revision!,
    });
    expect(renamed.outcome).toBe("ok");
    expect(renamed.state.providers[0]?.profiles[0]?.displayName).toBe(
      "Renamed",
    );

    const stale = await value.handlers.credentials({
      command: "set_enabled",
      providerId: value.provider.id,
      credentialId,
      enabled: false,
      expectedRevision: provider.revision!,
    });
    expect(stale.outcome).toBe("conflict");
  });

  it("activates a new first Profile after the last Profile was removed", async () => {
    const value = fixture();
    const first = await value.handlers.auth(
      {
        command: "login",
        providerId: value.provider.id,
        acquisitionKind: "api_key",
        displayName: "Primary",
      },
      interaction("secret-primary"),
    );
    const initial = first.state.providers[0]!;
    const credentialId = initial.profiles[0]!.credentialId;
    const removed = await value.handlers.credentials({
      command: "remove",
      providerId: value.provider.id,
      credentialId,
      expectedRevision: initial.revision!,
    });
    expect(removed.outcome).toBe("ok");
    expect(removed.state.providers[0]?.profiles).toEqual([]);
    expect(removed.state.providers[0]?.activeCredentialId).toBeUndefined();

    const second = await value.handlers.auth(
      {
        command: "login",
        providerId: value.provider.id,
        acquisitionKind: "api_key",
        displayName: "Secondary",
      },
      interaction("secret-secondary"),
    );
    expect(second.outcome).toBe("ok");
    const state = second.state.providers[0]!;
    expect(state.profiles.map((profile) => profile.displayName)).toEqual([
      "Secondary",
    ]);
    expect(state.activeCredentialId).toBe(state.profiles[0]?.credentialId);
    // Both acquisitions were active, so both scheduled post-login work.
    expect(value.postLoginCaptures).toHaveLength(2);
  });

  it("exposes local OAuth availability as one acquisition kind", async () => {
    const value = fixture();
    const query = await value.handlers.auth(
      { command: "query" },
      interaction("unused"),
    );

    expect(query.options?.providers[0]).toMatchObject({
      providerId: value.provider.id,
      source: "pi_builtin",
      acquisitionOptions: [
        {
          kind: "api_key",
          authType: "api_key",
          interactive: true,
          state: "available",
        },
      ],
    });
  });

  it("fails fast on overlapping management and cancels the active operation", async () => {
    const value = fixture();
    const blocked = blockingInteraction();
    const login = value.handlers.auth(
      {
        command: "login",
        providerId: value.provider.id,
        acquisitionKind: "api_key",
        displayName: "Primary",
      },
      blocked,
    );
    await Promise.resolve();

    const busy = await value.handlers.credentials({
      command: "remove",
      providerId: value.provider.id,
      credentialId: "missing",
      expectedRevision: "absent",
    });
    expect(busy.outcome).toBe("management_operation_in_progress");
    expect(busy.activeOperation).toMatchObject({
      kind: "acquire_api_key",
      providerId: value.provider.id,
    });

    const cancelled = await value.handlers.credentials({
      command: "cancel_management",
      operationId: busy.activeOperation!.operationId,
    });
    expect(cancelled.outcome).toBe("ok");

    // Pi observes the guarded signal, so explicit cancellation settles the
    // login without a separate interaction abort.
    await expect(login).resolves.toMatchObject({ outcome: "cancelled" });

    const after = await value.handlers.credentials({
      command: "remove",
      providerId: value.provider.id,
      credentialId: "missing",
      expectedRevision: "absent",
    });
    expect(after.outcome).toBe("unknown_profile");
  });
});
