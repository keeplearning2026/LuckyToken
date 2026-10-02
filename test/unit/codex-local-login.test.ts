import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it, vi } from "vitest";

import { createCodexLocalLogin } from "../../src/credentials/codex-local-login.js";
import { parseCodexInternalAuth } from "../../src/credentials/codex-internal-auth.js";
import { createProviderCredentialProfiles } from "../../src/credentials/profile-authority.js";
import { createCredentialProfilesControlPlaneHandlers } from "../../src/credentials/profile-control-plane.js";
import {
  createFileProviderCredentialRecordStore,
  createInMemoryProviderCredentialRecordStore,
  credentialProfileCarrier,
  type ProviderCredentialRecordStore,
  type PersistedCredentialProfileV2,
} from "../../src/credentials/profile-record-store.js";
import { createProviderRuntime } from "../../src/providers/runtime.js";
import { loadBundledProviderConfigurations } from "../../src/providers/bundled-configuration.js";

const providerId = "openai-codex";
const provider = builtinProviders().find((item) => item.id === providerId)!;
function document(account = "account-a", expires = Date.now() + 3600_000) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const access = [encode({ alg: "none" }), encode({
    exp: Math.floor(expires / 1000),
    "https://api.openai.com/auth": { chatgpt_account_id: account },
  }), "signature"].join(".");
  return JSON.stringify({ auth_mode: "chatgpt", tokens: {
    access_token: access, refresh_token: `refresh-${account}`, account_id: account,
  } });
}

async function isolated(
  operation: (root: string, authPath: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "Token-local-login-"));
  try { await operation(root, join(root, "auth.json")); }
  finally { await rm(root, { recursive: true, force: true }); }
}

function fixture(store: ProviderCredentialRecordStore, authPath: string) {
  const profiles = createProviderCredentialProfiles({
    recordStore: store, providers: () => [provider], createId: randomUUID, now: Date.now,
  });
  const login = createCodexLocalLogin({
    store, authPath, createId: randomUUID, now: Date.now,
    authMethodLabel: () => provider.auth.oauth!.name,
  });
  return { ...profiles, login };
}
const memory = () => createInMemoryProviderCredentialRecordStore({ createRevision: randomUUID });

async function sibling(store: ProviderCredentialRecordStore) {
  const current = (await store.read(providerId))!;
  const id = randomUUID();
  const generation = randomUUID();
  const other: PersistedCredentialProfileV2 = {
    credentialId: id, credentialGeneration: generation, displayName: "Profile 1",
    authType: "oauth", authMethodLabel: provider.auth.oauth!.name,
    enabled: true, priority: 1, createdAt: 1, updatedAt: 1, kind: "unavailable",
  };
  await store.publishCredential(providerId, current.revision, {
    credentialId: id, credentialGeneration: generation, credential: null,
  }, () => ({ kind: "commit", value: undefined, record: { ...current, profiles: [
    ...current.profiles, other,
  ].map((item) => item.acquisition === "codex_local" ? { ...item, displayName: "Old local" } : item) } }));
  return id;
}

