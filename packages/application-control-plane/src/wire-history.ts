/**
 * Wire codecs for the history surface (Ticket 23). Pure allowlist decoders:
 * unknown fields are rejected (strict), every value is bounded, and range
 * endpoints are validated before they can reach the authorities.
 */
import type {
  HistoryAcknowledgeResult,
  HistoryCommand,
  HistoryCommandResult,
  HistoryCounts,
  HistoryDeleteAuthorityFailure,
  HistoryDeleteCommand,
  HistoryDeletePreview,
  HistoryDeleteResult,
  HistoryExportCommand,
  HistoryExportFailure,
  HistoryExportFailureCode,
  HistoryExportManifestSummary,
  HistoryExportResult,
  HistoryQueryResult,
  HistoryRange,
  PersistenceAuthorityId,
  PersistenceAuthorityProjection,
  PersistenceProjection,
} from "./history-contract.js";
import { PERSISTENCE_AUTHORITY_IDS } from "./history-contract.js";
import { isRecord } from "./wire.js";

const MAX_DESTINATION_PATH_LENGTH = 4_096;

function isSafeTime(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function isNonNegativeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function decodeAuthorityId(value: unknown): PersistenceAuthorityId | undefined {
  return PERSISTENCE_AUTHORITY_IDS.includes(value as PersistenceAuthorityId)
    ? (value as PersistenceAuthorityId)
    : undefined;
}

/**
 * Half-open history range: `"all"` or an object with at least one endpoint,
 * non-negative safe integers, and `fromMs <= toMs`. Unknown keys reject.
 */
export function decodeHistoryRange(value: unknown): HistoryRange | undefined {
  if (value === "all") return "all";
  if (!isRecord(value)) return undefined;
  for (const key of Object.keys(value)) {
    if (key !== "fromMs" && key !== "toMs") return undefined;
  }
  const fromMs = value.fromMs;
  const toMs = value.toMs;
  if (fromMs !== undefined && !isSafeTime(fromMs)) return undefined;
  if (toMs !== undefined && !isSafeTime(toMs)) return undefined;
  if (fromMs === undefined && toMs === undefined) return undefined;
  if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) {
    return undefined;
  }
  return Object.freeze({
    ...(fromMs === undefined ? {} : { fromMs }),
    ...(toMs === undefined ? {} : { toMs }),
  });
}

export function decodeHistoryCounts(value: unknown): HistoryCounts | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of Object.keys(value)) {
    if (key !== "requestLedger" && key !== "diagnostics" && key !== "capture") {
      return undefined;
    }
  }
  if (
    !isNonNegativeCount(value.requestLedger) ||
    !isNonNegativeCount(value.diagnostics) ||
    !isNonNegativeCount(value.capture)
  ) {
    return undefined;
  }
  return Object.freeze({
    requestLedger: value.requestLedger,
    diagnostics: value.diagnostics,
    capture: value.capture,
  });
}

export function decodeHistoryQueryResult(
  value: unknown,
): HistoryQueryResult | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of Object.keys(value)) {
    if (key !== "range" && key !== "counts") return undefined;
  }
  const range = decodeHistoryRange(value.range);
  const counts = decodeHistoryCounts(value.counts);
  if (range === undefined || counts === undefined) return undefined;
  return Object.freeze({ range, counts });
}

function decodeDestinationPath(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_DESTINATION_PATH_LENGTH
  ) {
    return undefined;
  }
  return value;
}

export function decodeHistoryExportCommand(
  value: unknown,
): HistoryExportCommand | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of Object.keys(value)) {
    if (
      key !== "range" &&
      key !== "capture" &&
      key !== "destinationPath" &&
      key !== "overwrite"
    ) {
      return undefined;
    }
  }
  const range = decodeHistoryRange(value.range);
  if (range === undefined || (value.capture !== "excluded" && value.capture !== "included")) {
    return undefined;
  }
  const destinationPath = decodeDestinationPath(value.destinationPath);
  if (destinationPath === undefined || typeof value.overwrite !== "boolean") {
    return undefined;
  }
  return Object.freeze({
    range,
    capture: value.capture,
    destinationPath,
    overwrite: value.overwrite,
  });
}

export function decodeHistoryDeleteCommand(
  value: unknown,
): HistoryDeleteCommand | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of Object.keys(value)) {
    if (key !== "range") return undefined;
  }
  const range = decodeHistoryRange(value.range);
  return range === undefined ? undefined : Object.freeze({ range });
}

function decodeHistoryExportFailure(
  value: unknown,
): HistoryExportFailure | undefined {
  if (!isRecord(value)) return undefined;
  const code = value.code;
  const allowed: readonly HistoryExportFailureCode[] = [
    "invalid_destination",
    "destination_exists",
    "destination_locked",
    "export_too_large",
    "source_unavailable",
    "cancelled",
    "internal",
  ];
  if (!allowed.includes(code as HistoryExportFailureCode)) return undefined;
  if (typeof value.message !== "string" || value.message.length === 0 || value.message.length > 512) {
    return undefined;
  }
  return Object.freeze({ code: code as HistoryExportFailureCode, message: value.message });
}

