import type {
  HistoryCommand,
  HistoryCommandResult,
  HistoryCounts,
  HistoryDeleteCommand,
  HistoryDeletePreview,
  HistoryDeleteResult,
  HistoryDeleteManagementResult,
  HistoryExportCommand,
  HistoryExportFailure,
  HistoryExportFailureCode,
  HistoryExportManifestSummary,
  HistoryExportResult,
  HistoryExportManagementResult,
  HistoryQueryResult,
  HistoryQueryManagementResult,
  HistoryRange,
} from "./history-contract.js";
import { isRecord } from "./wire.js";
import { decodeDiagnosticsUnavailableResult } from "./wire-request-diagnostics.js";

const MAX_DESTINATION_PATH_LENGTH = 4_096;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isSafeTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCount(value: unknown): value is number {
  return isSafeTime(value);
}

export function decodeHistoryRange(value: unknown): HistoryRange | undefined {
  if (value === "all") return "all";
  if (!isRecord(value) || !exactKeys(value, ["fromMs", "toMs"])) return undefined;
  const { fromMs, toMs } = value;
  if (fromMs === undefined && toMs === undefined) return undefined;
  if (fromMs !== undefined && !isSafeTime(fromMs)) return undefined;
  if (toMs !== undefined && !isSafeTime(toMs)) return undefined;
  if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) return undefined;
  return Object.freeze({
    ...(fromMs === undefined ? {} : { fromMs }),
    ...(toMs === undefined ? {} : { toMs }),
  });
}

export function decodeHistoryCounts(value: unknown): HistoryCounts | undefined {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["requestJourneys", "runtimeEvents"]) ||
    !isCount(value.requestJourneys) ||
    !isCount(value.runtimeEvents)
  ) return undefined;
  return Object.freeze({
    requestJourneys: value.requestJourneys,
    runtimeEvents: value.runtimeEvents,
  });
}

export function decodeHistoryQueryResult(value: unknown): HistoryQueryResult | undefined {
  if (!isRecord(value) || !exactKeys(value, ["range", "counts"])) return undefined;
  const range = decodeHistoryRange(value.range);
  const counts = decodeHistoryCounts(value.counts);
  return range === undefined || counts === undefined
    ? undefined
    : Object.freeze({ range, counts });
}

function decodeDestinationPath(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_DESTINATION_PATH_LENGTH
    ? value
    : undefined;
}

export function decodeHistoryExportCommand(value: unknown): HistoryExportCommand | undefined {
  if (!isRecord(value) || !exactKeys(value, ["destinationPath", "overwrite"])) return undefined;
  const destinationPath = decodeDestinationPath(value.destinationPath);
  if (destinationPath === undefined || typeof value.overwrite !== "boolean") return undefined;
  return Object.freeze({ destinationPath, overwrite: value.overwrite });
}

export function decodeHistoryDeleteCommand(value: unknown): HistoryDeleteCommand | undefined {
  if (!isRecord(value) || !exactKeys(value, ["range"])) return undefined;
  const range = decodeHistoryRange(value.range);
  return range === undefined ? undefined : Object.freeze({ range });
}

function decodeExportFailure(value: unknown): HistoryExportFailure | undefined {
  const codes: readonly HistoryExportFailureCode[] = [
    "invalid_destination", "destination_exists", "destination_locked",
    "export_too_large", "source_unavailable", "cancelled", "internal",
  ];
  if (!isRecord(value) || !exactKeys(value, ["code", "message"]) ||
      !codes.includes(value.code as HistoryExportFailureCode) ||
      typeof value.message !== "string" || value.message.length === 0 || value.message.length > 512) {
    return undefined;
  }
  return Object.freeze({ code: value.code as HistoryExportFailureCode, message: value.message });
}

function decodeManifest(value: unknown): HistoryExportManifestSummary | undefined {
  if (!isRecord(value) || !exactKeys(value, ["manifestVersion", "exportedAt", "sensitive", "snapshot"]) ||
      value.manifestVersion !== 2 || !isSafeTime(value.exportedAt) || value.sensitive !== true ||
      !isRecord(value.snapshot) || !exactKeys(value.snapshot, ["contract", "schemaVersion", "bytes"]) ||
      value.snapshot.contract !== "luckytoken-diagnostics-sqlite" || value.snapshot.schemaVersion !== 1 ||
      !isCount(value.snapshot.bytes)) return undefined;
  return Object.freeze({
    manifestVersion: 2,
    exportedAt: value.exportedAt,
    sensitive: true,
    snapshot: Object.freeze({
      contract: "luckytoken-diagnostics-sqlite",
      schemaVersion: 1,
      bytes: value.snapshot.bytes,
    }),
  });
}

