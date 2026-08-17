import type {
  BackupCommand,
  BackupFailure,
  BackupManifestEntrySummary,
  BackupManifestSummary,
  BackupResult,
  CompatibilityIssue,
  RecoveryProjection,
} from "./backup-contract.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const failureCodes: ReadonlySet<string> = new Set([
  "invalid_destination",
  "destination_exists",
  "destination_locked",
  "source_outside_owned_root",
  "source_unavailable",
  "backup_too_large",
  "cancelled",
  "internal",
]);

export function decodeBackupCommand(value: unknown): BackupCommand | undefined {
  const input = record(value);
  if (input === undefined) return undefined;
  if (input.command === "confirm") {
    return typeof input.actionId === "string" &&
      input.actionId.length > 0 &&
      input.actionId.length <= 128
      ? { command: "confirm", actionId: input.actionId }
      : undefined;
  }
  if (
    input.command !== "create" ||
    (input.mode !== "ordinary" && input.mode !== "full_sensitive") ||
    typeof input.destinationPath !== "string" ||
    input.destinationPath.length === 0 ||
    input.destinationPath.length > 4_096 ||
    typeof input.overwrite !== "boolean"
  ) {
    return undefined;
  }
  return {
    command: "create",
    mode: input.mode,
    destinationPath: input.destinationPath,
    overwrite: input.overwrite,
  };
}

function decodeFailure(value: unknown): BackupFailure | undefined {
  const input = record(value);
  if (
    input === undefined ||
    typeof input.code !== "string" ||
    !failureCodes.has(input.code) ||
    typeof input.message !== "string" ||
    input.message.length === 0 ||
    input.message.length > 512
  ) {
    return undefined;
  }
  return Object.freeze({
    code: input.code as BackupFailure["code"],
    message: input.message,
  });
}

function decodeEntry(value: unknown): BackupManifestEntrySummary | undefined {
  const input = record(value);
  if (
    input === undefined ||
    typeof input.id !== "string" ||
    input.id.length === 0 ||
    input.id.length > 128 ||
    typeof input.contract !== "string" ||
    input.contract.length === 0 ||
    input.contract.length > 128 ||
    (typeof input.version !== "string" && typeof input.version !== "number") ||
    typeof input.sensitive !== "boolean"
  ) {
    return undefined;
  }
  return Object.freeze({
    id: input.id,
    contract: input.contract,
    version: input.version,
    sensitive: input.sensitive,
  });
}

function decodeManifest(value: unknown): BackupManifestSummary | undefined {
  const input = record(value);
  if (
    input === undefined ||
    input.format !== "luckytoken-backup" ||
    input.formatVersion !== 1 ||
    !Number.isSafeInteger(input.createdAt) ||
    (input.createdAt as number) < 0 ||
    typeof input.sensitive !== "boolean" ||
    !Array.isArray(input.entries)
  ) {
    return undefined;
  }
  const entries = input.entries.map(decodeEntry);
  if (entries.some((entry) => entry === undefined)) return undefined;
  const typed = entries.filter(
    (entry): entry is BackupManifestEntrySummary => entry !== undefined,
  );
  if (typed.some((entry) => entry.sensitive !== input.sensitive)) {
    return undefined;
  }
  return Object.freeze({
    format: "luckytoken-backup",
    formatVersion: 1,
    createdAt: input.createdAt as number,
    sensitive: input.sensitive,
    entries: Object.freeze(typed),
  });
}

export function decodeBackupResult(value: unknown): BackupResult | undefined {
  const input = record(value);
  if (
    input === undefined ||
    (input.outcome !== "ok" &&
      input.outcome !== "confirmation_required" &&
      input.outcome !== "failed")
  ) {
    return undefined;
  }
  if (input.outcome === "confirmation_required") {
    return typeof input.actionId === "string" &&
      input.actionId.length > 0 &&
      typeof input.confirmationMessage === "string" &&
      input.confirmationMessage.length > 0
      ? Object.freeze({
          outcome: "confirmation_required" as const,
          actionId: input.actionId,
          confirmationMessage: input.confirmationMessage,
        })
      : undefined;
  }
  if (input.outcome === "failed") {
    const failure = decodeFailure(input.failure);
    return failure === undefined
      ? undefined
      : Object.freeze({ outcome: "failed" as const, failure });
  }
  const manifest = decodeManifest(input.manifest);
  if (
    manifest === undefined ||
    typeof input.destinationPath !== "string" ||
    input.destinationPath.length === 0
  ) {
    return undefined;
  }
  return Object.freeze({
    outcome: "ok" as const,
    destinationPath: input.destinationPath,
    manifest,
  });
}

function decodeIssue(value: unknown): CompatibilityIssue | undefined {
  const input = record(value);
  if (
    input === undefined ||
    typeof input.path !== "string" ||
    input.path.length === 0 ||
    input.path.length > 4_096 ||
    typeof input.contract !== "string" ||
    input.contract.length === 0 ||
    input.contract.length > 128 ||
    (typeof input.foundVersion !== "string" &&
      typeof input.foundVersion !== "number") ||
    (typeof input.expectedVersion !== "string" &&
      typeof input.expectedVersion !== "number") ||
    typeof input.validationError !== "string" ||
    input.validationError.length === 0 ||
    input.validationError.length > 512
  ) {
    return undefined;
  }
  return Object.freeze({
    path: input.path,
    contract: input.contract,
    foundVersion: input.foundVersion,
    expectedVersion: input.expectedVersion,
    validationError: input.validationError,
  });
}

export function decodeRecoveryProjection(
  value: unknown,
): RecoveryProjection | undefined {
  const input = record(value);
  if (
    input === undefined ||
    input.mode !== "incompatible_configuration" ||
    !Array.isArray(input.issues) ||
    input.issues.length === 0 ||
    input.issues.length > 64
  ) {
    return undefined;
  }
  const issues = input.issues.map(decodeIssue);
  if (issues.some((entry) => entry === undefined)) return undefined;
  return Object.freeze({
    mode: "incompatible_configuration",
    issues: Object.freeze(
      issues.filter((entry): entry is CompatibilityIssue => entry !== undefined),
    ),
  });
}
