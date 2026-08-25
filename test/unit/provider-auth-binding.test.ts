import { mkdtemp, rm } from "node:fs/promises";
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
} from "../../src/credentials/profile-record-store.js";
import {
  createBrowserOAuthProvider,
  createFixtureAuthContext,
} from "../support/auth-login-fixture.js";
import { createFixtureProvider } from "../support/credential-fixture.js";
import { createProviderNativeResponses } from "../../src/provider-native-responses/index.js";
import { parseProviderNativeResponsesConfiguration } from "../../src/provider-native-responses/configuration.js";
import {
  isManagedProviderAuthBindingCapture,
  type ManagedProviderAuthBindingCapture,
  type ProviderAuthBindingCapture,
} from "../../src/credentials/profile-contract.js";

function requireManaged(
  capture: ProviderAuthBindingCapture,
): ManagedProviderAuthBindingCapture {
  expect(isManagedProviderAuthBindingCapture(capture)).toBe(true);
  if (!isManagedProviderAuthBindingCapture(capture)) {
    throw new Error("Expected managed Provider Profile capture");
  }
  return capture;
}

describe("ProviderAuthBindingAuthority", () => {
  it("switches Responses Native only after a final 429 and retries with the next exact Profile", async () => {
    let nextId = 0;
    let nextRevision = 0;
    const provider = createFixtureProvider({ id: "openai" });
    const profiles = createProviderCredentialProfiles({
      recordStore: createInMemoryProviderCredentialRecordStore({
        createRevision: () => `revision-${++nextRevision}`,
      }),
      providers: () => [provider],
      createId: () => `profile-id-${++nextId}`,
      now: () => 1_786_400_000_000,
    });
    const models = createModels({ credentials: profiles.credentialStore });
    models.setProvider(provider);
    const add = async (displayName: string, secret: string) => {
      const state = await profiles.management.query([provider.id]);
      const binding = await profiles.binding.createLoginBinding({
        providerId: provider.id,
        authType: "api_key",
        displayName,
        useNow: false,
        expectedRevision: state.providers[0]!.revision!,
      });
      await profiles.binding.runBound(binding, () =>
        models.login(provider.id, "api_key", {
          prompt: async () => secret,
          notify: () => {},
        }),
      );
    };
    await add("Primary", "profile-secret-primary");
    await add("Backup", "profile-secret-backup");
    const beforePolicy = (await profiles.management.query([provider.id])).providers[0]!;
    await profiles.management.setSwitchPolicy({
      providerId: provider.id,
      expectedRevision: beforePolicy.revision!,
      apiKeyOn429: true,
      oauthOn429: false,
    });

    const authorizations: string[] = [];
    const captures: unknown[] = [];
    const attempts: unknown[] = [];
    const lane = createProviderNativeResponses({
      models,
      bindings: profiles.binding,
      configuration: parseProviderNativeResponsesConfiguration({
        transport: { maxRetries: 0 },
      }),
      fetch: async (input, init) => {
        authorizations.push(new Request(input, init).headers.get("authorization") ?? "");
        return authorizations.length === 1
          ? new Response("rate limited", { status: 429 })
          : new Response('{"status":"completed"}', { status: 200 });
      },
    });
    const response = await lane.execute({
      operation: "responses",
      model: {
        id: "gpt-test",
        name: "GPT Test",
        api: "openai-responses",
        provider: provider.id,
        baseUrl: "https://fixture.invalid/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000,
        maxTokens: 100,
      },
      rawBody: '{"model":"gpt-test","input":"hello"}',
      sessionId: "00000000-0000-4000-8000-000000000001",
      signal: new AbortController().signal,
      credentialActivity: {
        credentialCaptured: (capture) => captures.push(capture),
        credentialAttempt: (attempt) => attempts.push(attempt),
      },
    });

    expect(response.status).toBe(200);
    expect(authorizations).toEqual([
      "Bearer profile-secret-primary",
      "Bearer profile-secret-backup",
    ]);
    expect(captures).toEqual([
      expect.objectContaining({
        displayName: "Primary",
        authMethodLabel: provider.auth.apiKey?.name,
        lane: "provider_native",
        selectionReason: "active",
      }),
    ]);
    expect(attempts).toEqual([
      expect.objectContaining({
        displayName: "Primary",
        attempt: 1,
        outcome: "http_429",
      }),
      expect.objectContaining({
        displayName: "Backup",
        attempt: 2,
        selectionReason: "http_429_switch",
        outcome: "success",
      }),
    ]);
    const after = (await profiles.management.query([provider.id])).providers[0]!;
    expect(after.profiles.find(
      (profile) => profile.credentialId === after.activeCredentialId,
    )?.displayName).toBe("Backup");
  });

  it("captures ambient only at zero Profiles and otherwise binds the exact active Profile", async () => {
    const generatedIds = [
      "credential-managed",
      "credential-generation-managed",
      "selection-generation-managed",
      "selection-generation-cleared",
    ];
    const revisions = ["revision-managed", "revision-disabled"];
    const provider = createFixtureProvider();
    const profiles = createProviderCredentialProfiles({
      recordStore: createInMemoryProviderCredentialRecordStore({
        createRevision: () => revisions.shift() ?? "unexpected-revision",
      }),
      providers: () => [provider],
      createId: () => generatedIds.shift() ?? "unexpected-id",
      now: () => 1_786_400_000_000,
    });
    const models = createModels({
      credentials: profiles.credentialStore,
      authContext: createFixtureAuthContext({ FIXTURE_API_KEY: "ambient-secret" }),
    });
    models.setProvider(provider);
    const model = models.getModel(provider.id, "fixture-model")!;

    const ambient = await profiles.binding.capture(provider.id);
    expect(ambient.facts).toEqual({ kind: "ambient", providerId: provider.id });
    expect(await profiles.binding.runBound(ambient, () => models.getAuth(model))).toEqual({
      auth: { apiKey: "ambient-secret" },
      source: "FIXTURE_API_KEY",
    });

    const login = await profiles.binding.createLoginBinding({
      providerId: provider.id,
      authType: "api_key",
      displayName: "Managed production",
      useNow: false,
      expectedRevision: NO_PROVIDER_RECORD_REVISION,
    });
    await profiles.binding.runBound(login, () =>
      models.login(provider.id, "api_key", {
        prompt: async () => "managed-secret",
        notify: () => {},
      }),
    );

    const managed = await profiles.binding.capture(provider.id);
    expect(managed.facts).toEqual({
      kind: "managed",
      providerId: provider.id,
      credentialId: "credential-managed",
      authType: "api_key",
      authMethodLabel: "Fixture API key",
      displayName: "Managed production",
      credentialGeneration: "credential-generation-managed",
      selectionGeneration: "selection-generation-managed",
    });
    expect(await profiles.binding.runBound(managed, () => models.getAuth(model))).toEqual({
      auth: { apiKey: "managed-secret" },
      source: "stored credential",
    });

    await profiles.management.setEnabled({
      providerId: provider.id,
      credentialId: "credential-managed",
      enabled: false,
      expectedRevision: "revision-managed",
    });
    await expect(profiles.binding.capture(provider.id)).rejects.toMatchObject({
      outcome: "no_active_profile",
    });
  });

  it("serializes silent OAuth refresh per Profile and preserves every management generation", async () => {
    const generatedIds = [
      "credential-oauth",
      "credential-generation-oauth",
      "selection-generation-oauth",
      "credential-generation-reconnected",
    ];
    let refreshCalls = 0;
    const base = createBrowserOAuthProvider({ id: "oauth-provider" });
    const provider = {
      ...base,
      auth: {
        ...base.auth,
        oauth: {
          ...base.auth.oauth!,
          login: async () => ({
            type: "oauth" as const,
            access: "expired-access",
            refresh: "refresh-token",
            expires: 1,
            providerPrivate: { tenant: "tenant-a" },
          }),
          refresh: async (credential: {
            readonly type: "oauth";
            readonly access: string;
            readonly refresh: string;
            readonly expires: number;
            readonly [key: string]: unknown;
          }) => {
            refreshCalls += 1;
            return {
              ...credential,
              access: "rotated-access",
              expires: Date.now() + 3_600_000,
            };
          },
          toAuth: async (credential: { readonly access: string }) => ({
            apiKey: credential.access,
          }),
        },
      },
    };
    const store = createInMemoryProviderCredentialRecordStore({
      createRevision: () => "revision-oauth",
    });
    const profiles = createProviderCredentialProfiles({
      recordStore: store,
      providers: () => [provider],
      createId: () => generatedIds.shift() ?? "unexpected-id",
      now: () => 1_786_400_000_000,
    });
    const models = createModels({ credentials: profiles.credentialStore });
    models.setProvider(provider);
    const login = await profiles.binding.createLoginBinding({
      providerId: provider.id,
      authType: "oauth",
      displayName: "OAuth account",
      useNow: false,
      expectedRevision: NO_PROVIDER_RECORD_REVISION,
    });
    await profiles.binding.runBound(login, () =>
      models.login(provider.id, "oauth", { prompt: async () => "unused", notify: () => {} }),
    );
    const before = await store.read(provider.id);
    const capture = await profiles.binding.capture(provider.id);
    const model = models.getModel(provider.id, "fixture-model")!;

    const resolved = await Promise.all([
      profiles.binding.runBound(capture, () => models.getAuth(model)),
      profiles.binding.runBound(capture, () => models.getAuth(model)),
    ]);

    expect(refreshCalls).toBe(1);
    expect(resolved).toEqual([
      { auth: { apiKey: "rotated-access" }, source: "OAuth" },
      { auth: { apiKey: "rotated-access" }, source: "OAuth" },
    ]);
    const after = await store.read(provider.id);
    expect(after).toMatchObject({
      revision: before?.revision,
      selectionGeneration: before?.selectionGeneration,
      activeCredentialId: before?.activeCredentialId,
      profiles: [{
        credentialGeneration: before?.profiles[0]?.credentialGeneration,
        updatedAt: before?.profiles[0]?.updatedAt,
        credential: {
          type: "oauth",
          access: "rotated-access",
          refresh: "refresh-token",
          providerPrivate: { tenant: "tenant-a" },
        },
      }],
    });
  });

  it("allows removal during OAuth network refresh and discards the late publication", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "Token-refresh-remove-"));
    const generatedIds = [
      "credential-oauth",
      "credential-generation-oauth",
      "selection-generation-oauth",
      "selection-generation-removed",
    ];
    const revisions = ["revision-oauth", "revision-removed"];
    let markRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    let releaseRefresh!: () => void;
    const refreshMayFinish = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const base = createBrowserOAuthProvider({ id: "refresh-remove-provider" });
    const provider = {
      ...base,
      auth: {
        ...base.auth,
        oauth: {
          ...base.auth.oauth!,
          login: async () => ({
            type: "oauth" as const,
            access: "expired-access",
            refresh: "refresh-token",
            expires: 1,
          }),
          refresh: async (credential: {
            readonly type: "oauth";
            readonly access: string;
            readonly refresh: string;
            readonly expires: number;
          }) => {
            markRefreshStarted();
            await refreshMayFinish;
            return {
              ...credential,
              access: "late-access",
              expires: Date.now() + 3_600_000,
            };
          },
          toAuth: async (credential: { readonly access: string }) => ({
            apiKey: credential.access,
          }),
        },
      },
    };

    try {
      const store = createFileProviderCredentialRecordStore({
        piDirectory: codexHome,
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
      const login = await profiles.binding.createLoginBinding({
        providerId: provider.id,
        authType: "oauth",
        displayName: "Removable account",
        useNow: false,
        expectedRevision: NO_PROVIDER_RECORD_REVISION,
      });
      await profiles.binding.runBound(login, () =>
        models.login(provider.id, "oauth", { prompt: async () => "unused", notify: () => {} }),
      );
      const capture = await profiles.binding.capture(provider.id);
      const model = models.getModel(provider.id, "fixture-model")!;

      const resolving = profiles.binding.runBound(capture, () => models.getAuth(model));
      await refreshStarted;
      const removed = await profiles.management.remove({
        providerId: provider.id,
        credentialId: "credential-oauth",
        expectedRevision: "revision-oauth",
      });
      expect(removed).toMatchObject({
        outcome: "ok",
        provider: { revision: "revision-removed", profiles: [] },
      });

      releaseRefresh();
      await expect(resolving).resolves.toBeUndefined();
      expect((await store.read(provider.id))?.profiles).toEqual([]);
    } finally {
      releaseRefresh();
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it("reconnects one logical credential incarnation without changing selection", async () => {
    const generatedIds = [
      "credential-a",
      "credential-generation-a",
      "selection-generation-a",
      "credential-generation-reconnected",
    ];
    const revisions = ["revision-a", "revision-reconnected"];
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
    const firstLogin = await profiles.binding.createLoginBinding({
      providerId: provider.id,
      authType: "api_key",
      displayName: "Stable identity",
      useNow: false,
      expectedRevision: NO_PROVIDER_RECORD_REVISION,
    });
    await profiles.binding.runBound(firstLogin, () =>
      models.login(provider.id, "api_key", {
        prompt: async () => "old-secret",
        notify: () => {},
      }),
    );
    const oldCapture = await profiles.binding.capture(provider.id);

    const reconnect = await profiles.binding.createReconnectBinding({
      providerId: provider.id,
      credentialId: "credential-a",
      useNow: false,
      expectedRevision: "revision-a",
    });
    await profiles.binding.runBound(reconnect, () =>
      models.login(provider.id, "api_key", {
        prompt: async () => "new-secret",
        notify: () => {},
      }),
    );

    const record = await store.read(provider.id);
    expect(record).toMatchObject({
      revision: "revision-reconnected",
      selectionGeneration: "selection-generation-a",
      activeCredentialId: "credential-a",
      profiles: [{
        credentialId: "credential-a",
        credentialGeneration: "credential-generation-reconnected",
        displayName: "Stable identity",
        credential: { type: "api_key", key: "new-secret" },
      }],
    });
    const model = models.getModel(provider.id, "fixture-model")!;
    await expect(
      profiles.binding.runBound(oldCapture, () => models.getAuth(model)),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ outcome: "stale_binding" }),
    });
    const currentCapture = await profiles.binding.capture(provider.id);
    await expect(
      profiles.binding.runBound(currentCapture, () => models.getAuth(model)),
    ).resolves.toEqual({ auth: { apiKey: "new-secret" }, source: "stored credential" });
  });

  it("projects a failed silent OAuth refresh as reconnect_required without starting login", async () => {
    const generatedIds = [
      "credential-oauth",
      "credential-generation-oauth",
      "selection-generation-oauth",
    ];
    let loginCalls = 0;
    let refreshCalls = 0;
    const base = createBrowserOAuthProvider({ id: "kimi-coding" });
    const provider = {
      ...base,
      auth: {
        ...base.auth,
        oauth: {
          ...base.auth.oauth!,
          login: async () => {
            loginCalls += 1;
            return {
              type: "oauth" as const,
              access: loginCalls === 1 ? "expired-access" : "healthy-access",
              refresh: "retained-refresh",
              expires: loginCalls === 1 ? 1 : 9_000_000_000_000,
            };
          },
          refresh: async () => {
            refreshCalls += 1;
            throw new Error(
              "Kimi Code token refresh unauthorized (status 400): secret-provider-detail",
            );
          },
          toAuth: async (credential: { readonly access: string }) => ({
            apiKey: credential.access,
          }),
        },
      },
    };
    const store = createInMemoryProviderCredentialRecordStore({
      createRevision: () => "revision-oauth",
    });
    const profiles = createProviderCredentialProfiles({
      recordStore: store,
      providers: () => [provider],
      createId: () => generatedIds.shift() ?? "unexpected-id",
      now: () => 1_786_400_000_000,
    });
    const models = createModels({ credentials: profiles.credentialStore });
    models.setProvider(provider);
    const login = await profiles.binding.createLoginBinding({
      providerId: provider.id,
      authType: "oauth",
      displayName: "Expired account",
      useNow: false,
      expectedRevision: NO_PROVIDER_RECORD_REVISION,
    });
    await profiles.binding.runBound(login, () =>
      models.login(provider.id, "oauth", { prompt: async () => "unused", notify: () => {} }),
    );
    const before = await store.read(provider.id);
    const capture = await profiles.binding.capture(provider.id);

    await expect(
      profiles.binding.runBound(capture, () =>
        models.getAuth(models.getModel(provider.id, "fixture-model")!),
      ),
    ).rejects.toMatchObject({ code: "oauth" });

    expect(loginCalls).toBe(1);
    expect(refreshCalls).toBe(1);
    expect(await store.read(provider.id)).toEqual(before);
    expect((await profiles.management.query()).providers[0]?.profiles[0]).toMatchObject({
      credentialId: "credential-oauth",
      health: "reconnect_required",
    });
    await expect(profiles.binding.capture(provider.id)).rejects.toMatchObject({
      outcome: "no_active_profile",
    });
    expect(JSON.stringify(await profiles.management.query())).not.toContain(
      "secret-provider-detail",
    );

    const reconnect = await profiles.binding.createReconnectBinding({
      providerId: provider.id,
      credentialId: "credential-oauth",
      useNow: false,
      expectedRevision: "revision-oauth",
    });
    await profiles.binding.runBound(reconnect, () =>
      models.login(provider.id, "oauth", {
        prompt: async () => "unused",
        notify: () => {},
      }),
    );
    expect((await profiles.management.query()).providers[0]?.profiles[0]).toMatchObject({
      credentialId: "credential-oauth",
      health: "not_yet_verified",
    });
  });

  it("does not poison a valid OAuth Profile after a transient refresh failure", async () => {
    const generatedIds = [
      "credential-oauth",
      "credential-generation-oauth",
      "selection-generation-oauth",
    ];
    const base = createBrowserOAuthProvider({ id: "transient-refresh-provider" });
    const provider = {
      ...base,
      auth: {
        ...base.auth,
        oauth: {
          ...base.auth.oauth!,
          login: async () => ({
            type: "oauth" as const,
            access: "expired-access",
            refresh: "retained-refresh",
            expires: 1,
          }),
          refresh: async () => {
            throw Object.assign(new Error("temporary outage"), { code: "ETIMEDOUT" });
          },
          toAuth: async (credential: { readonly access: string }) => ({
            apiKey: credential.access,
          }),
        },
      },
    };
    const profiles = createProviderCredentialProfiles({
      recordStore: createInMemoryProviderCredentialRecordStore({
        createRevision: () => "revision-oauth",
      }),
      providers: () => [provider],
      createId: () => generatedIds.shift() ?? "unexpected-id",
      now: () => 1_786_400_000_000,
    });
    const models = createModels({ credentials: profiles.credentialStore });
    models.setProvider(provider);
    const login = await profiles.binding.createLoginBinding({
      providerId: provider.id,
      authType: "oauth",
      displayName: "Temporary outage",
      useNow: false,
      expectedRevision: NO_PROVIDER_RECORD_REVISION,
    });
    await profiles.binding.runBound(login, () =>
      models.login(provider.id, "oauth", { prompt: async () => "unused", notify: () => {} }),
    );
    const capture = await profiles.binding.capture(provider.id);
    await expect(profiles.binding.runBound(capture, () =>
      models.getAuth(models.getModel(provider.id, "fixture-model")!),
    )).rejects.toMatchObject({ code: "oauth" });

    expect((await profiles.management.query()).providers[0]?.profiles[0]).toMatchObject({
      credentialId: "credential-oauth",
      health: "not_yet_verified",
    });
    await expect(profiles.binding.capture(provider.id)).resolves.toMatchObject({
      facts: { credentialId: "credential-oauth" },
    });
  });

  it("fails a captured managed binding closed if it is disabled before credential resolution", async () => {
    const generatedIds = [
      "credential-a",
      "credential-generation-a",
      "selection-generation-a",
      "selection-generation-disabled",
    ];
    const revisions = ["revision-a", "revision-disabled"];
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
    const models = createModels({
      credentials: profiles.credentialStore,
      authContext: createFixtureAuthContext({ FIXTURE_API_KEY: "ambient-must-not-win" }),
    });
    models.setProvider(provider);
    const login = await profiles.binding.createLoginBinding({
      providerId: provider.id,
      authType: "api_key",
      displayName: "Will be disabled",
      useNow: false,
      expectedRevision: NO_PROVIDER_RECORD_REVISION,
    });
    await profiles.binding.runBound(login, () =>
      models.login(provider.id, "api_key", {
        prompt: async () => "managed-secret",
        notify: () => {},
      }),
    );
    const capture = await profiles.binding.capture(provider.id);
    await profiles.management.setEnabled({
      providerId: provider.id,
      credentialId: "credential-a",
      enabled: false,
      expectedRevision: "revision-a",
    });

    await expect(
      profiles.binding.runBound(capture, () =>
        models.getAuth(models.getModel(provider.id, "fixture-model")!),
      ),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ outcome: "stale_binding" }),
    });
  });

  it("atomically advances a current final-429 binding to the next eligible same-type Profile", async () => {
    const generatedIds = [
      "credential-a",
      "credential-generation-a",
      "selection-generation-a",
      "credential-b",
      "credential-generation-b",
      "credential-c",
      "credential-generation-c",
      "selection-generation-b",
    ];
    const revisions = [
      "revision-a",
      "revision-b",
      "revision-c",
      "revision-settings",
      "revision-switch",
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
      const login = await profiles.binding.createLoginBinding({
        providerId: provider.id,
        authType: "api_key",
        displayName,
        useNow: false,
        expectedRevision,
      });
      await profiles.binding.runBound(login, () =>
        models.login(provider.id, "api_key", {
          prompt: async () => `secret-${displayName}`,
          notify: () => {},
        }),
      );
    }
    await profiles.management.setSwitchPolicy({
      providerId: provider.id,
      expectedRevision: "revision-c",
      apiKeyOn429: true,
      oauthOn429: false,
    });
    const failed = requireManaged(await profiles.binding.capture(provider.id));

    const cancelled = new AbortController();
    cancelled.abort();
    await expect(profiles.binding.advanceAfterFinal429({
      capture: failed,
      attemptedCredentialIds: ["credential-a"],
      signal: cancelled.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(await store.read(provider.id)).toMatchObject({
      revision: "revision-settings",
      activeCredentialId: "credential-a",
    });

    const transition = await profiles.binding.advanceAfterFinal429({
      capture: failed,
      attemptedCredentialIds: ["credential-a"],
      retryAfterMs: 2_000,
    });

    expect(transition).toMatchObject({
      outcome: "switched",
      capture: {
        facts: {
          kind: "managed",
          providerId: provider.id,
          credentialId: "credential-b",
          authType: "api_key",
          displayName: "B",
          credentialGeneration: "credential-generation-b",
          selectionGeneration: "selection-generation-b",
        },
      },
    });
    expect(await store.read(provider.id)).toMatchObject({
      revision: "revision-switch",
      activeCredentialId: "credential-b",
      selectionGeneration: "selection-generation-b",
    });
    if (transition.outcome !== "switched") throw new Error("expected switch");
    await expect(
      profiles.binding.runBound(transition.capture, () =>
        models.getAuth(models.getModel(provider.id, "fixture-model")!),
      ),
    ).resolves.toEqual({ auth: { apiKey: "secret-B" }, source: "stored credential" });
    expect((await profiles.management.query()).providers[0]?.profiles[0]).toMatchObject({
      credentialId: "credential-a",
      health: "cooling_down",
    });
    await expect(profiles.binding.advanceAfterFinal429({
      capture: transition.capture,
      attemptedCredentialIds: ["credential-a", "credential-b", "credential-c"],
    })).resolves.toEqual({ outcome: "exhausted" });
  });

  it("rejects stale 429 decisions after reconnect or selection ABA but ignores metadata-only revisions", async () => {
    let nextId = 0;
    let nextRevision = 0;
    const provider = createFixtureProvider();
    const profiles = createProviderCredentialProfiles({
      recordStore: createInMemoryProviderCredentialRecordStore({
        createRevision: () => `revision-${++nextRevision}`,
      }),
      providers: () => [provider],
      createId: () => `generation-${++nextId}`,
      now: () => 1_786_400_000_000,
    });
    const models = createModels({ credentials: profiles.credentialStore });
    models.setProvider(provider);
    const add = async (displayName: string, secret: string) => {
      const state = (await profiles.management.query([provider.id])).providers[0]!;
      const binding = await profiles.binding.createLoginBinding({
        providerId: provider.id,
        authType: "api_key",
        displayName,
        useNow: false,
        expectedRevision: state.revision!,
      });
      await profiles.binding.runBound(binding, () =>
        models.login(provider.id, "api_key", {
          prompt: async () => secret,
          notify: () => {},
        }),
      );
    };
    await add("A", "secret-a");
    await add("B", "secret-b");
    let state = (await profiles.management.query([provider.id])).providers[0]!;
    await profiles.management.setSwitchPolicy({
      providerId: provider.id,
      expectedRevision: state.revision!,
      apiKeyOn429: true,
      oauthOn429: false,
    });

    const beforeReconnect = requireManaged(await profiles.binding.capture(provider.id));
    state = (await profiles.management.query([provider.id])).providers[0]!;
    const reconnect = await profiles.binding.createReconnectBinding({
      providerId: provider.id,
      credentialId: state.activeCredentialId!,
      useNow: false,
      expectedRevision: state.revision!,
    });
    await profiles.binding.runBound(reconnect, () =>
      models.login(provider.id, "api_key", {
        prompt: async () => "secret-a-reconnected",
        notify: () => {},
      }),
    );
    await expect(profiles.binding.advanceAfterFinal429({
      capture: beforeReconnect,
      attemptedCredentialIds: [],
    })).resolves.toEqual({ outcome: "stale_binding" });

    const beforeAba = requireManaged(await profiles.binding.capture(provider.id));
    state = (await profiles.management.query([provider.id])).providers[0]!;
    const a = state.profiles.find((profile) => profile.displayName === "A")!;
    const b = state.profiles.find((profile) => profile.displayName === "B")!;
    await profiles.management.activate({
      providerId: provider.id,
      credentialId: b.credentialId,
      expectedRevision: state.revision!,
    });
    state = (await profiles.management.query([provider.id])).providers[0]!;
    await profiles.management.activate({
      providerId: provider.id,
      credentialId: a.credentialId,
      expectedRevision: state.revision!,
    });
    await expect(profiles.binding.advanceAfterFinal429({
      capture: beforeAba,
      attemptedCredentialIds: [],
    })).resolves.toEqual({ outcome: "stale_binding" });

    const currentFailure = requireManaged(await profiles.binding.capture(provider.id));
    state = (await profiles.management.query([provider.id])).providers[0]!;
    await profiles.management.updateMetadata({
      providerId: provider.id,
      credentialId: b.credentialId,
      expectedRevision: state.revision!,
      displayName: "B renamed",
      note: "Latest metadata",
    });
    const transition = await profiles.binding.advanceAfterFinal429({
      capture: currentFailure,
      attemptedCredentialIds: [],
    });
    expect(transition).toMatchObject({
      outcome: "switched",
      capture: { facts: { credentialId: b.credentialId, displayName: "B renamed" } },
    });
  });
});
