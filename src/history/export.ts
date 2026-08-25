import { randomBytes, randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";

import type {
  HistoryExportFailure,
  HistoryExportManifestSummary,
} from "@token/application-control-plane/control-plane";
import {
  ensureDestinationDirectory,
  inspectDestination,
  validateCanonicalExportDestination,
} from "./path-safety.js";

export interface HistorySnapshotAuthority {
  createBackupSnapshot(signal: AbortSignal): Promise<Uint8Array>;
}

export interface HistoryExporterOptions {
  readonly diagnostics: HistorySnapshotAuthority;
  readonly ownedRoots: readonly string[];
  readonly applicationVersion: string;
  readonly now?: () => number;
  readonly createExportId?: () => string;
  readonly maxBytes?: number;
  readonly renameFile?: (fromPath: string, toPath: string) => Promise<void>;
}

export interface HistoryExportInput {
  readonly destinationPath: string;
  readonly overwrite: boolean;
  readonly signal: AbortSignal;
}

export type HistoryExportAttemptResult =
  | {
      readonly outcome: "ok";
      readonly exportId: string;
      readonly destinationPath: string;
      readonly manifest: HistoryExportManifestSummary;
    }
  | { readonly outcome: "failed"; readonly failure: HistoryExportFailure };

const DEFAULT_MAX_EXPORT_BYTES = 512 * 1024 * 1024;
const FAILURE_MESSAGES: Readonly<Record<HistoryExportFailure["code"], string>> =
  Object.freeze({
    invalid_destination: "The destination path is not valid for export.",
    destination_exists:
      "The destination already exists; confirm overwriting it to replace it.",
    destination_locked:
      "The destination is locked by another process; close it and retry the export.",
    export_too_large: "The export exceeds the maximum artifact size.",
    source_unavailable:
      "The diagnostics snapshot is unavailable; no artifact was published.",
    cancelled: "The export was cancelled; no artifact was published.",
    internal: "The export could not be completed.",
  });

function failed(code: HistoryExportFailure["code"]): HistoryExportAttemptResult {
  return Object.freeze({
    outcome: "failed",
    failure: Object.freeze({ code, message: FAILURE_MESSAGES[code] }),
  });
}

function aborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function renameFailureCode(error: unknown): HistoryExportFailure["code"] {
  const code = error instanceof Error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
  return code === "EBUSY" || code === "EACCES" || code === "EPERM"
    ? "destination_locked"
    : "internal";
}

export async function runHistoryExport(
  input: HistoryExportInput,
  options: HistoryExporterOptions,
): Promise<HistoryExportAttemptResult> {
  const validation = await validateCanonicalExportDestination(
    input.destinationPath,
    options.ownedRoots,
  );
  if (!validation.ok) return failed(validation.code);
  const initialDestination = await inspectDestination(
    input.destinationPath,
    input.overwrite,
  );
  if (initialDestination.kind === "rejected") {
    return failed(initialDestination.code);
  }
  if (aborted(input.signal)) return failed("cancelled");

  let snapshot: Uint8Array;
  try {
    snapshot = await options.diagnostics.createBackupSnapshot(input.signal);
  } catch {
    return failed(aborted(input.signal) ? "cancelled" : "source_unavailable");
  }
  if (aborted(input.signal)) return failed("cancelled");

  const exportedAt = options.now?.() ?? Date.now();
  const manifest: HistoryExportManifestSummary = Object.freeze({
    manifestVersion: 2,
    exportedAt,
    sensitive: true,
    snapshot: Object.freeze({
      contract: "token-diagnostics-sqlite",
      schemaVersion: 2,
      bytes: snapshot.byteLength,
    }),
  });
  const artifact = JSON.stringify({
    manifestVersion: manifest.manifestVersion,
    exportedAt: manifest.exportedAt,
    application: { id: "Token", version: options.applicationVersion },
    sensitive: manifest.sensitive,
    snapshot: {
      ...manifest.snapshot,
      encoding: "base64",
      content: Buffer.from(snapshot).toString("base64"),
    },
  });
  if (Buffer.byteLength(artifact, "utf8") > (options.maxBytes ?? DEFAULT_MAX_EXPORT_BYTES)) {
    return failed("export_too_large");
  }

  await ensureDestinationDirectory(input.destinationPath);
  const tempPath = `${input.destinationPath}.Token-export.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    if (aborted(input.signal)) return failed("cancelled");
    const handle = await open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(artifact, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (aborted(input.signal)) return failed("cancelled");
    const finalDestination = await inspectDestination(
      input.destinationPath,
      input.overwrite,
    );
    if (finalDestination.kind === "rejected") {
      return failed(finalDestination.code);
    }
    try {
      await (options.renameFile ?? rename)(tempPath, input.destinationPath);
    } catch (error) {
      return failed(renameFailureCode(error));
    }
    return Object.freeze({
      outcome: "ok",
      exportId: options.createExportId?.() ?? randomUUID(),
      destinationPath: input.destinationPath,
      manifest,
    });
  } catch {
    return failed(aborted(input.signal) ? "cancelled" : "internal");
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}
