import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { LuckyTokenCliConfig } from "../cli-config.js";
import { stripJsonComments } from "../providers/models-json-schema.js";
import { PI_COMPATIBILITY_BASELINE } from "../providers/pi-baseline.js";
import {
  createBackupAuthority,
  type BackupAuthority,
  type BackupFileSource,
  type BackupSnapshotSource,
} from "./authority.js";

export interface ConfiguredBackupAuthorityOptions {
  readonly configPath: string;
  readonly config: LuckyTokenCliConfig;
  readonly applicationVersion: string;
  readonly snapshots: readonly BackupSnapshotSource[];
}

/** The complete explicit LuckyToken-owned file allowlist. Paths come only
 * from the already validated LuckyToken config; no external application's
 * default data directory is discovered. */
export function configuredBackupFiles(
  configPath: string,
  config: LuckyTokenCliConfig,
): readonly BackupFileSource[] {
  return Object.freeze([
    {
      id: "configuration",
      path: resolve(configPath),
      contract: "luckytoken-config",
      version: config.schemaVersion,
      category: "configuration",
    },
    {
      id: "models",
      path: config.pi.modelsJson,
      contract: "pi-models-json",
      version: PI_COMPATIBILITY_BASELINE.version,
      category: "configuration",
      optional: true,
      parseJson: (text: string) => JSON.parse(stripJsonComments(text)),
    },
    {
      id: "public-models",
      path: join(dirname(config.pi.modelsJson), "public-models.json"),
      contract: "luckytoken-public-models",
      version: 1,
      category: "configuration",
      optional: true,
      parseJson: (text: string) => JSON.parse(text),
    },
    {
      id: "settings",
      path: join(dirname(configPath), "settings.json"),
      contract: "luckytoken-settings",
      version: 1,
      category: "configuration",
      optional: true,
    },
  ] satisfies readonly BackupFileSource[]);
}

export function configuredCredentialProfileBackupSnapshot(
  config: LuckyTokenCliConfig,
): BackupSnapshotSource {
  const directory = join(config.pi.directory, "credential-profiles");
  return Object.freeze({
    id: "provider-credential-profiles",
    contract: "luckytoken-provider-credential-profiles",
    version: 1,
    category: "credentials" as const,
    sourcePath: directory,
    optional: true,
    async snapshot(signal: AbortSignal): Promise<Uint8Array> {
      signal.throwIfAborted();
      const entries = await readdir(directory, { withFileTypes: true });
      const providers: Array<{ providerId: string; record: string }> = [];
      for (const entry of entries.sort((left, right) =>
        left.name.localeCompare(right.name))) {
        signal.throwIfAborted();
        if (!entry.isFile()) continue;
        const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63})\.json$/u.exec(entry.name);
        if (match === null) continue;
        providers.push({
          providerId: match[1]!,
          record: (await readFile(join(directory, entry.name))).toString("base64"),
        });
      }
      signal.throwIfAborted();
      return Buffer.from(JSON.stringify({
        schemaVersion: "luckytoken-provider-credential-profiles-backup-v1",
        providers,
      }), "utf8");
    },
  });
}

export function createConfiguredBackupAuthority(
  options: ConfiguredBackupAuthorityOptions,
): BackupAuthority {
  return createBackupAuthority({
    ownedRoot: resolve(dirname(options.configPath)),
    applicationVersion: options.applicationVersion,
    files: configuredBackupFiles(options.configPath, options.config),
    snapshots: Object.freeze([
      configuredCredentialProfileBackupSnapshot(options.config),
      ...options.snapshots,
    ]),
  });
}

function rawSnapshot(
  id: string,
  contract: string,
  version: number,
  category: "history" | "capture",
  path: string,
): BackupSnapshotSource {
  return Object.freeze({
    id,
    contract,
    version,
    category,
    sourcePath: path,
    optional: true,
    async snapshot(signal: AbortSignal): Promise<Uint8Array> {
      signal.throwIfAborted();
      const bytes = await readFile(path);
      signal.throwIfAborted();
      return bytes;
    },
  });
}

/** Recovery mode never opens or interprets incompatible SQLite stores. A
 * separately confirmed full-sensitive backup may copy their exact dormant
 * bytes so the user can recover them externally. */
export function recoveryBackupSnapshots(
  config: LuckyTokenCliConfig,
): readonly BackupSnapshotSource[] {
  return Object.freeze([
    rawSnapshot(
      "request-ledger",
      "luckytoken-request-ledger-sqlite",
      3,
      "history",
      join(config.requestLedger.directory, "ledger.sqlite3"),
    ),
    rawSnapshot(
      "runtime-diagnostics",
      "luckytoken-runtime-diagnostics-sqlite",
      1,
      "history",
      join(config.runtimeDiagnostics.directory, "diagnostics.sqlite3"),
    ),
    rawSnapshot(
      "deep-capture",
      "luckytoken-deep-capture-sqlite",
      1,
      "capture",
      join(config.deepDiagnostics.directory, "capture.sqlite3"),
    ),
  ]);
}
