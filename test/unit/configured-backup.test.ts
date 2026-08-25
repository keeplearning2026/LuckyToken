import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configuredBackupFiles,
  configuredCredentialProfileBackupSnapshot,
  recoveryBackupSnapshots,
} from "../../src/backup/configured.js";
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
    expect(files.find((file) => file.id === "provider-credentials")).toBeUndefined();
    expect(configuredCredentialProfileBackupSnapshot(config)).toMatchObject({
      id: "provider-credential-profiles",
      contract: "Token-provider-credential-profiles",
      version: 1,
      category: "credentials",
    });
  });

  it("snapshots independent Provider records and never reads obsolete auth.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-profile-backup-"));
    try {
      const directory = join(root, "credential-profiles");
      await mkdir(directory, { recursive: true });
      await writeFile(join(root, "auth.json"), "obsolete-auth-canary", "utf8");
      await writeFile(
        join(directory, "provider-a.json"),
        '{"credential":"profile-secret"}',
        "utf8",
      );
      const source = configuredCredentialProfileBackupSnapshot({
        pi: { directory: root },
      } as TokenCliConfig);
      const snapshot = JSON.parse(Buffer.from(
        await source.snapshot(new AbortController().signal),
      ).toString("utf8")) as {
        providers: Array<{ providerId: string; record: string }>;
      };
      expect(snapshot.providers).toEqual([{
        providerId: "provider-a",
        record: Buffer.from('{"credential":"profile-secret"}').toString("base64"),
      }]);
      expect(JSON.stringify(snapshot)).not.toContain("obsolete-auth-canary");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
