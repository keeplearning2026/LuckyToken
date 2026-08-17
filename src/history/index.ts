/**
 * History module (Ticket 23) — the one owner-process authority for the
 * versioned export workflow and confirmed irreversible deletion over the
 * three persistent authorities (Request Ledger, Runtime Diagnostics,
 * Deep-capture store). Each store stays authoritative over its own range
 * count/query/delete operations; the history module only orchestrates
 * ranges, gates, serialization, and per-authority truth.
 */
export {
  createHistoryAuthority,
  type HistoryAuthority,
  type HistoryAuthorityOptions,
} from "./authority.js";
export {
  runHistoryExport,
  type HistoryExportAttemptResult,
  type HistoryExportInput,
  type HistoryExportSources,
  type HistoryExporterOptions,
} from "./export.js";
export {
  runHistoryDelete,
  type HistoryDeleteAttempt,
} from "./delete.js";
export {
  validateExportDestination,
  inspectDestination,
  ensureDestinationDirectory,
  type DestinationRejection,
  type DestinationRejectionCode,
} from "./path-safety.js";
export {
  HISTORY_EXPORT_MANIFEST_VERSION,
  SENSITIVE_MARKER_LINE,
  buildManifestFooter,
  buildManifestHeader,
  serializeRange,
  type HistoryExportSourceFacts,
} from "./manifest.js";
