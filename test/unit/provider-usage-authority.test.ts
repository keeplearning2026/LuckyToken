import { createModels } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { createProviderCredentialProfiles } from "../../src/credentials/profile-authority.js";
import {
  createInMemoryProviderCredentialRecordStore,
} from "../../src/credentials/profile-record-store.js";
import { createProviderUsageAuthority } from "../../src/provider-usage/authority.js";
import type { ProviderUsageProbe } from "../../src/provider-usage/contract.js";
import { createFixtureProvider } from "../support/credential-fixture.js";

function probe(providerId: string): ProviderUsageProbe {
  return Object.freeze({
    providerId,
    eligibility: () => ({ state: "eligible" as const }),
    acquire: async () => ({
      state: "observed" as const,
      facts: {
        windows: [{ kind: "weekly" as const, usedPercent: 25 }],
        budgets: [],
      },
    }),
  });
}

function fixture() {
  let nextId = 0;
  let nextRevision = 0;
  const provider = createFixtureProvider({ id: "usage-provider" });
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
  const usage = createProviderUsageAuthority({
    models,
    binding: profiles.binding,
    profileSnapshot: () => profiles.management.snapshot(),
    probes: [probe(provider.id)],
    now: () => 2_000,
  });
  return { provider, profiles, models, usage };
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

describe("Provider Usage Profile ownership", () => {
  it("attributes observations to the exact active credentialId", async () => {
    const value = fixture();
    const credentialId = await add(value, "Primary", "secret-primary");

    expect(await value.usage.query()).toEqual({
      profiles: [{
        providerId: value.provider.id,
        credentialId,
        state: "unobserved",
      }],
    });

    const refreshed = await value.usage.refresh(value.provider.id);
    expect(refreshed.refresh).toEqual({
      providerId: value.provider.id,
      credentialId,
      outcome: "succeeded",
    });
    expect(refreshed.snapshot.profiles[0]).toMatchObject({
      providerId: value.provider.id,
      credentialId,
      state: "observed",
      observation: {
        observedAt: 2_000,
        windows: [{ kind: "weekly", usedPercent: 25 }],
      },
    });
  });

  it("never reuses Profile A usage after active selection changes to Profile B", async () => {
    const value = fixture();
    const first = await add(value, "Primary", "secret-primary");
    const second = await add(value, "Backup", "secret-backup");
    await value.usage.refresh(value.provider.id);

    const before = (await value.profiles.management.query([
      value.provider.id,
    ])).providers[0]!;
    await value.profiles.management.activate({
      providerId: value.provider.id,
      credentialId: second,
      expectedRevision: before.revision!,
    });

    expect(await value.usage.query()).toEqual({
      profiles: [{
        providerId: value.provider.id,
        credentialId: second,
        state: "unobserved",
      }],
    });
    expect(first).not.toBe(second);
  });

  it("publishes passive usage only while the exact selection is current", async () => {
    const value = fixture();
    const first = await add(value, "Primary", "secret-primary");
    const second = await add(value, "Backup", "secret-backup");
    const capture = await value.profiles.binding.capture(value.provider.id);

    const before = (await value.profiles.management.query([
      value.provider.id,
    ])).providers[0]!;
    await value.profiles.management.activate({
      providerId: value.provider.id,
      credentialId: second,
      expectedRevision: before.revision!,
    });

    await expect(
      value.usage.observePassive(
        value.provider.id,
        capture,
        "https://fixture.invalid",
        {
          windows: [{ kind: "weekly", usedPercent: 99 }],
          budgets: [],
        },
      ),
    ).resolves.toBe(false);
    const state = await value.usage.query();
    expect(state.profiles[0]?.credentialId).toBe(second);
    expect(state.profiles[0]?.state).toBe("unobserved");
    expect(first).not.toBe(second);
  });
});
