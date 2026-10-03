import { createModels } from "@earendil-works/pi-ai";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { LocalOAuthRegistration } from "@token/provider-contract/local-oauth";
import { createProviderCredentialProfiles } from "../../src/credentials/profile-authority.js";
import { createInMemoryProviderCredentialRecordStore } from "../../src/credentials/profile-record-store.js";
import { createFixtureProvider } from "../support/credential-fixture.js";

function fixture(localOAuthRegistrations: readonly LocalOAuthRegistration[] = []) {
  let nextId = 0;
  let nextRevision = 0;
  const provider = createFixtureProvider();
  const store = createInMemoryProviderCredentialRecordStore({
    createRevision: () => `revision-${++nextRevision}`,
  });
  const profiles = createProviderCredentialProfiles({
    recordStore: store,
    providers: () => [provider],
    createId: () => `id-${++nextId}`,
    now: () => 1_000,
    localOAuthRegistrations: () => localOAuthRegistrations,
  });
  const models = createModels({ credentials: profiles.credentialStore });
  models.setProvider(provider);
  return { provider, store, profiles, models };
}

async function addApiKey(
  value: ReturnType<typeof fixture>,
  displayName: string,
  secret: string,
): Promise<string> {
  const binding = await value.profiles.binding.createAcquisitionBinding({
    providerId: value.provider.id,
    acquisitionKind: "api_key",
    displayName,
  });
  await value.profiles.binding.runBound(binding, () =>
    value.models.login(value.provider.id, "api_key", {
      prompt: async () => secret,
      notify: () => undefined,
    }),
  );
  return binding.credentialId;
}