function decodeSourceCount(value: unknown): { schemaVersion: number; count: number } | undefined {
  if (!isRecord(value)) return undefined;
  if (!isNonNegativeCount(value.schemaVersion) || !isNonNegativeCount(value.count)) {
    return undefined;
  }
  return Object.freeze({ schemaVersion: value.schemaVersion, count: value.count });
}

function decodeManifestSummary(
  value: unknown,
): HistoryExportManifestSummary | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.manifestVersion !== 1 ||
    !isSafeTime(value.exportedAt) ||
    typeof value.sensitive !== "boolean" ||
    typeof value.auditUnavailable !== "boolean" ||
    !isRecord(value.sources)
  ) {
    return undefined;
  }
  const sources = value.sources;
  const requestLedger = decodeSourceCount(sources.requestLedger);
  const diagnostics = decodeSourceCount(sources.diagnostics);
  let capture: HistoryExportManifestSummary["sources"]["capture"];
  if (
    isRecord(sources.capture) &&
    sources.capture.included === false &&
    sources.capture.reason === "excluded-by-default"
  ) {
    capture = Object.freeze({ included: false, reason: "excluded-by-default" });
  } else if (
    isRecord(sources.capture) &&
    sources.capture.included === true
  ) {
    const count = decodeSourceCount(sources.capture);
    if (count === undefined) return undefined;
    capture = Object.freeze({ included: true, ...count });
  } else {
    return undefined;
  }
  if (requestLedger === undefined || diagnostics === undefined) return undefined;
  return Object.freeze({
    manifestVersion: 1,
    exportedAt: value.exportedAt,
    sensitive: value.sensitive,
    auditUnavailable: value.auditUnavailable,
    sources: Object.freeze({
      requestLedger,
      diagnostics,
      capture,
    }),
  });
}

export function decodeHistoryExportResult(
  value: unknown,
): HistoryExportResult | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.outcome !== "ok" &&
    value.outcome !== "confirmation_required" &&
    value.outcome !== "failed"
  ) {
    return undefined;
  }
  const outcome = value.outcome;
  if (outcome === "confirmation_required") {
    if (
      typeof value.actionId !== "string" ||
      value.actionId.length === 0 ||
      value.actionId.length > 128 ||
      typeof value.confirmationMessage !== "string" ||
      value.confirmationMessage.length === 0 ||
      value.confirmationMessage.length > 512
    ) {
      return undefined;
    }
    return Object.freeze({
      outcome,
      actionId: value.actionId,
      confirmationMessage: value.confirmationMessage,
    });
  }
  if (outcome === "ok") {
    if (
      typeof value.exportId !== "string" ||
      value.exportId.length === 0 ||
      value.exportId.length > 128
    ) {
      return undefined;
    }
    const destinationPath = decodeDestinationPath(value.destinationPath);
    const manifest = decodeManifestSummary(value.manifest);
    if (destinationPath === undefined || manifest === undefined) return undefined;
    return Object.freeze({
      outcome,
      exportId: value.exportId,
      destinationPath,
      manifest,
    });
  }
  const failure = decodeHistoryExportFailure(value.failure);
  if (failure === undefined) return undefined;
  return Object.freeze({ outcome, failure });
}

export function decodeHistoryDeletePreview(
  value: unknown,
): HistoryDeletePreview | undefined {
  if (!isRecord(value)) return undefined;
  const range = decodeHistoryRange(value.range);
  const counts = decodeHistoryCounts(value.counts);
  if (range === undefined || counts === undefined) return undefined;
  return Object.freeze({ range, counts });
}

function decodeHistoryDeleteAuthorityFailure(
  value: unknown,
): HistoryDeleteAuthorityFailure | undefined {
  if (!isRecord(value)) return undefined;
  const authority = decodeAuthorityId(value.authority);
  if (
    authority === undefined ||
    (value.code !== "storage_failure" && value.code !== "internal") ||
    !isNonNegativeCount(value.deleted)
  ) {
    return undefined;
  }
  return Object.freeze({ authority, code: value.code, deleted: value.deleted });
}

