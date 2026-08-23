import type { DiagnosticsUnavailableResult } from "./request-diagnostics-contract.js";

/** Ticket 24 backup and recovery public contract. */

export type BackupMode = "ordinary" | "full_sensitive";

export type BackupFailureCode =
  | "invalid_destination"
  | "destination_exists"
  | "destination_locked"
  | "source_outside_owned_root"
  | "source_unavailable"
  | "backup_too_large"
  | "cancelled"
  | "internal";

export interface BackupFailure {
  readonly code: BackupFailureCode;
  /** Fixed, value-free copy. Raw filesystem/storage errors never cross the
   * control boundary. */
  readonly message: string;
}

export interface BackupManifestEntrySummary {
  readonly id: string;
  readonly contract: string;
  readonly version: string | number;
  readonly sensitive: boolean;
}

export interface BackupManifestSummary {
  readonly format: "luckytoken-backup";
  readonly formatVersion: 1;
  readonly createdAt: number;
  readonly sensitive: boolean;
  readonly entries: readonly BackupManifestEntrySummary[];
}

export interface BackupCreateCommand {
  readonly mode: BackupMode;
  readonly destinationPath: string;
  readonly overwrite: boolean;
}

export interface BackupResult {
  readonly outcome: "ok" | "confirmation_required" | "failed";
  readonly actionId?: string;
  readonly confirmationMessage?: string;
  readonly destinationPath?: string;
  readonly manifest?: BackupManifestSummary;
  readonly failure?: BackupFailure;
}
export type BackupManagementResult = BackupResult | DiagnosticsUnavailableResult;

export type BackupCommand =
  | ({ readonly command: "create" } & BackupCreateCommand)
  | { readonly command: "confirm"; readonly actionId: string };

export type BackupCommandHandler = (
  command: BackupCommand,
  signal: AbortSignal,
) => Promise<BackupResult>;

/** Exact, sanitized fact about one LuckyToken-owned file that cannot be
 * safely interpreted by this application build. */
export interface CompatibilityIssue {
  readonly path: string;
  readonly contract: string;
  readonly foundVersion: string | number | "missing" | "invalid";
  readonly expectedVersion: string | number;
  readonly validationError: string;
}

export interface RecoveryProjection {
  readonly mode: "incompatible_configuration";
  readonly issues: readonly CompatibilityIssue[];
}
