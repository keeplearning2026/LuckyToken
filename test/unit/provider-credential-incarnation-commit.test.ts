import { syntheticCodexAccess } from "../support/codex-credential-fixture.js";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Credential } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  createFileProviderCredentialRecordStore,
  createInMemoryProviderCredentialRecordStore,
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

function recordFor(input: {
  readonly credentialId: string;
  readonly credentialGeneration: string;
  readonly credential: Credential;
  readonly revision?: string | undefined;
  readonly displayName?: string;
}): PersistedProviderCredentialRecordV2 {
  return {
    schemaVersion: PROVIDER_CREDENTIAL_RECORD_SCHEMA_VERSION,
    providerId,
    revision: input.revision ?? NO_PROVIDER_RECORD_REVISION,
    selectionGeneration: `selection-${input.credentialId}`,
    activeCredentialId: input.credentialId,
    switchPolicy: { apiKeyOn429: false, oauthOn429: false },
    profiles: [{
      credentialId: input.credentialId,
      credentialGeneration: input.credentialGeneration,
      authType: input.credential.type,
      authMethodLabel: "Fixture credentials",
      displayName: input.displayName ?? "Fixture profile",
      enabled: true,
      priority: 0,
      createdAt: 1,
      updatedAt: 1,
      kind: "reference", reference: managedCredentialReference(
        providerId,
        input.credentialId,
        input.credentialGeneration,
        input.credential,
      ),
    }],
  };
}

function recordPath(piDirectory: string): string {
  return join(piDirectory, "credential-profiles", `${providerId}.json`);
}

function incarnationPath(
  piDirectory: string,
  id: string,
  generation: string,
): string {
  return join(
    piDirectory,
    "credentials",
    providerId,
    id,
    `${generation}.auth.json`,
  );
}

