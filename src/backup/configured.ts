import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { TokenCliConfig } from "../cli-config.js";
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
  readonly config: TokenCliConfig;
  readonly applicationVersion: string;
  readonly snapshots: readonly BackupSnapshotSource[];
}

/** The complete explicit Token-owned file allowlist. Paths come only
 * from the already validated Token config; no external application's
 * default data directory is discovered. */
export function configuredBackupFiles(
  configPath: string,
  config: TokenCliConfig,
): readonly BackupFileSource[] {
  return Object.freeze([
    {
      id: "configuration",
      path: resolve(configPath),
      contract: "token-config",
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
      contract: "Token-public-models",
      version: 1,
      category: "configuration",
      optional: true,
      parseJson: (text: string) => JSON.parse(text),
    },
    {
      id: "settings",
      path: join(dirname(configPath), "settings.json"),
      contract: "Token-settings",
      version: 1,
      category: "configuration",
      optional: true,
    },
  ] satisfies readonly BackupFileSource[]);
}

export function configuredCredentialProfileBackupSnapshot(
  config: TokenCliConfig,
): BackupSnapshotSource {
  const directory = join(config.pi.directory, "credential-profiles");
  return Object.freeze({
    id: "provider-credential-profiles",
    contract: "Token-provider-credential-profiles",
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
        schemaVersion: "Token-provider-credential-profiles-backup-v1",
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

/** Recovery mode has no configured store snapshots. Live unified Diagnostics
 * owns its consistent SQLite snapshot and the Application injects that source
 * into normal backups; this module never discovers or copies legacy stores. */
export function recoveryBackupSnapshots(
  config: TokenCliConfig,
): readonly BackupSnapshotSource[] {
  void config;
  return Object.freeze([]);
}