describe("shared local Codex acquisition", () => {
  for (const storage of ["memory", "file"] as const) {
    it(`${storage}: rebuilds every invocation, retains siblings and selection, and publishes no source metadata`, async () => isolated(async (root, authPath) => {
      const store = storage === "memory" ? memory() :
        createFileProviderCredentialRecordStore({ piDirectory: join(root, "pi"), createRevision: randomUUID });
      const state = fixture(store, authPath);
      await writeFile(authPath, document());
      const first = await state.login();
      const other = await sibling(store);
      let record = (await store.read(providerId))!;
      await state.management.updateMetadata({
        providerId, credentialId: first.credentialId, expectedRevision: record.revision,
        displayName: "Renamed", note: "old note",
      });
      record = (await store.read(providerId))!;
      const second = await state.login({ credentialId: first.credentialId, expectedRevision: record.revision });
      record = (await store.read(providerId))!;
      expect(record.activeCredentialId).toBe(second.credentialId);
      expect(record.profiles.map((item) => item.credentialId)).toEqual([other, second.credentialId]);
      expect(record.profiles[1]).toMatchObject({ displayName: "Profile 2", enabled: true, priority: 2 });
      expect(record.profiles[1]).not.toHaveProperty("note");
      expect(second.credentialGeneration).not.toBe(first.credentialGeneration);
      await state.management.activate({ providerId, credentialId: other, expectedRevision: record.revision });
      const selected = (await store.read(providerId))!;
      await state.login();
      record = (await store.read(providerId))!;
      expect(record.activeCredentialId).toBe(other);
      expect(record.selectionGeneration).toBe(selected.selectionGeneration);
      await state.management.setEnabled({
        providerId, credentialId: other, expectedRevision: record.revision, enabled: false,
      });
      await state.login();
      expect((await store.read(providerId))!.activeCredentialId).toBeUndefined();
      const dto = await state.management.query();
      expect(JSON.stringify(dto)).not.toContain("acquisition");
      expect(JSON.stringify(dto)).not.toContain("codex_local");
      expect(dto.providers[0]!.profiles).toHaveLength(2);
      expect(JSON.parse(await readFile(authPath, "utf8")).tokens.refresh_token).toBe("refresh-account-a");
    }));
  }

  for (const input of ["missing", "directory", "empty", "json", "mode", "oversize", "expiry"] as const) {
    it(`replaces previous credentials with unavailable for ${input}`, async () => isolated(async (_root, authPath) => {
      const store = memory();
      const state = fixture(store, authPath);
      await writeFile(authPath, document());
      const previous = await state.login();
      await rm(authPath);
      if (input === "directory") await mkdir(authPath);
      else if (input !== "missing") {
        const raw = input === "empty" ? "" : input === "json" ? "{" :
          input === "mode" ? '{"auth_mode":"apikey","OPENAI_API_KEY":"canary"}' :
            input === "oversize" ? "a".repeat(1024 * 1024 + 1) : document().replace(/"access_token":"[^"]+"/u, '"access_token":"no-expiry"');
        await writeFile(authPath, raw);
      }
      const next = await state.login();
      const record = (await store.read(providerId))!;
      expect(record.profiles).toHaveLength(1);
      expect(record.profiles[0]).toMatchObject({ credentialId: next.credentialId, kind: "unavailable" });
      expect(next.credentialId).not.toBe(previous.credentialId);
      expect(record.profiles[0]).not.toHaveProperty("incarnation");
      expect(await store.readCredential(providerId, previous.credentialId, previous.credentialGeneration)).toEqual({ state: "missing" });
      expect((await state.management.query()).providers[0]!.profiles[0]!.health).toBe("reconnect_required");
      await expect(state.binding.capture(providerId)).rejects.toMatchObject({ outcome: "no_active_profile" });
    }));
  }

  it("serializes concurrent invocations and rejects a stale reconnect before rebuilding", async () => isolated(async (_root, authPath) => {
    await writeFile(authPath, document());
    const store = memory();
    const state = fixture(store, authPath);
    await state.login();
    const old = (await store.read(providerId))!;
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => state.login()));
    const current = (await store.read(providerId))!;
    expect(current.profiles).toHaveLength(1);
    expect(current.profiles[0]!.credentialId).toBe(outcomes[7]!.credentialId);
    await expect(state.login({ credentialId: old.profiles[0]!.credentialId, expectedRevision: old.revision }))
      .rejects.toMatchObject({ outcome: "conflict" });
    expect(await store.read(providerId)).toEqual(current);
  }));

  it("imports expired grants unchanged and refreshes only the owned incarnation", async () => isolated(async (root, authPath) => {
    const raw = document("account-a", Date.now() - 3600_000);
    await writeFile(authPath, raw);
    const store = createFileProviderCredentialRecordStore({ piDirectory: join(root, "pi"), createRevision: randomUUID });
    const state = fixture(store, authPath);
    const imported = await state.login();
    const old = await store.readCredential(providerId, imported.credentialId, imported.credentialGeneration);
    expect(old.state).toBe("ok");
    if (old.state !== "ok" || old.credential.type !== "oauth") throw new Error("Missing imported credential");
    expect(old.credential.expires).toBeLessThan(Date.now());
    const expiry = Math.floor((Date.now() + 3600_000) / 1000) * 1000;
    const refreshed = { ...old.credential, expires: expiry,
      access: JSON.parse(document("account-a", expiry)).tokens.access_token as string, refresh: "rotated-refresh" };
    await store.modifyCredential(providerId, imported.credentialId, imported.credentialGeneration, async () => refreshed);
    expect(await store.readCredential(providerId, imported.credentialId, imported.credentialGeneration))
      .toMatchObject({ state: "ok", credential: refreshed });
    expect(await readFile(authPath, "utf8")).toBe(raw);
  }));

  it("leaves the committed record intact when publication fails, then GC collects its orphan", async () => isolated(async (root, authPath) => {
    let fail = false;
    const store = createFileProviderCredentialRecordStore({
      piDirectory: join(root, "pi"), createRevision: randomUUID,
      hooks: { afterIncarnationPublication: () => { if (fail) throw new Error("Injected publication failure"); } },
    });
    const state = fixture(store, authPath);
    await writeFile(authPath, document());
    await state.login();
    const committed = await store.read(providerId);
    fail = true;
    await expect(state.login()).rejects.toThrow("Injected publication failure");
    expect(await store.read(providerId)).toEqual(committed);
    expect(await store.collectOrphans(providerId, { graceMs: 0, now: () => Date.now() + 1_000 })).toHaveLength(1);
  }));

  it("Reconnect uses the shared module and schedules the new capture; Recheck keeps the owned credential", async () => isolated(async (_root, authPath) => {
    const store = memory();
    const state = fixture(store, authPath);
    await writeFile(authPath, document());
    const first = await state.login();
    await writeFile(authPath, document("account-b"));
    const login = vi.fn(async () => { throw new Error("Local Reconnect must not run interactive login"); });
    const postLogin = vi.fn();
    const recheck = vi.fn(async () => "succeeded" as const);
    const handlers = createCredentialProfilesControlPlaneHandlers({
      models: { getProviders: () => [provider], login },
      management: state.management, binding: state.binding,
      loginFromLocalCodex: state.login, postLoginProvider: postLogin, recheckProvider: recheck,
    });
    const before = (await store.read(providerId))!;
    await handlers.credentials({ command: "recheck", providerId, credentialId: first.credentialId, expectedRevision: before.revision });
    expect(recheck).toHaveBeenCalledOnce();
    const unchanged = await store.readCredential(providerId, first.credentialId, first.credentialGeneration);
    expect(unchanged.state === "ok" && unchanged.credential.type === "oauth" && unchanged.credential.refresh).toBe("refresh-account-a");
    const result = await handlers.auth({
      command: "reconnect", providerId, credentialId: first.credentialId,
      expectedRevision: before.revision, useNow: false,
    }, { signal: new AbortController().signal, notify: async () => undefined,
      prompt: async () => "" });
    expect(result.outcome).toBe("ok");
    expect(login).not.toHaveBeenCalled();
    expect(postLogin).toHaveBeenCalledOnce();
    const next = result.state.providers[0]!.profiles[0]!;
    expect(next.credentialId).not.toBe(first.credentialId);
    expect(postLogin.mock.calls[0]![1].facts.credentialId).toBe(next.credentialId);
    const current = (await store.read(providerId))!.profiles[0]!;
    expect(await store.readCredential(providerId, current.credentialId, current.credentialGeneration))
      .toMatchObject({ credential: { refresh: "refresh-account-b" } });
    await rm(authPath);
    const invalid = await handlers.auth({
      command: "reconnect", providerId, credentialId: current.credentialId,
      expectedRevision: (await store.read(providerId))!.revision, useNow: false,
    }, { signal: new AbortController().signal, notify: async () => undefined, prompt: async () => "" });
    expect(invalid.outcome).toBe("unavailable");
    expect(invalid.state.providers[0]!.profiles[0]!.health).toBe("reconnect_required");
    expect(invalid.state.providers[0]!.profiles[0]!.credentialId).not.toBe(current.credentialId);
    expect(postLogin).toHaveBeenCalledOnce();
    const unavailable = invalid.state.providers[0]!.profiles[0]!;
    const rechecked = await handlers.credentials({
      command: "recheck", providerId, credentialId: unavailable.credentialId,
      expectedRevision: invalid.state.providers[0]!.revision!,
    });
    expect(rechecked).toMatchObject({
      outcome: "reconnect_required",
      error: "Provider authentication must be reconnected",
    });
    expect(rechecked.state.providers[0]!.profiles[0]).toMatchObject({
      credentialId: unavailable.credentialId,
      health: "reconnect_required",
    });
    expect(recheck).toHaveBeenCalledOnce();
  }));

  it("does not publish an in-flight old refresh into the reconstructed Profile", async () => isolated(async (root, authPath) => {
    await writeFile(authPath, document());
    const store = createFileProviderCredentialRecordStore({
      piDirectory: join(root, "pi"), createRevision: randomUUID,
    });
    const state = fixture(store, authPath);
    const previous = await state.login();
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const rotation = store.modifyCredential(providerId, previous.credentialId,
      previous.credentialGeneration, async (credential) => {
        entered(); await waiting; return credential;
      });
    let collection: Promise<readonly string[]> | undefined;
    try {
      await paused;
      await writeFile(authPath, document("account-b"));
      const next = await state.login();
      expect(next.credentialId).not.toBe(previous.credentialId);
      collection = store.collectOrphans(providerId, { graceMs: 0, now: () => Date.now() + 1_000 });
    } finally { release(); }
    expect(await rotation).toBeUndefined();
    expect(await collection).toHaveLength(1);
    const current = (await store.read(providerId))!.profiles[0]!;
    expect(await store.readCredential(providerId, current.credentialId, current.credentialGeneration))
      .toMatchObject({ credential: { refresh: "refresh-account-b" } });
  }));

  it("normalizes an overflowing priority without changing sibling order or metadata", async () => isolated(async (_root, authPath) => {
    const store = memory();
    const state = fixture(store, authPath);
    await state.login();
    const other = await sibling(store);
    await state.management.setPriority({
      providerId, credentialId: other, priority: Number.MAX_SAFE_INTEGER,
      expectedRevision: (await store.read(providerId))!.revision,
    });
    await state.login();
    const profiles = (await store.read(providerId))!.profiles;
    expect(profiles.map((item) => item.priority)).toEqual([0, 1]);
    expect(profiles[0]).toMatchObject({ credentialId: other, displayName: "Profile 1" });
  }));

  it("includes local acquisition in ordinary 429 switching and rejects old publication", async () => isolated(async (_root, authPath) => {
    await writeFile(authPath, document());
    const store = memory();
    const state = fixture(store, authPath);
    const local = await state.login();
    const oldCapture = await state.binding.capture(providerId);
    const id = randomUUID();
    const generation = randomUUID();
    const credential = parseCodexInternalAuth(document("account-b"))!;
    const current = (await store.read(providerId))!;
    await store.publishCredential(providerId, current.revision, {
      credentialId: id, credentialGeneration: generation, credential,
    }, () => ({ kind: "commit", value: undefined, record: {
      ...current, activeCredentialId: id, selectionGeneration: randomUUID(),
      switchPolicy: { apiKeyOn429: false, oauthOn429: true },
      profiles: [...current.profiles, {
        credentialId: id, credentialGeneration: generation, authType: "oauth",
        authMethodLabel: provider.auth.oauth!.name, displayName: "Manual",
        enabled: true, priority: 1, createdAt: 1, updatedAt: 1,
        ...credentialProfileCarrier(providerId, id, generation, credential),
      }],
    } }));
    const manual = await state.binding.capture(providerId);
    if (manual.facts.kind !== "managed") throw new Error("Missing managed capture");
    const switched = await state.binding.advanceAfterFinal429({
      capture: manual as Parameters<typeof state.binding.advanceAfterFinal429>[0]["capture"],
      attemptedCredentialIds: [id],
    });
    expect(switched.outcome).toBe("switched");
    expect((await store.read(providerId))!.activeCredentialId).toBe(local.credentialId);
    expect(await state.binding.publishIfCurrent(manual, () => { throw new Error("Stale publication"); })).toBe(false);
    expect(await state.binding.publishIfCurrent(oldCapture, () => { throw new Error("ABA publication"); })).toBe(false);
    await rm(authPath);
    const capture = await state.binding.capture(providerId);
    expect(await state.binding.runBound(capture, () => state.credentialStore.read(providerId)))
      .toMatchObject({ refresh: "refresh-account-a" });
    await state.login();
    expect(await state.binding.publishIfCurrent(capture, () => { throw new Error("Deleted publication"); })).toBe(false);
    await expect(state.binding.capture(providerId)).rejects.toMatchObject({ outcome: "no_active_profile" });
    expect((await store.read(providerId))!.profiles).toHaveLength(2);
  }));

  it("serializes independent file stores and never exposes the staged empty list", async () => isolated(async (root, authPath) => {
    await writeFile(authPath, document());
    const options = { piDirectory: join(root, "pi"), createRevision: randomUUID };
    const store = createFileProviderCredentialRecordStore(options);
    const secondStore = createFileProviderCredentialRecordStore(options);
    const first = fixture(store, authPath);
    const second = fixture(secondStore, authPath);
    await Promise.all([first.login(), second.login(), first.login(), second.login()]);
    const record = (await store.read(providerId))!;
    expect(record.profiles).toHaveLength(1);
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const pausedStore = createFileProviderCredentialRecordStore({ ...options,
      hooks: { afterIncarnationPublication: async () => { entered(); await waiting; } },
    });
    const operation = fixture(pausedStore, authPath).login();
    try {
      await paused;
      expect(await secondStore.read(providerId)).toEqual(record);
    } finally { release(); await operation; }
    const next = (await store.read(providerId))!;
    expect(next.profiles).toHaveLength(1);
    expect(next.profiles[0]!.credentialId).not.toBe(record.profiles[0]!.credentialId);
  }));

  it("startup defaults on, off preserves the record, and explicit reconnect ignores the switch", async () => isolated(async (root, authPath) => {
    const original = document();
    await writeFile(authPath, original);
    const store = memory();
    const options = {
      piDirectory: join(root, "pi"), modelsJsonPath: join(root, "models.json"), codexHome: root,
      credentialRecordStore: store,
      bundledProviderConfigurations: (await loadBundledProviderConfigurations(join(root, "bundled.json"))).configurations,
      userProviderPackages: {},
      fetch: vi.fn(() => { throw new Error("Startup must not use network"); }),
    };
    await createProviderRuntime(options);
    const first = (await store.read(providerId))!;
    await writeFile(authPath, "{");
    const runtime = await createProviderRuntime({ ...options, codexAutoLoginOnStartup: false });
    expect(await store.read(providerId)).toEqual(first);
    const capture = await runtime.providerAuthBindings.capture(providerId);
    const model = runtime.models.getModels(providerId)[0]!;
    const resolved = await runtime.providerAuthBindings.runBound(capture, () => runtime.models.getAuth(model));
    expect(resolved?.auth.apiKey).toBe(JSON.parse(original).tokens.access_token);
    await runtime.loginFromLocalCodex({ credentialId: first.profiles[0]!.credentialId, expectedRevision: first.revision });
    expect((await store.read(providerId))!.profiles[0]!.kind).toBe("unavailable");
    await createProviderRuntime(options);
    expect((await store.read(providerId))!.profiles).toHaveLength(1);
  }));
});