function hashFile(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function assertRecordFileConsistency(
  store: ProviderCredentialRecordStore,
  piDirectory: string,
): Promise<void> {
  const record = await store.read(providerId);
  if (record === undefined) return;
  for (const profile of record.profiles) {
    const read = await store.readCredential(
      providerId,
      profile.credentialId,
      profile.credentialGeneration,
    );
    expect(read.state).toBe("ok");
    if (read.state !== "ok") continue;
    expect(read.tokenRevision).toBe(profile.reference!.revision);
    const bytes = await readFile(
      join(piDirectory, "credentials", profile.reference!.path),
    );
    expect(hashFile(bytes)).toBe(profile.reference!.revision);
  }
}

describe("Provider credential incarnation commit protocol", () => {
  it("refuses publication through a parent junction without writing secrets outside", async () => {
    const piDirectory = await mkdtemp(join(tmpdir(), "Token-incarnation-junction-"));
    try {
      const outside = join(piDirectory, "outside");
      const parent = join(piDirectory, "credentials", providerId);
      await mkdir(outside);
      await mkdir(parent, { recursive: true });
      await symlink(outside, join(parent, credentialId), process.platform === "win32" ? "junction" : "dir");
      const store = createFileProviderCredentialRecordStore({ piDirectory, createRevision: () => "revision-1" });
      await expect(store.publishCredential(providerId, NO_PROVIDER_RECORD_REVISION, {
        credentialId, credentialGeneration: "generation-1", credential: credentialA,
      }, () => ({ kind: "commit", record: recordFor({
        credentialId, credentialGeneration: "generation-1", credential: credentialA,
      }), value: undefined }))).rejects.toThrow(/credential.*directory/i);
      expect(await readdir(outside)).toEqual([]);
      expect(await store.read(providerId)).toBeUndefined();
    } finally {
      await rm(piDirectory, { recursive: true, force: true });
    }
  });
  it("writes the incarnation document before switching the record reference", async () => {
    const piDirectory = await mkdtemp(join(tmpdir(), "Token-incarnation-commit-"));
    const revisions = ["revision-1", "revision-2"];
    const observations: Array<{
      readonly recordText?: string;
      readonly files: readonly string[];
    }> = [];
    try {
      const store = createFileProviderCredentialRecordStore({
        piDirectory,
        createRevision: () => revisions.shift() ?? "unexpected-revision",
        hooks: {
          afterIncarnationPublication: async () => {
            let recordText: string | undefined;
            try {
              recordText = await readFile(recordPath(piDirectory), "utf8");
            } catch {
              recordText = undefined;
            }
            const files = await readdir(
              join(piDirectory, "credentials", providerId, credentialId),
            );
            observations.push({
              ...(recordText === undefined ? {} : { recordText }),
              files: files.sort(),
            });
          },
        },
      });

      const first = await store.publishCredential(
        providerId,
        NO_PROVIDER_RECORD_REVISION,
        {
          credentialId,
          credentialGeneration: "generation-1",
          credential: credentialA,
        },
        () => ({
          kind: "commit",
          record: recordFor({
            credentialId,
            credentialGeneration: "generation-1",
            credential: credentialA,
          }),
          value: undefined,
        }),
      );
      expect(first.kind).toBe("committed");
      expect(observations[0]).toEqual({
        files: ["generation-1.auth.json"],
      });

      const second = await store.publishCredential(
        providerId,
        "revision-1",
        {
          credentialId,
          credentialGeneration: "generation-2",
          credential: credentialB,
        },
        () => ({
          kind: "commit",
          record: recordFor({
            credentialId,
            credentialGeneration: "generation-2",
            credential: credentialB,
          }),
          value: undefined,
        }),
      );
      expect(second.kind).toBe("committed");

      // Inside the second publication the new document already existed while
      // the persisted record still referenced generation 1.
      const observed = observations[1];
      expect(observed).toBeDefined();
      const observedRecord = JSON.parse(observed!.recordText!) as {
        revision: string;
        profiles: Array<{ credentialGeneration: string }>;
      };
      expect(observedRecord.revision).toBe("revision-1");
      expect(observedRecord.profiles[0]!.credentialGeneration).toBe("generation-1");
      expect(observed!.files).toEqual([
        "generation-1.auth.json",
        "generation-2.auth.json",
      ]);

      const record = await store.read(providerId);
      const profile = record!.profiles[0]!;
      expect(profile.credentialGeneration).toBe("generation-2");
      const bytes = await readFile(incarnationPath(piDirectory, credentialId, "generation-2"));
      expect(profile.reference!.revision).toBe(hashFile(bytes));
      expect(JSON.parse(bytes.toString("utf8"))).toEqual({ auth_mode: "chatgpt", tokens: {
        access_token: credentialB.access, refresh_token: credentialB.refresh, account_id: "acct-test",
      }, last_refresh: null });
    } finally {
      await rm(piDirectory, { recursive: true, force: true });
    }
  });

  it("leaves the old incarnation authoritative when the record commit fails", async () => {
    const piDirectory = await mkdtemp(join(tmpdir(), "Token-incarnation-crash-"));
    const revisions = ["revision-1"];
    try {
      const store = createFileProviderCredentialRecordStore({
        piDirectory,
        createRevision: () => revisions.shift() ?? "unexpected-revision",
      });
      await store.publishCredential(
        providerId,
        NO_PROVIDER_RECORD_REVISION,
        {
          credentialId,
          credentialGeneration: "generation-1",
          credential: credentialA,
        },
        () => ({
          kind: "commit",
          record: recordFor({
            credentialId,
            credentialGeneration: "generation-1",
            credential: credentialA,
          }),
          value: undefined,
        }),
      );

      const crashing = createFileProviderCredentialRecordStore({
        piDirectory,
        createRevision: () => "unexpected-revision",
        hooks: {
          afterIncarnationPublication: () => {
            throw new Error("simulated crash before record commit");
          },
        },
      });
      await expect(crashing.publishCredential(
        providerId,
        "revision-1",
        {
          credentialId,
          credentialGeneration: "generation-2",
          credential: credentialB,
        },
        () => ({
          kind: "commit",
          record: recordFor({
            credentialId,
            credentialGeneration: "generation-2",
            credential: credentialB,
          }),
          value: undefined,
        }),
      )).rejects.toThrow("simulated crash before record commit");

      // The record still references generation 1 and only that document is
      // consulted; the uncommitted generation 2 document is ignored.
      const record = await store.read(providerId);
      expect(record?.revision).toBe("revision-1");
      expect(record?.profiles[0]!.credentialGeneration).toBe("generation-1");
      await expect(
        store.readCredential(providerId, credentialId, "generation-1"),
      ).resolves.toMatchObject({ state: "ok", credential: credentialA });
      await expect(
        store.readCredential(providerId, credentialId, "generation-2"),
      ).resolves.toEqual({ state: "missing" });
      expect(await exists(incarnationPath(piDirectory, credentialId, "generation-2")))
        .toBe(true);

      const collected = await store.collectOrphans(providerId, { graceMs: 0 });
      expect(collected).toEqual([
        `${providerId}/${credentialId}/generation-2.auth.json`,
      ]);
      expect(await exists(incarnationPath(piDirectory, credentialId, "generation-2")))
        .toBe(false);
      await assertRecordFileConsistency(store, piDirectory);
    } finally {
      await rm(piDirectory, { recursive: true, force: true });
    }
  });

  it("never lets an old capture consume or overwrite a new grant", async () => {
    const piDirectory = await mkdtemp(join(tmpdir(), "Token-incarnation-old-"));
    const revisions = ["revision-1", "revision-2"];
    try {
      const store = createFileProviderCredentialRecordStore({
        piDirectory,
        createRevision: () => revisions.shift() ?? "unexpected-revision",
      });
      await store.publishCredential(
        providerId,
        NO_PROVIDER_RECORD_REVISION,
        {
          credentialId,
          credentialGeneration: "generation-1",
          credential: credentialA,
        },
        () => ({
          kind: "commit",
          record: recordFor({
            credentialId,
            credentialGeneration: "generation-1",
            credential: credentialA,
          }),
          value: undefined,
        }),
      );
      await store.publishCredential(
        providerId,
        "revision-1",
        {
          credentialId,
          credentialGeneration: "generation-2",
          credential: credentialB,
        },
        () => ({
          kind: "commit",
          record: recordFor({
            credentialId,
            credentialGeneration: "generation-2",
            credential: credentialB,
          }),
          value: undefined,
        }),
      );

      let mutations = 0;
      const oldCapture = await store.modifyCredential(
        providerId,
        credentialId,
        "generation-1",
        async () => {
          mutations += 1;
          return { ...credentialA, access: syntheticCodexAccess("stale-rotation") };
        },
      );
      expect(oldCapture).toBeUndefined();
      expect(mutations).toBe(0);
      await expect(
        store.readCredential(providerId, credentialId, "generation-1"),
      ).resolves.toEqual({ state: "missing" });
      await expect(
        store.readCredential(providerId, credentialId, "generation-2"),
      ).resolves.toMatchObject({ state: "ok", credential: credentialB });

      const stale = await store.publishCredential(
        providerId,
        "revision-1",
        {
          credentialId,
          credentialGeneration: "generation-1",
          credential: credentialA,
        },
        () => {
          throw new Error("stale publication must not reach the mutation");
        },
      );
      expect(stale.kind).toBe("revision_conflict");
      await assertRecordFileConsistency(store, piDirectory);
    } finally {
      await rm(piDirectory, { recursive: true, force: true });
    }
  });

  it("rotates inside the referenced incarnation without changing generations", async () => {
    const piDirectory = await mkdtemp(join(tmpdir(), "Token-incarnation-rotate-"));
    try {
      const store = createFileProviderCredentialRecordStore({
        piDirectory,
        createRevision: () => "revision-1",
      });
      await store.publishCredential(
        providerId,
        NO_PROVIDER_RECORD_REVISION,
        {
          credentialId,
          credentialGeneration: "generation-1",
          credential: credentialA,
        },
        () => ({
          kind: "commit",
          record: recordFor({
            credentialId,
            credentialGeneration: "generation-1",
            credential: credentialA,
          }),
          value: undefined,
        }),
      );

      const rotated = await store.modifyCredential(
        providerId,
        credentialId,
        "generation-1",
        async (current) => ({ ...current, access: syntheticCodexAccess("access-rotated") }),
      );
      expect(rotated).toMatchObject({ access: syntheticCodexAccess("access-rotated") });

      const record = await store.read(providerId);
      expect(record?.revision).toBe("revision-1");
      expect(record?.profiles[0]!.credentialGeneration).toBe("generation-1");
      const bytes = await readFile(incarnationPath(piDirectory, credentialId, "generation-1"));
      expect(JSON.parse(bytes.toString("utf8"))).toMatchObject({
        tokens: { access_token: syntheticCodexAccess("access-rotated") },
      });
      expect(record?.profiles[0]!.reference!.revision).toBe(hashFile(bytes));

      const declined = await store.modifyCredential(
        providerId,
        credentialId,
        "generation-1",
        async () => undefined,
      );
      expect(declined).toMatchObject({ access: syntheticCodexAccess("access-rotated") });
      await assertRecordFileConsistency(store, piDirectory);
    } finally {
      await rm(piDirectory, { recursive: true, force: true });
    }
  });

  it("reconciles a rotation whose record update failed from the same path only", async () => {
    const piDirectory = await mkdtemp(join(tmpdir(), "Token-incarnation-reconcile-"));
    let failNextRotation = true;
    try {
      const store = createFileProviderCredentialRecordStore({
        piDirectory,
        createRevision: () => "revision-1",
        hooks: {
          afterIncarnationRotation: () => {
            if (failNextRotation) {
              failNextRotation = false;
              throw new Error("simulated rotation record-commit failure");
            }
          },
        },
      });
      await store.publishCredential(
        providerId,
        NO_PROVIDER_RECORD_REVISION,
        {
          credentialId,
          credentialGeneration: "generation-1",
          credential: credentialA,
        },
        () => ({
          kind: "commit",
          record: recordFor({
            credentialId,
            credentialGeneration: "generation-1",
            credential: credentialA,
          }),
          value: undefined,
        }),
      );

      await expect(store.modifyCredential(
        providerId,
        credentialId,
        "generation-1",
        async () => ({ ...credentialA, access: syntheticCodexAccess("access-rotated") }),
      )).rejects.toThrow("simulated rotation record-commit failure");

      // The referenced document is newer than the record hash. The next read
      // reconciles it because the record still references the same path.
      const reconciled = await store.readCredential(
        providerId,
        credentialId,
        "generation-1",
      );
      expect(reconciled).toMatchObject({
        state: "ok",
        credential: { access: syntheticCodexAccess("access-rotated") },
      });
      const bytes = await readFile(incarnationPath(piDirectory, credentialId, "generation-1"));
      if (reconciled.state === "ok") {
        expect(reconciled.tokenRevision).toBe(hashFile(bytes));
      }
      const recoveredStore = createFileProviderCredentialRecordStore({
        piDirectory, createRevision: () => "must-not-change-management-revision",
      });
      await recoveredStore.readCredential(providerId, credentialId, "generation-1");
      const recoveredRecord = await recoveredStore.read(providerId);
      expect(recoveredRecord?.profiles[0]!.reference!.revision).toBe(hashFile(bytes));
      expect(recoveredRecord?.revision).toBe("revision-1");

      // A later successful rotation commits the reconciled revision.
      await store.modifyCredential(
        providerId,
        credentialId,
        "generation-1",
        async (current) => ({ ...current, access: syntheticCodexAccess("access-committed") }),
      );
      await assertRecordFileConsistency(store, piDirectory);
    } finally {
      await rm(piDirectory, { recursive: true, force: true });
    }
  });

  it("treats a referenced but missing or invalid document as unavailable", async () => {
    const piDirectory = await mkdtemp(join(tmpdir(), "Token-incarnation-missing-"));
    try {
      const store = createFileProviderCredentialRecordStore({
        piDirectory,
        createRevision: () => "revision-1",
      });
      await store.publishCredential(
        providerId,
        NO_PROVIDER_RECORD_REVISION,
        {
          credentialId,
          credentialGeneration: "generation-1",
          credential: credentialA,
        },
        () => ({
          kind: "commit",
          record: recordFor({
            credentialId,
            credentialGeneration: "generation-1",
            credential: credentialA,
          }),
          value: undefined,
        }),
      );
      const decoyPath = incarnationPath(piDirectory, credentialId, "generation-decoy");
      await writeFile(decoyPath, JSON.stringify(credentialB), "utf8");

      await rm(incarnationPath(piDirectory, credentialId, "generation-1"));
      await expect(
        store.readCredential(providerId, credentialId, "generation-1"),
      ).resolves.toEqual({ state: "missing" });
      let mutations = 0;
      await expect(store.modifyCredential(
        providerId,
        credentialId,
        "generation-1",
        async () => {
          mutations += 1;
          return credentialB;
        },
      )).resolves.toBeUndefined();
      expect(mutations).toBe(0);

      await writeFile(
        incarnationPath(piDirectory, credentialId, "generation-1"),
        "{ not-valid-json",
        "utf8",
      );
      await expect(
        store.readCredential(providerId, credentialId, "generation-1"),
      ).resolves.toEqual({ state: "invalid" });
      await expect(store.modifyCredential(
        providerId,
        credentialId,
        "generation-1",
        async () => {
          mutations += 1;
          return credentialB;
        },
      )).resolves.toBeUndefined();
      expect(mutations).toBe(0);
      expect(await exists(decoyPath)).toBe(true);
    } finally {
      await rm(piDirectory, { recursive: true, force: true });
    }
  });

  it("recovers a consistent record/file pair across reconnect, delete, and re-add", async () => {
    const piDirectory = await mkdtemp(join(tmpdir(), "Token-incarnation-lifecycle-"));
    const revisions = ["revision-1", "revision-2", "revision-3", "revision-4"];
    try {
      const store = createFileProviderCredentialRecordStore({
        piDirectory,
        createRevision: () => revisions.shift() ?? "unexpected-revision",
      });
      await store.publishCredential(
        providerId,
        NO_PROVIDER_RECORD_REVISION,
        {
          credentialId,
          credentialGeneration: "generation-1",
          credential: credentialA,
        },
        () => ({
          kind: "commit",
          record: recordFor({
            credentialId,
            credentialGeneration: "generation-1",
            credential: credentialA,
          }),
          value: undefined,
        }),
      );
      await assertRecordFileConsistency(store, piDirectory);

      await store.modifyCredential(
        providerId,
        credentialId,
        "generation-1",
        async (current) => ({ ...current, access: syntheticCodexAccess("access-rotated") }),
      );
      await assertRecordFileConsistency(store, piDirectory);

      await store.publishCredential(
        providerId,
        "revision-1",
        {
          credentialId,
          credentialGeneration: "generation-2",
          credential: credentialB,
        },
        () => ({
          kind: "commit",
          record: recordFor({
            credentialId,
            credentialGeneration: "generation-2",
            credential: credentialB,
          }),
          value: undefined,
        }),
      );
      await assertRecordFileConsistency(store, piDirectory);

      const collected = await store.collectOrphans(providerId, { graceMs: 0 });
      expect(collected).toEqual([
        `${providerId}/${credentialId}/generation-1.auth.json`,
      ]);
      await assertRecordFileConsistency(store, piDirectory);

      const removed = await store.modifyManagement(
        providerId,
        "revision-2",
        (current) => {
          const committed: PersistedProviderCredentialRecordV2 = {
            schemaVersion: current!.schemaVersion,
            providerId: current!.providerId,
            revision: current!.revision,
            selectionGeneration: current!.selectionGeneration,
            switchPolicy: current!.switchPolicy,
            profiles: [],
          };
          return { kind: "commit", record: committed, value: undefined };
        },
      );
      expect(removed.kind).toBe("committed");
      // Delete commits the reference removal first; the document survives
      // until orphan collection.
      expect(await exists(incarnationPath(piDirectory, credentialId, "generation-2")))
        .toBe(true);
      expect(await store.collectOrphans(providerId, { graceMs: 0 })).toEqual([
        `${providerId}/${credentialId}/generation-2.auth.json`,
      ]);
      expect(await exists(incarnationPath(piDirectory, credentialId, "generation-2")))
        .toBe(false);
      await expect(
        store.readCredential(providerId, credentialId, "generation-2"),
      ).resolves.toEqual({ state: "missing" });

      const readded = await store.publishCredential(
        providerId,
        "revision-3",
        {
          credentialId,
          credentialGeneration: "generation-3",
          credential: credentialA,
        },
        (current) => ({
          kind: "commit",
          record: recordFor({
            credentialId,
            credentialGeneration: "generation-3",
            credential: credentialA,
            revision: current?.revision,
          }),
          value: undefined,
        }),
      );
      expect(readded.kind).toBe("committed");
      await assertRecordFileConsistency(store, piDirectory);
    } finally {
      await rm(piDirectory, { recursive: true, force: true });
    }
  });

  it("fails closed on stale-format and malformed records without reinterpretation", async () => {
    const piDirectory = await mkdtemp(join(tmpdir(), "Token-incarnation-format-"));
    try {
      const store = createFileProviderCredentialRecordStore({
        piDirectory,
        createRevision: () => "unexpected-revision",
      });
      await mkdir(join(piDirectory, "credential-profiles"), { recursive: true });
      await writeFile(
        recordPath(piDirectory),
        JSON.stringify({
          schemaVersion: 1,
          providerId,
          revision: "revision-legacy",
          selectionGeneration: "selection-legacy",
          activeCredentialId: credentialId,
          switchPolicy: { apiKeyOn429: false, oauthOn429: false },
          profiles: [{
            credentialId,
            credentialGeneration: "generation-legacy",
            authType: "oauth",
            authMethodLabel: "Fixture credentials",
            displayName: "Legacy profile",
            enabled: true,
            priority: 0,
            createdAt: 1,
            updatedAt: 1,
            credential: credentialA,
          }],
        }),
        "utf8",
      );
      await expect(store.read(providerId)).rejects.toMatchObject({
        code: "PROVIDER_CREDENTIAL_RECORD_SHAPE",
      });
      await expect(
        store.readCredential(providerId, credentialId, "generation-legacy"),
      ).rejects.toMatchObject({ code: "PROVIDER_CREDENTIAL_RECORD_SHAPE" });

      await writeFile(recordPath(piDirectory), "{ definitely-not-json", "utf8");
      await expect(store.read(providerId)).rejects.toMatchObject({
        code: "PROVIDER_CREDENTIAL_RECORD_SYNTAX",
      });
    } finally {
      await rm(piDirectory, { recursive: true, force: true });
    }
  });

  it("reconciles interrupted in-memory rotation without changing logical identity", async () => {
    const store = createInMemoryProviderCredentialRecordStore({ createRevision: () => "revision-1",
      hooks: { afterIncarnationRotation: () => { throw new Error("interrupted"); } } });
    await store.publishCredential(providerId, "absent", { credentialId, credentialGeneration: "generation-1", credential: credentialA },
      () => ({ kind: "commit", record: recordFor({ credentialId, credentialGeneration: "generation-1", credential: credentialA }), value: undefined }));
    await expect(store.modifyCredential(providerId, credentialId, "generation-1", async () => credentialB)).rejects.toThrow("interrupted");
    const resolved = await store.readCredential(providerId, credentialId, "generation-1");
    expect(resolved).toMatchObject({ state: "ok", credential: credentialB });
    const record = (await store.read(providerId))!;
    expect(record.revision).toBe("revision-1");
    expect(record.profiles[0]!.credentialGeneration).toBe("generation-1");
    if (resolved.state !== "ok") throw new Error("Missing credential");
    expect(record.profiles[0]!.reference!.revision).toBe(resolved.tokenRevision);
  });

  it("keeps the in-memory store on the same commit contract", async () => {
    const revisions = ["revision-1", "revision-2"];
    const store = createInMemoryProviderCredentialRecordStore({
      createRevision: () => revisions.shift() ?? "unexpected-revision",
      now: () => 1_000,
    });
    await store.publishCredential(
      providerId,
      NO_PROVIDER_RECORD_REVISION,
      {
        credentialId,
        credentialGeneration: "generation-1",
        credential: credentialA,
      },
      () => ({
        kind: "commit",
        record: recordFor({
          credentialId,
          credentialGeneration: "generation-1",
          credential: credentialA,
        }),
        value: undefined,
      }),
    );
    await expect(
      store.readCredential(providerId, credentialId, "generation-1"),
    ).resolves.toMatchObject({ state: "ok", credential: credentialA });
    await store.modifyCredential(
      providerId,
      credentialId,
      "generation-1",
      async (current) => ({ ...current, access: syntheticCodexAccess("access-memory-rotated") }),
    );
    await expect(
      store.readCredential(providerId, credentialId, "generation-1"),
    ).resolves.toMatchObject({
      state: "ok",
      credential: { access: syntheticCodexAccess("access-memory-rotated") },
    });
    await store.publishCredential(
      providerId,
      "revision-1",
      {
        credentialId,
        credentialGeneration: "generation-2",
        credential: credentialB,
      },
      () => ({
        kind: "commit",
        record: recordFor({
          credentialId,
          credentialGeneration: "generation-2",
          credential: credentialB,
        }),
        value: undefined,
      }),
    );
    let mutations = 0;
    await expect(store.modifyCredential(
      providerId,
      credentialId,
      "generation-1",
      async () => {
        mutations += 1;
        return credentialA;
      },
    )).resolves.toBeUndefined();
    expect(mutations).toBe(0);
    await expect(
      store.collectOrphans(providerId, { graceMs: 0, now: () => 2_000 }),
    ).resolves.toEqual([
      `${providerId}/${credentialId}/generation-1.auth.json`,
    ]);
    await expect(
      store.readCredential(providerId, credentialId, "generation-2"),
    ).resolves.toMatchObject({ state: "ok", credential: credentialB });
  });
});
