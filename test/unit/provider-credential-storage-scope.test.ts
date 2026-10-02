import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { expect, it } from "vitest";
import { createProviderCredentialProfiles } from "../../src/credentials/profile-authority.js";
import { createFileProviderCredentialRecordStore, createInMemoryProviderCredentialRecordStore, parseProviderCredentialRecord, type PersistedProviderCredentialRecordV2 } from "../../src/credentials/profile-record-store.js";
import { createFixtureProvider } from "../support/credential-fixture.js";

it.each(["both", "neither", "inline-carrier", "incarnation-carrier"])("rejects obsolete credential carriers at parsing and construction: %s", async (caseName) => {
  const providerId = "fixture";
  const carrier = caseName === "both" ? { kind: "inline", inline: { type: "api_key", key: "synthetic" }, incarnation: {} }
    : caseName === "neither" ? { kind: "inline" }
    : caseName === "inline-carrier" ? { kind: "inline", inline: { type: "api_key", key: "synthetic" } }
    : { kind: "incarnation", incarnation: { relativePath: "fixture/id/generation.auth.json", tokenRevision: "a".repeat(64) } };
  const record = { schemaVersion: 2, providerId, revision: "absent", selectionGeneration: "selection",
    switchPolicy: { apiKeyOn429: false, oauthOn429: false }, profiles: [{ credentialId: "id", credentialGeneration: "generation",
      authType: "api_key", authMethodLabel: "Fixture", displayName: "Fixture", enabled: true,
      priority: 0, createdAt: 1, updatedAt: 1, ...carrier }] } as unknown as PersistedProviderCredentialRecordV2;
  expect(() => parseProviderCredentialRecord(JSON.stringify(record), providerId)).toThrow();
  const store = createInMemoryProviderCredentialRecordStore({ createRevision: () => "next" });
  await expect(store.modifyManagement(providerId, "absent", () => ({ kind: "commit", record, value: undefined }))).rejects.toThrow();
  await expect(store.modifySelection(providerId, () => ({ kind: "commit", record, value: undefined }))).rejects.toThrow();
  expect(await store.read(providerId)).toBeUndefined();
});

it("persists every Provider payload as a referenced managed document", async () => {
  const root = await mkdtemp(join(tmpdir(), "Token-credential-scope-"));
  try {
    let id = 0;
    const store = createFileProviderCredentialRecordStore({ piDirectory: root, createRevision: () => `revision-${++id}` });
    const fixture = createFixtureProvider();
    const codex = builtinProviders().find((provider) => provider.id === "openai-codex")!;
    const profiles = createProviderCredentialProfiles({ recordStore: store,
      providers: () => [fixture, codex], createId: () => `id-${++id}`, now: () => 1 });
    const inline = { type: "api_key" as const, key: "synthetic-secret", env: { CUSTOM: "opaque-value" } };
    const login = await profiles.binding.createLoginBinding({ providerId: fixture.id, acquisitionKind: "api_key", displayName: "Fixture", useNow: true, expectedRevision: "absent" });
    await profiles.binding.runBound(login, () => profiles.credentialStore.modify(fixture.id, async () => inline));
    const record = (await store.read(fixture.id))!;
    const profile = record.profiles[0]!;
    expect(profile.kind).toBe("reference");
    if (profile.kind !== "reference") throw new Error("Missing credential reference");
    expect(profile.reference.owner).toBe("managed");
    expect(JSON.parse(await readFile(join(root, "credentials", profile.reference.path), "utf8")))
      .toMatchObject({ type: "api_key", key: "synthetic-secret", env: { CUSTOM: "opaque-value" } });
    expect((await store.readCredential(fixture.id, profile.credentialId, profile.credentialGeneration)))
      .toMatchObject({ state: "ok", credential: inline });

    const access = `header.${Buffer.from(JSON.stringify({ exp: 1_900_000_000,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" },
    })).toString("base64url")}.signature`;
    const codexLogin = await profiles.binding.createLoginBinding({ providerId: codex.id, acquisitionKind: "oauth", displayName: "Codex", useNow: true, expectedRevision: "absent" });
    await profiles.binding.runBound(codexLogin, () => profiles.credentialStore.modify(codex.id, async () => ({ type: "oauth", access, refresh: "synthetic-refresh", expires: 1_900_000_000_000 })));
    const codexRecord = (await store.read(codex.id))!;
    const codexProfile = codexRecord.profiles[0]!;
    expect(codexProfile.kind).toBe("reference");
    if (codexProfile.kind !== "reference") throw new Error("Missing Codex credential reference");
    expect(codexProfile.reference.owner).toBe("managed");
    const document = JSON.parse(await readFile(join(root, "credentials", codexProfile.reference.path), "utf8"));
    expect(document).toMatchObject({ auth_mode: "chatgpt", tokens: { access_token: access, refresh_token: "synthetic-refresh", account_id: "acct-test" } });
    expect(document).not.toHaveProperty("type");
    expect((await store.readCredential(codex.id, codexProfile.credentialId, codexProfile.credentialGeneration))).toMatchObject({ state: "ok", credential: { type: "oauth", access } });
  } finally { await rm(root, { recursive: true, force: true }); }
});
