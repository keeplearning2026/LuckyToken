/**
 * Ticket 24 backup authority.
 *
 * It reads only an explicit allowlist of LuckyToken-owned sources. Ordinary
 * backups serialize recursively redacted JSON configuration; full-sensitive
 * backups preserve the allowlisted source bytes and consistent store-owned
 * SQLite snapshots, but only after a single-use confirmation. Publication is
 * one atomic rename and every failure removes the temporary artifact.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { open, readFile, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type {
  BackupCommand,
  BackupFailure,
  BackupManifestEntrySummary,
  BackupManifestSummary,
  BackupResult,
} from "@luckytoken/application-control-plane/control-plane";
import { redactDiagnostic } from "../runtime-diagnostics/redaction.js";
import {
  ensureDestinationDirectory,
  inspectDestination,
} from "../history/path-safety.js";
import { validateCanonicalExportDestination } from "../history/path-safety.js";

const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const FULL_CONFIRMATION =
  "This full-sensitive backup includes raw LuckyToken configuration, Provider credentials, Client token secrets, permanent history, and Deep Diagnostics capture. Store it as a secret and confirm to continue.";

export interface BackupFileSource {
  readonly id: string;
  readonly path: string;
  readonly contract: string;
  readonly version: string | number;
  readonly category: "configuration" | "credentials" | "client_tokens";
  /** Transparent files created on first use are absent in a new install. */
  readonly optional?: boolean;
  readonly parseJson?: (text: string) => unknown;
}

export interface BackupSnapshotSource {
  readonly id: string;
  readonly contract: string;
  readonly version: string | number;
  readonly category: "history" | "capture";
  /** Optional explicit owned path used only to prove this snapshot belongs
   * to the configured LuckyToken root before invoking the store owner. */
  readonly sourcePath?: string;
  readonly optional?: boolean;
  snapshot(signal: AbortSignal): Promise<Uint8Array>;
}

export interface BackupAuthorityOptions {
  readonly ownedRoot: string;
  readonly applicationVersion: string;
  readonly files: readonly BackupFileSource[];
  readonly snapshots: readonly BackupSnapshotSource[];
  readonly now?: () => number;
  readonly createActionId?: () => string;
  readonly maxBytes?: number;
  readonly publish?: (fromPath: string, toPath: string) => Promise<void>;
}

export interface BackupAuthority {
  handle(command: BackupCommand, signal: AbortSignal): Promise<BackupResult>;
}

interface PendingBackup {
  readonly actionId: string;
  readonly destinationPath: string;
  readonly overwrite: boolean;
}

class BackupRejected extends Error {
  constructor(readonly code: BackupFailure["code"]) {
    super(code);
  }
}

const FAILURE_MESSAGES: Readonly<Record<BackupFailure["code"], string>> =
  Object.freeze({
    invalid_destination: "The backup destination is not valid.",
    destination_exists:
      "The backup destination already exists; confirm replacement explicitly.",
    destination_locked:
      "The backup destination is locked by another process.",
    source_outside_owned_root:
      "A configured source is outside the LuckyToken-owned data root; it was not read.",
    source_unavailable:
      "A required LuckyToken backup source is unavailable; no artifact was published.",
    backup_too_large: "The backup exceeds the maximum artifact size.",
    cancelled: "The backup was cancelled; no artifact was published.",
    internal: "The backup could not be completed.",
  });

function failure(code: BackupFailure["code"]): BackupResult {
  return Object.freeze({
    outcome: "failed" as const,
    failure: Object.freeze({ code, message: FAILURE_MESSAGES[code] }),
  });
}

function comparisonPath(value: string): string {
  const canonical = resolve(value);
  return process.platform === "win32"
    ? canonical.toLocaleLowerCase("en-US")
    : canonical;
}

async function assertOwnedSource(
  ownedRoot: string,
  sourcePath: string,
): Promise<string> {
  let root: string;
  let source: string;
  try {
    [root, source] = await Promise.all([
      realpath(ownedRoot),
      realpath(sourcePath),
    ]);
  } catch (error) {
    const code =
      error instanceof Error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    if (code === "ENOENT") throw new BackupRejected("source_unavailable");
    throw new BackupRejected("source_unavailable");
  }
  const rootKey = comparisonPath(root);
  const sourceKey = comparisonPath(source);
  const rel = relative(rootKey, sourceKey);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return source;
  }
  throw new BackupRejected("source_outside_owned_root");
}

