import { createModels } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { createProviderCredentialProfiles } from "../../src/credentials/profile-authority.js";
import {
  createInMemoryProviderCredentialRecordStore,
} from "../../src/credentials/profile-record-store.js";
import {
  isProfileProviderAuthBindingCapture,
} from "../../src/credentials/profile-contract.js";
import { createFixtureProvider } from "../support/credential-fixture.js";

function fixture() {
  let nextId = 0;
  let nextRevision = 0;
  const provider = createFixtureProvider({ id: "openai" });
  const profiles = createProviderCredentialProfiles({
    recordStore: createInMemoryProviderCredentialRecordStore({
      createRevision: () => `revision-${++nextRevision}`,
    }),
    providers: () => [provider],
    createId: () => `id-${++nextId}`,
    now: () => 10_000,
  });
  const models = createModels({ credentials: profiles.credentialStore });
  models.setProvider(provider);
  return { provider, profiles, models };
}

async function add(
  value: ReturnType<typeof fixture>,
  name: string,
  key: string,
): Promise<string> {
  const binding = await value.profiles.binding.createAcquisitionBinding({
    providerId: value.provider.id,
    acquisitionKind: "api_key",
    displayName: name,
  });
  await value.profiles.binding.runBound(binding, () =>
    value.models.login(value.provider.id, "api_key", {
      prompt: async () => key,
      notify: () => undefined,
    }),
  );
  return binding.credentialId;
}

describe("Provider Profile binding authority", () => {
  it("captures unbound only while the Provider has zero Token Profiles", async () => {
    const value = fixture();
    expect((await value.profiles.binding.capture(value.provider.id)).facts)
      .toEqual({ kind: "unbound", providerId: value.provider.id });

    const credentialId = await add(value, "Primary", "secret-primary");
    const capture = await value.profiles.binding.capture(value.provider.id);
    expect(isProfileProviderAuthBindingCapture(capture)).toBe(true);
    expect(capture.facts).toMatchObject({
      kind: "profile",
      credentialId,
      acquisitionKind: "api_key",
      authType: "api_key",
      referenceOwner: "managed",
    });
  });

  it("keeps a request bound to its exact Profile after active selection changes", async () => {
    const value = fixture();
    const first = await add(value, "Primary", "secret-primary");
    const second = await add(value, "Backup", "secret-backup");
    const capture = await value.profiles.binding.capture(value.provider.id);
    if (!isProfileProviderAuthBindingCapture(capture)) {
      throw new Error("expected Profile capture");
    }

    const state = (await value.profiles.management.query([
      value.provider.id,
    ])).providers[0]!;
    await value.profiles.management.activate({
      providerId: value.provider.id,
      credentialId: second,
      expectedRevision: state.revision!,
    });

    const credential = await value.profiles.binding.runBound(
      capture,
      () => value.profiles.credentialStore.read(value.provider.id),
    );
    expect(credential).toEqual({ type: "api_key", key: "secret-primary" });
    expect(capture.facts.credentialId).toBe(first);
  });

  it("prevents a stale request from changing active selection after A→B", async () => {
    const value = fixture();
    const first = await add(value, "Primary", "secret-primary");
    const second = await add(value, "Backup", "secret-backup");
    const stale = await value.profiles.binding.capture(value.provider.id);
    if (!isProfileProviderAuthBindingCapture(stale)) {
      throw new Error("expected Profile capture");
    }

    let state = (await value.profiles.management.query([
      value.provider.id,
    ])).providers[0]!;
    await value.profiles.management.setSwitchPolicy({
      providerId: value.provider.id,
      expectedRevision: state.revision!,
      apiKeyOn429: true,
      oauthOn429: false,
    });
    state = (await value.profiles.management.query([
      value.provider.id,
    ])).providers[0]!;
    await value.profiles.management.activate({
      providerId: value.provider.id,
      credentialId: second,
      expectedRevision: state.revision!,
    });

    await expect(
      value.profiles.binding.advanceAfterFinal429({
        capture: stale,
        attemptedCredentialIds: [first],
      }),
    ).resolves.toEqual({ outcome: "stale_binding" });
    expect(
      (await value.profiles.management.query([value.provider.id]))
        .providers[0]?.activeCredentialId,
    ).toBe(second);
  });

  it("lists only the active Profile and does not let Pi delete Profile state", async () => {
    const value = fixture();
    await add(value, "Primary", "secret-primary");
    await add(value, "Backup", "secret-backup");

    await expect(value.profiles.credentialStore.list()).resolves.toEqual([
      { providerId: value.provider.id, type: "api_key" },
    ]);
    await expect(
      value.profiles.credentialStore.delete(value.provider.id),
    ).rejects.toMatchObject({ outcome: "stale_binding" });
  });
});
