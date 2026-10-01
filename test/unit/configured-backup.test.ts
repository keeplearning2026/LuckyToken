import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configuredBackupFiles,
  configuredCredentialProfileBackupSnapshot,
  recoveryBackupSnapshots,
} from "../../src/backup/configured.js";
import {
  credentialIncarnationReference,
  createFileProviderCredentialRecordStore,
} from "../../src/credentials/profile-record-store.js";
import type { TokenCliConfig } from "../../src/cli-config.js";

describe("configured backup contract versions", () => {
  it("recovery backup never reads or snapshots legacy diagnostics stores", () => {
    const config = {
      schemaVersion: "token-config-v2",
      pi: {
        directory: "C:\\Token",
        modelsJson: "C:\\Token\\models.json",
      },
    } as Record<string, unknown>;
    for (const name of [
      "runtimeDiagnostics",
      "requestLedger",
      "deepDiagnostics",
      "failureLogging",
    ]) {
      Object.defineProperty(config, name, {
        get(): never {
          throw new Error(`legacy config was read: ${name}`);
        },
      });
    }

    const snapshots = recoveryBackupSnapshots(
      config as unknown as TokenCliConfig,
    );
    expect(snapshots).toEqual([]);
    expect(Object.isFrozen(snapshots)).toBe(true);
  });

  it("tracks models and replaces obsolete auth.json backup with Provider Profile records", () => {
    const config = {
      schemaVersion: 1,
      pi: {
        directory: "C:\\Token",
        modelsJson: "C:\\Token\\models.json",
      },
    } as unknown as TokenCliConfig;

    const files = configuredBackupFiles("C:\\Token\\config.json", config);
    expect(files.find((file) => file.id === "models")).toMatchObject({
      contract: "pi-models-json",
      version: "0.84.2",
    });
    expect(files.find((file) => file.id === "commandcode-models")).toMatchObject({
      path: "C:\\Token\\commandcode-models.json",
      contract: "token-commandcode-models",
      version: "token-commandcode-models-v2",
      optional: true,
    });
    expect(files.find((file) => file.id === "provider-credentials")).toBeUndefined();
    expect(configuredCredentialProfileBackupSnapshot(config)).toMatchObject({
      id: "provider-credential-profiles",
      contract: "Token-provider-credential-profiles",
      version: 2,
      category: "credentials",
    });
  });

  it("treats an absent Provider record directory as an empty sensitive snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-profile-backup-empty-"));
    try {
      const source = configuredCredentialProfileBackupSnapshot({
        pi: { directory: root },
      } as TokenCliConfig);

      const snapshot = JSON.parse(
        Buffer.from(await source.snapshot(new AbortController().signal)).toString("utf8"),
      ) as { providers: readonly unknown[] };

      expect(snapshot.providers).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("snapshots independent Provider records and never reads obsolete auth.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-profile-backup-"));
    try {
      const directory = join(root, "credential-profiles");
      await mkdir(directory, { recursive: true });
      await writeFile(join(root, "auth.json"), "obsolete-auth-canary", "utf8");
      const store = createFileProviderCredentialRecordStore({
        piDirectory: root,
        createRevision: () => "revision-a",
      });
      const credential = { type: "api_key", key: "profile-secret" } as const;
      await store.publishIncarnation(
        "provider-a",
        "absent",
        {
          credentialId: "credential-a",
          credentialGeneration: "generation-a",
          credential,
        },
        () => ({
          kind: "commit",
          record: {
            schemaVersion: 2,
            providerId: "provider-a",
            revision: "record-a",
            selectionGeneration: "selection-a",
            activeCredentialId: "credential-a",
            switchPolicy: { apiKeyOn429: false, oauthOn429: false },
            profiles: [
              {
                credentialId: "credential-a",
                credentialGeneration: "generation-a",
                authType: "api_key",
                authMethodLabel: "Fixture credentials",
                displayName: "Profile A",
                enabled: true,
                priority: 0,
                createdAt: 1,
                updatedAt: 1,
                incarnation: credentialIncarnationReference(
                  "provider-a",
                  "credential-a",
                  "generation-a",
                  credential,
                ),
              },
            ],
          },
          value: undefined,
        }),
      );
      const source = configuredCredentialProfileBackupSnapshot({
        pi: { directory: root },
      } as TokenCliConfig);
      const snapshot = JSON.parse(Buffer.from(
        await source.snapshot(new AbortController().signal),
      ).toString("utf8")) as {
        providers: Array<{
          providerId: string;
          record: string;
          incarnations: Array<{
            relativePath: string;
            tokenRevision: string;
            content: string;
          }>;
        }>;
      };
      expect(snapshot.providers).toHaveLength(1);
      expect(snapshot.providers[0]).toMatchObject({
        providerId: "provider-a",
        record: (
          await readFile(join(directory, "provider-a.json"))
        ).toString("base64"),
      });
      expect(snapshot.providers[0]?.incarnations).toHaveLength(1);
      const incarnation = snapshot.providers[0]!.incarnations[0]!;
      expect(incarnation.relativePath).toBe(
        "provider-a/credential-a/generation-a.auth.json",
      );
      const incarnationBytes = Buffer.from(incarnation.content, "base64");
      expect(createHash("sha256").update(incarnationBytes).digest("hex")).toBe(
        incarnation.tokenRevision,
      );
      expect(JSON.stringify(snapshot)).not.toContain("obsolete-auth-canary");
      expect(incarnationBytes.toString("utf8")).toContain("profile-secret");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