export function decodeHistoryExportResult(value: unknown): HistoryExportResult | undefined {
  if (!isRecord(value)) return undefined;
  if (value.outcome === "confirmation_required") {
    if (!exactKeys(value, ["outcome", "actionId", "confirmationMessage"]) ||
        typeof value.actionId !== "string" || value.actionId.length === 0 || value.actionId.length > 128 ||
        typeof value.confirmationMessage !== "string" || value.confirmationMessage.length === 0 || value.confirmationMessage.length > 512) return undefined;
    return Object.freeze({ outcome: value.outcome, actionId: value.actionId, confirmationMessage: value.confirmationMessage });
  }
  if (value.outcome === "ok") {
    if (!exactKeys(value, ["outcome", "exportId", "destinationPath", "manifest"]) ||
        typeof value.exportId !== "string" || value.exportId.length === 0 || value.exportId.length > 128) return undefined;
    const destinationPath = decodeDestinationPath(value.destinationPath);
    const manifest = decodeManifest(value.manifest);
    return destinationPath === undefined || manifest === undefined ? undefined :
      Object.freeze({ outcome: value.outcome, exportId: value.exportId, destinationPath, manifest });
  }
  if (value.outcome !== "failed" || !exactKeys(value, ["outcome", "failure"])) return undefined;
  const failure = decodeExportFailure(value.failure);
  return failure === undefined ? undefined : Object.freeze({ outcome: value.outcome, failure });
}

export function decodeHistoryDeletePreview(value: unknown): HistoryDeletePreview | undefined {
  if (!isRecord(value) || !exactKeys(value, ["range", "counts"])) return undefined;
  const range = decodeHistoryRange(value.range);
  const counts = decodeHistoryCounts(value.counts);
  return range === undefined || counts === undefined ? undefined : Object.freeze({ range, counts });
}

export function decodeHistoryDeleteResult(value: unknown): HistoryDeleteResult | undefined {
  if (!isRecord(value)) return undefined;
  if (value.outcome === "confirmation_required") {
    if (!exactKeys(value, ["outcome", "actionId", "preview", "confirmationMessage"]) ||
        typeof value.actionId !== "string" || value.actionId.length === 0 || value.actionId.length > 128 ||
        typeof value.confirmationMessage !== "string" || value.confirmationMessage.length === 0 || value.confirmationMessage.length > 512) return undefined;
    const preview = decodeHistoryDeletePreview(value.preview);
    return preview === undefined ? undefined : Object.freeze({
      outcome: value.outcome, actionId: value.actionId, preview,
      confirmationMessage: value.confirmationMessage,
    });
  }
  if (value.outcome === "completed") {
    if (!exactKeys(value, ["outcome", "deleted"])) return undefined;
    const deleted = decodeHistoryCounts(value.deleted);
    return deleted === undefined ? undefined : Object.freeze({ outcome: value.outcome, deleted });
  }
  if (value.outcome !== "failed" || !exactKeys(value, ["outcome", "failure"]) ||
      !isRecord(value.failure) || !exactKeys(value.failure, ["code", "message"]) ||
      (value.failure.code !== "storage_failure" && value.failure.code !== "internal") ||
      typeof value.failure.message !== "string" || value.failure.message.length === 0 || value.failure.message.length > 512) return undefined;
  return Object.freeze({ outcome: value.outcome, failure: Object.freeze({ code: value.failure.code, message: value.failure.message }) });
}

export function decodeHistoryQueryManagementResult(value: unknown): HistoryQueryManagementResult | undefined {
  return decodeDiagnosticsUnavailableResult(value) ?? decodeHistoryQueryResult(value);
}

export function decodeHistoryExportManagementResult(value: unknown): HistoryExportManagementResult | undefined {
  return decodeDiagnosticsUnavailableResult(value) ?? decodeHistoryExportResult(value);
}

export function decodeHistoryDeleteManagementResult(value: unknown): HistoryDeleteManagementResult | undefined {
  return decodeDiagnosticsUnavailableResult(value) ?? decodeHistoryDeleteResult(value);
}

export function decodeHistoryCommand(value: unknown): HistoryCommand | undefined {
  if (!isRecord(value) || typeof value.command !== "string") return undefined;
  if (value.command === "query") {
    if (!exactKeys(value, ["command", "range"])) return undefined;
    const range = value.range === undefined ? undefined : decodeHistoryRange(value.range);
    return value.range !== undefined && range === undefined ? undefined : Object.freeze({ command: "query", ...(range === undefined ? {} : { range }) });
  }
  if (value.command === "export") {
    const command = decodeHistoryExportCommand(value);
    return command === undefined ? undefined : Object.freeze({ command: "export", ...command });
  }
  if (value.command === "delete") {
    const command = decodeHistoryDeleteCommand(value);
    return command === undefined ? undefined : Object.freeze({ command: "delete", ...command });
  }
  if (value.command === "export_confirm" || value.command === "delete_confirm") {
    if (!exactKeys(value, ["command", "actionId"]) || typeof value.actionId !== "string" || value.actionId.length === 0 || value.actionId.length > 128) return undefined;
    return Object.freeze({ command: value.command, actionId: value.actionId });
  }
  return undefined;
}

export function decodeHistoryCommandResult(kind: HistoryCommand["command"], value: unknown): HistoryCommandResult | undefined {
  if (kind === "query") {
    const result = decodeHistoryQueryResult(value);
    return result === undefined ? undefined : { kind, result };
  }
  if (kind === "export" || kind === "export_confirm") {
    const result = decodeHistoryExportResult(value);
    return result === undefined ? undefined : { kind: "export", result };
  }
  const result = decodeHistoryDeleteResult(value);
  return result === undefined ? undefined : { kind: "delete", result };
}
