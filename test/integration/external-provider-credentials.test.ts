import { createModels, type Credential } from "@earendil-works/pi-ai";
import { DEFAULT_COMMANDCODE_MODEL_CATALOG } from "@token/commandcode-model-catalog";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createApiKeyFileSource } from "../../src/credentials/api-key-file-source.js";
import { createExternalCredentialSource } from "../../src/credentials/external-credential-source.js";
import { createProviderCredentialProfiles } from "../../src/credentials/profile-authority.js";
import { createInMemoryProviderCredentialRecordStore } from "../../src/credentials/profile-record-store.js";
import { createProviderUsageAuthority } from "../../src/provider-usage/authority.js";
import { createBundledProviderConfigurations } from "../../src/providers/bundled-configuration.js";
import { createProviderRuntime } from "../../src/providers/runtime.js";
import { createBrowserOAuthProvider, createSecretApiKeyProvider } from "../support/auth-login-fixture.js";

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "Token-external-provider-"));
  try { await run(home); }
  finally { await rm(home, { recursive: true, force: true }); }
}

/** A second login format, deliberately without JWTs or Codex field names. */
function jsonLoginSource(path: string, refresh?: () => Promise<void>) {
  return createExternalCredentialSource({
    path, authType: "oauth", authMethodLabel: "Fixture account", displayName: "Fixture login",
    retryDelayMs: 1,
    decode(raw) {
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (typeof value.principal !== "string" || typeof value.token !== "string" ||
        typeof value.renewal !== "string" || typeof value.validUntil !== "number") {
        return { state: "invalid", reason: "Incomplete fixture login" };
      }
      return { state: "ok", document: { identityKey: value.principal,
        credential: { type: "oauth", access: value.token, refresh: value.renewal, expires: value.validUntil } } };
    },
    ...(refresh === undefined ? {} : { refresh: async () => {
      await refresh();
      return { outcome: "completed" as const };
    } }),
  });
}

const loginDocument = (principal: string, token: string, validFor: number) =>
  JSON.stringify({ principal, token, renewal: "synthetic-renewal", validUntil: Date.now() + validFor });

