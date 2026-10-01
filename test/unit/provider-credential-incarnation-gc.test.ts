import { syntheticCodexAccess } from "../support/codex-credential-fixture.js";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { Credential } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  createFileProviderCredentialRecordStore,
  createInMemoryProviderCredentialRecordStore,
  credentialIncarnationReference,
  NO_PROVIDER_RECORD_REVISION,
  PROVIDER_CREDENTIAL_RECORD_SCHEMA_VERSION,
  type PersistedProviderCredentialRecordV2,
  type ProviderCredentialRecordStore,
} from "../../src/credentials/profile-record-store.js";

const providerId = "openai-codex";
const credentialId = "credential-a";
const credential: Credential = {
  type: "oauth",
  access: syntheticCodexAccess("access-a"),
  refresh: "refresh-a",
  expires: 1_900_000_000_000,
};

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
      kind: "incarnation", incarnation: credentialIncarnationReference(
        providerId,
        credentialId,
        input.credentialGeneration,
        input.credential,
      ),
    }],
  };
}

function incarnationDirectory(piDirectory: string): string {
  return join(piDirectory, "credentials", providerId, credentialId);
}

function incarnationPath(piDirectory: string, generation: string): string {
  return join(incarnationDirectory(piDirectory), `${generation}.auth.json`);
}

