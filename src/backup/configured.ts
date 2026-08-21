import { readFile } from "node:fs/promises";
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
    {
      id: "provider-credentials",
      path: join(config.pi.directory, "auth.json"),
      contract: "pi-auth-json",
      version: "0.84.1",
      category: "credentials",
      optional: true,
    },
  ] satisfies readonly BackupFileSource[]);
}

export function createConfiguredBackupAuthority(
  options: ConfiguredBackupAuthorityOptions,
): BackupAuthority {
  return createBackupAuthority({
    ownedRoot: resolve(dirname(options.configPath)),
    applicationVersion: options.applicationVersion,
    files: configuredBackupFiles(options.configPath, options.config),
    snapshots: options.snapshots,
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