describe("Credential Profile management target model", () => {
  it("makes only the first Profile active and preserves explicit selection", async () => {
    const value = fixture();
    const first = await addApiKey(value, "Primary", "secret-primary");
    const second = await addApiKey(value, "Backup", "secret-backup");

    const state = (await value.profiles.management.query([
      value.provider.id,
    ])).providers[0]!;
    expect(state.activeCredentialId).toBe(first);
    expect(state.profiles.map((profile) => profile.credentialId)).toEqual([
      first,
      second,
    ]);

    const activated = await value.profiles.management.activate({
      providerId: value.provider.id,
      credentialId: second,
      expectedRevision: state.revision!,
    });
    expect(activated.outcome).toBe("ok");
    expect(activated.provider?.activeCredentialId).toBe(second);
  });

  it("uses profiles[] as the only persisted order", async () => {
    const value = fixture();
    const first = await addApiKey(value, "Primary", "secret-primary");
    const second = await addApiKey(value, "Backup", "secret-backup");
    const before = (await value.profiles.management.query([
      value.provider.id,
    ])).providers[0]!;

    const reordered = await value.profiles.management.reorderProfiles({
      providerId: value.provider.id,
      credentialIds: [second, first],
      expectedRevision: before.revision!,
    });

    expect(reordered.outcome).toBe("ok");
    expect(
      reordered.provider?.profiles.map((profile) => profile.credentialId),
    ).toEqual([second, first]);
    expect((await value.store.read(value.provider.id))?.profiles.map(
      (profile) => profile.credentialId,
    )).toEqual([second, first]);
  });

  it("clears active selection when the active Profile is disabled", async () => {
    const value = fixture();
    const first = await addApiKey(value, "Primary", "secret-primary");
    await addApiKey(value, "Backup", "secret-backup");
    const before = (await value.profiles.management.query([
      value.provider.id,
    ])).providers[0]!;

    const disabled = await value.profiles.management.setEnabled({
      providerId: value.provider.id,
      credentialId: first,
      enabled: false,
      expectedRevision: before.revision!,
    });

    expect(disabled.outcome).toBe("ok");
    expect(disabled.provider?.activeCredentialId).toBeUndefined();
    expect(disabled.provider?.profiles).toEqual([
      expect.objectContaining({ credentialId: first, enabled: false }),
      expect.objectContaining({ enabled: true }),
    ]);
  });

  it("enforces Provider-local case-insensitive display-name uniqueness", async () => {
    const value = fixture();
    await addApiKey(value, "Primary", "secret-primary");

    await expect(
      value.profiles.binding.createAcquisitionBinding({
        providerId: value.provider.id,
        acquisitionKind: "api_key",
        displayName: "primary",
      }),
    ).rejects.toMatchObject({ outcome: "duplicate" });
  });

  it("rejects stale management intent with expectedRevision", async () => {
    const value = fixture();
    const first = await addApiKey(value, "Primary", "secret-primary");
    const before = (await value.profiles.management.query([
      value.provider.id,
    ])).providers[0]!;

    const firstMutation = await value.profiles.management.updateMetadata({
      providerId: value.provider.id,
      credentialId: first,
      displayName: "Primary updated",
      expectedRevision: before.revision!,
    });
    expect(firstMutation.outcome).toBe("ok");

    const stale = await value.profiles.management.setEnabled({
      providerId: value.provider.id,
      credentialId: first,
      enabled: false,
      expectedRevision: before.revision!,
    });
    expect(stale.outcome).toBe("conflict");
  });

  it("activates the first new Profile after the last Profile was removed", async () => {
    const value = fixture();
    const first = await addApiKey(value, "Primary", "secret-primary");
    const beforePolicy = (await value.profiles.management.query([
      value.provider.id,
    ])).providers[0]!;
    const policy = await value.profiles.management.setSwitchPolicy({
      providerId: value.provider.id,
      expectedRevision: beforePolicy.revision!,
      apiKeyOn429: true,
      oauthOn429: true,
    });
    expect(policy.outcome).toBe("ok");

    const removed = await value.profiles.management.remove({
      providerId: value.provider.id,
      credentialId: first,
      expectedRevision: policy.provider!.revision!,
    });
    expect(removed.outcome).toBe("ok");
    expect(removed.provider?.profiles).toEqual([]);
    expect(removed.provider?.activeCredentialId).toBeUndefined();

    const second = await addApiKey(value, "Secondary", "secret-secondary");
    const state = (await value.profiles.management.query([
      value.provider.id,
    ])).providers[0]!;
    expect(state.profiles.map((profile) => profile.displayName)).toEqual([
      "Secondary",
    ]);
    expect(state.activeCredentialId).toBe(second);
    expect(state.switchPolicy).toEqual({ apiKeyOn429: true, oauthOn429: true });
  });

  it("activates the first new local_oauth Profile after the last Profile was removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-profile-local-"));
    try {
      const path = join(root, "auth.json");
      await writeFile(path, "fixture credential");
      const registration: LocalOAuthRegistration = Object.freeze({
        providerId: "fixture-provider",
        icon: "terminal" as const,
        label: () => undefined,
        acquire: async () =>
          Object.freeze({
            owner: "external" as const,
            path,
          }),
        read: () => ({ type: "oauth" as const, access: "access", refresh: "refresh", expires: 1_000 }),
      });
      const value = fixture([registration]);
      const first = await value.profiles.management.acquireLocal({
        providerId: value.provider.id,
        displayName: "Local",
      });
      expect(first.outcome).toBe("ok");
      const firstId = first.provider!.profiles[0]!.credentialId;
      expect(first.provider?.activeCredentialId).toBe(firstId);

      const removed = await value.profiles.management.remove({
        providerId: value.provider.id,
        credentialId: firstId,
        expectedRevision: first.provider!.revision!,
      });
      expect(removed.outcome).toBe("ok");
      expect(removed.provider?.profiles).toEqual([]);

      const second = await value.profiles.management.acquireLocal({
        providerId: value.provider.id,
        displayName: "Local two",
      });
      expect(second.outcome).toBe("ok");
      expect(second.provider?.profiles).toHaveLength(1);
      expect(second.provider?.activeCredentialId).toBe(
        second.provider?.profiles[0]?.credentialId,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
