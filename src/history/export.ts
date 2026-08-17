/**
 * History export execution (Ticket 23) — the one streaming exporter.
 *
 * Streams committed sanitized records from the Request Ledger and Runtime
 * Diagnostics stores (and optionally the Deep-capture store) into a single
 * versioned manifest artifact at the user-chosen destination, re-applying
 * the universal redaction choke point to every record at serialization time
 * (defense in depth; committed records are already sanitized).
 *
 * Atomic publication: records stream into a `wx` temp file next to the
 * destination; the rename is the single publication point, so readers see
 * either the old file or the complete artifact, never a partial one. An
 * abort (connection lost), an oversized artifact, or a source-store fault
 * removes the temp file and never publishes. Replacing an existing file
 * requires explicit `overwrite` consent (checked before streaming and
 * re-checked immediately before publication). A locked destination maps to
 * `destination_locked` with a bounded retry.
 *
 * Bounded memory: paged store queries (limit 100) and a byte budget on the
 * artifact; no `SELECT *` of history is ever materialized.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { open, rename as renameFile, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

import type {
  DeepCaptureStore,
  HistoryExportCaptureMode,
  HistoryExportFailure,
  HistoryExportManifestSummary,
  HistoryRange,
  PersistenceAuthorityId,
  RequestLedgerStore,
  RuntimeDiagnosticsStore,
} from "@luckytoken/application-control-plane/control-plane";
import { redactDiagnostic } from "../runtime-diagnostics/redaction.js";
import {
  buildManifestFooter,
  buildManifestHeader,
  type HistoryExportSourceFacts,
} from "./manifest.js";
import {
  ensureDestinationDirectory,
  inspectDestination,
  validateCanonicalExportDestination,
} from "./path-safety.js";

export interface HistoryExportSources {
  readonly ledger: RequestLedgerStore;
  readonly diagnostics: RuntimeDiagnosticsStore;
  readonly capture: DeepCaptureStore;
}

export interface HistoryExporterOptions {
  readonly sources: HistoryExportSources;
  readonly ownedRoots: readonly string[];
  readonly applicationVersion: string;
  readonly now?: () => number;
  readonly createExportId?: () => string;
  /** Total artifact byte budget; defaults to 512 MiB. */
  readonly maxBytes?: number;
  /** Injectable publication seam (fault tests): defaults to fs.rename. */
  readonly renameFile?: (fromPath: string, toPath: string) => Promise<void>;
  /** Opaque known-value scrubber (already applied at commit; re-applied at
   *  serialization for defense in depth). */
  readonly scrub?: (value: string) => string;
  /** Snapshot of the owner-process persistence truth when this export
   *  starts. Fallback schema versions remain a defensive signal, but are
   *  not the only way an authority can be degraded. */
  readonly auditUnavailable?: boolean;
  /** Narrow sanitized source-fault seam: invoked with the failing authority
   *  only; never with fault text. */
  readonly onSourceFailure?: (
    authority: PersistenceAuthorityId,
    fact?: { readonly requestId?: string },
  ) => void;
}

export interface HistoryExportInput {
  readonly range: HistoryRange;
  readonly capture: HistoryExportCaptureMode;
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
const PAGE_LIMIT = 100;
const RENAME_RETRIES = 2;
const RENAME_RETRY_DELAY_MS = 100;

class ExportCancelled extends Error {
  constructor() {
    super("history export cancelled");
  }
}

class ExportTooLarge extends Error {
  constructor() {
    super("history export exceeds the maximum artifact size");
  }
}

/** A deterministic export failure raised mid-flight (source fault, locked
 *  destination, overwrite race); mapped to its wire code at the boundary. */
class ExportRejected extends Error {
  constructor(readonly code: HistoryExportFailure["code"]) {
    super(`history export failed: ${code}`);
  }
}

/** Conservative UTF-8 byte count (surrogate halves count 3 bytes: never
 *  under-counts, never allocates). */
function utf8Bytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else bytes += 3;
  }
  return bytes;
}

