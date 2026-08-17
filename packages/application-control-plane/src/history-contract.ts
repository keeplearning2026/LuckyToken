/**
 * History contract (Ticket 23) — owned by the Control Plane package as the
 * public seam, mirroring the diagnostics/ledger/capture contracts.
 *
 * One versioned export workflow for permanent structured history: the
 * Request Ledger and Runtime Diagnostics stores stream into one versioned
 * manifest artifact; raw Deep Diagnostics capture is excluded by default and
 * clearly reported as excluded, and including it requires a second explicit
 * sensitive-data confirmation and marks the artifact sensitive. Range/all
 * deletion of eligible history is irreversible and gated by a confirmation
 * with a count preview; the result reports truthful per-authority outcomes
 * (three separate SQLite authorities cannot delete atomically, so partial
 * failure is reported per authority — never a blanket claim).
 *
 * The universal redaction choke point (Ticket 07) removes authentication
 * capability values in every export mode before any byte is serialized.
 *
 * Range semantics: every history range is half-open `[fromMs, toMs)` —
 * eligible ⇔ `time >= fromMs && time < toMs` — so adjacent windows never
 * double-delete a boundary record and the count preview, deletion, and
 * export all agree. `"all"` is the explicit no-range selector, never an
 * accident of omitting both endpoints.
 */

/** Persistence authorities that can degrade independently (three separate
 *  SQLite/WAL files; no cross-database atomicity is ever claimed). */
export type PersistenceAuthorityId = "requestLedger" | "diagnostics" | "capture";

export const PERSISTENCE_AUTHORITY_IDS: readonly PersistenceAuthorityId[] =
  Object.freeze(["requestLedger", "diagnostics", "capture"]);

/** One authority's degraded state in a status projection. */
export interface PersistenceAuthorityProjection {
  readonly authority: PersistenceAuthorityId;
  /** Epoch-ms of the first failure of this run. */
  readonly since: number;
}

/**
 * Audit-unavailable projection merged into every published status snapshot
 * while at least one authority is unavailable. `acknowledged` only silences
 * the urgent presentation; it never claims storage recovered.
 */
export interface PersistenceProjection {
  readonly auditUnavailable: true;
  readonly acknowledged: boolean;
  readonly authorities: readonly PersistenceAuthorityProjection[];
}

/**
 * Half-open history range selector shared by query, export, and deletion.
 * `"all"` is explicit; the object form carries at least one endpoint and
 * `fromMs <= toMs`.
 */
export type HistoryRange =
  | "all"
  | { readonly fromMs?: number; readonly toMs?: number };

/** Per-authority eligible-record counts over one history range. */
export interface HistoryCounts {
  readonly requestLedger: number;
  readonly diagnostics: number;
  readonly capture: number;
}

export interface HistoryQueryResult {
  readonly range: HistoryRange;
  readonly counts: HistoryCounts;
}

export type HistoryExportCaptureMode = "excluded" | "included";

export interface HistoryExportCommand {
  readonly range: HistoryRange;
  readonly capture: HistoryExportCaptureMode;
  /** Absolute destination path; the backend validates and canonicalizes it
   *  (the shell's save dialog returns canonical absolute paths; the CLI
   *  resolves relative paths to the working directory). */
  readonly destinationPath: string;
  /** Explicit consent to atomically replace an existing destination. */
  readonly overwrite: boolean;
}

export type HistoryExportFailureCode =
  | "invalid_destination"
  | "destination_exists"
  | "destination_locked"
  | "export_too_large"
  | "source_unavailable"
  | "cancelled"
  | "internal";

/** Value-free export failure; `message` is a fixed template, never raw
 *  fault text or dynamic secret-bearing error text. */
export interface HistoryExportFailure {
  readonly code: HistoryExportFailureCode;
  readonly message: string;
}

/** Summary of the published artifact, mirrored from the manifest. */
export interface HistoryExportManifestSummary {
  readonly manifestVersion: 1;
  readonly exportedAt: number;
  readonly sensitive: boolean;
  readonly auditUnavailable: boolean;
  readonly sources: {
    readonly requestLedger: {
      readonly schemaVersion: number;
      readonly count: number;
    };
    readonly diagnostics: {
      readonly schemaVersion: number;
      readonly count: number;
    };
    readonly capture:
      | {
          readonly included: false;
          readonly reason: "excluded-by-default";
        }
      | {
          readonly included: true;
          readonly schemaVersion: number;
          readonly count: number;
        };
  };
}

export type HistoryExportOutcome =
  | "ok"
  | "confirmation_required"
  | "failed";

export interface HistoryExportResult {
  readonly outcome: HistoryExportOutcome;
  /** Present only with outcome "confirmation_required": the single-use
   *  action id for `history_export_confirm`. */
  readonly actionId?: string;
  /** Present only with outcome "confirmation_required": the fixed message
   *  naming exactly what will be included. */
  readonly confirmationMessage?: string;
  /** Present only with outcome "ok". */
  readonly exportId?: string;
  readonly destinationPath?: string;
  readonly manifest?: HistoryExportManifestSummary;
  /** Present only with outcome "failed". */
  readonly failure?: HistoryExportFailure;
}

export interface HistoryDeleteCommand {
  readonly range: HistoryRange;
}

/** Count preview served before the irreversible deletion is confirmed. */
export interface HistoryDeletePreview {
  readonly range: HistoryRange;
  readonly counts: HistoryCounts;
}

export type HistoryDeleteFailureCode = "storage_failure" | "internal";

/** One authority's truthful deletion outcome. */
export interface HistoryDeleteAuthorityFailure {
  readonly authority: PersistenceAuthorityId;
  readonly code: HistoryDeleteFailureCode;
  /** Rows this authority committed before its failure (0 on failure). */
  readonly deleted: number;
}

export type HistoryDeleteOutcome =
  | "confirmation_required"
  | "completed"
  | "partial_failure"
  | "failed";

export interface HistoryDeleteResult {
  readonly outcome: HistoryDeleteOutcome;
  /** Present only with outcome "confirmation_required". */
  readonly actionId?: string;
  readonly preview?: HistoryDeletePreview;
  readonly confirmationMessage?: string;
  /** Per-authority committed row counts; present for completed /
   *  partial_failure / failed. */
  readonly deleted?: HistoryCounts;
  /** Present exactly when at least one authority failed. */
  readonly failures?: readonly HistoryDeleteAuthorityFailure[];
}

export type HistoryAcknowledgeOutcome = "ok" | "unchanged";

export interface HistoryAcknowledgeResult {
  readonly outcome: HistoryAcknowledgeOutcome;
}

export type HistoryCommand =
  | { readonly command: "query"; readonly range?: HistoryRange }
  | ({ readonly command: "export" } & HistoryExportCommand)
  | { readonly command: "export_confirm"; readonly actionId: string }
  | ({ readonly command: "delete" } & HistoryDeleteCommand)
  | { readonly command: "delete_confirm"; readonly actionId: string }
  | { readonly command: "acknowledge" };

export type HistoryCommandResult =
  | { readonly kind: "query"; readonly result: HistoryQueryResult }
  | { readonly kind: "export"; readonly result: HistoryExportResult }
  | { readonly kind: "delete"; readonly result: HistoryDeleteResult }
  | { readonly kind: "acknowledge"; readonly result: HistoryAcknowledgeResult };

/**
 * Handles versioned history commands against the live authorities. The
 * signal aborts long-running exports when the requesting connection is
 * lost; an aborted export never publishes a partial artifact.
 */
export type HistoryCommandHandler = (
  command: HistoryCommand,
  signal: AbortSignal,
) => Promise<HistoryCommandResult>;
