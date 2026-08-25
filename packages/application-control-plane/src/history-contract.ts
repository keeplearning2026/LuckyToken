import type { DiagnosticsUnavailableResult } from "./request-diagnostics-contract.js";

/** Half-open range `[fromMs, toMs)` over sealed diagnostics records. */
export type HistoryRange =
  | "all"
  | { readonly fromMs?: number; readonly toMs?: number };

/** The only two persistent record families in unified diagnostics. */
export interface HistoryCounts {
  readonly requestJourneys: number;
  readonly runtimeEvents: number;
}

export interface HistoryQueryResult {
  readonly range: HistoryRange;
  readonly counts: HistoryCounts;
}

export type HistoryQueryManagementResult =
  | HistoryQueryResult
  | DiagnosticsUnavailableResult;

export interface HistoryExportCommand {
  readonly destinationPath: string;
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

export interface HistoryExportFailure {
  readonly code: HistoryExportFailureCode;
  readonly message: string;
}

export interface HistoryExportManifestSummary {
  readonly manifestVersion: 2;
  readonly exportedAt: number;
  readonly sensitive: true;
  readonly snapshot: {
    readonly contract: "luckytoken-diagnostics-sqlite";
    readonly schemaVersion: 2;
    readonly bytes: number;
  };
}

export interface HistoryExportResult {
  readonly outcome: "ok" | "confirmation_required" | "failed";
  readonly actionId?: string;
  readonly confirmationMessage?: string;
  readonly exportId?: string;
  readonly destinationPath?: string;
  readonly manifest?: HistoryExportManifestSummary;
  readonly failure?: HistoryExportFailure;
}
export type HistoryExportManagementResult =
  | HistoryExportResult
  | DiagnosticsUnavailableResult;

export interface HistoryDeleteCommand {
  readonly range: HistoryRange;
}

export interface HistoryDeletePreview {
  readonly range: HistoryRange;
  readonly counts: HistoryCounts;
}

export interface HistoryDeleteFailure {
  readonly code: "storage_failure" | "internal";
  readonly message: string;
}

export interface HistoryDeleteResult {
  readonly outcome: "confirmation_required" | "completed" | "failed";
  readonly actionId?: string;
  readonly preview?: HistoryDeletePreview;
  readonly confirmationMessage?: string;
  readonly deleted?: HistoryCounts;
  readonly failure?: HistoryDeleteFailure;
}
export type HistoryDeleteManagementResult =
  | HistoryDeleteResult
  | DiagnosticsUnavailableResult;

export type HistoryCommand =
  | { readonly command: "query"; readonly range?: HistoryRange }
  | ({ readonly command: "export" } & HistoryExportCommand)
  | { readonly command: "export_confirm"; readonly actionId: string }
  | ({ readonly command: "delete" } & HistoryDeleteCommand)
  | { readonly command: "delete_confirm"; readonly actionId: string };

export type HistoryCommandResult =
  | { readonly kind: "query"; readonly result: HistoryQueryResult }
  | { readonly kind: "export"; readonly result: HistoryExportResult }
  | { readonly kind: "delete"; readonly result: HistoryDeleteResult };

export type HistoryCommandHandler = (
  command: HistoryCommand,
  signal: AbortSignal,
) => Promise<HistoryCommandResult>;