export function decodeHistoryDeleteResult(
  value: unknown,
): HistoryDeleteResult | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.outcome !== "confirmation_required" &&
    value.outcome !== "completed" &&
    value.outcome !== "partial_failure" &&
    value.outcome !== "failed"
  ) {
    return undefined;
  }
  const outcome = value.outcome;
  if (outcome === "confirmation_required") {
    if (
      typeof value.actionId !== "string" ||
      value.actionId.length === 0 ||
      value.actionId.length > 128 ||
      typeof value.confirmationMessage !== "string" ||
      value.confirmationMessage.length === 0 ||
      value.confirmationMessage.length > 512
    ) {
      return undefined;
    }
    const preview = decodeHistoryDeletePreview(value.preview);
    if (preview === undefined) return undefined;
    return Object.freeze({
      outcome,
      actionId: value.actionId,
      confirmationMessage: value.confirmationMessage,
      preview,
    });
  }
  const deleted = decodeHistoryCounts(value.deleted);
  if (deleted === undefined) return undefined;
  let failures: readonly HistoryDeleteAuthorityFailure[] | undefined;
  if (value.failures !== undefined) {
    if (!Array.isArray(value.failures)) return undefined;
    const decoded = value.failures
      .map((entry) => decodeHistoryDeleteAuthorityFailure(entry))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
    if (decoded.length !== value.failures.length || decoded.length === 0) {
      return undefined;
    }
    failures = Object.freeze(decoded);
  }
  if (
    (outcome === "completed" && failures !== undefined) ||
    ((outcome === "partial_failure" || outcome === "failed") && failures === undefined)
  ) {
    return undefined;
  }
  return Object.freeze({
    outcome,
    deleted,
    ...(failures === undefined ? {} : { failures }),
  });
}

export function decodeHistoryAcknowledgeResult(
  value: unknown,
): HistoryAcknowledgeResult | undefined {
  if (!isRecord(value)) return undefined;
  if (value.outcome !== "ok" && value.outcome !== "unchanged") return undefined;
  return Object.freeze({ outcome: value.outcome });
}

export function decodeHistoryCommand(value: unknown): HistoryCommand | undefined {
  if (!isRecord(value) || typeof value.command !== "string") return undefined;
  if (value.command === "query") {
    for (const key of Object.keys(value)) {
      if (key !== "command" && key !== "range") return undefined;
    }
    const range =
      value.range === undefined ? undefined : decodeHistoryRange(value.range);
    if (range === undefined && value.range !== undefined) return undefined;
    return Object.freeze({
      command: "query",
      ...(range === undefined ? {} : { range }),
    });
  }
  if (value.command === "export") {
    const exportCommand = decodeHistoryExportCommand(value);
    return exportCommand === undefined
      ? undefined
      : Object.freeze({ command: "export", ...exportCommand });
  }
  if (value.command === "export_confirm") {
    if (
      typeof value.actionId !== "string" ||
      value.actionId.length === 0 ||
      value.actionId.length > 128
    ) {
      return undefined;
    }
    return Object.freeze({ command: "export_confirm", actionId: value.actionId });
  }
  if (value.command === "delete") {
    const deleteCommand = decodeHistoryDeleteCommand(value);
    return deleteCommand === undefined
      ? undefined
      : Object.freeze({ command: "delete", ...deleteCommand });
  }
  if (value.command === "delete_confirm") {
    if (
      typeof value.actionId !== "string" ||
      value.actionId.length === 0 ||
      value.actionId.length > 128
    ) {
      return undefined;
    }
    return Object.freeze({ command: "delete_confirm", actionId: value.actionId });
  }
  if (value.command === "acknowledge") {
    return Object.freeze({ command: "acknowledge" });
  }
  return undefined;
}

export function decodeHistoryCommandResult(
  kind: HistoryCommand["command"],
  value: unknown,
): HistoryCommandResult | undefined {
  if (kind === "query") {
    const result = decodeHistoryQueryResult(value);
    return result === undefined ? undefined : { kind, result };
  }
  if (kind === "export" || kind === "export_confirm") {
    const result = decodeHistoryExportResult(value);
    return result === undefined ? undefined : { kind: "export", result };
  }
  if (kind === "delete" || kind === "delete_confirm") {
    const result = decodeHistoryDeleteResult(value);
    return result === undefined ? undefined : { kind: "delete", result };
  }
  const result = decodeHistoryAcknowledgeResult(value);
  return result === undefined ? undefined : { kind: "acknowledge", result };
}

export function decodePersistenceAuthorityProjection(
  value: unknown,
): PersistenceAuthorityProjection | undefined {
  if (!isRecord(value)) return undefined;
  const authority = decodeAuthorityId(value.authority);
  if (authority === undefined || !isSafeTime(value.since)) return undefined;
  return Object.freeze({ authority, since: value.since });
}

export function decodePersistenceProjection(
  value: unknown,
): PersistenceProjection | undefined {
  if (
    !isRecord(value) ||
    value.auditUnavailable !== true ||
    typeof value.acknowledged !== "boolean" ||
    !Array.isArray(value.authorities) ||
    value.authorities.length === 0
  ) {
    return undefined;
  }
  const authorities = value.authorities
    .map((entry) => decodePersistenceAuthorityProjection(entry))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  if (authorities.length !== value.authorities.length) return undefined;
  return Object.freeze({
    auditUnavailable: true,
    acknowledged: value.acknowledged,
    authorities: Object.freeze(authorities),
  });
}
