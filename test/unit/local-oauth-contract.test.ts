import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalOAuthRegistration } from "@token/provider-contract/local-oauth";
import { createModels } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { createProviderCredentialProfiles } from "../../src/credentials/profile-authority.js";
import { createInMemoryProviderCredentialRecordStore } from "../../src/credentials/profile-record-store.js";
import { createFixtureProvider } from "../support/credential-fixture.js";
import { createSelectOAuthProvider } from "../support/auth-login-fixture.js";

describe("common local OAuth Profile operations", () => {
  it("keeps managed API key and OAuth login/read/modify independent of local registration", async () => {
    const providers = [createFixtureProvider(), createSelectOAuthProvider()];
    const localRegistrations = vi.fn(() => {
      throw new Error("Local registration must not be queried by managed operations");
    });
    const profiles = createProviderCredentialProfiles({
      recordStore: createInMemoryProviderCredentialRecordStore({ createRevision: randomUUID }),
      providers: () => providers, createId: randomUUID, now: Date.now,
      localOAuthRegistrations: localRegistrations,
    });
    const models = createModels({ credentials: profiles.credentialStore });
    for (const provider of providers) models.setProvider(provider);
    for (const [index, provider] of providers.entries()) {
      const kind = index === 0 ? "api_key" : "oauth";
      const acquisition = await profiles.binding.createAcquisitionBinding({
        providerId: provider.id, acquisitionKind: kind, displayName: "Managed",
      });
      await profiles.binding.runBound(acquisition, () => models.login(provider.id, kind, {
        prompt: async () => kind === "api_key" ? "managed-key" : "browser",
        notify: () => undefined,
      }));
      const capture = await profiles.binding.capture(provider.id);
      const credential = await profiles.binding.runBound(capture, () => profiles.credentialStore.read(provider.id));
      expect(credential?.type).toBe(kind);
      const mutation = vi.fn(async () => credential);
      expect(await profiles.binding.runBound(capture, () => profiles.credentialStore.modify(provider.id, mutation))).toEqual(credential);
      expect(mutation).toHaveBeenCalledTimes(1);
    }
    expect(localRegistrations).not.toHaveBeenCalled();
  });

  it("selects each Provider parser and rereads on modify without executing a Pi mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-local-contract-"));
    try {
      const providers = [createFixtureProvider({ id: "local-a" }), createFixtureProvider({ id: "local-b" })];
      const registrations: LocalOAuthRegistration[] = providers.map((provider) => ({
        providerId: provider.id,
        label: () => provider.id,
        icon: "terminal",
        acquire: async () => ({ owner: "external", path: join(root, `${provider.id}.json`) }),
        read: vi.fn((raw: string) => raw.startsWith(`${provider.id}:`)
          ? { type: "oauth" as const, access: raw, refresh: `${provider.id}-refresh`, expires: 1_000 }
          : undefined),
      }));
      const profiles = createProviderCredentialProfiles({
        recordStore: createInMemoryProviderCredentialRecordStore({ createRevision: randomUUID }),
        providers: () => providers, createId: randomUUID, now: Date.now,
        localOAuthRegistrations: () => registrations,
      });
      for (const provider of providers) {
        await writeFile(join(root, `${provider.id}.json`), `${provider.id}:first`);
        expect((await profiles.management.acquireLocal({
          providerId: provider.id, displayName: "Local",
        })).outcome).toBe("ok");
      }
      const mutation = vi.fn(async () => undefined);
      for (const provider of providers) {
        const path = join(root, `${provider.id}.json`);
        const capture = await profiles.binding.capture(provider.id);
        expect(await profiles.binding.runBound(capture, () => profiles.credentialStore.read(provider.id)))
          .toMatchObject({ type: "oauth", access: `${provider.id}:first` });
        await writeFile(path, `${provider.id}:second`);
        expect(await profiles.binding.runBound(capture, () => profiles.credentialStore.modify(provider.id, mutation)))
          .toMatchObject({ type: "oauth", access: `${provider.id}:second` });
        expect(await readFile(path, "utf8")).toBe(`${provider.id}:second`);
      }
      expect(mutation).not.toHaveBeenCalled();
      for (const registration of registrations) {
        expect(vi.mocked(registration.read).mock.calls.every(([raw]) => raw.startsWith(`${registration.providerId}:`))).toBe(true);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not commit when cancellation occurs while waiting to publish", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-local-cancel-"));
    try {
      const path = join(root, "owner-auth.json");
      await writeFile(path, "owner credential");
      const provider = createFixtureProvider({ id: "local-cancel" });
      const controller = new AbortController();
      const store = createInMemoryProviderCredentialRecordStore({ createRevision: randomUUID });
      const registration: LocalOAuthRegistration = {
        providerId: provider.id, label: () => "Local", icon: "terminal",
        acquire: async () => ({ owner: "external", path }),
        read: () => ({ type: "oauth", access: "access", refresh: "refresh", expires: 1_000 }),
      };
      const profiles = createProviderCredentialProfiles({
        recordStore: {
          ...store,
          publishCredential(providerId, publication, mutation) {
            // Deterministically model cancellation after parsing, before the
            // storage lock allows the publication mutation to run.
            controller.abort();
            return store.publishCredential(providerId, publication, mutation);
          },
        },
        providers: () => [provider], createId: randomUUID, now: Date.now,
        localOAuthRegistrations: () => [registration],
      });
      await expect(profiles.management.acquireLocal({
        providerId: provider.id, displayName: "Local", signal: controller.signal,
      })).rejects.toMatchObject({ name: "AbortError" });
      expect(await store.read(provider.id)).toBeUndefined();
      expect(await readFile(path, "utf8")).toBe("owner credential");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