function recordPath(piDirectory: string): string {
  return join(piDirectory, "credential-profiles", `${providerId}.json`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function publishFirstIncarnation(
  store: ProviderCredentialRecordStore,
  generation: string,
): Promise<void> {
  const result = await store.publishCredential(
    providerId,
    NO_PROVIDER_RECORD_REVISION,
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

describe("Provider credential orphan collection", () => {
  it("never collects an unreferenced document before the grace period", async () => {
    const piDirectory = await mkdtemp(join(tmpdir(), "Token-incarnation-grace-"));
    try {
      const store = createFileProviderCredentialRecordStore({
        piDirectory,
        createRevision: () => "revision-1",
      });
      await publishFirstIncarnation(store, "generation-1");
      const orphan = incarnationPath(piDirectory, "generation-orphan");
      await mkdir(incarnationDirectory(piDirectory), { recursive: true });
      await writeFile(orphan, JSON.stringify(credential), "utf8");

      await expect(
        store.collectOrphans(providerId, { graceMs: 60_000 }),
      ).resolves.toEqual([]);
      expect(await exists(orphan)).toBe(true);
      expect(await exists(incarnationPath(piDirectory, "generation-1"))).toBe(true);

      await expect(
        store.collectOrphans(providerId, {
          graceMs: 1_000,
          now: () => Date.now() + 5_000,
        }),
      ).resolves.toEqual([
        `${providerId}/${credentialId}/generation-orphan.auth.json`,
      ]);
      expect(await exists(orphan)).toBe(false);
      // The referenced incarnation is never collected.
      expect(await exists(incarnationPath(piDirectory, "generation-1"))).toBe(true);
    } finally {
      await rm(piDirectory, { recursive: true, force: true });
    }
  });

  it("cannot delete a document while the publication lock is held", async () => {
    const piDirectory = await mkdtemp(join(tmpdir(), "Token-incarnation-gc-lock-"));
    const pause = deferred();
    const paused = deferred();
    try {
      const store = createFileProviderCredentialRecordStore({
        piDirectory,
        createRevision: () => "revision-1",
      });
      await publishFirstIncarnation(store, "generation-1");

      const pausedStore = createFileProviderCredentialRecordStore({
        piDirectory,
        createRevision: () => "revision-2",
        hooks: {
          afterIncarnationPublication: async () => {
            paused.resolve();
            await pause.promise;
          },
        },
      });
      const publication = pausedStore.publishCredential(
        providerId,
        "revision-1",
        {
          credentialId,
          credentialGeneration: "generation-2",
          credential: { ...credential, access: syntheticCodexAccess("access-b") },
        },
        () => ({
          kind: "commit",
          record: recordFor({
            credentialGeneration: "generation-2",
            credential: { ...credential, access: syntheticCodexAccess("access-b") },
          }),
          value: undefined,
        }),
      );
      await paused.promise;

      // The new document exists while the record still references generation
      // 1; grace is zero, so only the shared publication lock can protect it.
      const onDisk = JSON.parse(await readFile(recordPath(piDirectory), "utf8")) as {
        profiles: Array<{ credentialGeneration: string }>;
      };
      expect(onDisk.profiles[0]!.credentialGeneration).toBe("generation-1");
      expect(await exists(incarnationPath(piDirectory, "generation-2"))).toBe(true);

      let collected: readonly string[] | undefined;
      const collection = store
        .collectOrphans(providerId, { graceMs: 0 })
        .then((deleted) => {
          collected = deleted;
        });
      await sleep(50);
      expect(collected).toBeUndefined();

      pause.resolve();
      await expect(publication).resolves.toMatchObject({ kind: "committed" });
      await collection;
      // Generation 1 became a genuine orphan only after the switch committed;
      // the document published under the held lock is never collected.
      expect(collected).toEqual([
        `${providerId}/${credentialId}/generation-1.auth.json`,
      ]);
      expect(await exists(incarnationPath(piDirectory, "generation-2"))).toBe(true);
      const committed = await store.read(providerId);
      expect(committed?.profiles[0]!.credentialGeneration).toBe("generation-2");
    } finally {
      pause.resolve();
      await rm(piDirectory, { recursive: true, force: true });
    }
  });

  it("removes the reference before the document and collects it afterwards", async () => {
    const piDirectory = await mkdtemp(join(tmpdir(), "Token-incarnation-delete-"));
    try {
      const store = createFileProviderCredentialRecordStore({
        piDirectory,
        createRevision: () => "revision-1",
      });
      await publishFirstIncarnation(store, "generation-1");
      const removed = await store.modifyManagement(
        providerId,
        "revision-1",
        (current) => ({
          kind: "commit",
          record: {
            schemaVersion: current!.schemaVersion,
            providerId: current!.providerId,
            revision: current!.revision,
            selectionGeneration: current!.selectionGeneration,
            switchPolicy: current!.switchPolicy,
            profiles: [],
          },
          value: undefined,
        }),
      );
      expect(removed.kind).toBe("committed");
      expect(await exists(incarnationPath(piDirectory, "generation-1"))).toBe(true);
      await expect(store.collectOrphans(providerId, { graceMs: 0 })).resolves.toEqual([
        `${providerId}/${credentialId}/generation-1.auth.json`,
      ]);
      expect(await exists(incarnationPath(piDirectory, "generation-1"))).toBe(false);
    } finally {
      await rm(piDirectory, { recursive: true, force: true });
    }
  });

  it("refuses symlinked documents and never touches a path outside the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-incarnation-link-"));
    try {
      const piDirectory = join(root, "pi");
      const outsidePath = join(root, "outside-secret.json");
      await writeFile(outsidePath, "outside-secret-canary", "utf8");
      const store = createFileProviderCredentialRecordStore({
        piDirectory,
        createRevision: () => "revision-1",
      });
      await publishFirstIncarnation(store, "generation-1");
      const linkPath = incarnationPath(piDirectory, "generation-link");
      let linkCreated = false;
      try {
        await symlink(outsidePath, linkPath, "file");
        linkCreated = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          process.platform !== "win32" ||
          (code !== "EPERM" && code !== "EACCES" && code !== "UNKNOWN")
        ) {
          throw error;
        }
      }
      if (linkCreated) {
        await expect(store.collectOrphans(providerId, { graceMs: 0 })).resolves.toEqual([]);
        expect(await exists(linkPath)).toBe(true);
      }
      // The outside document is never followed, read, or deleted.
      expect(await readFile(outsidePath, "utf8")).toBe("outside-secret-canary");
      expect(await exists(incarnationPath(piDirectory, "generation-1"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed on record references that escape the credential directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-incarnation-escape-"));
    try {
      const piDirectory = join(root, "pi");
      const outsidePath = join(root, "outside-secret.json");
      await writeFile(outsidePath, "outside-secret-canary", "utf8");
      const store = createFileProviderCredentialRecordStore({
        piDirectory,
        createRevision: () => "revision-1",
      });
      await mkdir(join(piDirectory, "credential-profiles"), { recursive: true });
      await writeFile(
        recordPath(piDirectory),
        JSON.stringify({
          schemaVersion: PROVIDER_CREDENTIAL_RECORD_SCHEMA_VERSION,
          providerId,
          revision: "revision-1",
          selectionGeneration: "selection-a",
          activeCredentialId: credentialId,
          switchPolicy: { apiKeyOn429: false, oauthOn429: false },
          profiles: [{
            credentialId,
            credentialGeneration: "generation-escape",
            authType: "oauth",
            authMethodLabel: "Fixture credentials",
            displayName: "Escape profile",
            enabled: true,
            priority: 0,
            createdAt: 1,
            updatedAt: 1,
            incarnation: {
              relativePath: "../../outside-secret.json",
              tokenRevision: "0".repeat(64),
            },
          }],
        }),
        "utf8",
      );
      await expect(store.read(providerId)).rejects.toMatchObject({
        code: "PROVIDER_CREDENTIAL_RECORD_SHAPE",
      });
      expect(await readFile(outsidePath, "utf8")).toBe("outside-secret-canary");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps in-memory orphan collection on the same grace contract", async () => {
    const revisions = ["revision-1", "revision-2"];
    const store = createInMemoryProviderCredentialRecordStore({
      createRevision: () => revisions.shift() ?? "unexpected-revision",
      now: () => 1_000,
    });
    await publishFirstIncarnation(store, "generation-1");
    await store.publishCredential(
      providerId,
      "revision-1",
      {
        credentialId,
        credentialGeneration: "generation-2",
        credential: { ...credential, access: syntheticCodexAccess("access-b") },
      },
      () => ({
        kind: "commit",
        record: recordFor({
          credentialGeneration: "generation-2",
          credential: { ...credential, access: syntheticCodexAccess("access-b") },
        }),
        value: undefined,
      }),
    );
    await expect(
      store.collectOrphans(providerId, { graceMs: 60_000, now: () => 2_000 }),
    ).resolves.toEqual([]);
    await expect(
      store.collectOrphans(providerId, { graceMs: 0, now: () => 2_000 }),
    ).resolves.toEqual([
      `${providerId}/${credentialId}/generation-1.auth.json`,
    ]);
  });
});
