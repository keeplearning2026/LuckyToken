import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createModels } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  createProviderCredentialProfiles,
  NO_PROVIDER_RECORD_REVISION,
} from "../../src/credentials/profile-authority.js";
import {
  createFileProviderCredentialRecordStore,
  createInMemoryProviderCredentialRecordStore,
  type PersistedProviderCredentialRecordV1,
  type ProviderCredentialRecordLock,
} from "../../src/credentials/profile-record-store.js";
import { createBrowserOAuthProvider } from "../support/auth-login-fixture.js";
import { createFixtureProvider } from "../support/credential-fixture.js";

describe("CredentialProfileManagement", () => {
  it("atomically persists a complete Profile order and normalizes priorities", async () => {
    const revisions = ["revision-initial", "revision-reordered"];
    const provider = createFixtureProvider();
    const store = createInMemoryProviderCredentialRecordStore({
      createRevision: () => revisions.shift() ?? "unexpected-revision",
    });
    await store.modifyManagement(
      provider.id,
      NO_PROVIDER_RECORD_REVISION,
      () => ({
        kind: "commit" as const,
        record: {
          schemaVersion: 1 as const,
          providerId: provider.id,
          revision: NO_PROVIDER_RECORD_REVISION,
          selectionGeneration: "selection-a",
          activeCredentialId: "credential-a",
          switchPolicy: { apiKeyOn429: true, oauthOn429: false },
          profiles: [
            {
              credentialId: "credential-a",
              credentialGeneration: "generation-a",
              authType: "api_key" as const,
              authMethodLabel: "Fixture credentials",
              displayName: "Profile A",
              enabled: true,
              priority: 12,
              createdAt: 1,
              updatedAt: 1,
              credential: { type: "api_key" as const, key: "secret-a" },
            },
            {
              credentialId: "credential-b",
              credentialGeneration: "generation-b",
              authType: "api_key" as const,
              authMethodLabel: "Fixture credentials",
              displayName: "Profile B",
              enabled: true,
              priority: -4,
              createdAt: 2,
              updatedAt: 2,
              credential: { type: "api_key" as const, key: "secret-b" },
            },
          ],
        },
        value: undefined,
      }),
    );
    const profiles = createProviderCredentialProfiles({
      recordStore: store,
      providers: () => [provider],
      createId: () => "unused-id",
      now: () => 1_786_400_000_000,
    });

    const reordered = await profiles.management.reorderProfiles({
      providerId: provider.id,
      credentialIds: ["credential-b", "credential-a"],
      expectedRevision: "revision-initial",
    });

    expect(reordered).toMatchObject({
      outcome: "ok",
      provider: {
        revision: "revision-reordered",
        activeCredentialId: "credential-a",
        switchPolicy: { apiKeyOn429: true, oauthOn429: false },
        profiles: [
          { credentialId: "credential-b", priority: 0 },
          { credentialId: "credential-a", priority: 1 },
        ],
      },
    });
    expect((await store.read(provider.id))?.profiles.map((profile) => ({
      credentialId: profile.credentialId,
      priority: profile.priority,
    }))).toEqual([
      { credentialId: "credential-b", priority: 0 },
      { credentialId: "credential-a", priority: 1 },
    ]);
  });

  it("fails closed before publication on a compromised file lock and surfaces release failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-profile-lock-"));
    const providerId = "lock-provider";
    const record: PersistedProviderCredentialRecordV1 = {
      schemaVersion: 1,
      providerId,
      revision: "mutation-supplies-revision",
      selectionGeneration: "selection-a",
      activeCredentialId: "credential-a",
      switchPolicy: { apiKeyOn429: false, oauthOn429: false },
      profiles: [{
        credentialId: "credential-a",
        credentialGeneration: "credential-generation-a",
        authType: "api_key",
        authMethodLabel: "Fixture credentials",
        displayName: "Profile 1",
        enabled: true,
        priority: 0,
        createdAt: 1,
        updatedAt: 1,
        credential: { type: "api_key", key: "lock-test-secret" },
      }],
    };
    try {
      let assertions = 0;
      let released = false;
      const compromisedLock: ProviderCredentialRecordLock = {
        acquire: async () => ({
          assertOwned: () => {
            assertions += 1;
            // Acquire, operation entry, and pre-staging checks succeed. The
            // lease is compromised while the temporary file is staged, so
            // only the assertion immediately before rename can catch it.
            if (assertions >= 4) throw new Error("compromised");
          },
          release: async () => {
            released = true;
          },
        }),
      };
      const compromised = createFileProviderCredentialRecordStore({
        piDirectory: root,
        createRevision: () => "revision-a",
        lock: compromisedLock,
      });
      await expect(compromised.modifyManagement(
        providerId,
        NO_PROVIDER_RECORD_REVISION,
        () => ({ kind: "commit", record, value: undefined }),
      )).rejects.toThrow("compromised");
      expect(assertions).toBe(4);
      expect(released).toBe(true);
      expect(await compromised.read(providerId)).toBeUndefined();

      const releaseFailure: ProviderCredentialRecordLock = {
        acquire: async () => ({
          assertOwned: () => undefined,
          release: async () => {
            throw new Error("release failed");
          },
        }),
      };
      const degraded: unknown[] = [];
      const releaseStore = createFileProviderCredentialRecordStore({
        piDirectory: join(root, "release"),
        createRevision: () => "revision-b",
        lock: releaseFailure,
        onLockDegraded: (error) => degraded.push(error),
      });
      await expect(releaseStore.modifyManagement(
        providerId,
        NO_PROVIDER_RECORD_REVISION,
        () => ({ kind: "commit", record, value: undefined }),
      )).resolves.toMatchObject({ kind: "committed" });
      expect(degraded).toEqual([expect.objectContaining({ message: "release failed" })]);
      expect(await releaseStore.read(providerId)).toMatchObject({
        revision: "revision-b",
        activeCredentialId: "credential-a",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("adds two Provider-declared non-OAuth Profiles and keeps the first active", async () => {
    const ids = [
      "credential-a",
      "credential-generation-a",
      "selection-generation-a",
      "revision-a",
      "credential-b",
      "credential-generation-b",
      "revision-b",
    ];
    const provider = createFixtureProvider();
    const profiles = createProviderCredentialProfiles({
      recordStore: createInMemoryProviderCredentialRecordStore({
        createRevision: () => ids.shift() ?? "unexpected-revision",
      }),
      providers: () => [provider],
      createId: () => ids.shift() ?? "unexpected-id",
      now: () => 1_786_400_000_000,
    });
    const models = createModels({ credentials: profiles.credentialStore });
    models.setProvider(provider);

    const add = async (input: {
      readonly displayName: string;
      readonly secret: string;
      readonly expectedRevision: string;
    }) => {
      const binding = await profiles.binding.createLoginBinding({
        providerId: provider.id,
        authType: "api_key",
        displayName: input.displayName,
        useNow: false,
        expectedRevision: input.expectedRevision,
      });
      await profiles.binding.runBound(binding, () =>
        models.login(provider.id, "api_key", {
          prompt: async () => input.secret,
          notify: () => {},
        }),
      );
    };

    await add({
      displayName: "Production",
      secret: "literal-secret-alpha",
      expectedRevision: NO_PROVIDER_RECORD_REVISION,
    });
    let projection = await profiles.management.query();
    const firstRevision = projection.providers[0]?.revision;
    expect(firstRevision).toBe("revision-a");

    await add({
      displayName: "Backup",
      secret: "literal-secret-beta",
      expectedRevision: firstRevision ?? "missing-revision",
    });
    projection = await profiles.management.query();
    expect(profiles.management.snapshot()).toEqual(projection);

    expect(projection.providers).toEqual([
      {
        providerId: "fixture-provider",
        implementationAvailable: true,
        revision: "revision-b",
        selectionGeneration: "selection-generation-a",
        activeCredentialId: "credential-a",
        switchPolicy: { apiKeyOn429: false, oauthOn429: false },
        profiles: [
          {
            credentialId: "credential-a",
            authType: "api_key",
            authMethodLabel: "Fixture API key",
            displayName: "Production",
            identityHint: "•••• lpha",
            enabled: true,
            health: "not_yet_verified",
            priority: 0,
            createdAt: 1_786_400_000_000,
            updatedAt: 1_786_400_000_000,
          },
          {
            credentialId: "credential-b",
            authType: "api_key",
            authMethodLabel: "Fixture API key",
            displayName: "Backup",
            identityHint: "•••• beta",
            enabled: true,
            health: "not_yet_verified",
            priority: 1,
            createdAt: 1_786_400_000_000,
            updatedAt: 1_786_400_000_000,
          },
        ],
      },
    ]);
    expect(JSON.stringify(projection)).not.toContain("literal-secret");
  });

  it("enumerates and restores sanitized Profiles after the State Owner restarts", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "Token-profile-home-"));
    const ids = [
      "credential-a",
      "credential-generation-a",
      "selection-generation-a",
      "credential-b",
      "credential-generation-b",
    ];
    const revisions = ["revision-a", "revision-b"];
    const provider = createFixtureProvider();
    const createStore = () =>
      createFileProviderCredentialRecordStore({
        piDirectory: codexHome,
        createRevision: () => revisions.shift() ?? "unexpected-revision",
      });

    try {
      const first = createProviderCredentialProfiles({
        recordStore: createStore(),
        providers: () => [provider],
        createId: () => ids.shift() ?? "unexpected-id",
        now: () => 1_786_400_000_000,
      });
      const models = createModels({ credentials: first.credentialStore });
      models.setProvider(provider);

      for (const [displayName, secret, expectedRevision] of [
        ["Production", "literal-secret-alpha", NO_PROVIDER_RECORD_REVISION],
        ["Backup", "literal-secret-beta", "revision-a"],
      ] as const) {
        const binding = await first.binding.createLoginBinding({
          providerId: provider.id,
          authType: "api_key",
          displayName,
          useNow: false,
          expectedRevision,
        });
        await first.binding.runBound(binding, () =>
          models.login(provider.id, "api_key", {
            prompt: async () => secret,
            notify: () => {},
          }),
        );
      }
      const beforeRestart = await first.management.query();

      const restartedStore = createStore();
      const restarted = createProviderCredentialProfiles({
        recordStore: restartedStore,
        providers: () => [provider],
        createId: () => "unused-id",
        now: () => 1_786_400_100_000,
      });

      expect(await restartedStore.listProviderIds()).toEqual([provider.id]);
      expect(await restarted.management.query()).toEqual(beforeRestart);
      expect(JSON.stringify(await restarted.management.query())).not.toContain("literal-secret");
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it("preserves keyless api_key and OAuth Provider payloads without inventing identity", async () => {
    const ids = [
      "credential-cloud",
      "credential-generation-cloud",
      "selection-generation-cloud",
      "revision-cloud",
      "credential-oauth",
      "credential-generation-oauth",
      "revision-oauth",
    ];
    const base = createBrowserOAuthProvider({ id: "dual-auth-provider" });
    const apiKeyCredential = {
      type: "api_key" as const,
      env: { AWS_PROFILE: "team-production" },
      credentialChain: { role: "deploy" },
    };
    const oauthCredential = {
      type: "oauth" as const,
      access: "opaque-access",
      refresh: "opaque-refresh",
      expires: 1_900_000_000_000,
      tenant: { id: "tenant-a" },
    };
    const provider = {
      ...base,
      auth: {
        apiKey: {
          name: "AWS credentials or bearer token",
          login: async () => apiKeyCredential,
          resolve: async () => undefined,
        },
        oauth: {
          ...base.auth.oauth!,
          name: "Dual Auth Account",
          login: async () => oauthCredential,
        },
      },
    };
    const store = createInMemoryProviderCredentialRecordStore({
      createRevision: () => ids.shift() ?? "unexpected-revision",
    });
    const profiles = createProviderCredentialProfiles({
      recordStore: store,
      providers: () => [provider],
      createId: () => ids.shift() ?? "unexpected-id",
      now: () => 1_786_400_000_000,
    });
    const models = createModels({ credentials: profiles.credentialStore });
    models.setProvider(provider);

    for (const [authType, displayName, expectedRevision] of [
      ["api_key", "Cloud role", NO_PROVIDER_RECORD_REVISION],
      ["oauth", "Personal account", "revision-cloud"],
    ] as const) {
      const binding = await profiles.binding.createLoginBinding({
        providerId: provider.id,
        authType,
        displayName,
        useNow: false,
        expectedRevision,
      });
      await profiles.binding.runBound(binding, () =>
        models.login(provider.id, authType, { prompt: async () => "unused", notify: () => {} }),
      );
    }

    const record = await store.read(provider.id);
    expect(record?.profiles.map((profile) => profile.credential)).toEqual([
      apiKeyCredential,
      oauthCredential,
    ]);
    const projected = (await profiles.management.query()).providers[0]?.profiles;
    expect(projected).toEqual([
      expect.objectContaining({
        authType: "api_key",
        authMethodLabel: "AWS credentials or bearer token",
      }),
      expect.objectContaining({
        authType: "oauth",
        authMethodLabel: "Dual Auth Account",
      }),
    ]);
    expect(projected?.every((profile) => !("identityHint" in profile))).toBe(true);
  });

  it("isolates a corrupt Provider record while another Provider remains mutable", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "Token-profile-isolation-"));
    const providerA = createFixtureProvider({ id: "provider-a" });
    const providerB = createFixtureProvider({ id: "provider-b" });
    const ids = [
      "credential-b1",
      "credential-generation-b1",
      "selection-generation-b1",
      "credential-b2",
      "credential-generation-b2",
    ];
    const revisions = ["revision-b1", "revision-b2"];

    try {
      const store = createFileProviderCredentialRecordStore({
        piDirectory: codexHome,
        createRevision: () => revisions.shift() ?? "unexpected-revision",
      });
      const profiles = createProviderCredentialProfiles({
        recordStore: store,
        providers: () => [providerA, providerB],
        createId: () => ids.shift() ?? "unexpected-id",
        now: () => 1_786_400_000_000,
      });
      const models = createModels({ credentials: profiles.credentialStore });
      models.setProvider(providerA);
      models.setProvider(providerB);

      const addToB = async (displayName: string, expectedRevision: string) => {
        const binding = await profiles.binding.createLoginBinding({
          providerId: providerB.id,
          authType: "api_key",
          displayName,
          useNow: false,
          expectedRevision,
        });
        await profiles.binding.runBound(binding, () =>
          models.login(providerB.id, "api_key", {
            prompt: async () => `secret-${displayName}`,
            notify: () => {},
          }),
        );
      };

      await addToB("B primary", NO_PROVIDER_RECORD_REVISION);
      await writeFile(
        join(codexHome, "credential-profiles", "provider-a.json"),
        "{ definitely not JSON",
        "utf8",
      );

      expect(await profiles.management.query()).toEqual({
        providers: [
          {
            providerId: "provider-a",
            implementationAvailable: true,
            recordError: {
              code: "invalid_record",
              message: "Stored Provider credential record is invalid",
            },
            profiles: [],
          },
          expect.objectContaining({
            providerId: "provider-b",
            revision: "revision-b1",
            profiles: [expect.objectContaining({ displayName: "B primary" })],
          }),
        ],
      });

      await addToB("B backup", "revision-b1");
      expect((await store.read(providerB.id))?.profiles).toHaveLength(2);
      await expect(store.read(providerA.id)).rejects.toMatchObject({
        code: "PROVIDER_CREDENTIAL_RECORD_SYNTAX",
      });
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it("renames and notes one Profile without modifying its sibling or selection", async () => {
    const ids = [
      "credential-a",
      "credential-generation-a",
      "selection-generation-a",
      "revision-a",
      "credential-b",
      "credential-generation-b",
      "revision-b",
      "revision-metadata",
      "revision-note-cleared",
    ];
    const provider = createFixtureProvider();
    const store = createInMemoryProviderCredentialRecordStore({
      createRevision: () => ids.shift() ?? "unexpected-revision",
    });
    const profiles = createProviderCredentialProfiles({
      recordStore: store,
      providers: () => [provider],
      createId: () => ids.shift() ?? "unexpected-id",
      now: () => 1_786_400_000_000,
    });
    const models = createModels({ credentials: profiles.credentialStore });
    models.setProvider(provider);
    for (const [displayName, secret, expectedRevision] of [
      ["Production", "literal-secret-alpha", NO_PROVIDER_RECORD_REVISION],
      ["Backup", "literal-secret-beta", "revision-a"],
    ] as const) {
      const binding = await profiles.binding.createLoginBinding({
        providerId: provider.id,
        authType: "api_key",
        displayName,
        useNow: false,
        expectedRevision,
      });
      await profiles.binding.runBound(binding, () =>
        models.login(provider.id, "api_key", {
          prompt: async () => secret,
          notify: () => {},
        }),
      );
    }
    const before = await store.read(provider.id);

    const result = await profiles.management.updateMetadata({
      providerId: provider.id,
      credentialId: "credential-b",
      displayName: "Disaster recovery",
      note: "Reserved for release incidents",
      expectedRevision: "revision-b",
    });

    expect(result).toMatchObject({
      outcome: "ok",
      provider: {
        revision: "revision-metadata",
        selectionGeneration: "selection-generation-a",
        activeCredentialId: "credential-a",
        profiles: [
          { credentialId: "credential-a", displayName: "Production" },
          {
            credentialId: "credential-b",
            displayName: "Disaster recovery",
            note: "Reserved for release incidents",
          },
        ],
      },
    });
    const after = await store.read(provider.id);
    expect(after?.profiles.map((profile) => profile.credential)).toEqual(
      before?.profiles.map((profile) => profile.credential),
    );

    const cleared = await profiles.management.updateMetadata({
      providerId: provider.id,
      credentialId: "credential-b",
      displayName: "Disaster recovery",
      expectedRevision: "revision-metadata",
    });
    expect(cleared).toMatchObject({
      outcome: "ok",
      provider: { revision: "revision-note-cleared" },
    });
    expect(
      cleared.provider?.profiles.find(
        (profile) => profile.credentialId === "credential-b",
      ),
    ).not.toHaveProperty("note");
  });

  it("rejects a complete known credential secret in Profile metadata", async () => {
    const ids = [
      "credential-a",
      "credential-generation-a",
      "selection-generation-a",
      "revision-a",
    ];
    const provider = createFixtureProvider();
    const store = createInMemoryProviderCredentialRecordStore({
      createRevision: () => ids.shift() ?? "unexpected-revision",
    });
    const profiles = createProviderCredentialProfiles({
      recordStore: store,
      providers: () => [provider],
      createId: () => ids.shift() ?? "unexpected-id",
      now: () => 1_786_400_000_000,
    });
    const models = createModels({ credentials: profiles.credentialStore });
    models.setProvider(provider);
    const binding = await profiles.binding.createLoginBinding({
      providerId: provider.id,
      authType: "api_key",
      displayName: "Production",
      useNow: false,
      expectedRevision: NO_PROVIDER_RECORD_REVISION,
    });
    await profiles.binding.runBound(binding, () =>
      models.login(provider.id, "api_key", {
        prompt: async () => "complete-secret-canary",
        notify: () => {},
      }),
    );

    const result = await profiles.management.updateMetadata({
      providerId: provider.id,
      credentialId: "credential-a",
      displayName: "Production",
      note: "Do not copy complete-secret-canary into metadata",
      expectedRevision: "revision-a",
    });

    expect(result).toEqual({
      outcome: "invalid",
      error: "Profile metadata must not contain stored credential secrets",
    });
    expect((await store.read(provider.id))?.revision).toBe("revision-a");
  });

  it("changes priority and active selection with separate selection generations", async () => {
    const generatedIds = [
      "credential-a",
      "credential-generation-a",
      "selection-generation-a",
      "credential-b",
      "credential-generation-b",
      "selection-generation-b",
      "selection-generation-cleared",
    ];
    const revisions = [
      "revision-a",
      "revision-b",
      "revision-priority",
      "revision-activate",
      "revision-disable",
      "revision-enable",
    ];
    const provider = createFixtureProvider();
    const store = createInMemoryProviderCredentialRecordStore({
      createRevision: () => revisions.shift() ?? "unexpected-revision",
    });
    const profiles = createProviderCredentialProfiles({
      recordStore: store,
      providers: () => [provider],
      createId: () => generatedIds.shift() ?? "unexpected-id",
      now: () => 1_786_400_000_000,
    });
    const models = createModels({ credentials: profiles.credentialStore });
    models.setProvider(provider);
    for (const [displayName, expectedRevision] of [
      ["A", NO_PROVIDER_RECORD_REVISION],
      ["B", "revision-a"],
    ] as const) {
      const binding = await profiles.binding.createLoginBinding({
        providerId: provider.id,
        authType: "api_key",
        displayName,
        useNow: false,
        expectedRevision,
      });
      await profiles.binding.runBound(binding, () =>
        models.login(provider.id, "api_key", {
          prompt: async () => `secret-${displayName}`,
          notify: () => {},
        }),
      );
    }

    expect(await profiles.management.setPriority({
      providerId: provider.id,
      credentialId: "credential-b",
      priority: -1,
      expectedRevision: "revision-b",
    })).toMatchObject({
      outcome: "ok",
      provider: {
        revision: "revision-priority",
        selectionGeneration: "selection-generation-a",
        activeCredentialId: "credential-a",
      },
    });
    expect(await profiles.management.activate({
      providerId: provider.id,
      credentialId: "credential-b",
      expectedRevision: "revision-priority",
    })).toMatchObject({
      outcome: "ok",
      provider: {
        revision: "revision-activate",
        selectionGeneration: "selection-generation-b",
        activeCredentialId: "credential-b",
      },
    });
    expect(await profiles.management.setEnabled({
      providerId: provider.id,
      credentialId: "credential-b",
      enabled: false,
      expectedRevision: "revision-activate",
    })).toMatchObject({
      outcome: "ok",
      provider: {
        revision: "revision-disable",
        selectionGeneration: "selection-generation-cleared",
        profiles: [
          expect.objectContaining({ credentialId: "credential-a", enabled: true }),
          expect.objectContaining({
            credentialId: "credential-b",
            enabled: false,
            health: "disabled",
          }),
        ],
      },
    });
    expect(await profiles.management.setEnabled({
      providerId: provider.id,
      credentialId: "credential-b",
      enabled: true,
      expectedRevision: "revision-disable",
    })).toMatchObject({
      outcome: "ok",
      provider: {
        revision: "revision-enable",
        selectionGeneration: "selection-generation-cleared",
        profiles: [
          expect.objectContaining({ credentialId: "credential-a", enabled: true }),
          expect.objectContaining({ credentialId: "credential-b", enabled: true }),
        ],
      },
    });
    expect((await store.read(provider.id))?.activeCredentialId).toBeUndefined();
  });

  it("removes inactive and active Profiles without selecting a sibling", async () => {
    const generatedIds = [
      "credential-a",
      "credential-generation-a",
      "selection-generation-a",
      "credential-b",
      "credential-generation-b",
      "credential-c",
      "credential-generation-c",
      "selection-generation-cleared",
    ];
    const revisions = [
      "revision-a",
      "revision-b",
      "revision-c",
      "revision-remove-b",
      "revision-remove-a",
    ];
    const provider = createFixtureProvider();
    const store = createInMemoryProviderCredentialRecordStore({
      createRevision: () => revisions.shift() ?? "unexpected-revision",
    });
    const profiles = createProviderCredentialProfiles({
      recordStore: store,
      providers: () => [provider],
      createId: () => generatedIds.shift() ?? "unexpected-id",
      now: () => 1_786_400_000_000,
    });
    const models = createModels({ credentials: profiles.credentialStore });
    models.setProvider(provider);
    for (const [displayName, expectedRevision] of [
      ["A", NO_PROVIDER_RECORD_REVISION],
      ["B", "revision-a"],
      ["C", "revision-b"],
    ] as const) {
      const binding = await profiles.binding.createLoginBinding({
        providerId: provider.id,
        authType: "api_key",
        displayName,
        useNow: false,
        expectedRevision,
      });
      await profiles.binding.runBound(binding, () =>
        models.login(provider.id, "api_key", {
          prompt: async () => `secret-${displayName}`,
          notify: () => {},
        }),
      );
    }

    expect(await profiles.management.remove({
      providerId: provider.id,
      credentialId: "credential-b",
      expectedRevision: "revision-c",
    })).toMatchObject({
      outcome: "ok",
      provider: {
        revision: "revision-remove-b",
        activeCredentialId: "credential-a",
        selectionGeneration: "selection-generation-a",
        profiles: [
          expect.objectContaining({ credentialId: "credential-a" }),
          expect.objectContaining({ credentialId: "credential-c" }),
        ],
      },
    });
    const removedActive = await profiles.management.remove({
      providerId: provider.id,
      credentialId: "credential-a",
      expectedRevision: "revision-remove-b",
    });
    expect(removedActive).toMatchObject({
      outcome: "ok",
      provider: {
        revision: "revision-remove-a",
        selectionGeneration: "selection-generation-cleared",
        profiles: [expect.objectContaining({ credentialId: "credential-c" })],
      },
    });
    expect(removedActive.provider).not.toHaveProperty("activeCredentialId");
    expect((await store.read(provider.id))?.profiles.map((profile) => profile.credentialId)).toEqual([
      "credential-c",
    ]);
  });

  it("keeps an orphaned Provider Profile discoverable and locally removable", async () => {
    const generatedIds = [
      "credential-a",
      "credential-generation-a",
      "selection-generation-a",
      "selection-generation-cleared",
    ];
    const revisions = ["revision-a", "revision-remove"];
    const provider = createFixtureProvider({ id: "removed-provider" });
    const store = createInMemoryProviderCredentialRecordStore({
      createRevision: () => revisions.shift() ?? "unexpected-revision",
    });
    const installed = createProviderCredentialProfiles({
      recordStore: store,
      providers: () => [provider],
      createId: () => generatedIds.shift() ?? "unexpected-id",
      now: () => 1_786_400_000_000,
    });
    const models = createModels({ credentials: installed.credentialStore });
    models.setProvider(provider);
    const binding = await installed.binding.createLoginBinding({
      providerId: provider.id,
      authType: "api_key",
      displayName: "Retained profile",
      useNow: false,
      expectedRevision: NO_PROVIDER_RECORD_REVISION,
    });
    await installed.binding.runBound(binding, () =>
      models.login(provider.id, "api_key", {
        prompt: async () => "orphan-secret-canary",
        notify: () => {},
      }),
    );

    const orphaned = createProviderCredentialProfiles({
      recordStore: store,
      providers: () => [],
      createId: () => generatedIds.shift() ?? "unexpected-id",
      now: () => 1_786_400_100_000,
    });
    expect(await orphaned.management.query()).toMatchObject({
      providers: [{
        providerId: "removed-provider",
        implementationAvailable: false,
        profiles: [{
          credentialId: "credential-a",
          authMethodLabel: "Fixture API key",
          displayName: "Retained profile",
        }],
      }],
    });
    await expect(orphaned.binding.createLoginBinding({
      providerId: provider.id,
      authType: "api_key",
      displayName: "New profile",
      useNow: false,
      expectedRevision: "revision-a",
    })).rejects.toMatchObject({ outcome: "unavailable" });

    expect(await orphaned.management.remove({
      providerId: provider.id,
      credentialId: "credential-a",
      expectedRevision: "revision-a",
    })).toMatchObject({
      outcome: "ok",
      provider: { implementationAvailable: false, profiles: [] },
    });
    expect((await store.read(provider.id))?.profiles).toEqual([]);
  });

  it("lets only one client publish from the same Provider revision", async () => {
    const generatedIds = [
      "credential-a",
      "credential-generation-a",
      "credential-b",
      "credential-generation-b",
      "selection-generation-winner",
    ];
    const provider = createFixtureProvider();
    const store = createInMemoryProviderCredentialRecordStore({
      createRevision: () => "revision-winner",
    });
    const profiles = createProviderCredentialProfiles({
      recordStore: store,
      providers: () => [provider],
      createId: () => generatedIds.shift() ?? "unexpected-id",
      now: () => 1_786_400_000_000,
    });
    const models = createModels({ credentials: profiles.credentialStore });
    models.setProvider(provider);
    const bindings = await Promise.all([
      profiles.binding.createLoginBinding({
        providerId: provider.id,
        authType: "api_key",
        displayName: "Client A",
        useNow: false,
        expectedRevision: NO_PROVIDER_RECORD_REVISION,
      }),
      profiles.binding.createLoginBinding({
        providerId: provider.id,
        authType: "api_key",
        displayName: "Client B",
        useNow: false,
        expectedRevision: NO_PROVIDER_RECORD_REVISION,
      }),
    ]);

    const results = await Promise.allSettled(
      bindings.map((binding) =>
        profiles.binding.runBound(binding, () =>
          models.login(provider.id, "api_key", {
            prompt: async () => `secret-${binding.displayName}`,
            notify: () => {},
          }),
        ),
      ),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({
          cause: expect.objectContaining({ outcome: "conflict" }),
        }),
      }),
    ]);
    expect((await store.read(provider.id))?.profiles).toHaveLength(1);
  });

  it("projects a zero-Profile Provider as an ambient-only external auth source", async () => {
    const provider = createFixtureProvider();
    const profiles = createProviderCredentialProfiles({
      recordStore: createInMemoryProviderCredentialRecordStore({
        createRevision: () => "unused-revision",
      }),
      providers: () => [provider],
      createId: () => "unused-id",
      now: () => 1_786_400_000_000,
    });

    expect(await profiles.management.query()).toEqual({
      providers: [{
        providerId: provider.id,
        implementationAvailable: true,
        revision: NO_PROVIDER_RECORD_REVISION,
        ambient: {
          kind: "external",
          status: "unknown",
          message: "External auth is resolved only when the Provider is used",
        },
        profiles: [],
      }],
    });
  });

  it("updates Provider 429 switch settings without changing selection", async () => {
    const generatedIds = [
      "credential-a",
      "credential-generation-a",
      "selection-generation-a",
    ];
    const revisions = ["revision-a", "revision-settings"];
    const provider = createFixtureProvider();
    const profiles = createProviderCredentialProfiles({
      recordStore: createInMemoryProviderCredentialRecordStore({
        createRevision: () => revisions.shift() ?? "unexpected-revision",
      }),
      providers: () => [provider],
      createId: () => generatedIds.shift() ?? "unexpected-id",
      now: () => 1_786_400_000_000,
    });
    const models = createModels({ credentials: profiles.credentialStore });
    models.setProvider(provider);
    const login = await profiles.binding.createLoginBinding({
      providerId: provider.id,
      authType: "api_key",
      displayName: "Production",
      useNow: false,
      expectedRevision: NO_PROVIDER_RECORD_REVISION,
    });
    await profiles.binding.runBound(login, () =>
      models.login(provider.id, "api_key", {
        prompt: async () => "literal-secret",
        notify: () => {},
      }),
    );

    expect(await profiles.management.setSwitchPolicy({
      providerId: provider.id,
      expectedRevision: "revision-a",
      apiKeyOn429: true,
      oauthOn429: false,
    })).toMatchObject({
      outcome: "ok",
      provider: {
        revision: "revision-settings",
        selectionGeneration: "selection-generation-a",
        activeCredentialId: "credential-a",
        switchPolicy: { apiKeyOn429: true, oauthOn429: false },
      },
    });
  });

  it("does not expose a complete short secret and rejects sibling metadata that contains it", async () => {
    const generatedIds = [
      "credential-a",
      "credential-generation-a",
      "selection-generation-a",
      "credential-b",
      "credential-generation-b",
    ];
    const revisions = ["revision-a"];
    const provider = createFixtureProvider();
    const store = createInMemoryProviderCredentialRecordStore({
      createRevision: () => revisions.shift() ?? "unexpected-revision",
    });
    const profiles = createProviderCredentialProfiles({
      recordStore: store,
      providers: () => [provider],
      createId: () => generatedIds.shift() ?? "unexpected-id",
      now: () => 1_786_400_000_000,
    });
    const models = createModels({ credentials: profiles.credentialStore });
    models.setProvider(provider);

    const first = await profiles.binding.createLoginBinding({
      providerId: provider.id,
      authType: "api_key",
      displayName: "Primary",
      useNow: false,
      expectedRevision: NO_PROVIDER_RECORD_REVISION,
    });
    await profiles.binding.runBound(first, () =>
      models.login(provider.id, "api_key", {
        prompt: async () => "ABCD",
        notify: () => {},
      }),
    );
    const projection = await profiles.management.query();
    expect(projection.providers[0]?.profiles[0]).not.toHaveProperty("identityHint");
    expect(JSON.stringify(projection)).not.toContain("ABCD");

    const second = await profiles.binding.createLoginBinding({
      providerId: provider.id,
      authType: "api_key",
      displayName: "ABCD",
      useNow: false,
      expectedRevision: "revision-a",
    });
    await expect(profiles.binding.runBound(second, () =>
      models.login(provider.id, "api_key", {
        prompt: async () => "different-long-secret",
        notify: () => {},
      }),
    )).rejects.toMatchObject({
      cause: expect.objectContaining({ outcome: "invalid" }),
    });
    expect((await store.read(provider.id))?.profiles).toHaveLength(1);
  });

  it("activates the first managed Profile added to an existing zero-Profile record", async () => {
    const generatedIds = [
      "credential-a",
      "credential-generation-a",
      "selection-generation-a",
      "selection-generation-cleared",
      "credential-b",
      "credential-generation-b",
      "selection-generation-b",
    ];
    const revisions = ["revision-a", "revision-remove", "revision-b"];
    const provider = createFixtureProvider();
    const store = createInMemoryProviderCredentialRecordStore({
      createRevision: () => revisions.shift() ?? "unexpected-revision",
    });
    const profiles = createProviderCredentialProfiles({
      recordStore: store,
      providers: () => [provider],
      createId: () => generatedIds.shift() ?? "unexpected-id",
      now: () => 1_786_400_000_000,
    });
    const models = createModels({ credentials: profiles.credentialStore });
    models.setProvider(provider);
    const login = async (displayName: string, expectedRevision: string) => {
      const binding = await profiles.binding.createLoginBinding({
        providerId: provider.id,
        authType: "api_key",
        displayName,
        useNow: false,
        expectedRevision,
      });
      await profiles.binding.runBound(binding, () =>
        models.login(provider.id, "api_key", {
          prompt: async () => `long-secret-${displayName}`,
          notify: () => {},
        }),
      );
    };

    await login("A", NO_PROVIDER_RECORD_REVISION);
    await profiles.management.remove({
      providerId: provider.id,
      credentialId: "credential-a",
      expectedRevision: "revision-a",
    });
    await login("B", "revision-remove");

    expect(await store.read(provider.id)).toMatchObject({
      revision: "revision-b",
      activeCredentialId: "credential-b",
      selectionGeneration: "selection-generation-b",
    });
  });

  it("projects successful Request Ledger evidence as ready health", async () => {
    const generatedIds = [
      "credential-a",
      "credential-generation-a",
      "selection-generation-a",
    ];
    const provider = createFixtureProvider();
    const profiles = createProviderCredentialProfiles({
      recordStore: createInMemoryProviderCredentialRecordStore({
        createRevision: () => "revision-a",
      }),
      providers: () => [provider],
      createId: () => generatedIds.shift() ?? "unexpected-id",
      now: () => 1_786_400_000_000,
      credentialUsage: (credentialIds) => credentialIds.map((credentialId) => ({
        credentialId,
        lastUsedAt: 100,
        lastSucceededAt: 101,
      })),
    });
    const models = createModels({ credentials: profiles.credentialStore });
    models.setProvider(provider);
    const binding = await profiles.binding.createLoginBinding({
      providerId: provider.id,
      authType: "api_key",
      displayName: "Ready",
      useNow: false,
      expectedRevision: NO_PROVIDER_RECORD_REVISION,
    });
    await profiles.binding.runBound(binding, () =>
      models.login(provider.id, "api_key", {
        prompt: async () => "long-ready-secret",
        notify: () => {},
      }),
    );

    expect((await profiles.management.query()).providers[0]?.profiles[0]).toMatchObject({
      health: "ready",
      lastUsedAt: 100,
      lastSucceededAt: 101,
    });
  });
});
