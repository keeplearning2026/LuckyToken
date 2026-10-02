import { syntheticCodexAccess } from "../support/codex-credential-fixture.js";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { Credential } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { configuredCredentialProfileBackupSnapshot } from "../../src/backup/configured.js";
import type { TokenCliConfig } from "../../src/cli-config.js";
import {
  createFileProviderCredentialRecordStore,
  managedCredentialReference,
  NO_PROVIDER_RECORD_REVISION,
  PROVIDER_CREDENTIAL_RECORD_SCHEMA_VERSION,
  type PersistedProviderCredentialRecordV2,
  type ProviderCredentialRecordStore,
} from "../../src/credentials/profile-record-store.js";

const providerId = "openai-codex";
const credentialId = "credential-a";
const credentialA: Credential = {
  type: "oauth",
  access: syntheticCodexAccess("access-a"),
  refresh: "refresh-a",
  expires: 1_900_000_000_000,
};
const credentialB: Credential = {
  ...credentialA,
  access: syntheticCodexAccess("access-b"),
};

interface SnapshotProvider {
  readonly providerId: string;
  readonly record: string;
  readonly incarnations: readonly {
    readonly relativePath: string;
    readonly tokenRevision: string;
    readonly content: string;
  }[];
}

interface SnapshotDocument {
  readonly schemaVersion: string;
  readonly providers: readonly SnapshotProvider[];
}

function recordFor(input: {
  readonly credentialGeneration: string;
  readonly credential: Credential;
}): PersistedProviderCredentialRecordV2 {
  return {
    schemaVersion: PROVIDER_CREDENTIAL_RECORD_SCHEMA_VERSION,
    providerId,
    revision: NO_PROVIDER_RECORD_REVISION,
    selectionGeneration: `selection-${credentialId}`,
    activeCredentialId: credentialId,
    switchPolicy: { apiKeyOn429: false, oauthOn429: false },
    profiles: [{
      credentialId,
      credentialGeneration: input.credentialGeneration,
      authType: input.credential.type,
      authMethodLabel: "Fixture credentials",
      displayName: "Fixture profile",
      enabled: true,
      priority: 0,
      createdAt: 1,
      updatedAt: 1,
      kind: "reference", reference: managedCredentialReference(
        providerId,
        credentialId,
        input.credentialGeneration,
        input.credential,
      ),
    }],
  };
}

function snapshotSource(piDirectory: string) {
  return configuredCredentialProfileBackupSnapshot({
    pi: { directory: piDirectory },
  } as TokenCliConfig);
}

async function takeSnapshot(piDirectory: string): Promise<SnapshotDocument> {
  const source = snapshotSource(piDirectory);
  const bytes = await source.snapshot(new AbortController().signal);
  return JSON.parse(Buffer.from(bytes).toString("utf8")) as SnapshotDocument;
}

function decodedRecord(provider: SnapshotProvider): PersistedProviderCredentialRecordV2 {
  return JSON.parse(
    Buffer.from(provider.record, "base64").toString("utf8"),
  ) as PersistedProviderCredentialRecordV2;
}

function decodedIncarnations(
  provider: SnapshotProvider,
): readonly { readonly bytes: Buffer; readonly content: string }[] {
  return provider.incarnations.map((incarnation) => ({
    bytes: Buffer.from(incarnation.content, "base64"),
    content: incarnation.content,
  }));
}

function assertConsistentPair(provider: SnapshotProvider): void {
  const record = decodedRecord(provider);
  expect(provider.incarnations).toHaveLength(record.profiles.length);
  for (const profile of record.profiles) {
    const incarnation = provider.incarnations.find(
      (candidate) => candidate.relativePath === profile.reference!.path,
    );
    expect(incarnation).toBeDefined();
    const bytes = Buffer.from(incarnation!.content, "base64");
    expect(createHash("sha256").update(bytes).digest("hex"))
      .toBe(profile.reference!.revision);
    expect(incarnation!.tokenRevision).toBe(profile.reference!.revision);
  }
}

