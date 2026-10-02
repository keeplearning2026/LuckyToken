import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { TokenCliConfig } from "../cli-config.js";
import {
  COMMANDCODE_MODEL_CATALOG_SCHEMA,
  parseCommandCodeModelCatalogText,
} from "@token/commandcode-model-catalog";
import { parseProviderCredentialRecord } from "../credentials/profile-record-store.js";
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
      id: "commandcode-models",
      path: join(dirname(configPath), "commandcode-models.json"),
      contract: "token-commandcode-models",
      version: COMMANDCODE_MODEL_CATALOG_SCHEMA,
      category: "configuration",
      optional: true,
      parseJson: (text: string) =>
        parseCommandCodeModelCatalogText(text, "commandcode-models.json"),
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

const CREDENTIAL_PROFILE_SNAPSHOT_ATTEMPTS = 6;
const CREDENTIAL_PROFILE_SNAPSHOT_RETRY_DELAY_MS = 15;
const SAFE_SNAPSHOT_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;

/** Thrown when the record and a referenced document do not form one
 * point-in-time pair, e.g. because a rotation or reference switch committed
 * between two reads. The snapshot retries instead of publishing a torn
 * capture. */
class TornCredentialProfileSnapshot extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TornCredentialProfileSnapshot";
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function snapshotIncarnationPath(
  credentialDirectory: string,
  relativePath: string,
): string {
  const segments = relativePath.split("/");
  if (
    segments.length !== 3 ||
    segments.some(
      (segment) =>
        !SAFE_SNAPSHOT_SEGMENT_PATTERN.test(segment) ||
        segment.endsWith(".") ||
        segment.endsWith(" "),
    )
  ) {
    throw new Error(
      `Refusing to read non-canonical credential incarnation path ${JSON.stringify(relativePath)}`,
    );
  }
  const root = resolve(credentialDirectory);
  const candidate = resolve(root, ...segments);
  const pathRelative = relative(root, candidate);
  if (pathRelative === "" || pathRelative.startsWith("..") || isAbsolute(pathRelative)) {
    throw new Error(
      `Refusing to read credential incarnation outside the Token credential directory`,
    );
  }
  return candidate;
}

/** Read the referenced Credential-incarnation document. Only Token-owned
 * documents under the credential root are read; symlinks/reparse points and
 * paths that resolve outside the root are refused, never copied. */
async function readReferencedIncarnation(
  credentialDirectory: string,
  relativePath: string,
): Promise<{ readonly content: string; readonly tokenRevision: string }> {
  const target = snapshotIncarnationPath(credentialDirectory, relativePath);
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new TornCredentialProfileSnapshot(
        `Referenced credential incarnation ${relativePath} is missing`,
      );
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(
      `Refusing to copy non-regular credential incarnation ${JSON.stringify(relativePath)}`,
    );
  }
  const [realRoot, realTarget] = await Promise.all([
    realpath(credentialDirectory),
    realpath(target),
  ]);
  const realRelative = relative(resolve(realRoot), resolve(realTarget));
  if (realRelative === "" || realRelative.startsWith("..") || isAbsolute(realRelative)) {
    throw new Error(
      `Refusing to copy credential incarnation that resolves outside the Token credential directory`,
    );
  }
  const bytes = await readFile(target);
  return Object.freeze({
    content: bytes.toString("base64"),
    tokenRevision: sha256Hex(bytes),
  });
}

async function captureCredentialProfileSnapshot(
  directory: string,
  credentialDirectory: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    // A fresh install has never written a Provider record; an absent record
    // directory is an empty snapshot, not a backup failure.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      entries = [];
    } else {
      throw error;
    }
  }
  const providers: Array<{
    providerId: string;
    record: string;
    incarnations: Array<{
      relativePath: string;
      tokenRevision: string;
      content: string;
    }>;
  }> = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    signal.throwIfAborted();
    if (!entry.isFile()) continue;
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63})\.json$/u.exec(entry.name);
    if (match === null) continue;
    const providerId = match[1]!;
    const recordBytes = await readFile(join(directory, entry.name));
    // Record writes and managed credential writes are both atomic renames.
    // The Profile carries only a stable reference, so backup integrity uses
    // the bytes read for this snapshot rather than a persisted Profile hash.
    const record = parseProviderCredentialRecord(
      recordBytes.toString("utf8"),
      providerId,
    );
    const incarnations: Array<{
      relativePath: string;
      tokenRevision: string;
      content: string;
    }> = [];
    for (const profile of record.profiles) {
      signal.throwIfAborted();
      if (profile.reference.owner !== "managed") continue;
      const captured = await readReferencedIncarnation(
        credentialDirectory,
        profile.reference.path,
      );
      incarnations.push({
        relativePath: profile.reference.path,
        tokenRevision: captured.tokenRevision,
        content: captured.content,
      });
    }
    providers.push({
      providerId,
      record: recordBytes.toString("base64"),
      incarnations,
    });
  }
  signal.throwIfAborted();
  return Buffer.from(JSON.stringify({
    schemaVersion: "Token-provider-credential-profiles-backup-v2",
    providers,
  }), "utf8");
}

/** Sensitive credential snapshot: captures each Provider record together with
 * every managed document it references, re-verifying the content hash and
 * retrying a torn read. Orphan documents are not captured, and externally
 * owned documents are never read or copied. */
export function configuredCredentialProfileBackupSnapshot(
  config: TokenCliConfig,
): BackupSnapshotSource {
  const directory = join(config.pi.directory, "credential-profiles");
  const credentialDirectory = join(config.pi.directory, "credentials");
  return Object.freeze({
    id: "provider-credential-profiles",
    contract: "Token-provider-credential-profiles",
    version: 2,
    category: "credentials" as const,
    sourcePath: directory,
    optional: true,
    async snapshot(signal: AbortSignal): Promise<Uint8Array> {
      for (let attempt = 0; ; attempt += 1) {
        signal.throwIfAborted();
        try {
          return await captureCredentialProfileSnapshot(
            directory,
            credentialDirectory,
            signal,
          );
        } catch (error) {
          const lastAttempt = attempt >= CREDENTIAL_PROFILE_SNAPSHOT_ATTEMPTS - 1;
          if (
            lastAttempt ||
            signal.aborted ||
            !(error instanceof TornCredentialProfileSnapshot)
          ) {
            throw error;
          }
          await sleep(CREDENTIAL_PROFILE_SNAPSHOT_RETRY_DELAY_MS, undefined, { signal });
        }
      }
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