function sanitizeJson(
  bytes: Uint8Array,
  parse: ((text: string) => unknown) | undefined,
): unknown {
  let parsed: unknown;
  try {
    const text = Buffer.from(bytes).toString("utf8");
    parsed = parse === undefined ? JSON.parse(text) : parse(text);
  } catch {
    throw new BackupRejected("source_unavailable");
  }
  return redactDiagnostic("backup", parsed, undefined).details ?? Object.freeze({});
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function createBackupAuthority(
  options: BackupAuthorityOptions,
): BackupAuthority {
  const now = options.now ?? Date.now;
  const createActionId = options.createActionId ?? randomUUID;
  const maximumBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const publish = options.publish ?? rename;
  let pending: PendingBackup | undefined;

  const execute = async (
    destinationPath: string,
    overwrite: boolean,
    sensitive: boolean,
    signal: AbortSignal,
  ): Promise<BackupResult> => {
    const destinationValidation = await validateCanonicalExportDestination(
      destinationPath,
      [options.ownedRoot],
    );
    if (!destinationValidation.ok) return failure("invalid_destination");
    const destination = await inspectDestination(destinationPath, overwrite);
    if (destination.kind === "rejected") return failure(destination.code);
    const tempPath = `${destinationPath}.luckytoken-backup.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let published = false;
    try {
      signal.throwIfAborted();
      const entries: Array<{
        summary: BackupManifestEntrySummary;
        encoding: "json" | "base64";
        content: unknown;
      }> = [];
      for (const source of options.files) {
        if (!sensitive && source.category !== "configuration") continue;
        let sourcePath: string;
        try {
          sourcePath = await assertOwnedSource(options.ownedRoot, source.path);
        } catch (error) {
          if (
            source.optional === true &&
            error instanceof BackupRejected &&
            error.code === "source_unavailable"
          ) {
            continue;
          }
          throw error;
        }
        const bytes = await readFile(sourcePath);
        signal.throwIfAborted();
        entries.push({
          summary: Object.freeze({
            id: source.id,
            contract: source.contract,
            version: source.version,
            sensitive,
          }),
          encoding: sensitive ? "base64" : "json",
          content: sensitive
            ? bytes.toString("base64")
            : sanitizeJson(bytes, source.parseJson),
        });
      }
      if (sensitive) {
        for (const source of options.snapshots) {
          signal.throwIfAborted();
          if (source.sourcePath !== undefined) {
            try {
              await assertOwnedSource(options.ownedRoot, source.sourcePath);
            } catch (error) {
              if (
                source.optional === true &&
                error instanceof BackupRejected &&
                error.code === "source_unavailable"
              ) {
                continue;
              }
              throw error;
            }
          }
          let bytes: Uint8Array;
          try {
            bytes = await source.snapshot(signal);
          } catch (error) {
            if (
              source.optional === true &&
              error instanceof Error &&
              (error as NodeJS.ErrnoException).code === "ENOENT"
            ) {
              continue;
            }
            throw error;
          }
          signal.throwIfAborted();
          entries.push({
            summary: Object.freeze({
              id: source.id,
              contract: source.contract,
              version: source.version,
              sensitive: true,
            }),
            encoding: "base64",
            content: Buffer.from(bytes).toString("base64"),
          });
        }
      }
      const createdAt = now();
      if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
        throw new BackupRejected("internal");
      }
      const manifest: BackupManifestSummary = Object.freeze({
        format: "luckytoken-backup",
        formatVersion: 1,
        createdAt,
        sensitive,
        entries: Object.freeze(entries.map((entry) => entry.summary)),
      });
      const artifact = `${JSON.stringify({
        ...manifest,
        applicationVersion: options.applicationVersion,
        sensitivity: sensitive ? "FULL_SENSITIVE" : "ORDINARY_REDACTED",
        entries: entries.map((entry) => ({
          ...entry.summary,
          encoding: entry.encoding,
          content: entry.content,
        })),
      }, null, 2)}\n`;
      if (byteLength(artifact) > maximumBytes) {
        throw new BackupRejected("backup_too_large");
      }
      await ensureDestinationDirectory(destinationPath);
      const canonicalAgain = await validateCanonicalExportDestination(
        destinationPath,
        [options.ownedRoot],
      );
      if (!canonicalAgain.ok) throw new BackupRejected("invalid_destination");
      handle = await open(tempPath, "wx", 0o600);
      await handle.writeFile(artifact, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      signal.throwIfAborted();
      if (!overwrite) {
        const beforePublish = await inspectDestination(destinationPath, false);
        if (beforePublish.kind === "rejected") {
          throw new BackupRejected("destination_exists");
        }
      }
      await publish(tempPath, destinationPath);
      published = true;
      return Object.freeze({
        outcome: "ok" as const,
        destinationPath,
        manifest,
      });
    } catch (error) {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      if (signal.aborted) return failure("cancelled");
      if (error instanceof BackupRejected) return failure(error.code);
      const code =
        error instanceof Error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
      if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
        return failure("destination_locked");
      }
      return failure("internal");
    } finally {
      if (!published) await rm(tempPath, { force: true }).catch(() => undefined);
    }
  };

  return Object.freeze({
    async handle(command: BackupCommand, signal: AbortSignal): Promise<BackupResult> {
      if (command.command === "create") {
        if (command.mode === "ordinary") {
          return execute(
            command.destinationPath,
            command.overwrite,
            false,
            signal,
          );
        }
        pending = Object.freeze({
          actionId: createActionId(),
          destinationPath: command.destinationPath,
          overwrite: command.overwrite,
        });
        return Object.freeze({
          outcome: "confirmation_required" as const,
          actionId: pending.actionId,
          confirmationMessage: FULL_CONFIRMATION,
        });
      }
      const gate = pending;
      if (gate === undefined || gate.actionId !== command.actionId) {
        throw new Error("No matching full-sensitive backup confirmation is pending");
      }
      pending = undefined;
      return execute(
        gate.destinationPath,
        gate.overwrite,
        true,
        signal,
      );
    },
  });
}