function failure(
  code: HistoryExportFailure["code"],
  message: string,
): HistoryExportFailure {
  return Object.freeze({ code, message });
}

const FAILURE_MESSAGES: Readonly<
  Record<HistoryExportFailure["code"], string>
> = Object.freeze({
  invalid_destination: "The destination path is not valid for export.",
  destination_exists:
    "The destination already exists; confirm overwriting it to replace it.",
  destination_locked:
    "The destination is locked by another process; close it and retry the export.",
  export_too_large: "The export exceeds the maximum artifact size.",
  source_unavailable:
    "A history source is unavailable; no artifact was published.",
  cancelled: "The export was cancelled; no artifact was published.",
  internal: "The export could not be completed.",
});

function safeTime(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must return a non-negative safe integer`);
  }
  return value;
}

/** Universal redaction re-applied at serialization: every record passes the
 *  choke point again so authentication capability values can never reach
 *  artifact bytes, in any export mode. */
function serializeRecord(
  record: unknown,
  scrub: ((value: string) => string) | undefined,
): string {
  const sanitized = redactDiagnostic("", record, undefined, scrub);
  return JSON.stringify(
    sanitized.details ?? Object.freeze({ omitted: "unsupported-record-shape" }),
  );
}

/** Bounded artifact writer: every chunk counts against the byte budget and
 *  a single oversize throws before more bytes are written. */
class ArtifactWriter {
  private bytes = 0;
  constructor(
    private readonly handle: FileHandle,
    private readonly maximumBytes: number,
  ) {}

  async write(text: string): Promise<void> {
    this.bytes += utf8Bytes(text);
    if (this.bytes > this.maximumBytes) throw new ExportTooLarge();
    await this.handle.write(text, null, "utf8");
  }
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new ExportCancelled();
}

export async function runHistoryExport(
  input: HistoryExportInput,
  options: HistoryExporterOptions,
): Promise<HistoryExportAttemptResult> {
  const now = options.now ?? Date.now;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_EXPORT_BYTES;
  const createExportId = options.createExportId ?? randomUUID;
  const publish =
    options.renameFile ??
    ((fromPath: string, toPath: string) => renameFile(fromPath, toPath));

  const validate = await validateCanonicalExportDestination(
    input.destinationPath,
    options.ownedRoots,
  );
  if (!validate.ok) {
    return {
      outcome: "failed",
      failure: failure(validate.code, FAILURE_MESSAGES[validate.code]),
    };
  }
  const destination = await inspectDestination(
    input.destinationPath,
    input.overwrite,
  );
  if (destination.kind === "rejected") {
    return {
      outcome: "failed",
      failure: failure(destination.code, FAILURE_MESSAGES[destination.code]),
    };
  }
  let exportedAt: number;
  try {
    exportedAt = safeTime(now(), "history export clock");
  } catch {
    exportedAt = Date.now();
  }
  const auditUnavailable =
    options.auditUnavailable === true ||
    options.sources.ledger.schemaVersion === 0 ||
    options.sources.diagnostics.schemaVersion === 0 ||
    options.sources.capture.schemaVersion === 0;
  const sensitive = input.capture === "included";

  // Half-open history range → inclusive store query endpoints (the stores'
  // query convention): `[fromMs, toMs)` maps to `[fromMs, toMs - 1]`. A
  // zero exclusive end (or an empty from==to window) yields no eligible
  // records; the section is simply empty.
  const rangeFrom =
    input.range === "all" ? undefined : input.range.fromMs;
  const rangeToExclusive =
    input.range === "all" ? undefined : input.range.toMs;
  const rangeToInclusive =
    rangeToExclusive === undefined
      ? undefined
      : rangeToExclusive === 0
        ? undefined
        : rangeToExclusive - 1;
  const emptyWindow =
    rangeToExclusive === 0 ||
    (rangeFrom !== undefined &&
      rangeToExclusive !== undefined &&
      rangeFrom >= rangeToExclusive);

  const tempPath = `${input.destinationPath}.luckytoken-export.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let handle: FileHandle | undefined;
  let published = false;
  try {
    await ensureDestinationDirectory(input.destinationPath);
    const canonicalAfterCreate = await validateCanonicalExportDestination(
      input.destinationPath,
      options.ownedRoots,
    );
    if (!canonicalAfterCreate.ok) {
      throw new ExportRejected("invalid_destination");
    }
    checkAbort(input.signal);
    const canonicalBeforePublish = await validateCanonicalExportDestination(
      input.destinationPath,
      options.ownedRoots,
    );
    if (!canonicalBeforePublish.ok) {
      throw new ExportRejected("invalid_destination");
    }
    handle = await open(tempPath, "wx", 0o600);
    const writer = new ArtifactWriter(handle, maxBytes);
    await writer.write(
      `${buildManifestHeader({
        exportedAt,
        range: input.range,
        sensitive,
        auditUnavailable,
        applicationVersion: options.applicationVersion,
      })}\n`,
    );

    /** One paged section. `fetchPage` returns committed records plus the
     *  next cursor; a source fault aborts the whole export (never a partial
     *  artifact claiming completeness). */
    const streamSection = async (
      name: "requestLedger" | "diagnostics" | "capture",
      firstSection: boolean,
      fetchPage: (
        cursor: number | undefined,
      ) => {
        readonly records: readonly unknown[];
        readonly hasMore: boolean;
        readonly lastRowId?: number;
      },
    ): Promise<number> => {
      await writer.write(
        `${firstSection ? "" : ","}\n    "${name}": [\n`,
      );
      if (emptyWindow) {
        await writer.write("    ]");
        return 0;
      }
      let count = 0;
      let cursor: number | undefined;
      let hasMore = true;
      while (hasMore) {
        checkAbort(input.signal);
        let page;
        try {
          page = fetchPage(cursor);
        } catch {
          options.onSourceFailure?.(name);
          throw new ExportRejected("source_unavailable");
        }
        for (let index = 0; index < page.records.length; index += 1) {
          const record = page.records[index]!;
          const isLast =
            !page.hasMore && index === page.records.length - 1;
          await writer.write(
            `      ${serializeRecord(record, options.scrub)}${isLast ? "" : ","}\n`,
          );
          count += 1;
        }
        hasMore = page.hasMore;
        cursor =
          page.lastRowId ??
          (page.records.at(-1) as { readonly id?: number } | undefined)?.id ??
          cursor;
      }
      await writer.write("    ]");
      return count;
    };

    const ledgerCount = await streamSection(
      "requestLedger",
      true,
      (cursor) => {
        const page = options.sources.ledger.query({
          ...(cursor === undefined ? {} : { afterId: cursor }),
          limit: PAGE_LIMIT,
          ...(rangeFrom === undefined ? {} : { from: rangeFrom }),
          ...(rangeToInclusive === undefined
            ? {}
            : { to: rangeToInclusive }),
        });
        return { records: page.records, hasMore: page.hasMore };
      },
    );
    const diagnosticsCount = await streamSection(
      "diagnostics",
      false,
      (cursor) => {
        const page = options.sources.diagnostics.query({
          ...(cursor === undefined ? {} : { afterId: cursor }),
          limit: PAGE_LIMIT,
          ...(rangeFrom === undefined ? {} : { from: rangeFrom }),
          ...(rangeToInclusive === undefined
            ? {}
            : { to: rangeToInclusive }),
        });
        return { records: page.records, hasMore: page.hasMore };
      },
    );
    let captureCount = 0;
    let captureFacts: HistoryExportSourceFacts["capture"];
    if (input.capture === "included") {
      captureCount = await streamSection("capture", false, (cursor) => {
        const page = options.sources.capture.queryRange({
          ...(cursor === undefined ? {} : { afterId: cursor }),
          limit: PAGE_LIMIT,
          ...(rangeFrom === undefined ? {} : { from: rangeFrom }),
          ...(rangeToInclusive === undefined
            ? {}
            : { to: rangeToInclusive }),
        });
        return {
          records: page.records,
          hasMore: page.hasMore,
          ...(page.lastRowId === undefined ? {} : { lastRowId: page.lastRowId }),
        };
      });
      captureFacts = Object.freeze({
        included: true,
        schemaVersion: options.sources.capture.schemaVersion,
        count: captureCount,
      });
    } else {
      captureFacts = Object.freeze({
        included: false,
        reason: "excluded-by-default",
      });
    }
    const sources: HistoryExportSourceFacts = Object.freeze({
      requestLedger: Object.freeze({
        schemaVersion: options.sources.ledger.schemaVersion,
        count: ledgerCount,
      }),
      diagnostics: Object.freeze({
        schemaVersion: options.sources.diagnostics.schemaVersion,
        count: diagnosticsCount,
      }),
      capture: captureFacts,
    });
    await writer.write(buildManifestFooter(sources));
    await handle.sync();
    await handle.close();
    handle = undefined;

    // Re-check the overwrite race immediately before publication: a file
    // that appeared mid-stream is never silently clobbered.
    checkAbort(input.signal);
    if (!input.overwrite) {
      const nowExists = await inspectDestination(
        input.destinationPath,
        false,
      );
      if (nowExists.kind === "rejected") {
        throw new ExportRejected("destination_exists");
      }
    }
    // One publication point: rename over (atomic on Windows via
    // MOVEFILE_REPLACE_EXISTING). A locked destination retries a bounded
    // number of times, then reports destination_locked — the temp file is
    // always cleaned below.
    let publishError: unknown;
    for (let attempt = 0; attempt <= RENAME_RETRIES; attempt += 1) {
      try {
        await publish(tempPath, input.destinationPath);
        published = true;
        break;
      } catch (error) {
        publishError = error;
        const code =
          error instanceof Error &&
          typeof (error as NodeJS.ErrnoException).code === "string"
            ? (error as NodeJS.ErrnoException).code
            : undefined;
        if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") {
          break;
        }
        if (attempt < RENAME_RETRIES) {
          await new Promise((resolve) =>
            setTimeout(resolve, RENAME_RETRY_DELAY_MS),
          );
        }
      }
    }
    if (!published) {
      const code =
        publishError instanceof Error &&
        typeof (publishError as NodeJS.ErrnoException).code === "string" &&
        (publishError as NodeJS.ErrnoException).code !== undefined
          ? (publishError as NodeJS.ErrnoException).code
          : undefined;
      const locked =
        code === "EPERM" || code === "EBUSY" || code === "EACCES";
      throw new ExportRejected(
        locked ? "destination_locked" : "internal",
      );
    }
    const manifest: HistoryExportManifestSummary = Object.freeze({
      manifestVersion: 1,
      exportedAt,
      sensitive,
      auditUnavailable,
      sources,
    });
    return {
      outcome: "ok",
      exportId: createExportId(),
      destinationPath: input.destinationPath,
      manifest,
    };
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    // The temp file is always removed; a failure never publishes.
    await rm(tempPath, { force: true }).catch(() => undefined);
    if (error instanceof ExportCancelled) {
      return {
        outcome: "failed",
        failure: failure("cancelled", FAILURE_MESSAGES.cancelled),
      };
    }
    if (error instanceof ExportTooLarge) {
      return {
        outcome: "failed",
        failure: failure("export_too_large", FAILURE_MESSAGES.export_too_large),
      };
    }
    if (error instanceof ExportRejected) {
      return {
        outcome: "failed",
        failure: failure(error.code, FAILURE_MESSAGES[error.code]),
      };
    }
    return {
      outcome: "failed",
      failure: failure("internal", FAILURE_MESSAGES.internal),
    };
  } finally {
    if (!published) {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}