async function publishGeneration(
  store: ProviderCredentialRecordStore,
  expectedRevision: string,
  generation: string,
  credential: Credential,
): Promise<void> {
  const result = await store.publishCredential(
    providerId,
    expectedRevision,
    { credentialId, credentialGeneration: generation, credential },
    () => ({
      kind: "commit",
      record: recordFor({ credentialGeneration: generation, credential }),
      value: undefined,
    }),
  );
  expect(result.kind).toBe("committed");
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("sensitive Provider credential profile snapshot", () => {
  it("recovers an interrupted rotation before a backup without another OAuth refresh", async () => {
    const piDirectory = await mkdtemp(join(tmpdir(), "Token-incarnation-backup-recovery-"));
    try {
      const store = createFileProviderCredentialRecordStore({ piDirectory, createRevision: () => "revision-1",
        hooks: { afterIncarnationRotation: () => { throw new Error("crash before record commit"); } } });
      await publishGeneration(store, NO_PROVIDER_RECORD_REVISION, "generation-1", credentialA);
      await expect(store.modifyCredential(providerId, credentialId, "generation-1", async (current) => ({ ...current, access: syntheticCodexAccess("rotated") }))).rejects.toThrow("crash before record commit");
      const snapshot = await takeSnapshot(piDirectory);
      assertConsistentPair(snapshot.providers[0]!);
      expect(decodedRecord(snapshot.providers[0]!).revision).toBe("revision-1");
    } finally { await rm(piDirectory, { recursive: true, force: true }); }
  });
  it("captures the record and every referenced incarnation consistently", async () => {
    const piDirectory = await mkdtemp(join(tmpdir(), "Token-incarnation-backup-"));
    try {
      const store = createFileProviderCredentialRecordStore({
        piDirectory,
        createRevision: () => "revision-1",
      });
      await publishGeneration(store, NO_PROVIDER_RECORD_REVISION, "generation-1", credentialA);
      const recorded = (await store.read(providerId))!;

      // Unreferenced documents and Codex-owned external documents are never
      // copied into the snapshot.
      await writeFile(join(piDirectory, "auth.json"), "external-codex-canary", "utf8");
      const orphanDirectory = join(piDirectory, "credentials", providerId, credentialId);
      await mkdir(orphanDirectory, { recursive: true });
      await writeFile(
        join(orphanDirectory, "generation-orphan.auth.json"),
        "orphan-canary",
        "utf8",
      );

      const snapshot = await takeSnapshot(piDirectory);
      expect(snapshot.schemaVersion).toBe(
        "Token-provider-credential-profiles-backup-v2",
      );
      expect(snapshot.providers).toHaveLength(1);
      const provider = snapshot.providers[0]!;
      expect(provider.providerId).toBe(providerId);
      expect(decodedRecord(provider)).toMatchObject({
        schemaVersion: PROVIDER_CREDENTIAL_RECORD_SCHEMA_VERSION,
        revision: "revision-1",
      });
      expect(provider.incarnations).toEqual([{
        relativePath: `${providerId}/${credentialId}/generation-1.auth.json`,
        tokenRevision: recorded.profiles[0]!.reference!.revision,
        content: expect.any(String),
      }]);
      assertConsistentPair(provider);
      const serialized = JSON.stringify(snapshot);
      expect(serialized).not.toContain("external-codex-canary");
      expect(serialized).not.toContain("orphan-canary");
      expect(JSON.parse(decodedIncarnations(provider)[0]!.bytes.toString("utf8")))
        .toEqual({ auth_mode: "chatgpt", tokens: { access_token: credentialA.access,
          refresh_token: credentialA.refresh, account_id: "acct-test" }, last_refresh: null });
    } finally {
      await rm(piDirectory, { recursive: true, force: true });
    }
  });

  it("yields a consistent pair throughout a reference switch", async () => {
    const piDirectory = await mkdtemp(join(tmpdir(), "Token-incarnation-backup-switch-"));
    const pause = deferred();
    const paused = deferred();
    try {
      const store = createFileProviderCredentialRecordStore({
        piDirectory,
        createRevision: () => "revision-1",
      });
      await publishGeneration(store, NO_PROVIDER_RECORD_REVISION, "generation-1", credentialA);

      const switching = createFileProviderCredentialRecordStore({
        piDirectory,
        createRevision: () => "revision-2",
        hooks: {
          afterIncarnationPublication: async () => {
            paused.resolve();
            await pause.promise;
          },
        },
      });
      const publication = publishGeneration(
        switching,
        "revision-1",
        "generation-2",
        credentialB,
      );
      await paused.promise;

      const duringSwitch = await takeSnapshot(piDirectory);
      const beforeProvider = duringSwitch.providers[0]!;
      expect(decodedRecord(beforeProvider).profiles[0]!.credentialGeneration)
        .toBe("generation-1");
      assertConsistentPair(beforeProvider);

      pause.resolve();
      await publication;
      const afterSwitch = await takeSnapshot(piDirectory);
      const afterProvider = afterSwitch.providers[0]!;
      expect(decodedRecord(afterProvider).profiles[0]!.credentialGeneration)
        .toBe("generation-2");
      assertConsistentPair(afterProvider);
    } finally {
      pause.resolve();
      await rm(piDirectory, { recursive: true, force: true });
    }
  });

  it("retries an in-flight rotation instead of returning a torn pair", async () => {
    const piDirectory = await mkdtemp(join(tmpdir(), "Token-incarnation-backup-rotation-"));
    const pause = deferred();
    const paused = deferred();
    try {
      const store = createFileProviderCredentialRecordStore({
        piDirectory,
        createRevision: () => "revision-1",
        hooks: {
          afterIncarnationRotation: async () => {
            paused.resolve();
            await pause.promise;
          },
        },
      });
      await publishGeneration(store, NO_PROVIDER_RECORD_REVISION, "generation-1", credentialA);

      const rotation = store.modifyCredential(
        providerId,
        credentialId,
        "generation-1",
        async (current) => ({ ...current, access: syntheticCodexAccess("access-rotated") }),
      );
      await paused.promise;

      const snapshotting = takeSnapshot(piDirectory);
      await sleep(40);
      pause.resolve();
      await rotation;
      const snapshot = await snapshotting;

      const provider = snapshot.providers[0]!;
      const record = decodedRecord(provider);
      expect(record.revision).toBe("revision-1");
      assertConsistentPair(provider);
      const incarnation = decodedIncarnations(provider)[0]!;
      expect(JSON.parse(incarnation.bytes.toString("utf8"))).toMatchObject({
        tokens: { access_token: syntheticCodexAccess("access-rotated") },
      });
      expect(record.profiles[0]!.reference!.revision)
        .toBe(createHash("sha256").update(incarnation.bytes).digest("hex"));
      await expect(readFile(
        join(
          piDirectory,
          "credentials",
          record.profiles[0]!.reference!.path,
        ),
      )).resolves.toEqual(incarnation.bytes);
    } finally {
      pause.resolve();
      await rm(piDirectory, { recursive: true, force: true });
    }
  });

  it("fails closed when a record is not the current contract", async () => {
    const piDirectory = await mkdtemp(join(tmpdir(), "Token-incarnation-backup-format-"));
    try {
      const directory = join(piDirectory, "credential-profiles");
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, `${providerId}.json`),
        JSON.stringify({ schemaVersion: 1, credential: "legacy-secret" }),
        "utf8",
      );
      await expect(takeSnapshot(piDirectory)).rejects.toMatchObject({
        code: "PROVIDER_CREDENTIAL_RECORD_SHAPE",
      });
    } finally {
      await rm(piDirectory, { recursive: true, force: true });
    }
  });
});