describe("Provider-neutral external credentials", () => {
  it("rejects unbounded read budgets and presentation metadata before reading a file", () => {
    const options = { path: "unused", authType: "api_key" as const,
      authMethodLabel: "API key", displayName: "Key file",
      decode: () => ({ state: "invalid" as const, reason: "Unused" }) };
    for (const readAttempts of [NaN, Infinity, 0, 17]) {
      expect(() => createExternalCredentialSource({ ...options, readAttempts })).toThrow();
    }
    for (const retryDelayMs of [NaN, Infinity, -1, 1001]) {
      expect(() => createExternalCredentialSource({ ...options, retryDelayMs })).toThrow();
    }
    expect(() => createExternalCredentialSource({ ...options, displayName: "x".repeat(65) })).toThrow();
    expect(() => createExternalCredentialSource({ ...options, authMethodLabel: "x".repeat(129) })).toThrow();
  });

  it("uses an API key file through Runtime, real Pi auth and usage without a Codex identity", async () => {
    await withHome(async (home) => {
      const path = join(home, "provider.key");
      const config = join(home, "models.json");
      const bytes = "synthetic-file-key\n";
      await writeFile(path, bytes);
      await writeFile(config, JSON.stringify({ providers: { "file-provider": {
        api: "openai-responses", baseUrl: "https://fixture.invalid", models: [{ id: "fixture-model" }],
      } } }));
      const runtime = await createProviderRuntime({
        piDirectory: join(home, "pi"), modelsJsonPath: config, codexHome: home,
        bundledProviderConfigurations: createBundledProviderConfigurations(DEFAULT_COMMANDCODE_MODEL_CATALOG),
        userProviderPackages: {}, fetch: async () => { throw new Error("No network in fixture"); },
        externalCredentialSources: { "file-provider": createApiKeyFileSource({
          path, authMethodLabel: "Fixture API key", displayName: "Fixture key file",
        }) },
      });
      const model = runtime.models.getModel("file-provider", "fixture-model")!;
      const capture = await runtime.providerAuthBindings.capture("file-provider");
      expect(capture.facts).toMatchObject({ kind: "external", authType: "api_key", displayName: "Fixture key file" });
      expect(JSON.stringify(capture)).not.toContain("synthetic-file-key");
      const auth = await runtime.providerAuthBindings.runBound(capture, () => runtime.models.getAuth(model));
      expect(auth?.auth.apiKey).toBe("synthetic-file-key");
      expect(auth?.source).toBe("stored credential");
      expect((await runtime.credentialManagement.query(["file-provider"])).providers[0]?.ambient)
        .toMatchObject({ kind: "external", status: "connected", displayName: "Fixture key file" });
      const usage = createProviderUsageAuthority({ models: runtime.models, binding: runtime.providerAuthBindings,
        probes: [{ providerId: "file-provider", eligibility(context) {
          expect(context.binding).toEqual({ kind: "external", authType: "api_key" });
          return { state: "eligible" };
        }, async acquire(input) {
          expect(input.auth.auth.apiKey).toBe("synthetic-file-key");
          return { state: "observed", facts: { windows: [{ kind: "weekly", usedPercent: 12 }], budgets: [] } };
        } }],
      });
      try {
        expect((await usage.refresh("file-provider")).refresh.outcome).toBe("succeeded");
        await writeFile(path, "synthetic-replacement-key");
        expect((await usage.query()).providers[0]?.state).not.toBe("observed");
        await expect(runtime.providerAuthBindings.runBound(capture, () => runtime.models.getAuth(model)))
          .rejects.toThrow();
        expect(await runtime.providerAuthBindings.publishIfCurrent(capture, () => {
          throw new Error("A stale key must not publish");
        })).toBe(false);
      } finally { await usage.close(); }
      // Only this fixture writer changes bytes, never the source/Runtime.
      expect(await readFile(path, "utf8")).toBe("synthetic-replacement-key");
      expect(await readFile(config, "utf8")).not.toContain("synthetic-file-key");
    });
  });

  it("resolves a different login JSON through the same binding without Pi refresh or file mutation", async () => {
    await withHome(async (home) => {
      const path = join(home, "other-auth.json");
      const bytes = loginDocument("principal-a", "synthetic-other-access", 3_600_000);
      await writeFile(path, bytes);
      let piRefreshes = 0;
      const base = createBrowserOAuthProvider({ id: "other-login" });
      const provider = { ...base, auth: { ...base.auth, oauth: { ...base.auth.oauth!,
        refresh: async (credential: Parameters<NonNullable<typeof base.auth.oauth>["refresh"]>[0]) => {
          piRefreshes += 1; return credential;
        },
      } } };
      const source = jsonLoginSource(path);
      const profiles = createProviderCredentialProfiles({
        recordStore: createInMemoryProviderCredentialRecordStore({ createRevision: () => "r1" }),
        providers: () => [provider], now: Date.now, createId: () => "id1",
        externalSources: { "other-login": source },
      });
      const models = createModels({ credentials: profiles.credentialStore });
      models.setProvider(provider);
      const capture = await profiles.binding.capture(provider.id);
      const model = models.getModel(provider.id, "fixture-model")!;
      expect((await profiles.binding.runBound(capture, () => models.getAuth(model)))?.auth.apiKey)
        .toBe("synthetic-other-access");
      expect(await source.read()).toMatchObject({ state: "ok", identityKey: "principal-a" });
      expect(JSON.stringify(await source.read())).not.toMatch(/synthetic-other-access|synthetic-renewal/);
      let callbackRuns = 0;
      await expect(profiles.binding.runBound(capture, () => profiles.credentialStore.modify(provider.id, async () => {
        callbackRuns += 1; return undefined;
      }))).rejects.toMatchObject({ outcome: "external_read_only" });
      await writeFile(path, loginDocument("principal-a", "synthetic-expired", -1));
      await expect(profiles.binding.runBound(capture, () => models.getAuth(model))).rejects.toThrow();
      expect(piRefreshes).toBe(0);
      expect(callbackRuns).toBe(0);
      await writeFile(path, bytes);
      expect(await readFile(path, "utf8")).toBe(bytes);
    });
  });

  it("coalesces owner refresh and post-refresh verification while one waiter cancels", async () => {
    await withHome(async (home) => {
      const path = join(home, "other-auth.json");
      await writeFile(path, loginDocument("principal-a", "synthetic-old", 10_000));
      let release!: () => void;
      let entered!: () => void;
      const blocked = new Promise<void>((done) => { release = done; });
      const started = new Promise<void>((done) => { entered = done; });
      let refreshes = 0;
      const source = jsonLoginSource(path, async () => {
        refreshes += 1; entered(); await blocked;
        await writeFile(path, loginDocument("principal-a", "synthetic-new", 3_600_000));
      });
      const controller = new AbortController();
      const canceled = source.resolve({ signal: controller.signal });
      const rejected = expect(canceled).rejects.toBeDefined();
      const other = source.resolve();
      try {
        await started;
        controller.abort();
        await rejected;
        release();
        expect(await other).toMatchObject({ state: "ok", identityKey: "principal-a", refreshed: true,
          credential: { type: "oauth", access: "synthetic-new" } });
        expect(refreshes).toBe(1);
        expect(await source.resolve()).toMatchObject({ state: "ok", refreshed: false });
        expect(refreshes).toBe(1);
      } finally { release(); await Promise.allSettled([canceled, other]); }
    });
  });

  it("binds terminal usage evidence to the revision resolved after owner refresh", async () => {
    await withHome(async (home) => {
      const path = join(home, "other-auth.json");
      await writeFile(path, loginDocument("principal-a", "synthetic-old", 10_000));
      const source = jsonLoginSource(path, () => writeFile(path,
        loginDocument("principal-a", "synthetic-refreshed", 3_600_000)));
      const provider = createBrowserOAuthProvider({ id: "other-login" });
      const profiles = createProviderCredentialProfiles({
        recordStore: createInMemoryProviderCredentialRecordStore({ createRevision: () => "r1" }),
        providers: () => [provider], now: Date.now, createId: () => "id1",
        externalSources: { [provider.id]: source },
      });
      const models = createModels({ credentials: profiles.credentialStore });
      models.setProvider(provider);
      let calls = 0;
      let terminal = true;
      const usage = createProviderUsageAuthority({ models, binding: profiles.binding,
        probes: [{ providerId: provider.id, eligibility: () => ({ state: "eligible" }), async acquire() {
          calls += 1;
          return terminal ? { state: "unavailable", reason: "terminal" } :
            { state: "observed", facts: { windows: [{ kind: "weekly", usedPercent: 12 }], budgets: [] } };
        } }],
      });
      try {
        const first = await usage.refresh(provider.id);
        expect(first.snapshot.providers[0]).toMatchObject({ state: "unavailable", reason: "terminal" });
        expect((await usage.refresh(provider.id)).refresh).toMatchObject({ outcome: "unavailable", reason: "terminal" });
        expect(calls).toBe(1);
        terminal = false;
        await writeFile(path, loginDocument("principal-a", "synthetic-recovery", 3_600_000));
        expect((await usage.refresh(provider.id)).refresh.outcome).toBe("succeeded");
        expect(calls).toBe(2);
      } finally { await usage.close(); }
    });
  });

  it.each(["unchanged", "identity", "expiry"])("rejects owner refresh with %s verification failure", async (failure) => {
    await withHome(async (home) => {
      const path = join(home, "other-auth.json");
      await writeFile(path, loginDocument("principal-a", "synthetic-old", 10_000));
      const source = jsonLoginSource(path, async () => {
        if (failure !== "unchanged") await writeFile(path, loginDocument(
          failure === "identity" ? "principal-b" : "principal-a", "synthetic-new",
          failure === "expiry" ? 10_000 : 3_600_000));
      });
      expect(await source.resolve()).toMatchObject({ state: "unavailable", reason: "verification_failed",
        detail: failure === "unchanged" ? "revision_unchanged" : failure === "identity" ? "identity_changed" : "insufficient_validity" });
    });
  });

  it("rejects a refresh that redirects the file even when the principal stays the same", async () => {
    await withHome(async (home) => {
      const oldHome = join(home, "old");
      const newHome = join(home, "new");
      const link = join(home, "current");
      await mkdir(oldHome);
      await mkdir(newHome);
      const oldBytes = loginDocument("principal-a", "synthetic-old", 10_000);
      await writeFile(join(oldHome, "login.json"), oldBytes);
      await writeFile(join(newHome, "login.json"), loginDocument("principal-a", "synthetic-new", 3_600_000));
      await symlink(oldHome, link, process.platform === "win32" ? "junction" : "dir");
      const source = jsonLoginSource(join(link, "login.json"), async () => {
        await unlink(link);
        await symlink(newHome, link, process.platform === "win32" ? "junction" : "dir");
      });
      expect(await source.resolve()).toMatchObject({ state: "unavailable", reason: "verification_failed", detail: "identity_changed" });
      expect(await readFile(join(oldHome, "login.json"), "utf8")).toBe(oldBytes);
    });
  });

  it("contains decoder and delegate exceptions without exposing credential material", async () => {
    await withHome(async (home) => {
      const path = join(home, "login.json");
      await writeFile(path, loginDocument("principal-a", "synthetic-secret", 10_000));
      const failedRefresh = jsonLoginSource(path, async () => { throw new Error("synthetic-secret"); });
      const resolution = await failedRefresh.resolve();
      expect(resolution).toMatchObject({ state: "unavailable", reason: "refresh_unavailable", detail: "delegate_failed" });
      expect(JSON.stringify(resolution)).not.toContain("synthetic-secret");
      const failedDecode = createExternalCredentialSource({ path, authType: "oauth", displayName: "Fixture login",
        authMethodLabel: "Fixture account", decode() { throw new Error("synthetic-secret"); } });
      const read = await failedDecode.read();
      expect(read).toMatchObject({ state: "invalid" });
      expect(JSON.stringify(read)).not.toContain("synthetic-secret");
    });
  });

  it("preserves four read states and rejects oversized, multiline and mismatched documents", async () => {
    await withHome(async (home) => {
      const path = join(home, "provider.key");
      const source = createApiKeyFileSource({ path, authMethodLabel: "API key", displayName: "Key file" });
      expect(await source.read()).toMatchObject({ state: "missing" });
      const directorySource = createApiKeyFileSource({ path: home, authMethodLabel: "API key", displayName: "Key file" });
      expect(await directorySource.read()).toMatchObject({ state: "unreadable" });
      for (const bytes of ["", "synthetic-first\nsynthetic-second"]) {
        await writeFile(path, bytes);
        expect(await source.read()).toMatchObject({ state: "invalid" });
      }
      await writeFile(path, "x".repeat(1024 * 1024 + 1));
      expect(await source.read()).toMatchObject({ state: "unreadable" });
      await writeFile(path, "synthetic-key");
      const before = await source.read();
      await writeFile(path, "  synthetic-key\n");
      const after = await source.read();
      expect(after).toMatchObject({ state: "ok" });
      if (before.state !== "ok" || after.state !== "ok") throw new Error("Fixture must be readable");
      expect(after.identityKey).toBe(before.identityKey);
      expect(after.tokenRevision).not.toBe(before.tokenRevision);
      const mismatch = createExternalCredentialSource({ path, authType: "api_key", authMethodLabel: "API key",
        displayName: "Key file", decode: () => ({ state: "ok", document: {
          identityKey: "principal", credential: { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 },
        } }) });
      expect(await mismatch.read()).toMatchObject({ state: "invalid" });
    });
  });

  it("keeps managed profiles authoritative for a non-Codex provider", async () => {
    await withHome(async (home) => {
      const provider = createSecretApiKeyProvider({ id: "other-login" });
      const path = join(home, "provider.key");
      await writeFile(path, "synthetic-external-key");
      const profiles = createProviderCredentialProfiles({
        recordStore: createInMemoryProviderCredentialRecordStore({ createRevision: () => "r1" }),
        providers: () => [provider], createId: () => "id1", now: Date.now,
        externalSources: { [provider.id]: createApiKeyFileSource({ path, authMethodLabel: "API key", displayName: "Key file" }) },
      });
      const external = await profiles.binding.capture(provider.id);
      expect(await profiles.binding.runBound(external, () => profiles.credentialStore.list()))
        .toEqual([{ providerId: provider.id, type: "api_key" }]);
      const login = await profiles.binding.createLoginBinding({ providerId: provider.id, authType: "api_key",
        displayName: "Managed", useNow: true, expectedRevision: "absent" });
      const credential: Credential = { type: "api_key", key: "synthetic-managed-key" };
      await profiles.binding.runBound(login, () => profiles.credentialStore.modify(provider.id, async () => credential));
      const captured = await profiles.binding.capture(provider.id);
      expect(captured.facts.kind).toBe("managed");
      expect(await profiles.binding.runBound(captured, () => profiles.credentialStore.read(provider.id))).toEqual(credential);
      expect(await readFile(path, "utf8")).toBe("synthetic-external-key");
    });
  });
});
