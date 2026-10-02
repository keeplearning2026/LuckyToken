import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";

import {
  createCodexLocalAcquisitionStrategy,
  LocalAcquisitionError,
  type LocalAcquisitionStrategy,
} from "../../src/credentials/acquisition.js";
import { createProviderCredentialProfiles } from "../../src/credentials/profile-authority.js";
import {
  createFileProviderCredentialRecordStore,
  createInMemoryProviderCredentialRecordStore,
  NO_PROVIDER_RECORD_REVISION,
  type ProviderCredentialRecordStore,
} from "../../src/credentials/profile-record-store.js";

const providerId = "openai-codex";
const provider = builtinProviders().find((item) => item.id === providerId)!;

function syntheticDocument(
  account = "account-a",
  expires = Date.now() + 3_600_000,
): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const access = [
    encode({ alg: "none" }),
    encode({
      exp: Math.floor(expires / 1000),
      "https://api.openai.com/auth": { chatgpt_account_id: account },
    }),
    "signature",
  ].join(".");
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: access,
      refresh_token: `refresh-${account}`,
      account_id: account,
    },
  });
}

async function isolated(
  operation: (root: string, authPath: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "Token-local-login-"));
  try {
    await operation(root, join(root, "auth.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function fixture(
  store: ProviderCredentialRecordStore,
  authPath: string,
  acquisition?: { reads: number },
): ReturnType<typeof createProviderCredentialProfiles> {
  const base = createCodexLocalAcquisitionStrategy({
    authPath,
    label: () => provider.auth.oauth!.name,
  });
  const strategy: LocalAcquisitionStrategy =
    acquisition === undefined
      ? base
      : Object.freeze({
          ...base,
          async acquire(signal?: AbortSignal) {
            acquisition.reads += 1;
            return base.acquire(signal);
          },
        });
  return createProviderCredentialProfiles({
    recordStore: store,
    providers: () => [provider],
    createId: randomUUID,
    now: Date.now,
    acquisitionStrategies: [strategy],
  });
}

const memory = () =>
  createInMemoryProviderCredentialRecordStore({ createRevision: randomUUID });

async function addLocal(
  profiles: ReturnType<typeof createProviderCredentialProfiles>,
  overrides: {
    readonly displayName?: string;
    readonly useNow?: boolean;
    readonly expectedRevision?: string;
  } = {},
) {
  const binding = await profiles.binding.createLoginBinding({
    providerId,
    acquisitionKind: "local_oauth",
    displayName: overrides.displayName ?? "Profile 1",
    useNow: overrides.useNow ?? true,
    expectedRevision:
      overrides.expectedRevision ?? NO_PROVIDER_RECORD_REVISION,
  });
  return profiles.binding.acquireLocal(binding);
}

describe("local Codex acquisition", () => {
  for (const storage of ["memory", "file"] as const) {
    it(`${storage}: forms one ordinary Profile that references the external document`, async () =>
      isolated(async (root, authPath) => {
        const store =
          storage === "memory"
            ? memory()
            : createFileProviderCredentialRecordStore({
                piDirectory: join(root, "pi"),
                createRevision: randomUUID,
              });
        const profiles = fixture(store, authPath);
        await writeFile(authPath, syntheticDocument(), "utf8");

        const published = await addLocal(profiles);
        const record = (await store.read(providerId))!;
        expect(record.activeCredentialId).toBe(published.credentialId);
        expect(record.profiles).toHaveLength(1);
        const profile = record.profiles[0]!;
        expect(profile).toMatchObject({
          credentialId: published.credentialId,
          credentialGeneration: published.credentialGeneration,
          strategyId: "codex_local",
          displayName: "Profile 1",
          enabled: true,
        });
        expect(profile.kind).toBe("reference");
        if (profile.kind !== "reference") return;
        expect(profile.reference.owner).toBe("external");
        expect(profile.reference.revision).toMatch(/^[0-9a-f]{64}$/u);

        const read = await store.readCredential(
          providerId,
          published.credentialId,
          published.credentialGeneration,
        );
        expect(read.state).toBe("ok");
        if (read.state !== "ok") return;
        expect(read.credential).toMatchObject({ type: "oauth" });
        expect(JSON.parse(await readFile(authPath, "utf8")).tokens.refresh_token)
          .toBe("refresh-account-a");

        const projection = await profiles.management.query();
        const projected = projection.providers[0]!.profiles[0]!;
        expect(projected.acquisitionKind).toBe("local_oauth");
        expect(projected.health).not.toBe("reconnect_required");
        expect(JSON.stringify(projection)).not.toContain("codex_local");
        expect(JSON.stringify(projection)).not.toContain("strategyId");
        expect(JSON.stringify(projection)).not.toContain(authPath.split(/[\\/]/u).pop()!);
      }));
  }

  it("fails without a Profile when the local document is missing, invalid or unsupported", async () =>
    isolated(async (root, authPath) => {
      const store = memory();
      const profiles = fixture(store, authPath);

      await expect(addLocal(profiles)).rejects.toBeInstanceOf(LocalAcquisitionError);
      expect(await store.read(providerId)).toBeUndefined();

      await writeFile(authPath, "", "utf8");
      await expect(addLocal(profiles)).rejects.toBeInstanceOf(LocalAcquisitionError);
      expect(await store.read(providerId)).toBeUndefined();

      await writeFile(authPath, "{truncated", "utf8");
      await expect(addLocal(profiles)).rejects.toBeInstanceOf(LocalAcquisitionError);
      expect(await store.read(providerId)).toBeUndefined();

      await writeFile(
        authPath,
        JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "synthetic" }),
        "utf8",
      );
      await expect(addLocal(profiles)).rejects.toBeInstanceOf(LocalAcquisitionError);
      expect(await store.read(providerId)).toBeUndefined();
    }));

  it("blocks a second local login without reading the source", async () =>
    isolated(async (_root, authPath) => {
      const store = memory();
      const acquisition = { reads: 0 };
      const profiles = fixture(store, authPath, acquisition);
      await writeFile(authPath, syntheticDocument(), "utf8");

      const first = await addLocal(profiles);
      const revision = (await store.read(providerId))!.revision;
      await expect(
        addLocal(profiles, { expectedRevision: revision, displayName: "Profile 2" }),
      ).rejects.toMatchObject({ outcome: "duplicate" });
      expect(acquisition.reads).toBe(1);
      const record = (await store.read(providerId))!;
      expect(record.profiles.map((item) => item.credentialId)).toEqual([
        first.credentialId,
      ]);
    }));

  it("reconnect keeps the Profile identity and replaces its credential revision", async () =>
    isolated(async (_root, authPath) => {
      const store = memory();
      const profiles = fixture(store, authPath);
      await writeFile(authPath, syntheticDocument(), "utf8");
      const first = await addLocal(profiles);

      const before = (await store.read(providerId))!;
      await profiles.management.updateMetadata({
        providerId,
        credentialId: first.credentialId,
        expectedRevision: before.revision,
        displayName: "Renamed",
        note: "kept note",
      });
      const renamed = (await store.read(providerId))!;

      await writeFile(authPath, syntheticDocument("account-b"), "utf8");
      const binding = await profiles.binding.createReconnectBinding({
        providerId,
        credentialId: first.credentialId,
        useNow: false,
        expectedRevision: renamed.revision,
      });
      const published = await profiles.binding.acquireLocal(binding);

      expect(published.credentialId).toBe(first.credentialId);
      expect(published.credentialGeneration).not.toBe(first.credentialGeneration);
      const after = (await store.read(providerId))!;
      expect(after.profiles).toHaveLength(1);
      expect(after.profiles[0]).toMatchObject({
        credentialId: first.credentialId,
        credentialGeneration: published.credentialGeneration,
        displayName: "Renamed",
        note: "kept note",
        enabled: true,
        strategyId: "codex_local",
      });
      expect(after.activeCredentialId).toBe(first.credentialId);
      expect(after.selectionGeneration).toBe(renamed.selectionGeneration);
      if (after.profiles[0]!.kind !== "reference") return;
      expect(after.profiles[0]!.reference.revision).not.toBe(
        renamed.profiles[0]!.kind === "reference"
          ? renamed.profiles[0]!.reference.revision
          : undefined,
      );
    }));

  it("reconnect failure leaves the existing Profile reconnecting", async () =>
    isolated(async (_root, authPath) => {
      const store = memory();
      const profiles = fixture(store, authPath);
      await writeFile(authPath, syntheticDocument(), "utf8");
      const first = await addLocal(profiles);
      const before = (await store.read(providerId))!;

      await rm(authPath, { force: true });
      const binding = await profiles.binding.createReconnectBinding({
        providerId,
        credentialId: first.credentialId,
        useNow: false,
        expectedRevision: before.revision,
      });
      await expect(profiles.binding.acquireLocal(binding)).rejects.toBeInstanceOf(
        LocalAcquisitionError,
      );
      const after = (await store.read(providerId))!;
      expect(after.revision).toBe(before.revision);
      expect(after.profiles[0]!.credentialGeneration).toBe(first.credentialGeneration);

      const projected = await profiles.management.query([providerId]);
      expect(
        projected.providers[0]!.profiles[0]!.health,
      ).toBe("reconnect_required");

      await writeFile(authPath, syntheticDocument(), "utf8");
      const recovered = await profiles.management.query([providerId]);
      expect(recovered.providers[0]!.profiles[0]!.health).not.toBe(
        "reconnect_required",
      );
    }));

  it("rejects an unsupported auth mode without an ambient fallback", async () =>
    isolated(async (_root, authPath) => {
      const store = memory();
      const profiles = fixture(store, authPath);
      await mkdir(authPath, { recursive: true });
      await expect(addLocal(profiles)).rejects.toBeInstanceOf(LocalAcquisitionError);
      expect(await store.read(providerId)).toBeUndefined();
    }));

  it("serves Pi from the external document and never lets refresh write it", async () =>
    isolated(async (_root, authPath) => {
      const store = memory();
      const profiles = fixture(store, authPath);
      await writeFile(authPath, syntheticDocument(), "utf8");
      const published = await addLocal(profiles);
      const capture = await profiles.binding.capture(providerId);

      const read = await profiles.binding.runBound(capture, () =>
        profiles.credentialStore.read(providerId),
      );
      expect(read).toMatchObject({ type: "oauth" });

      let callbackRan = false;
      const modified = await profiles.binding.runBound(capture, () =>
        profiles.credentialStore.modify(providerId, async () => {
          callbackRan = true;
          return { type: "oauth", access: "rotated", refresh: "rotated", expires: Date.now() + 3_600_000 };
        }),
      );
      expect(callbackRan).toBe(false);
      expect(modified).toEqual(read);
      expect(JSON.parse(await readFile(authPath, "utf8"))).toEqual(
        JSON.parse(syntheticDocument()),
      );
      const record = (await store.read(providerId))!;
      expect(record.profiles[0]!.kind).toBe("reference");
      if (record.profiles[0]!.kind !== "reference") return;
      expect(record.profiles[0]!.reference.revision).toBe(
        createHash("sha256").update(await readFile(authPath)).digest("hex"),
      );
      expect(record.profiles[0]!.credentialGeneration).toBe(
        published.credentialGeneration,
      );

      // Less than five minutes remain and Token cannot refresh the owner's
      // document, so the read fails closed instead of handing over a dying
      // token.
      await writeFile(authPath, syntheticDocument("account-a", Date.now() + 60_000), "utf8");
      await profiles.management.query([providerId]);
      await expect(
        profiles.binding.runBound(capture, () =>
          profiles.credentialStore.read(providerId),
        ),
      ).rejects.toMatchObject({ outcome: "stale_binding" });

      await rm(authPath, { force: true });
      await expect(
        profiles.binding.runBound(capture, () =>
          profiles.credentialStore.read(providerId),
        ),
      ).rejects.toMatchObject({ outcome: "stale_binding" });
    }));
});
