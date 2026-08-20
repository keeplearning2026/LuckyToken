import type {
  RuntimeDiagnosticEvent,
  RuntimeDiagnosticsQueryResult,
} from "./diagnostics-contract.js";
import {
  controlPlaneVersion,
  type AliasCanonicalTarget,
  type AliasCommand,
  type AliasCommandResult,
  type AliasFileError,
  type AliasFileErrorKind,
  type AliasFileState,
  type AliasLayer,
  type AliasStatusProjection,
  type AliasValidationCode,
  type AliasValidationErrorProjection,
  type ApplicationCommand,
  type ApplicationCommandConflict,
  type ApplicationCommandExecution,
  type ApplicationCommandOutcome,
  type ApplicationCommandResult,
  type ApplicationIdentity,
  type ApplicationOwnership,
  type ApplicationStatus,
  type CatalogCommand,
  type CatalogCommandResult,
  type CodexIntegrationCommand,
  type CodexIntegrationCommandResult,
  type CodexIntegrationObservedState,
  type CodexIntegrationProjection,
  type CatalogModelAvailability,
  type CatalogModelProjection,
  type CatalogProviderProjection,
  type CatalogProviderState,
  type CatalogRefreshErrorProjection,
  type CatalogRefreshReportProjection,
  type CatalogSnapshotProjection,
  type CatalogStatusProjection,
  type DataPlaneFailure,
  type EffectiveAliasProjection,
  type EffectiveAliasRegistryProjection,
  type EffectiveCatalogCompositionError,
  type EffectiveCatalogProjection,
  type EffectiveModelCost,
  type EffectiveModelLayer,
  type EffectiveModelProjection,
  type EffectiveProviderLayer,
  type EffectiveProviderProjection,
  type HelloResult,
  type ModelsCommand,
  type ModelsCommandResult,
  type ModelsFileError,
  type ModelsFileErrorLocation,
  type ModelsFileErrorKind,
  type ModelsFileState,
  type ModelsProjection,
  type CaptureEvent,
  type CaptureQueryResult,
  type RegisteredSetting,
  type RequestLedgerEvent,
  type RequestLedgerQueryResult,
  type RuntimeCommand,
  type RuntimeCommandConflict,
  type RuntimeCommandExecution,
  type RuntimeCommandResult,
  type SettingsCommand,
  type SettingsCommandResult,
  type StatusEvent,
  type StatusSnapshot,
} from "./contracts.js";
import {
  decodeDiagnosticEvent,
  decodeDiagnosticRecord,
} from "./wire-diagnostics.js";
import {
  decodeRequestLedgerEvent,
  decodeRequestLedgerResult,
} from "./wire-ledger.js";
import {
  decodeAnalyticsResult,
} from "./wire-analytics.js";
import {
  normalizeAnalyticsQuery,
  type AnalyticsOptionsResult,
  type AnalyticsQuery,
  type AnalyticsResult,
} from "./analytics-contract.js";
import {
  decodeCaptureEvent,
  decodeCaptureQuery,
  decodeCaptureQueryResult,
} from "./wire-capture.js";
import {
  decodeHistoryAcknowledgeResult,
  decodeHistoryDeleteCommand,
  decodeHistoryDeleteResult,
  decodeHistoryExportCommand,
  decodeHistoryExportResult,
  decodeHistoryQueryResult,
  decodeHistoryRange,
  decodePersistenceProjection,
} from "./wire-history.js";
import type {
  HistoryAcknowledgeResult,
  HistoryDeleteCommand,
  HistoryExportCommand,
  HistoryExportResult,
  HistoryDeleteResult,
  HistoryQueryResult,
} from "./history-contract.js";
import type { BackupCommand, BackupResult } from "./backup-contract.js";
import {
  decodeBackupCommand,
  decodeBackupResult,
  decodeRecoveryProjection,
} from "./wire-backup.js";
import { decodeAttentionProjection } from "./attention-contract.js";
import {
  type AuthCommand,
  type AuthCommandResult,
  type AuthInfoLink,
  type AuthInteractionEvent,
  type AuthInteractionResponse,
  type AuthOptionsProjection,
  type AuthPromptOption,
  type AuthProviderOption,
  type CredentialCommand,
  type CredentialCommandResult,
  type CredentialFileError,
  type CredentialFileErrorKind,
  type CredentialImportApplyEntryResult,
  type CredentialImportEntryPreview,
  type CredentialImportSelection,
  type CredentialProjection,
  type ProviderAuthStatus,
  type RequestIdentitiesQueryResult,
  type RequestIdentityRecord,
} from "./contracts.js";

export type RecordValue = Record<string, unknown>;

export type ClientRequest =
  | {
      readonly type: "hello";
      readonly requestId: string;
      readonly contractVersion: number;
      readonly capability: string;
    }
  | { readonly type: "get_status"; readonly requestId: string }
  | {
      readonly type: "get_diagnostics";
      readonly requestId: string;
      readonly query?: unknown;
    }
  | { readonly type: "get_request_identities"; readonly requestId: string }
  | { readonly type: "diagnostics_subscribe"; readonly requestId: string }
  | { readonly type: "diagnostics_unsubscribe"; readonly requestId: string }
  | {
      readonly type: "get_request_ledger";
      readonly requestId: string;
      readonly query?: unknown;
    }
  | {
      readonly type: "get_analytics";
      readonly requestId: string;
      readonly query: AnalyticsQuery;
    }
  | { readonly type: "ledger_subscribe"; readonly requestId: string }
  | { readonly type: "ledger_unsubscribe"; readonly requestId: string }
  | {
      readonly type: "get_capture";
      readonly requestId: string;
      readonly query?: unknown;
    }
  | { readonly type: "capture_subscribe"; readonly requestId: string }
  | { readonly type: "capture_unsubscribe"; readonly requestId: string }
  | {
      readonly type: "history_query";
      readonly requestId: string;
      readonly range?: unknown;
    }
  | {
      readonly type: "history_export_command";
      readonly requestId: string;
      readonly command: HistoryExportCommand;
    }
  | {
      readonly type: "history_export_confirm";
      readonly requestId: string;
      readonly actionId: string;
    }
  | {
      readonly type: "history_delete_command";
      readonly requestId: string;
      readonly command: HistoryDeleteCommand;
    }
  | {
      readonly type: "history_delete_confirm";
      readonly requestId: string;
      readonly actionId: string;
    }
  | { readonly type: "history_acknowledge"; readonly requestId: string }
  | {
      readonly type: "backup_command";
      readonly requestId: string;
      readonly command: BackupCommand;
    }
  | {
      readonly type: "runtime_command";
      readonly requestId: string;
      readonly command: RuntimeCommand;
    }
  | {
      readonly type: "settings_command";
      readonly requestId: string;
      readonly command: SettingsCommand;
    }
  | {
      readonly type: "application_command";
      readonly requestId: string;
      readonly command: ApplicationCommand;
    }
  | {
      readonly type: "models_command";
      readonly requestId: string;
      readonly command: ModelsCommand;
    }
  | {
      readonly type: "credential_command";
      readonly requestId: string;
      readonly command: CredentialCommand;
    }
  | {
      readonly type: "auth_command";
      readonly requestId: string;
      readonly command: AuthCommand;
    }
  | {
      readonly type: "auth_interaction_response";
      readonly requestId: string;
      readonly response: AuthInteractionResponse;
    }
  | {
      readonly type: "catalog_command";
      readonly requestId: string;
      readonly command: CatalogCommand;
    }
  | {
      readonly type: "alias_command";
      readonly requestId: string;
      readonly command: AliasCommand;
    }
  | {
      readonly type: "codex_integration_command";
      readonly requestId: string;
      readonly command: CodexIntegrationCommand;
    }
  | { readonly type: "subscribe"; readonly requestId: string }
  | { readonly type: "unsubscribe"; readonly requestId: string };

export type ControlPlaneErrorCode =
  "invalid_request" | "unauthorized" | "hello_required" | "unknown_command";

export type ServerMessage =
  | {
      readonly type: "hello_result";
      readonly requestId: string;
      readonly result: HelloResult;
    }
  | {
      readonly type: "status_result";
      readonly requestId: string;
      readonly snapshot: StatusSnapshot;
    }
  | {
      readonly type: "runtime_command_result";
      readonly requestId: string;
      readonly result: RuntimeCommandResult;
    }
  | {
      readonly type: "diagnostics_result";
      readonly requestId: string;
      readonly result: RuntimeDiagnosticsQueryResult;
    }
  | {
      readonly type: "request_identities_result";
      readonly requestId: string;
      readonly result: RequestIdentitiesQueryResult;
    }
  | {
      readonly type: "request_ledger_result";
      readonly requestId: string;
      readonly result: RequestLedgerQueryResult;
    }
  | {
      readonly type: "analytics_result";
      readonly requestId: string;
      readonly result: AnalyticsResult | AnalyticsOptionsResult;
    }
  | {
      readonly type: "capture_result";
      readonly requestId: string;
      readonly result: CaptureQueryResult;
    }
  | {
      readonly type: "history_query_result";
      readonly requestId: string;
      readonly result: HistoryQueryResult;
    }
  | {
      readonly type: "history_export_result";
      readonly requestId: string;
      readonly result: HistoryExportResult;
    }
  | {
      readonly type: "history_delete_result";
      readonly requestId: string;
      readonly result: HistoryDeleteResult;
    }
  | {
      readonly type: "history_acknowledge_result";
      readonly requestId: string;
      readonly result: HistoryAcknowledgeResult;
    }
  | {
      readonly type: "backup_result";
      readonly requestId: string;
      readonly result: BackupResult;
    }
  | {
      readonly type: "settings_command_result";
      readonly requestId: string;
      readonly result: SettingsCommandResult;
    }
  | {
      readonly type: "application_command_result";
      readonly requestId: string;
      readonly result: ApplicationCommandResult;
    }
  | {
      readonly type: "models_command_result";
      readonly requestId: string;
      readonly result: ModelsCommandResult;
    }
  | {
      readonly type: "credential_command_result";
      readonly requestId: string;
      readonly result: CredentialCommandResult;
    }
  | {
      readonly type: "auth_command_result";
      readonly requestId: string;
      readonly result: AuthCommandResult;
    }
  | {
      readonly type: "auth_interaction_event";
      readonly requestId: string;
      readonly event: AuthInteractionEvent;
    }
  | {
      readonly type: "catalog_command_result";
      readonly requestId: string;
      readonly result: CatalogCommandResult;
    }
  | {
      readonly type: "alias_command_result";
      readonly requestId: string;
      readonly result: AliasCommandResult;
    }
  | {
      readonly type: "codex_integration_command_result";
      readonly requestId: string;
      readonly result: CodexIntegrationCommandResult;
    }
  | { readonly type: "subscribed"; readonly requestId: string }
  | { readonly type: "unsubscribed"; readonly requestId: string }
  | {
      readonly type: "error";
      readonly requestId: string;
      readonly code: ControlPlaneErrorCode;
    }
  | {
      readonly type: "event";
      readonly event:
        | StatusEvent
        | RuntimeDiagnosticEvent
        | RequestLedgerEvent
        | CaptureEvent;
    };

export type DecodedClientRequest =
  | { readonly type: "valid"; readonly request: ClientRequest }
  | {
      readonly type: "invalid";
      readonly requestId: string;
      readonly code: "invalid_request" | "unknown_command";
    };

export function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeRequestId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value)
    ? value
    : undefined;
}

export function decodeCatalogStatusProjection(
  value: unknown,
): CatalogStatusProjection | undefined {
  if (
    !isRecord(value) ||
    typeof value.version !== "number" ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) < 0 ||
    typeof value.refreshing !== "boolean" ||
    !Array.isArray(value.failedProviderIds) ||
    value.failedProviderIds.some((entry) => typeof entry !== "string")
  ) {
    return undefined;
  }
  if (
    value.refreshedAt !== undefined &&
    typeof value.refreshedAt !== "number"
  ) {
    return undefined;
  }
  return Object.freeze({
    version: value.version as number,
    refreshing: value.refreshing,
    ...(value.refreshedAt === undefined
      ? {}
      : { refreshedAt: value.refreshedAt as number }),
    failedProviderIds: Object.freeze([...value.failedProviderIds]),
  });
}

export function decodeApplicationStatus(
  value: unknown,
): ApplicationStatus | undefined {
  if (
    !isRecord(value) ||
    (value.provider !== "configured" && value.provider !== "unconfigured") ||
    (value.modelDataPlane !== "stopped" &&
      value.modelDataPlane !== "starting" &&
      value.modelDataPlane !== "running" &&
      value.modelDataPlane !== "stopping" &&
      value.modelDataPlane !== "failed")
  ) {
    return undefined;
  }
  const dataPlane = decodeDataPlaneStatus(value.dataPlane);
  if (
    (value.dataPlane !== undefined && dataPlane === undefined) ||
    (value.modelDataPlane === "failed" && dataPlane?.failure === undefined) ||
    (value.modelDataPlane !== "failed" && dataPlane?.failure !== undefined)
  ) {
    return undefined;
  }
  const settings = decodeSettingsProjection(value.settings);
  if (value.settings !== undefined && settings === undefined) {
    return undefined;
  }
  const models = decodeModelsProjection(value.models);
  if (value.models !== undefined && models === undefined) {
    return undefined;
  }
  const credentials = decodeCredentialProjection(value.credentials);
  if (value.credentials !== undefined && credentials === undefined) {
    return undefined;
  }
  const catalog = decodeCatalogStatusProjection(value.catalog);
  if (value.catalog !== undefined && catalog === undefined) {
    return undefined;
  }
  const aliases = decodeAliasStatusProjection(value.aliases);
  if (value.aliases !== undefined && aliases === undefined) {
    return undefined;
  }
  if (value.confirmation !== undefined) return undefined;
  return {
    modelDataPlane: value.modelDataPlane,
    provider: value.provider,
    ...(dataPlane === undefined ? {} : { dataPlane }),
    ...(settings === undefined ? {} : { settings }),
    ...(models === undefined ? {} : { models }),
    ...(credentials === undefined ? {} : { credentials }),
    ...(catalog === undefined ? {} : { catalog }),
    ...(aliases === undefined ? {} : { aliases }),
  };
}

function decodeRegisteredSetting(
  value: unknown,
): RegisteredSetting | undefined {
  if (
    !isRecord(value) ||
    typeof value.key !== "string" ||
    (value.type !== "boolean" &&
      value.type !== "number" &&
      value.type !== "string") ||
    (typeof value.default !== "boolean" &&
      typeof value.default !== "number" &&
      typeof value.default !== "string") ||
    (value.sensitivity !== "public" && value.sensitivity !== "secret") ||
    (value.applyMode !== "hot-apply" &&
      value.applyMode !== "restart-required") ||
    (typeof value.value !== "boolean" &&
      typeof value.value !== "number" &&
      typeof value.value !== "string")
  ) {
    return undefined;
  }
  const effective =
    typeof value.effective === "boolean" ||
    typeof value.effective === "number" ||
    typeof value.effective === "string"
      ? value.effective
      : undefined;
  if (
    (value.effective !== undefined && effective === undefined) ||
    (value.applyMode === "hot-apply" && value.effective !== undefined) ||
    (value.applyMode === "restart-required" && effective === undefined)
  ) {
    return undefined;
  }
  return Object.freeze({
    key: value.key,
    type: value.type,
    default: value.default,
    validation: value.validation,
    sensitivity: value.sensitivity,
    applyMode: value.applyMode,
    value: value.value,
    ...(effective === undefined ? {} : { effective }),
  });
}

export function decodeSettingsProjection(
  value: unknown,
): Readonly<Record<string, RegisteredSetting>> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  const result: Record<string, RegisteredSetting> = Object.create(null);
  for (const [key, raw] of Object.entries(value)) {
    const setting = decodeRegisteredSetting(raw);
    if (setting === undefined || setting.key !== key) return undefined;
    result[key] = setting;
  }
  return Object.freeze(result);
}

function decodeSettingsCommand(value: unknown): SettingsCommand | undefined {
  if (!isRecord(value)) return undefined;
  if (value.command === "query") {
    if (value.keys === undefined) return { command: "query" };
    if (
      Array.isArray(value.keys) &&
      value.keys.every((key) => typeof key === "string")
    ) {
      return { command: "query", keys: value.keys as string[] };
    }
    return undefined;
  }
  if (value.command === "set") {
    if (typeof value.key !== "string" || value.key.length === 0) {
      return undefined;
    }
    return { command: "set", key: value.key, value: value.value };
  }
  return undefined;
}

const catalogProviderStates: ReadonlySet<string> = new Set([
  "known",
  "cached",
  "refreshing",
  "succeeded",
  "failed",
]);

const catalogModelAvailability: ReadonlySet<string> = new Set([
  "available",
  "unavailable",
  "unknown",
]);

function decodeCatalogModelProjection(
  value: unknown,
): CatalogModelProjection | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.dynamic !== "boolean" ||
    typeof value.availability !== "string" ||
    !catalogModelAvailability.has(value.availability)
  ) {
    return undefined;
  }
  return Object.freeze({
    id: value.id,
    dynamic: value.dynamic,
    availability: value.availability as CatalogModelAvailability,
  });
}

function decodeCatalogProviderProjection(
  value: unknown,
): CatalogProviderProjection | undefined {
  if (
    !isRecord(value) ||
    typeof value.providerId !== "string" ||
    value.providerId.length === 0 ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    typeof value.dynamic !== "boolean" ||
    typeof value.state !== "string" ||
    !catalogProviderStates.has(value.state) ||
    !Array.isArray(value.models)
  ) {
    return undefined;
  }
  const models = value.models.map(decodeCatalogModelProjection);
  if (models.some((entry) => entry === undefined)) return undefined;
  if (
    (value.error !== undefined && typeof value.error !== "string") ||
    (value.errorCode !== undefined && typeof value.errorCode !== "string") ||
    (value.refreshedAt !== undefined &&
      typeof value.refreshedAt !== "number") ||
    (value.cachedAt !== undefined && typeof value.cachedAt !== "number")
  ) {
    return undefined;
  }
  // Only a failed Provider carries the value-safe error fields, and a
  // failed Provider always does.
  if (value.state !== "failed" && value.error !== undefined) {
    return undefined;
  }
  if (value.state !== "failed" && value.errorCode !== undefined) {
    return undefined;
  }
  if (value.state === "failed" && value.error === undefined) {
    return undefined;
  }
  return Object.freeze({
    providerId: value.providerId,
    name: value.name,
    dynamic: value.dynamic,
    state: value.state as CatalogProviderState,
    ...(value.error === undefined ? {} : { error: value.error as string }),
    ...(value.errorCode === undefined
      ? {}
      : { errorCode: value.errorCode as string }),
    ...(value.refreshedAt === undefined
      ? {}
      : { refreshedAt: value.refreshedAt as number }),
    ...(value.cachedAt === undefined
      ? {}
      : { cachedAt: value.cachedAt as number }),
    models: Object.freeze(
      models.filter(
        (entry): entry is CatalogModelProjection => entry !== undefined,
      ),
    ),
  });
}

function decodeCatalogRefreshError(
  value: unknown,
): CatalogRefreshErrorProjection | undefined {
  if (
    !isRecord(value) ||
    typeof value.providerId !== "string" ||
    value.providerId.length === 0 ||
    typeof value.code !== "string" ||
    value.code.length === 0 ||
    typeof value.message !== "string" ||
    value.message.length === 0
  ) {
    return undefined;
  }
  return Object.freeze({
    providerId: value.providerId,
    code: value.code,
    message: value.message,
  });
}

export function decodeCatalogSnapshotProjection(
  value: unknown,
): CatalogSnapshotProjection | undefined {
  if (
    !isRecord(value) ||
    typeof value.version !== "number" ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) < 0 ||
    typeof value.modelsJsonValid !== "boolean" ||
    !Array.isArray(value.providers) ||
    !Array.isArray(value.refreshErrors)
  ) {
    return undefined;
  }
  const providers = value.providers.map(decodeCatalogProviderProjection);
  if (providers.some((entry) => entry === undefined)) return undefined;
  const refreshErrors = value.refreshErrors.map(decodeCatalogRefreshError);
  if (refreshErrors.some((entry) => entry === undefined)) return undefined;
  const modelsJsonError = decodeModelsFileError(value.modelsJsonError);
  if (value.modelsJsonError !== undefined && modelsJsonError === undefined) {
    return undefined;
  }
  if (!value.modelsJsonValid && modelsJsonError === undefined) {
    // An invalid models.json always carries its value-free file error.
    return undefined;
  }
  if (value.modelsJsonValid && modelsJsonError !== undefined) {
    return undefined;
  }
  if (
    value.refreshedAt !== undefined &&
    typeof value.refreshedAt !== "number"
  ) {
    return undefined;
  }
  return Object.freeze({
    version: value.version as number,
    modelsJsonValid: value.modelsJsonValid,
    ...(modelsJsonError === undefined ? {} : { modelsJsonError }),
    ...(value.refreshedAt === undefined
      ? {}
      : { refreshedAt: value.refreshedAt as number }),
    providers: Object.freeze(
      providers.filter(
        (entry): entry is CatalogProviderProjection => entry !== undefined,
      ),
    ),
    refreshErrors: Object.freeze(
      refreshErrors.filter(
        (entry): entry is CatalogRefreshErrorProjection => entry !== undefined,
      ),
    ),
  });
}

function decodeCatalogRefreshReport(
  value: unknown,
): CatalogRefreshReportProjection | undefined {
  if (
    !isRecord(value) ||
    value.trigger !== "manual" ||
    typeof value.startedAt !== "number" ||
    typeof value.finishedAt !== "number" ||
    !Array.isArray(value.providers)
  ) {
    return undefined;
  }
  const providers = value.providers.map(
    (
      entry: unknown,
    ): CatalogRefreshReportProjection["providers"][number] | undefined => {
      if (!isRecord(entry) || typeof entry.providerId !== "string") {
        return undefined;
      }
      if (
        entry.outcome !== "succeeded" &&
        entry.outcome !== "failed" &&
        entry.outcome !== "skipped"
      ) {
        return undefined;
      }
      if (
        (entry.error !== undefined && typeof entry.error !== "string") ||
        (entry.errorCode !== undefined && typeof entry.errorCode !== "string")
      ) {
        return undefined;
      }
      if (entry.outcome !== "failed" && entry.error !== undefined) {
        return undefined;
      }
      return Object.freeze({
        providerId: entry.providerId,
        outcome: entry.outcome,
        ...(entry.error === undefined ? {} : { error: entry.error as string }),
        ...(entry.errorCode === undefined
          ? {}
          : { errorCode: entry.errorCode as string }),
      });
    },
  );
  if (providers.some((entry) => entry === undefined)) return undefined;
  return Object.freeze({
    trigger: "manual" as const,
    startedAt: value.startedAt as number,
    finishedAt: value.finishedAt as number,
    providers: Object.freeze(
      providers.filter(
        (entry): entry is CatalogRefreshReportProjection["providers"][number] =>
          entry !== undefined,
      ),
    ),
  });
}

export function decodeCatalogCommand(
  value: unknown,
): CatalogCommand | undefined {
  if (!isRecord(value) || value.command !== "query") {
    if (isRecord(value) && value.command === "refresh") {
      if (value.mode === "background" || value.mode === "manual") {
        return { command: "refresh", mode: value.mode };
      }
    }
    return undefined;
  }
  return { command: "query" };
}

export function decodeCatalogCommandResult(
  value: unknown,
): CatalogCommandResult | undefined {
  if (
    !isRecord(value) ||
    (value.outcome !== "ok" &&
      value.outcome !== "scheduled" &&
      value.outcome !== "unavailable")
  ) {
    return undefined;
  }
  const snapshot = decodeCatalogSnapshotProjection(value.snapshot);
  if (snapshot === undefined) return undefined;
  const refresh =
    value.refresh === undefined
      ? undefined
      : decodeCatalogRefreshReport(value.refresh);
  if (value.refresh !== undefined && refresh === undefined) {
    return undefined;
  }
  // Only a completed manual refresh carries the per-Provider report.
  if (value.outcome !== "ok" && refresh !== undefined) return undefined;
  return Object.freeze({
    outcome: value.outcome as CatalogCommandResult["outcome"],
    snapshot,
    ...(refresh === undefined ? {} : { refresh }),
  });
}

export function decodeCodexIntegrationCommand(
  value: unknown,
): CodexIntegrationCommand | undefined {
  if (!isRecord(value) || typeof value.command !== "string") return undefined;
  if (value.command === "query") return { command: "query" };
  if (value.command === "sync_catalog") return { command: "sync_catalog" };
  if (value.command === "set_enabled" && typeof value.enabled === "boolean") {
    return { command: "set_enabled", enabled: value.enabled };
  }
  return undefined;
}

const codexObservedStates: ReadonlySet<string> = new Set([
  "native",
  "managed",
  "drifted",
  "conflict",
  "unavailable",
]);

export function decodeCodexIntegrationProjection(
  value: unknown,
): CodexIntegrationProjection | undefined {
  if (
    !isRecord(value) ||
    typeof value.desiredEnabled !== "boolean" ||
    typeof value.observedState !== "string" ||
    !codexObservedStates.has(value.observedState) ||
    typeof value.codexHome !== "string" ||
    value.codexHome.length === 0 ||
    typeof value.configPath !== "string" ||
    value.configPath.length === 0 ||
    typeof value.catalogPath !== "string" ||
    value.catalogPath.length === 0 ||
    typeof value.restartRequired !== "boolean" ||
    !Array.isArray(value.warnings) ||
    value.warnings.some((warning) => typeof warning !== "string")
  ) {
    return undefined;
  }
  if (value.endpoint !== undefined && typeof value.endpoint !== "string") {
    return undefined;
  }
  if (
    value.modelCount !== undefined &&
    (typeof value.modelCount !== "number" ||
      !Number.isSafeInteger(value.modelCount) ||
      value.modelCount < 0)
  ) {
    return undefined;
  }
  if (value.message !== undefined && typeof value.message !== "string") {
    return undefined;
  }
  return Object.freeze({
    desiredEnabled: value.desiredEnabled,
    observedState: value.observedState as CodexIntegrationObservedState,
    codexHome: value.codexHome,
    configPath: value.configPath,
    catalogPath: value.catalogPath,
    ...(value.endpoint === undefined ? {} : { endpoint: value.endpoint }),
    ...(value.modelCount === undefined ? {} : { modelCount: value.modelCount }),
    warnings: Object.freeze([...(value.warnings as string[])]),
    restartRequired: value.restartRequired,
    ...(value.message === undefined ? {} : { message: value.message }),
  });
}

export function decodeCodexIntegrationCommandResult(
  value: unknown,
): CodexIntegrationCommandResult | undefined {
  if (!isRecord(value)) return undefined;
  const state = decodeCodexIntegrationProjection(value.state);
  return state === undefined ? undefined : Object.freeze({ state });
}

export function decodeAliasCommand(value: unknown): AliasCommand | undefined {
  if (!isRecord(value) || typeof value.command !== "string") {
    return undefined;
  }
  if (value.command === "query") return { command: "query" };
  const revision = value.revision;
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    (revision as number) < 0
  ) {
    return undefined;
  }
  if (value.command === "write" && isRecord(value.aliases)) {
    return {
      command: "write",
      revision: revision as number,
      aliases: Object.freeze({ ...value.aliases }),
    };
  }
  if (
    (value.command === "rename_model" ||
      value.command === "restore_model_name") &&
    typeof value.providerId === "string" &&
    value.providerId.length > 0 &&
    typeof value.modelId === "string" &&
    value.modelId.length > 0
  ) {
    if (value.command === "rename_model") {
      if (typeof value.modelName !== "string" || value.modelName.length === 0) {
        return undefined;
      }
      return {
        command: "rename_model",
        revision: revision as number,
        providerId: value.providerId,
        modelId: value.modelId,
        modelName: value.modelName,
      };
    }
    return {
      command: "restore_model_name",
      revision: revision as number,
      providerId: value.providerId,
      modelId: value.modelId,
    };
  }
  return undefined;
}

const aliasValidationCodes: ReadonlySet<string> = new Set([
  "invalid",
  "ambiguous",
  "unknown",
  "duplicate",
]);

function decodeAliasValidationError(
  value: unknown,
): AliasValidationErrorProjection | undefined {
  if (
    !isRecord(value) ||
    // The failing alias may itself be the invalid input (e.g. an empty
    // key), so any string is a valid error entry.
    typeof value.alias !== "string" ||
    typeof value.code !== "string" ||
    !aliasValidationCodes.has(value.code) ||
    typeof value.message !== "string" ||
    value.message.length === 0
  ) {
    return undefined;
  }
  return Object.freeze({
    alias: value.alias,
    code: value.code as AliasValidationCode,
    message: value.message,
  });
}

function decodeAliasTarget(
  value: unknown,
): AliasCanonicalTarget | undefined {
  if (
    !isRecord(value) ||
    typeof value.provider !== "string" ||
    value.provider.length === 0 ||
    typeof value.model !== "string" ||
    value.model.length === 0
  ) {
    return undefined;
  }
  return Object.freeze({ provider: value.provider, model: value.model });
}

function decodeEffectiveAlias(
  value: unknown,
): EffectiveAliasProjection | undefined {
  if (
    !isRecord(value) ||
    typeof value.alias !== "string" ||
    value.alias.length === 0 ||
    (value.layer !== "default" && value.layer !== "user")
  ) {
    return undefined;
  }
  const target = decodeAliasTarget(value.target);
  if (target === undefined) return undefined;
  return Object.freeze({
    alias: value.alias,
    target,
    layer: value.layer as AliasLayer,
  });
}

function decodeEffectiveAliasRegistry(
  value: unknown,
): EffectiveAliasRegistryProjection | undefined {
  if (
    !isRecord(value) ||
    !Array.isArray(value.aliases) ||
    !Array.isArray(value.errors)
  ) {
    return undefined;
  }
  const aliases = value.aliases.map(decodeEffectiveAlias);
  if (aliases.some((entry) => entry === undefined)) return undefined;
  const errors = value.errors.map(decodeAliasValidationError);
  if (errors.some((entry) => entry === undefined)) return undefined;
  return Object.freeze({
    aliases: Object.freeze(
      aliases.filter(
        (entry): entry is EffectiveAliasProjection => entry !== undefined,
      ),
    ),
    errors: Object.freeze(
      errors.filter(
        (entry): entry is AliasValidationErrorProjection => entry !== undefined,
      ),
    ),
  });
}

const aliasErrorKinds: ReadonlySet<string> = new Set([
  "parse",
  "schema",
  "validation",
  "load",
  "storage",
]);

export function decodeAliasFileError(
  value: unknown,
): AliasFileError | undefined {
  if (
    !isRecord(value) ||
    typeof value.kind !== "string" ||
    !aliasErrorKinds.has(value.kind) ||
    typeof value.message !== "string" ||
    value.message.length === 0
  ) {
    return undefined;
  }
  const rawEntries = value.entries;
  if (rawEntries !== undefined && !Array.isArray(rawEntries)) {
    return undefined;
  }
  const entries =
    rawEntries === undefined
      ? undefined
      : rawEntries.map(decodeAliasValidationError);
  if (value.entries !== undefined && entries === undefined) return undefined;
  if (
    value.entries !== undefined &&
    entries !== undefined &&
    entries.some((entry) => entry === undefined)
  ) {
    return undefined;
  }
  // Per-alias entries exist exactly for the validation kind.
  if (value.kind !== "validation" && value.entries !== undefined) {
    return undefined;
  }
  if (value.kind === "validation" && value.entries === undefined) {
    return undefined;
  }
  return Object.freeze({
    kind: value.kind as AliasFileErrorKind,
    message: value.message,
    ...(entries === undefined
      ? {}
      : {
          entries: Object.freeze(
            entries.filter(
              (entry): entry is AliasValidationErrorProjection =>
                entry !== undefined,
            ),
          ),
        }),
  });
}

export function decodeAliasFileState(value: unknown): AliasFileState | undefined {
  if (
    !isRecord(value) ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    typeof value.path !== "string" ||
    value.path.length === 0 ||
    typeof value.present !== "boolean" ||
    typeof value.valid !== "boolean" ||
    typeof value.raw !== "string" ||
    typeof value.catalogVersion !== "number" ||
    !Number.isSafeInteger(value.catalogVersion) ||
    (value.catalogVersion as number) < 0
  ) {
    return undefined;
  }
  const error = decodeAliasFileError(value.error);
  if (value.error !== undefined && error === undefined) return undefined;
  const aliases = value.aliases;
  if (aliases !== undefined && !isRecord(aliases)) return undefined;
  if (!value.present && aliases !== undefined) return undefined;
  if (aliases !== undefined && !value.valid) return undefined;
  if (aliases === undefined && value.present && value.valid) return undefined;
  const effective = decodeEffectiveAliasRegistry(value.effective);
  if (effective === undefined) {
    // The effective registry is always authoritative: defaults apply even
    // when the file is absent or broken (a broken file contributes no user
    // mappings, never a repair).
    return undefined;
  }
  return Object.freeze({
    revision: value.revision as number,
    path: value.path,
    present: value.present,
    valid: value.valid,
    raw: value.raw,
    catalogVersion: value.catalogVersion as number,
    ...(aliases === undefined ? {} : { aliases }),
    ...(effective === undefined ? {} : { effective }),
    ...(error === undefined ? {} : { error }),
  });
}

export function decodeAliasCommandResult(
  value: unknown,
): AliasCommandResult | undefined {
  if (
    !isRecord(value) ||
    (value.outcome !== "ok" &&
      value.outcome !== "conflict" &&
      value.outcome !== "invalid" &&
      value.outcome !== "storage_failure")
  ) {
    return undefined;
  }
  const state = decodeAliasFileState(value.state);
  if (state === undefined) return undefined;
  const error = decodeAliasFileError(value.error);
  if (value.error !== undefined && error === undefined) return undefined;
  if (value.outcome === "invalid" && error === undefined) return undefined;
  if (value.outcome === "storage_failure" && error === undefined) {
    return undefined;
  }
  if (value.outcome === "ok" || value.outcome === "conflict") {
    if (error !== undefined) return undefined;
  }
  return Object.freeze({
    outcome: value.outcome as AliasCommandResult["outcome"],
    state,
    ...(error === undefined ? {} : { error }),
  });
}

export function decodeAliasStatusProjection(
  value: unknown,
): AliasStatusProjection | undefined {
  if (
    !isRecord(value) ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    typeof value.path !== "string" ||
    value.path.length === 0 ||
    typeof value.present !== "boolean" ||
    typeof value.valid !== "boolean"
  ) {
    return undefined;
  }
  const error = decodeAliasFileError(value.error);
  if (value.error !== undefined && error === undefined) return undefined;
  return Object.freeze({
    revision: value.revision as number,
    path: value.path,
    present: value.present,
    valid: value.valid,
    ...(error === undefined ? {} : { error }),
  });
}

export function decodeModelsCommand(value: unknown): ModelsCommand | undefined {
  if (!isRecord(value) || typeof value.command !== "string") {
    return undefined;
  }
  if (value.command === "query") return { command: "query" };
  const revision = value.revision;
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    (revision as number) < 0
  ) {
    return undefined;
  }
  if (value.command === "write_raw") {
    if (typeof value.content !== "string") return undefined;
    return {
      command: "write_raw",
      revision: revision as number,
      content: value.content,
    };
  }
  if (value.command === "write_structured") {
    if (!isRecord(value.providers)) return undefined;
    return {
      command: "write_structured",
      revision: revision as number,
      providers: value.providers,
    };
  }
  return undefined;
}

const modelsErrorKinds: ReadonlySet<string> = new Set([
  "parse",
  "schema",
  "load",
  "storage",
]);

export function decodeModelsFileError(
  value: unknown,
): ModelsFileError | undefined {
  if (
    !isRecord(value) ||
    typeof value.kind !== "string" ||
    !modelsErrorKinds.has(value.kind) ||
    typeof value.message !== "string" ||
    value.message.length === 0
  ) {
    return undefined;
  }
  const location = decodeModelsFileErrorLocation(value.location);
  if (value.location !== undefined && location === undefined) {
    return undefined;
  }
  return Object.freeze({
    kind: value.kind as ModelsFileErrorKind,
    message: value.message,
    ...(location === undefined ? {} : { location }),
  });
}

function decodeModelsFileErrorLocation(
  value: unknown,
): ModelsFileErrorLocation | undefined {
  if (
    !isRecord(value) ||
    typeof value.line !== "number" ||
    !Number.isSafeInteger(value.line) ||
    (value.line as number) < 1 ||
    typeof value.column !== "number" ||
    !Number.isSafeInteger(value.column) ||
    (value.column as number) < 1
  ) {
    return undefined;
  }
  const position = value.position;
  if (
    (position !== undefined &&
      (typeof position !== "number" ||
        !Number.isSafeInteger(position) ||
        (position as number) < 0)) ||
    (position === undefined && value.position !== undefined)
  ) {
    return undefined;
  }
  return Object.freeze({
    line: value.line as number,
    column: value.column as number,
    ...(position === undefined ? {} : { position: position as number }),
  });
}

const effectiveModelLayers: ReadonlySet<string> = new Set([
  "builtin",
  "user",
  "upserted",
  "overridden",
]);

const effectiveProviderLayers: ReadonlySet<string> = new Set([
  "builtin",
  "user",
  "overlaid",
]);

function decodeStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.some((entry) => typeof entry !== "string")) return undefined;
  return Object.freeze([...value]);
}

function decodeEffectiveModelCost(
  value: unknown,
): EffectiveModelCost | undefined {
  if (
    !isRecord(value) ||
    typeof value.input !== "number" ||
    typeof value.output !== "number" ||
    typeof value.cacheRead !== "number" ||
    typeof value.cacheWrite !== "number"
  ) {
    return undefined;
  }
  const tiers = value.tiers;
  if (tiers !== undefined && !Array.isArray(tiers)) return undefined;
  return Object.freeze({
    input: value.input,
    output: value.output,
    cacheRead: value.cacheRead,
    cacheWrite: value.cacheWrite,
    ...(tiers === undefined ? {} : { tiers: Object.freeze([...tiers]) }),
  });
}

function decodeThinkingLevelMap(
  value: unknown,
): Readonly<Record<string, string | null>> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string | null> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string" && entry !== null) return undefined;
    result[key] = entry;
  }
  return Object.freeze(result);
}

function decodeEffectiveModel(
  value: unknown,
): EffectiveModelProjection | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    typeof value.api !== "string" ||
    value.api.length === 0 ||
    typeof value.provider !== "string" ||
    value.provider.length === 0 ||
    typeof value.baseUrl !== "string" ||
    typeof value.reasoning !== "boolean" ||
    typeof value.contextWindow !== "number" ||
    typeof value.maxTokens !== "number" ||
    typeof value.layer !== "string" ||
    !effectiveModelLayers.has(value.layer)
  ) {
    return undefined;
  }
  const input = value.input;
  if (
    !Array.isArray(input) ||
    input.some((entry) => entry !== "text" && entry !== "image")
  ) {
    return undefined;
  }
  const cost = decodeEffectiveModelCost(value.cost);
  if (cost === undefined) return undefined;
  const overriddenFields = decodeStringArray(value.overriddenFields);
  if (value.overriddenFields !== undefined && overriddenFields === undefined) {
    return undefined;
  }
  const thinkingLevelMap = decodeThinkingLevelMap(value.thinkingLevelMap);
  if (value.thinkingLevelMap !== undefined && thinkingLevelMap === undefined) {
    return undefined;
  }
  const compat = value.compat;
  if (compat !== undefined && !isRecord(compat)) return undefined;
  if (value.layer !== "overridden" && overriddenFields !== undefined) {
    return undefined;
  }
  return Object.freeze({
    id: value.id,
    name: value.name,
    api: value.api,
    provider: value.provider,
    baseUrl: value.baseUrl,
    reasoning: value.reasoning,
    input: Object.freeze([...input]),
    cost,
    contextWindow: value.contextWindow,
    maxTokens: value.maxTokens,
    layer: value.layer as EffectiveModelLayer,
    ...(overriddenFields === undefined ? {} : { overriddenFields }),
    ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
    ...(compat === undefined ? {} : { compat }),
  });
}

function decodeEffectiveProvider(
  value: unknown,
): EffectiveProviderProjection | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    typeof value.layer !== "string" ||
    !effectiveProviderLayers.has(value.layer) ||
    !Array.isArray(value.models)
  ) {
    return undefined;
  }
  if (value.baseUrl !== undefined && typeof value.baseUrl !== "string") {
    return undefined;
  }
  const models: EffectiveModelProjection[] = [];
  for (const model of value.models) {
    const decoded = decodeEffectiveModel(model);
    if (decoded === undefined) return undefined;
    models.push(decoded);
  }
  return Object.freeze({
    id: value.id,
    name: value.name,
    ...(value.baseUrl === undefined ? {} : { baseUrl: value.baseUrl }),
    layer: value.layer as EffectiveProviderLayer,
    models: Object.freeze(models),
  });
}

function decodeEffectiveCatalog(
  value: unknown,
): EffectiveCatalogProjection | undefined {
  if (
    !isRecord(value) ||
    value.schemaVersion !== "luckytoken-effective-catalog-v1" ||
    !isRecord(value.baseline) ||
    typeof value.baseline.package !== "string" ||
    value.baseline.package.length === 0 ||
    typeof value.baseline.version !== "string" ||
    value.baseline.version.length === 0 ||
    typeof value.baseline.schema !== "string" ||
    value.baseline.schema.length === 0 ||
    !Array.isArray(value.providers) ||
    !Array.isArray(value.compositionErrors)
  ) {
    return undefined;
  }
  const providers: EffectiveProviderProjection[] = [];
  for (const provider of value.providers) {
    const decoded = decodeEffectiveProvider(provider);
    if (decoded === undefined) return undefined;
    providers.push(decoded);
  }
  const compositionErrors: EffectiveCatalogCompositionError[] = [];
  for (const entry of value.compositionErrors) {
    if (
      !isRecord(entry) ||
      typeof entry.providerId !== "string" ||
      entry.providerId.length === 0 ||
      typeof entry.message !== "string" ||
      entry.message.length === 0
    ) {
      return undefined;
    }
    compositionErrors.push(
      Object.freeze({ providerId: entry.providerId, message: entry.message }),
    );
  }
  return Object.freeze({
    schemaVersion: "luckytoken-effective-catalog-v1",
    baseline: Object.freeze({
      package: value.baseline.package as "@earendil-works/pi-coding-agent",
      version: value.baseline.version as "0.84.1",
      schema: value.baseline
        .schema as "pi-coding-agent-0.84.1-models-json-schema",
    }),
    providers: Object.freeze(providers),
    compositionErrors: Object.freeze(compositionErrors),
  });
}

export function decodeModelsFileState(
  value: unknown,
): ModelsFileState | undefined {
  if (
    !isRecord(value) ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    typeof value.path !== "string" ||
    value.path.length === 0 ||
    typeof value.present !== "boolean" ||
    typeof value.valid !== "boolean" ||
    typeof value.raw !== "string"
  ) {
    return undefined;
  }
  const error = decodeModelsFileError(value.error);
  if (value.error !== undefined && error === undefined) return undefined;
  if (value.valid && error !== undefined) return undefined;
  const providers = value.providers;
  if (providers !== undefined && !isRecord(providers)) return undefined;
  if (providers !== undefined && !value.valid) return undefined;
  if (providers === undefined && value.valid && value.present) return undefined;
  // Ticket 09: a valid state carries exactly the effective catalog; an
  // invalid state never does.
  const catalog = decodeEffectiveCatalog(value.catalog);
  if (value.catalog !== undefined && catalog === undefined) return undefined;
  if (value.valid && catalog === undefined) return undefined;
  if (!value.valid && catalog !== undefined) return undefined;
  return Object.freeze({
    revision: value.revision as number,
    path: value.path,
    present: value.present,
    valid: value.valid,
    raw: value.raw,
    ...(providers === undefined ? {} : { providers }),
    ...(catalog === undefined ? {} : { catalog }),
    ...(error === undefined ? {} : { error }),
  });
}

export function decodeModelsCommandResult(
  value: unknown,
): ModelsCommandResult | undefined {
  if (
    !isRecord(value) ||
    (value.outcome !== "ok" &&
      value.outcome !== "conflict" &&
      value.outcome !== "invalid" &&
      value.outcome !== "storage_failure")
  ) {
    return undefined;
  }
  const state = decodeModelsFileState(value.state);
  if (state === undefined) return undefined;
  const error = decodeModelsFileError(value.error);
  if (value.error !== undefined && error === undefined) return undefined;
  if (value.outcome === "invalid") {
    if (
      error === undefined ||
      (error.kind !== "parse" && error.kind !== "schema")
    ) {
      return undefined;
    }
  }
  if (value.outcome === "storage_failure") {
    if (error === undefined || error.kind !== "storage") return undefined;
  }
  if (value.outcome !== "invalid" && value.outcome !== "storage_failure") {
    if (error !== undefined) return undefined;
  }
  return Object.freeze({
    outcome: value.outcome as ModelsCommandResult["outcome"],
    state,
    ...(error === undefined ? {} : { error }),
  });
}

export function decodeModelsProjection(
  value: unknown,
): ModelsProjection | undefined {
  if (
    !isRecord(value) ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    typeof value.path !== "string" ||
    value.path.length === 0 ||
    typeof value.present !== "boolean" ||
    typeof value.valid !== "boolean"
  ) {
    return undefined;
  }
  const error = decodeModelsFileError(value.error);
  if (value.error !== undefined && error === undefined) return undefined;
  if (value.valid && error !== undefined) return undefined;
  return Object.freeze({
    revision: value.revision as number,
    path: value.path,
    present: value.present,
    valid: value.valid,
    ...(error === undefined ? {} : { error }),
  });
}

function decodeCredentialFileError(
  value: unknown,
): CredentialFileError | undefined {
  if (
    !isRecord(value) ||
    (value.kind !== "parse" &&
      value.kind !== "invalid" &&
      value.kind !== "load") ||
    typeof value.message !== "string" ||
    value.message.length === 0
  ) {
    return undefined;
  }
  return Object.freeze({
    kind: value.kind as CredentialFileErrorKind,
    message: value.message,
  });
}

export function decodeProviderAuthStatus(
  value: unknown,
): ProviderAuthStatus | undefined {
  if (
    !isRecord(value) ||
    typeof value.providerId !== "string" ||
    value.providerId.length === 0 ||
    typeof value.stored !== "boolean" ||
    (value.storedType !== undefined &&
      value.storedType !== "api_key" &&
      value.storedType !== "oauth") ||
    typeof value.environment !== "boolean" ||
    typeof value.modelsJson !== "boolean" ||
    typeof value.commandDerived !== "boolean" ||
    typeof value.expired !== "boolean" ||
    typeof value.unavailable !== "boolean" ||
    (value.effectiveSource !== "stored" &&
      value.effectiveSource !== "environment" &&
      value.effectiveSource !== "models.json" &&
      value.effectiveSource !== "command" &&
      value.effectiveSource !== "none")
  ) {
    return undefined;
  }
  // Bounded-fact consistency: a stored credential is the effective source
  // when present and `unavailable` means no source resolves.
  // Stored presence is a fact; the effective source follows request-time
  // precedence and may differ when a stored reference cannot resolve.
  if (value.unavailable !== (value.effectiveSource === "none"))
    return undefined;
  if (value.stored === true && value.storedType === undefined) return undefined;
  if (value.stored === false && value.storedType !== undefined)
    return undefined;
  return Object.freeze({
    providerId: value.providerId,
    stored: value.stored,
    ...(value.storedType === undefined ? {} : { storedType: value.storedType }),
    environment: value.environment,
    modelsJson: value.modelsJson,
    commandDerived: value.commandDerived,
    expired: value.expired,
    unavailable: value.unavailable,
    effectiveSource: value.effectiveSource,
  });
}

function decodeProviderAuthStatuses(
  value: unknown,
): readonly ProviderAuthStatus[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const statuses = value
    .map((entry) => decodeProviderAuthStatus(entry))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  return statuses.length === value.length ? Object.freeze(statuses) : undefined;
}

/** Sanitized auth.json projection (Ticket 12): file facts plus bounded
 *  per-Provider status rows; strict decoding so credential values or raw
 *  credential shapes can never cross the wire. */
export function decodeCredentialProjection(
  value: unknown,
  options: { readonly allowEmptyPath?: boolean } = {},
): CredentialProjection | undefined {
  if (
    !isRecord(value) ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    typeof value.path !== "string" ||
    (value.path.length === 0 && options.allowEmptyPath !== true) ||
    typeof value.present !== "boolean" ||
    typeof value.valid !== "boolean"
  ) {
    return undefined;
  }
  const error = decodeCredentialFileError(value.error);
  if (value.error !== undefined && error === undefined) return undefined;
  if (value.valid && error !== undefined) return undefined;
  const providers = decodeProviderAuthStatuses(value.providers);
  if (providers === undefined) return undefined;
  return Object.freeze({
    revision: value.revision as number,
    path: value.path,
    present: value.present,
    valid: value.valid,
    ...(error === undefined ? {} : { error }),
    providers,
  });
}

function decodeCredentialImportSelection(
  value: unknown,
): CredentialImportSelection | undefined {
  if (
    !isRecord(value) ||
    typeof value.providerId !== "string" ||
    value.providerId.length === 0 ||
    typeof value.overwrite !== "boolean"
  ) {
    return undefined;
  }
  return Object.freeze({
    providerId: value.providerId,
    overwrite: value.overwrite,
  });
}

function decodeCredentialImportSelections(
  value: unknown,
): readonly CredentialImportSelection[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const selections = value
    .map((entry) => decodeCredentialImportSelection(entry))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  return selections.length === value.length
    ? Object.freeze(selections)
    : undefined;
}

function decodeCredentialImportEntryPreview(
  value: unknown,
): CredentialImportEntryPreview | undefined {
  if (
    !isRecord(value) ||
    typeof value.providerId !== "string" ||
    value.providerId.length === 0 ||
    (value.type !== "api_key" && value.type !== "oauth") ||
    typeof value.wouldOverwrite !== "boolean"
  ) {
    return undefined;
  }
  return Object.freeze({
    providerId: value.providerId,
    type: value.type,
    wouldOverwrite: value.wouldOverwrite,
  });
}

function decodeCredentialImportApplyEntryResult(
  value: unknown,
): CredentialImportApplyEntryResult | undefined {
  if (
    !isRecord(value) ||
    typeof value.providerId !== "string" ||
    value.providerId.length === 0 ||
    (value.outcome !== "applied" &&
      value.outcome !== "unchanged" &&
      value.outcome !== "skipped" &&
      value.outcome !== "conflict" &&
      value.outcome !== "overwrite_required")
  ) {
    return undefined;
  }
  return Object.freeze({
    providerId: value.providerId,
    outcome: value.outcome,
  });
}

function decodeCredentialImportApplyEntryResults(
  value: unknown,
): readonly CredentialImportApplyEntryResult[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value
    .map((entry) => decodeCredentialImportApplyEntryResult(entry))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  return entries.length === value.length ? Object.freeze(entries) : undefined;
}

export function decodeCredentialCommand(
  value: unknown,
): CredentialCommand | undefined {
  if (!isRecord(value)) return undefined;
  if (value.command === "query") {
    return { command: "query" };
  }
  if (
    typeof value.expectedRevision !== "number" ||
    !Number.isSafeInteger(value.expectedRevision) ||
    (value.expectedRevision as number) < 0
  ) {
    return undefined;
  }
  const expectedRevision = value.expectedRevision as number;
  if (value.command === "logout") {
    if (typeof value.providerId !== "string" || value.providerId.length === 0) {
      return undefined;
    }
    return {
      command: "logout",
      providerId: value.providerId,
      expectedRevision,
    };
  }
  if (value.command === "login") {
    if (
      typeof value.providerId !== "string" ||
      value.providerId.length === 0 ||
      typeof value.value !== "string" ||
      typeof value.overwrite !== "boolean"
    ) {
      return undefined;
    }
    return {
      command: "login",
      providerId: value.providerId,
      expectedRevision,
      value: value.value,
      overwrite: value.overwrite,
    };
  }
  if (value.command === "import_preview") {
    if (typeof value.content !== "string") return undefined;
    return {
      command: "import_preview",
      expectedRevision,
      content: value.content,
    };
  }
  if (value.command === "import_apply") {
    if (typeof value.importId !== "string" || value.importId.length === 0) {
      return undefined;
    }
    const selections = decodeCredentialImportSelections(value.selections);
    if (selections === undefined) return undefined;
    return {
      command: "import_apply",
      expectedRevision,
      importId: value.importId,
      selections,
    };
  }
  return undefined;
}

/** Validates a credential command result against the command that produced
 *  it: `login`/`logout` may only carry `changed`, `import_preview` only the
 *  masked plan, and `import_apply` only per-entry outcomes — a credential
 *  value or raw credential shape can never pass. */
export function decodeCredentialCommandResult(
  value: unknown,
  command: CredentialCommand,
): CredentialCommandResult | undefined {
  if (
    !isRecord(value) ||
    (value.outcome !== "ok" &&
      value.outcome !== "conflict" &&
      value.outcome !== "invalid" &&
      value.outcome !== "unknown_provider" &&
      value.outcome !== "overwrite_required" &&
      value.outcome !== "storage_failure" &&
      value.outcome !== "unavailable") ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0
  ) {
    return undefined;
  }
  const outcome = value.outcome;
  const revision = value.revision as number;
  // The unavailable DTO carries a minimal value-free state (the authority
  // is not running, so no path exists yet); every other outcome requires a
  // normal non-empty projection.
  const state = decodeCredentialProjection(value.state, {
    allowEmptyPath: outcome === "unavailable",
  });
  if (state === undefined) return undefined;
  if (outcome === "ok") {
    if (typeof value.error === "string") return undefined;
    if (command.command === "login" || command.command === "logout") {
      if (value.changed !== undefined && typeof value.changed !== "boolean") {
        return undefined;
      }
      if (value.importId !== undefined || value.previewEntries !== undefined) {
        return undefined;
      }
      if (command.command === "logout" && value.entries !== undefined) {
        return undefined;
      }
      return Object.freeze({
        outcome,
        revision,
        state,
        ...(value.changed === undefined ? {} : { changed: value.changed }),
      });
    }
    if (command.command === "import_preview") {
      if (typeof value.importId !== "string" || value.importId.length === 0) {
        return undefined;
      }
      const previewEntries = decodeCredentialImportEntryPreviews(
        value.previewEntries,
      );
      if (previewEntries === undefined) {
        return undefined;
      }
      if (value.changed !== undefined || value.entries !== undefined) {
        return undefined;
      }
      return Object.freeze({
        outcome,
        revision,
        state,
        importId: value.importId,
        previewEntries,
      });
    }
    if (command.command === "import_apply") {
      const entries = decodeCredentialImportApplyEntryResults(value.entries);
      if (entries === undefined) {
        return undefined;
      }
      if (value.changed !== undefined || value.importId !== undefined) {
        return undefined;
      }
      return Object.freeze({ outcome, revision, state, entries });
    }
    // query: no extras.
    if (
      value.changed !== undefined ||
      value.importId !== undefined ||
      value.previewEntries !== undefined ||
      value.entries !== undefined
    ) {
      return undefined;
    }
    return Object.freeze({ outcome, revision, state });
  }
  if (outcome === "unavailable") {
    if (
      typeof value.error !== "string" ||
      value.error.length === 0 ||
      value.changed !== undefined ||
      value.importId !== undefined ||
      value.previewEntries !== undefined ||
      value.entries !== undefined
    ) {
      return undefined;
    }
    return Object.freeze({ outcome, revision, state, error: value.error });
  }
  // conflict / invalid / unknown_provider / overwrite_required /
  // storage_failure: error is required; import_apply may also carry the
  // per-entry results.
  if (typeof value.error !== "string" || value.error.length === 0) {
    return undefined;
  }
  if (value.changed !== undefined || value.importId !== undefined) {
    return undefined;
  }
  if (command.command === "import_apply") {
    const entries = decodeCredentialImportApplyEntryResults(value.entries);
    if (entries === undefined) return undefined;
    return Object.freeze({
      outcome,
      revision,
      state,
      error: value.error,
      entries,
    });
  }
  if (value.previewEntries !== undefined || value.entries !== undefined) {
    return undefined;
  }
  return Object.freeze({ outcome, revision, state, error: value.error });
}

function decodeCredentialImportEntryPreviews(
  value: unknown,
): readonly CredentialImportEntryPreview[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value
    .map((entry) => decodeCredentialImportEntryPreview(entry))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  return entries.length === value.length ? Object.freeze(entries) : undefined;
}

/** Ticket 13: strict decode of the per-Provider login options projection. */
export function decodeAuthOptionsProjection(
  value: unknown,
): AuthOptionsProjection | undefined {
  if (!isRecord(value) || !Array.isArray(value.providers)) return undefined;
  const providers: AuthProviderOption[] = [];
  for (const raw of value.providers) {
    const option = decodeAuthProviderOption(raw);
    if (option === undefined) return undefined;
    providers.push(option);
  }
  return Object.freeze({ providers: Object.freeze(providers) });
}

function decodeAuthProviderOption(value: unknown): AuthProviderOption | undefined {
  if (
    !isRecord(value) ||
    typeof value.providerId !== "string" ||
    value.providerId.length === 0 ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    (value.source !== "pi_builtin" &&
      value.source !== "luckytoken_bundled" &&
      value.source !== "user") ||
    typeof value.account !== "boolean" ||
    typeof value.subscription !== "boolean" ||
    typeof value.apiKey !== "boolean"
  ) {
    return undefined;
  }
  if (
    (value.accountLabel !== undefined &&
      (typeof value.accountLabel !== "string" ||
        value.accountLabel.length === 0)) ||
    (value.apiKeyLabel !== undefined &&
      (typeof value.apiKeyLabel !== "string" ||
        value.apiKeyLabel.length === 0))
  ) {
    return undefined;
  }
  // A subscription is always an account flow: the metadata rule means
  // `subscription` can never be true while `account` is false.
  if (value.subscription === true && value.account !== true) return undefined;
  const status = decodeProviderAuthStatus(value.status);
  if (status === undefined) return undefined;
  return Object.freeze({
    providerId: value.providerId,
    name: value.name,
    source: value.source as AuthProviderOption["source"],
    account: value.account,
    subscription: value.subscription,
    ...(value.accountLabel === undefined
      ? {}
      : { accountLabel: value.accountLabel as string }),
    apiKey: value.apiKey,
    ...(value.apiKeyLabel === undefined
      ? {}
      : { apiKeyLabel: value.apiKeyLabel as string }),
    status,
  });
}

/** Ticket 13: strict decode of one typed interaction event crossing the
 *  wire. Only the allowlisted event shapes pass; anything else (including
 *  any secret-bearing extension) is rejected. */
export function decodeAuthInteractionEvent(
  value: unknown,
): AuthInteractionEvent | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.type === "info") {
    if (typeof value.message !== "string") return undefined;
    const links = decodeAuthInfoLinks(value.links);
    if (value.links !== undefined && links === undefined) return undefined;
    return Object.freeze({
      type: "info",
      message: value.message,
      ...(links === undefined ? {} : { links }),
    });
  }
  if (value.type === "auth_url") {
    if (typeof value.url !== "string" || value.url.length === 0) {
      return undefined;
    }
    if (
      value.instructions !== undefined &&
      typeof value.instructions !== "string"
    ) {
      return undefined;
    }
    return Object.freeze({
      type: "auth_url",
      url: value.url,
      ...(value.instructions === undefined
        ? {}
        : { instructions: value.instructions as string }),
    });
  }
  if (value.type === "device_code") {
    if (
      typeof value.userCode !== "string" ||
      value.userCode.length === 0 ||
      typeof value.verificationUri !== "string" ||
      value.verificationUri.length === 0 ||
      (value.intervalSeconds !== undefined &&
        (typeof value.intervalSeconds !== "number" ||
          !Number.isSafeInteger(value.intervalSeconds) ||
          (value.intervalSeconds as number) < 1)) ||
      (value.expiresInSeconds !== undefined &&
        (typeof value.expiresInSeconds !== "number" ||
          !Number.isSafeInteger(value.expiresInSeconds) ||
          (value.expiresInSeconds as number) < 1))
    ) {
      return undefined;
    }
    return Object.freeze({
      type: "device_code",
      userCode: value.userCode,
      verificationUri: value.verificationUri,
      ...(value.intervalSeconds === undefined
        ? {}
        : { intervalSeconds: value.intervalSeconds as number }),
      ...(value.expiresInSeconds === undefined
        ? {}
        : { expiresInSeconds: value.expiresInSeconds as number }),
    });
  }
  if (value.type === "progress") {
    if (typeof value.message !== "string") return undefined;
    return Object.freeze({ type: "progress", message: value.message });
  }
  if (value.type === "prompt") {
    const prompt = decodeAuthPromptEvent(value);
    if (prompt === undefined) return undefined;
    return Object.freeze(prompt);
  }
  return undefined;
}

function decodeAuthPromptEvent(value: RecordValue):
  | Extract<AuthInteractionEvent, { readonly type: "prompt" }>
  | undefined {
  if (
    (value.kind !== "text" &&
      value.kind !== "secret" &&
      value.kind !== "manual_code" &&
      value.kind !== "select") ||
    typeof value.promptId !== "string" ||
    value.promptId.length === 0 ||
    typeof value.message !== "string" ||
    (value.placeholder !== undefined &&
      typeof value.placeholder !== "string")
  ) {
    return undefined;
  }
  const options = decodeAuthPromptOptions(value.options);
  if (value.options !== undefined && options === undefined) return undefined;
  if (value.kind !== "select" && options !== undefined) return undefined;
  if (value.kind === "select" && options === undefined) return undefined;
  return {
    type: "prompt",
    promptId: value.promptId,
    kind: value.kind,
    message: value.message,
    ...(value.placeholder === undefined
      ? {}
      : { placeholder: value.placeholder as string }),
    ...(options === undefined ? {} : { options }),
  };
}

function decodeAuthPromptOptions(
  value: unknown,
): readonly AuthPromptOption[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const options: AuthPromptOption[] = [];
  for (const raw of value) {
    if (
      !isRecord(raw) ||
      typeof raw.id !== "string" ||
      raw.id.length === 0 ||
      typeof raw.label !== "string" ||
      raw.label.length === 0 ||
      (raw.description !== undefined &&
        typeof raw.description !== "string")
    ) {
      return undefined;
    }
    options.push(
      Object.freeze({
        id: raw.id,
        label: raw.label,
        ...(raw.description === undefined
          ? {}
          : { description: raw.description as string }),
      }),
    );
  }
  return Object.freeze(options);
}

function decodeAuthInfoLinks(value: unknown): readonly AuthInfoLink[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const links: AuthInfoLink[] = [];
  for (const raw of value) {
    if (
      !isRecord(raw) ||
      typeof raw.url !== "string" ||
      raw.url.length === 0 ||
      (raw.label !== undefined &&
        (typeof raw.label !== "string" || raw.label.length === 0))
    ) {
      return undefined;
    }
    links.push(
      Object.freeze({
        url: raw.url,
        ...(raw.label === undefined ? {} : { label: raw.label as string }),
      }),
    );
  }
  return Object.freeze(links);
}

/** Ticket 13: strict decode of a client interaction response. */
export function decodeAuthInteractionResponse(
  value: unknown,
): AuthInteractionResponse | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.type === "cancel") {
    return Object.freeze({ type: "cancel" });
  }
  if (value.type === "prompt_response") {
    if (
      typeof value.promptId !== "string" ||
      value.promptId.length === 0 ||
      typeof value.value !== "string"
    ) {
      return undefined;
    }
    return Object.freeze({
      type: "prompt_response",
      promptId: value.promptId,
      value: value.value,
    });
  }
  return undefined;
}

/** Ticket 13: strict decode of an auth command. */
export function decodeAuthCommand(value: unknown): AuthCommand | undefined {
  if (!isRecord(value)) return undefined;
  if (value.command === "query") {
    return Object.freeze({ command: "query" });
  }
  if (value.command === "login") {
    if (
      typeof value.providerId !== "string" ||
      value.providerId.length === 0 ||
      (value.authType !== "oauth" && value.authType !== "api_key")
    ) {
      return undefined;
    }
    return Object.freeze({
      command: "login",
      providerId: value.providerId,
      authType: value.authType,
    });
  }
  return undefined;
}

/**
 * Ticket 13: validates an auth command result against the command that
 * produced it. `query` may carry the options projection; `login` never
 * does. Non-ok outcomes require a value-free error; no credential value
 * or raw error text can pass.
 */
export function decodeAuthCommandResult(
  value: unknown,
  command: AuthCommand,
): AuthCommandResult | undefined {
  if (
    !isRecord(value) ||
    (value.outcome !== "ok" &&
      value.outcome !== "cancelled" &&
      value.outcome !== "failed" &&
      value.outcome !== "conflict" &&
      value.outcome !== "unknown_provider" &&
      value.outcome !== "unsupported" &&
      value.outcome !== "storage_failure" &&
      value.outcome !== "unavailable")
  ) {
    return undefined;
  }
  const outcome = value.outcome as AuthCommandResult["outcome"];
  // The unavailable DTO carries a minimal value-free state (no path exists
  // while the authority is not running); every other outcome requires a
  // normal non-empty projection.
  const state = decodeCredentialProjection(value.state, {
    allowEmptyPath: outcome === "unavailable",
  });
  if (state === undefined) return undefined;
  const options =
    value.options === undefined
      ? undefined
      : decodeAuthOptionsProjection(value.options);
  if (value.options !== undefined && options === undefined) return undefined;
  if (outcome !== "ok") {
    if (typeof value.error !== "string" || value.error.length === 0) {
      return undefined;
    }
    // Non-ok outcomes never carry a projection; a failed query reports a
    // fixed value-free error instead.
    if (options !== undefined) return undefined;
    return Object.freeze({ outcome, state, error: value.error });
  }
  if (typeof value.error === "string") return undefined;
  if (command.command === "query") {
    if (options === undefined) return undefined;
    return Object.freeze({ outcome, state, options });
  }
  // login: never carries the options projection.
  if (options !== undefined) return undefined;
  return Object.freeze({ outcome, state });
}

export function decodeSettingsCommandResult(
  value: unknown,
): SettingsCommandResult | undefined {
  if (
    !isRecord(value) ||
    (value.outcome !== "ok" &&
      value.outcome !== "applied" &&
      value.outcome !== "pending" &&
      value.outcome !== "unknown_key" &&
      value.outcome !== "invalid_value")
  ) {
    return undefined;
  }
  const settings = decodeSettingsProjection(value.settings);
  if (settings === undefined) return undefined;
  if (value.confirmation !== undefined) return undefined;
  if (value.outcome === "invalid_value" && typeof value.error !== "string") {
    return undefined;
  }
  return Object.freeze({
    outcome: value.outcome,
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    settings,
  });
}

const failureMessages: Readonly<Record<DataPlaneFailure["code"], string>> = {
  port_in_use:
    "The configured port is already in use. Stop the other application or choose a different port.",
  start_failed:
    "The model gateway could not start. Check its configured address and try again.",
  stop_failed:
    "The model gateway could not stop cleanly. Restart LuckyToken before trying again.",
};

function decodeDataPlaneFailure(value: unknown): DataPlaneFailure | undefined {
  if (
    !isRecord(value) ||
    (value.code !== "port_in_use" &&
      value.code !== "start_failed" &&
      value.code !== "stop_failed")
  ) {
    return undefined;
  }
  return { code: value.code, message: failureMessages[value.code] };
}

function decodeDataPlaneStatus(
  value: unknown,
): ApplicationStatus["dataPlane"] | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    typeof value.configuredOrigin !== "string" ||
    !Number.isSafeInteger(value.configuredPort) ||
    (value.configuredPort as number) < 0 ||
    (value.configuredPort as number) > 65_535
  ) {
    return undefined;
  }
  let origin: URL;
  try {
    origin = new URL(value.configuredOrigin);
  } catch {
    return undefined;
  }
  const originPort = origin.port === "" ? 80 : Number.parseInt(origin.port, 10);
  if (
    origin.protocol !== "http:" ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    originPort !== value.configuredPort
  ) {
    return undefined;
  }
  const failure = decodeDataPlaneFailure(value.failure);
  if (value.failure !== undefined && failure === undefined) return undefined;
  return {
    configuredOrigin: value.configuredOrigin,
    configuredPort: value.configuredPort as number,
    ...(failure === undefined ? {} : { failure }),
  };
}

export function decodeClientRequest(value: unknown): DecodedClientRequest {
  if (!isRecord(value)) {
    return { type: "invalid", requestId: "", code: "invalid_request" };
  }
  const requestId = decodeRequestId(value.requestId);
  if (requestId === undefined || typeof value.type !== "string") {
    return {
      type: "invalid",
      requestId: requestId ?? "",
      code: "invalid_request",
    };
  }
  if (value.type === "hello") {
    if (
      !Number.isSafeInteger(value.contractVersion) ||
      typeof value.capability !== "string"
    ) {
      return { type: "invalid", requestId, code: "invalid_request" };
    }
    return {
      type: "valid",
      request: {
        type: "hello",
        requestId,
        contractVersion: value.contractVersion as number,
        capability: value.capability,
      },
    };
  }
  if (
    value.type === "get_status" ||
    value.type === "diagnostics_subscribe" ||
    value.type === "diagnostics_unsubscribe" ||
    value.type === "subscribe" ||
    value.type === "unsubscribe"
  ) {
    return { type: "valid", request: { type: value.type, requestId } };
  }
  if (value.type === "get_diagnostics") {
    return {
      type: "valid",
      request: {
        type: "get_diagnostics",
        requestId,
        ...(value.query === undefined ? {} : { query: value.query }),
      },
    };
  }
  if (value.type === "get_request_identities") {
    return {
      type: "valid",
      request: { type: "get_request_identities", requestId },
    };
  }
  if (value.type === "get_request_ledger") {
    return {
      type: "valid",
      request: {
        type: "get_request_ledger",
        requestId,
        ...(value.query === undefined ? {} : { query: value.query }),
      },
    };
  }
  if (value.type === "get_analytics") {
    const query = normalizeAnalyticsQuery(value.query);
    if (query === undefined) {
      return { type: "invalid", requestId, code: "invalid_request" };
    }
    return {
      type: "valid",
      request: { type: "get_analytics", requestId, query },
    };
  }
  if (
    value.type === "ledger_subscribe" ||
    value.type === "ledger_unsubscribe"
  ) {
    return { type: "valid", request: { type: value.type, requestId } };
  }
  if (value.type === "get_capture") {
    if (value.query === undefined) {
      return { type: "invalid", requestId, code: "invalid_request" };
    }
    const query = decodeCaptureQuery(value.query);
    if (query === undefined) {
      return { type: "invalid", requestId, code: "invalid_request" };
    }
    return {
      type: "valid",
      request: { type: "get_capture", requestId, query },
    };
  }
  if (
    value.type === "capture_subscribe" ||
    value.type === "capture_unsubscribe"
  ) {
    return { type: "valid", request: { type: value.type, requestId } };
  }
  if (value.type === "history_query") {
    if (value.range !== undefined) {
      const range = decodeHistoryRange(value.range);
      if (range === undefined) {
        return { type: "invalid", requestId, code: "invalid_request" };
      }
      return {
        type: "valid",
        request: { type: "history_query", requestId, range },
      };
    }
    return { type: "valid", request: { type: "history_query", requestId } };
  }
  if (value.type === "history_export_command") {
    const command = decodeHistoryExportCommand(value.command);
    if (command === undefined) {
      return { type: "invalid", requestId, code: "invalid_request" };
    }
    return {
      type: "valid",
      request: { type: "history_export_command", requestId, command },
    };
  }
  if (value.type === "history_export_confirm") {
    if (
      typeof value.actionId !== "string" ||
      value.actionId.length === 0 ||
      value.actionId.length > 128
    ) {
      return { type: "invalid", requestId, code: "invalid_request" };
    }
    return {
      type: "valid",
      request: {
        type: "history_export_confirm",
        requestId,
        actionId: value.actionId,
      },
    };
  }
  if (value.type === "history_delete_command") {
    const command = decodeHistoryDeleteCommand(value.command);
    if (command === undefined) {
      return { type: "invalid", requestId, code: "invalid_request" };
    }
    return {
      type: "valid",
      request: { type: "history_delete_command", requestId, command },
    };
  }
  if (value.type === "history_delete_confirm") {
    if (
      typeof value.actionId !== "string" ||
      value.actionId.length === 0 ||
      value.actionId.length > 128
    ) {
      return { type: "invalid", requestId, code: "invalid_request" };
    }
    return {
      type: "valid",
      request: {
        type: "history_delete_confirm",
        requestId,
        actionId: value.actionId,
      },
    };
  }
  if (value.type === "history_acknowledge") {
    return {
      type: "valid",
      request: { type: "history_acknowledge", requestId },
    };
  }
  if (value.type === "backup_command") {
    const command = decodeBackupCommand(value.command);
    if (command === undefined) {
      return { type: "invalid", requestId, code: "invalid_request" };
    }
    return {
      type: "valid",
      request: { type: "backup_command", requestId, command },
    };
  }
  if (value.type === "runtime_command") {
    if (
      value.command !== "start" &&
      value.command !== "stop" &&
      value.command !== "restart"
    ) {
      return { type: "invalid", requestId, code: "invalid_request" };
    }
    return {
      type: "valid",
      request: { type: "runtime_command", requestId, command: value.command },
    };
  }
  if (value.type === "settings_command") {
    const command = decodeSettingsCommand(value.command);
    if (command === undefined) {
      return { type: "invalid", requestId, code: "invalid_request" };
    }
    return {
      type: "valid",
      request: {
        type: "settings_command",
        requestId,
        command,
      },
    };
  }
  if (value.type === "application_command") {
    const command = decodeApplicationCommand(value.command);
    if (command === undefined) {
      return { type: "invalid", requestId, code: "invalid_request" };
    }
    return {
      type: "valid",
      request: {
        type: "application_command",
        requestId,
        command,
      },
    };
  }
  if (value.type === "models_command") {
    const command = decodeModelsCommand(value.command);
    if (command === undefined) {
      return { type: "invalid", requestId, code: "invalid_request" };
    }
    return {
      type: "valid",
      request: {
        type: "models_command",
        requestId,
        command,
      },
    };
  }
  if (value.type === "credential_command") {
    const command = decodeCredentialCommand(value.command);
    if (command === undefined) {
      return { type: "invalid", requestId, code: "invalid_request" };
    }
    return {
      type: "valid",
      request: {
        type: "credential_command",
        requestId,
        command,
      },
    };
  }
  if (value.type === "auth_command") {
    const command = decodeAuthCommand(value.command);
    if (command === undefined) {
      return { type: "invalid", requestId, code: "invalid_request" };
    }
    return {
      type: "valid",
      request: {
        type: "auth_command",
        requestId,
        command,
      },
    };
  }
  if (value.type === "auth_interaction_response") {
    const response = decodeAuthInteractionResponse(value.response);
    if (response === undefined) {
      return { type: "invalid", requestId, code: "invalid_request" };
    }
    return {
      type: "valid",
      request: {
        type: "auth_interaction_response",
        requestId,
        response,
      },
    };
  }
  if (value.type === "catalog_command") {
    const command = decodeCatalogCommand(value.command);
    if (command === undefined) {
      return { type: "invalid", requestId, code: "invalid_request" };
    }
    return {
      type: "valid",
      request: {
        type: "catalog_command",
        requestId,
        command,
      },
    };
  }
  if (value.type === "alias_command") {
    const command = decodeAliasCommand(value.command);
    if (command === undefined) {
      return { type: "invalid", requestId, code: "invalid_request" };
    }
    return {
      type: "valid",
      request: {
        type: "alias_command",
        requestId,
        command,
      },
    };
  }
  if (value.type === "codex_integration_command") {
    const command = decodeCodexIntegrationCommand(value.command);
    if (command === undefined) {
      return { type: "invalid", requestId, code: "invalid_request" };
    }
    return {
      type: "valid",
      request: {
        type: "codex_integration_command",
        requestId,
        command,
      },
    };
  }
  return { type: "invalid", requestId, code: "unknown_command" };
}

export function compatibleHello(application: ApplicationIdentity): HelloResult {
  return {
    type: "compatible",
    application,
    contractVersion: controlPlaneVersion,
  };
}

export function incompatibleHello(requestedVersion: number): HelloResult {
  return {
    type: "incompatible",
    requestedVersion,
    supportedVersions: [controlPlaneVersion],
  };
}

export function decodeHello(value: unknown): HelloResult | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.type === "incompatible" &&
    typeof value.requestedVersion === "number" &&
    Number.isSafeInteger(value.requestedVersion) &&
    Array.isArray(value.supportedVersions) &&
    value.supportedVersions.length === 1 &&
    value.supportedVersions[0] === controlPlaneVersion
  ) {
    return {
      type: "incompatible",
      requestedVersion: value.requestedVersion,
      supportedVersions: [controlPlaneVersion],
    };
  }
  if (
    value.type === "compatible" &&
    value.contractVersion === controlPlaneVersion &&
    isRecord(value.application) &&
    value.application.id === "luckytoken" &&
    typeof value.application.version === "string" &&
    (value.application.buildId === undefined ||
      (typeof value.application.buildId === "string" &&
        /^[a-f0-9]{64}$/u.test(value.application.buildId)))
  ) {
    return {
      type: "compatible",
      application: {
        id: "luckytoken",
        version: value.application.version,
        ...(value.application.buildId === undefined
          ? {}
          : { buildId: value.application.buildId }),
      },
      contractVersion: controlPlaneVersion,
    };
  }
  return undefined;
}

export function decodeApplicationOwnership(
  value: unknown,
): ApplicationOwnership | undefined {
  if (!isRecord(value) || !isRecord(value.owner)) return undefined;
  const owner = value.owner;
  if (
    (owner.kind !== "cli" && owner.kind !== "desktop") ||
    !Number.isSafeInteger(owner.pid) ||
    (owner.pid as number) <= 0 ||
    typeof owner.startedAt !== "string" ||
    Number.isNaN(Date.parse(owner.startedAt))
  ) {
    return undefined;
  }
  return Object.freeze({
    owner: Object.freeze({
      kind: owner.kind as "cli" | "desktop",
      pid: owner.pid as number,
      startedAt: owner.startedAt as string,
    }),
  });
}

function decodeApplicationCommand(
  value: unknown,
): ApplicationCommand | undefined {
  if (!isRecord(value)) return undefined;
  if (value.command === "attach") return { command: "attach" };
  if (value.command === "quit") {
    return typeof value.acknowledged === "boolean"
      ? { command: "quit", acknowledged: value.acknowledged }
      : undefined;
  }
  if (value.command === "desktop_owner") {
    return (value.action === "claim" || value.action === "renew") &&
      typeof value.leaseId === "string" &&
      value.leaseId.length > 0 &&
      value.leaseId.length <= 128 &&
      value.leaseId.trim() === value.leaseId &&
      !/\s/u.test(value.leaseId)
      ? {
          command: "desktop_owner",
          action: value.action,
          leaseId: value.leaseId,
        }
      : undefined;
  }
  if (value.command === "auto_start") {
    return value.action === "status" ||
      value.action === "enable" ||
      value.action === "disable"
      ? { command: "auto_start", action: value.action }
      : undefined;
  }
  return undefined;
}

const applicationCommandConflictMessages: Readonly<
  Record<ApplicationCommandConflict["code"], string>
> = {
  quit_requires_explicit_confirmation:
    "Quitting would stop the LuckyToken gateway that another process started. Acknowledge the quit explicitly to continue.",
  desktop_owner_lease_mismatch:
    "The desktop ownership lease belongs to a newer LuckyToken shell.",
};

function decodeApplicationCommandConflict(
  value: unknown,
): ApplicationCommandConflict | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.code === "quit_requires_explicit_confirmation" ||
    value.code === "desktop_owner_lease_mismatch"
  ) {
    return {
      code: value.code,
      message: applicationCommandConflictMessages[value.code],
    };
  }
  return undefined;
}

function decodeAutoStartRegistration(
  value: unknown,
): { readonly enabled: boolean } | undefined {
  return isRecord(value) && typeof value.enabled === "boolean"
    ? { enabled: value.enabled }
    : undefined;
}

export function decodeApplicationCommandExecution(
  value: unknown,
): ApplicationCommandExecution | undefined {
  if (
    !isRecord(value) ||
    (value.outcome !== "attached" &&
      value.outcome !== "lease_claimed" &&
      value.outcome !== "lease_renewed" &&
      value.outcome !== "drained" &&
      value.outcome !== "timed_out" &&
      value.outcome !== "conflict" &&
      value.outcome !== "ok" &&
      value.outcome !== "failed" &&
      value.outcome !== "unsupported")
  ) {
    return undefined;
  }
  const conflict = decodeApplicationCommandConflict(value.conflict);
  if (
    (value.outcome === "conflict" && conflict === undefined) ||
    (value.outcome !== "conflict" && value.conflict !== undefined)
  ) {
    return undefined;
  }
  const autoStart = decodeAutoStartRegistration(value.autoStart);
  if (
    (value.outcome === "ok" && autoStart === undefined) ||
    (value.outcome !== "ok" && value.autoStart !== undefined)
  ) {
    return undefined;
  }
  if (value.outcome === "failed" && typeof value.error !== "string") {
    return undefined;
  }
  return {
    outcome: value.outcome as ApplicationCommandOutcome,
    ...(conflict === undefined ? {} : { conflict }),
    ...(autoStart === undefined ? {} : { autoStart }),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  };
}

function decodeApplicationCommandResult(
  value: unknown,
): ApplicationCommandResult | undefined {
  if (
    !isRecord(value) ||
    (value.command !== "attach" &&
      value.command !== "desktop_owner" &&
      value.command !== "quit" &&
      value.command !== "auto_start")
  ) {
    return undefined;
  }
  const snapshot = decodeSnapshot(value.snapshot);
  const execution = decodeApplicationCommandExecution(value);
  if (snapshot === undefined || execution === undefined) return undefined;
  return {
    command: value.command as ApplicationCommandResult["command"],
    ...execution,
    snapshot,
  };
}

export function decodeSnapshot(value: unknown): StatusSnapshot | undefined {
  const safeStatus = decodeApplicationStatus(value);
  const sequence = isRecord(value) ? value.sequence : undefined;
  if (
    safeStatus === undefined ||
    typeof sequence !== "number" ||
    !Number.isSafeInteger(sequence) ||
    (sequence as number) < 0
  ) {
    return undefined;
  }
  const ownership = isRecord(value)
    ? decodeApplicationOwnership(value.ownership)
    : undefined;
  if (
    isRecord(value) &&
    value.ownership !== undefined &&
    ownership === undefined
  ) {
    return undefined;
  }
  const persistence =
    isRecord(value) && value.persistence !== undefined
      ? decodePersistenceProjection(value.persistence)
      : undefined;
  if (isRecord(value) && value.persistence !== undefined && persistence === undefined) {
    return undefined;
  }
  const recovery =
    isRecord(value) && value.recovery !== undefined
      ? decodeRecoveryProjection(value.recovery)
      : undefined;
  if (isRecord(value) && value.recovery !== undefined && recovery === undefined) {
    return undefined;
  }
  const attention =
    isRecord(value) && value.attention !== undefined
      ? decodeAttentionProjection(value.attention)
      : undefined;
  if (isRecord(value) && value.attention !== undefined && attention === undefined) {
    return undefined;
  }
  return {
    ...safeStatus,
    sequence,
    ...(ownership === undefined ? {} : { ownership }),
    ...(persistence === undefined ? {} : { persistence }),
    ...(recovery === undefined ? {} : { recovery }),
    ...(attention === undefined ? {} : { attention }),
  };
}

export function decodeEvent(value: unknown): StatusEvent | undefined {
  if (
    !isRecord(value) ||
    value.type !== "status_changed" ||
    typeof value.sequence !== "number" ||
    !Number.isSafeInteger(value.sequence)
  ) {
    return undefined;
  }
  const snapshot = decodeSnapshot(value.snapshot);
  return snapshot !== undefined && snapshot.sequence === value.sequence
    ? {
        type: "status_changed",
        sequence: value.sequence,
        snapshot,
      }
    : undefined;
}

function decodeRuntimeCommandConflict(
  value: unknown,
): RuntimeCommandConflict | undefined {
  if (!isRecord(value)) return undefined;
  if (value.code === "restart_requires_running") {
    return {
      code: value.code,
      message: "Start the model gateway before restarting it.",
    };
  }
  if (value.code === "runtime_unavailable") {
    return {
      code: value.code,
      message:
        "Runtime lifecycle commands are unavailable in this application.",
    };
  }
  if (value.code === "application_restart_required") {
    return {
      code: value.code,
      message: "Restart LuckyToken before starting the model gateway again.",
    };
  }
  return undefined;
}

export function decodeRuntimeCommandExecution(
  value: unknown,
): RuntimeCommandExecution | undefined {
  if (
    !isRecord(value) ||
    (value.outcome !== "completed" &&
      value.outcome !== "unchanged" &&
      value.outcome !== "failed" &&
      value.outcome !== "conflict")
  ) {
    return undefined;
  }
  const conflict = decodeRuntimeCommandConflict(value.conflict);
  if (
    (value.outcome === "conflict" && conflict === undefined) ||
    (value.outcome !== "conflict" && value.conflict !== undefined)
  ) {
    return undefined;
  }
  return {
    outcome: value.outcome,
    ...(conflict === undefined ? {} : { conflict }),
  };
}

function decodeRuntimeCommandResult(
  value: unknown,
): RuntimeCommandResult | undefined {
  if (
    !isRecord(value) ||
    (value.command !== "start" &&
      value.command !== "stop" &&
      value.command !== "restart")
  ) {
    return undefined;
  }
  const snapshot = decodeSnapshot(value.snapshot);
  const execution = decodeRuntimeCommandExecution(value);
  if (snapshot === undefined || execution === undefined) return undefined;
  return {
    command: value.command as RuntimeCommand,
    ...execution,
    snapshot,
  };
}

function decodeDiagnosticsResult(
  value: unknown,
): RuntimeDiagnosticsQueryResult | undefined {
  if (!isRecord(value) || !Array.isArray(value.records)) return undefined;
  const records = value.records
    .map((entry) => decodeDiagnosticRecord(entry))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  if (records.length !== value.records.length) return undefined;
  if (typeof value.hasMore !== "boolean") return undefined;
  return Object.freeze({
    records: Object.freeze(records),
    hasMore: value.hasMore,
  });
}

const REQUEST_IDENTITY_KEYS = new Set([
  "id",
  "time",
  "protocolId",
  "clientSessionId",
  "projectDir",
]);
const REQUEST_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * Strict request identity record decoder (Ticket 17 identity seam): the
 * allowed key set has no effective-session field, so a frame that ever
 * carries the internal `effectiveSessionId` (or any other unknown key) is
 * rejected instead of projected.
 */
export function decodeRequestIdentityRecord(
  value: unknown,
): RequestIdentityRecord | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of Object.keys(value)) {
    if (!REQUEST_IDENTITY_KEYS.has(key)) return undefined;
  }
  if (
    !Number.isSafeInteger(value.id) ||
    (value.id as number) < 1 ||
    !Number.isSafeInteger(value.time) ||
    (value.time as number) < 0 ||
    typeof value.protocolId !== "string" ||
    value.protocolId.length === 0
  ) {
    return undefined;
  }
  const clientSessionId = value.clientSessionId;
  if (
    (clientSessionId !== undefined &&
      (typeof clientSessionId !== "string" ||
        !REQUEST_SESSION_ID_PATTERN.test(clientSessionId))) ||
    (clientSessionId === undefined && value.clientSessionId !== undefined)
  ) {
    return undefined;
  }
  const projectDir = value.projectDir;
  if (
    (projectDir !== undefined &&
      (typeof projectDir !== "string" || projectDir.length === 0)) ||
    (projectDir === undefined && value.projectDir !== undefined)
  ) {
    return undefined;
  }
  return Object.freeze({
    id: value.id as number,
    time: value.time as number,
    protocolId: value.protocolId,
    ...(clientSessionId === undefined
      ? {}
      : { clientSessionId: clientSessionId as string }),
    ...(projectDir === undefined ? {} : { projectDir: projectDir as string }),
  });
}

function decodeRequestIdentitiesResult(
  value: unknown,
): RequestIdentitiesQueryResult | undefined {
  if (!isRecord(value) || !Array.isArray(value.records)) return undefined;
  const records = value.records
    .map((entry) => decodeRequestIdentityRecord(entry))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  if (records.length !== value.records.length) return undefined;
  return Object.freeze({
    records: Object.freeze(records),
  });
}

export function decodeServerMessage(value: unknown): ServerMessage | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.type === "event") {
    const diagnostic = decodeDiagnosticEvent(value.event);
    if (diagnostic !== undefined) {
      return { type: "event", event: diagnostic };
    }
    const ledger = decodeRequestLedgerEvent(value.event);
    if (ledger !== undefined) {
      return { type: "event", event: ledger };
    }
    const capture = decodeCaptureEvent(value.event);
    if (capture !== undefined) {
      return { type: "event", event: capture };
    }
    const event = decodeEvent(value.event);
    return event === undefined ? undefined : { type: "event", event };
  }
  const requestId = decodeRequestId(value.requestId);
  if (requestId === undefined) return undefined;
  if (value.type === "hello_result") {
    const result = decodeHello(value.result);
    return result === undefined
      ? undefined
      : { type: "hello_result", requestId, result };
  }
  if (value.type === "status_result") {
    const snapshot = decodeSnapshot(value.snapshot);
    return snapshot === undefined
      ? undefined
      : { type: "status_result", requestId, snapshot };
  }
  if (value.type === "diagnostics_result") {
    const result = decodeDiagnosticsResult(value.result);
    return result === undefined
      ? undefined
      : { type: "diagnostics_result", requestId, result };
  }
  if (value.type === "request_identities_result") {
    const result = decodeRequestIdentitiesResult(value.result);
    return result === undefined
      ? undefined
      : { type: "request_identities_result", requestId, result };
  }
  if (value.type === "request_ledger_result") {
    const result = decodeRequestLedgerResult(value.result);
    return result === undefined
      ? undefined
      : { type: "request_ledger_result", requestId, result };
  }
  if (value.type === "analytics_result") {
    const result = decodeAnalyticsResult(value.result);
    return result === undefined
      ? undefined
      : { type: "analytics_result", requestId, result };
  }
  if (value.type === "capture_result") {
    const result = decodeCaptureQueryResult(value.result);
    return result === undefined
      ? undefined
      : { type: "capture_result", requestId, result };
  }
  if (value.type === "history_query_result") {
    const result = decodeHistoryQueryResult(value.result);
    return result === undefined
      ? undefined
      : { type: "history_query_result", requestId, result };
  }
  if (value.type === "history_export_result") {
    const result = decodeHistoryExportResult(value.result);
    return result === undefined
      ? undefined
      : { type: "history_export_result", requestId, result };
  }
  if (value.type === "history_delete_result") {
    const result = decodeHistoryDeleteResult(value.result);
    return result === undefined
      ? undefined
      : { type: "history_delete_result", requestId, result };
  }
  if (value.type === "history_acknowledge_result") {
    const result = decodeHistoryAcknowledgeResult(value.result);
    return result === undefined
      ? undefined
      : { type: "history_acknowledge_result", requestId, result };
  }
  if (value.type === "backup_result") {
    const result = decodeBackupResult(value.result);
    return result === undefined
      ? undefined
      : { type: "backup_result", requestId, result };
  }
  if (value.type === "runtime_command_result") {
    const result = decodeRuntimeCommandResult(value.result);
    return result === undefined
      ? undefined
      : { type: "runtime_command_result", requestId, result };
  }
  if (value.type === "settings_command_result") {
    const result = decodeSettingsCommandResult(value.result);
    return result === undefined
      ? undefined
      : { type: "settings_command_result", requestId, result };
  }
  if (value.type === "application_command_result") {
    const result = decodeApplicationCommandResult(value.result);
    return result === undefined
      ? undefined
      : { type: "application_command_result", requestId, result };
  }
  if (value.type === "models_command_result") {
    const result = decodeModelsCommandResult(value.result);
    return result === undefined
      ? undefined
      : { type: "models_command_result", requestId, result };
  }
  if (value.type === "credential_command_result") {
    // The full per-command result validation happens against the client's
    // own command (executeCredentialCommand); the host already validated
    // this result before writing it. Only the shared fields are checked
    // here so a malformed frame is still rejected at the wire boundary.
    if (
      !isRecord(value.result) ||
      (value.result.outcome !== "ok" &&
        value.result.outcome !== "conflict" &&
        value.result.outcome !== "invalid" &&
        value.result.outcome !== "unknown_provider" &&
        value.result.outcome !== "overwrite_required" &&
        value.result.outcome !== "storage_failure" &&
        value.result.outcome !== "unavailable") ||
      !Number.isSafeInteger(value.result.revision) ||
      (value.result.revision as number) < 0 ||
      decodeCredentialProjection(value.result.state, {
        allowEmptyPath: value.result.outcome === "unavailable",
      }) === undefined
    ) {
      return undefined;
    }
    return {
      type: "credential_command_result",
      requestId,
      result: value.result as unknown as CredentialCommandResult,
    };
  }
  if (value.type === "auth_command_result") {
    // The full per-command result validation happens against the client's
    // own command (executeAuthCommand); the host already validated this
    // result before writing it. Only the shared fields are checked here so
    // a malformed frame is still rejected at the wire boundary.
    if (
      !isRecord(value.result) ||
      (value.result.outcome !== "ok" &&
        value.result.outcome !== "cancelled" &&
        value.result.outcome !== "failed" &&
        value.result.outcome !== "conflict" &&
        value.result.outcome !== "unknown_provider" &&
        value.result.outcome !== "unsupported" &&
        value.result.outcome !== "storage_failure" &&
        value.result.outcome !== "unavailable") ||
      decodeCredentialProjection(value.result.state, {
        allowEmptyPath: value.result.outcome === "unavailable",
      }) === undefined
    ) {
      return undefined;
    }
    return {
      type: "auth_command_result",
      requestId,
      result: value.result as unknown as AuthCommandResult,
    };
  }
  if (value.type === "auth_interaction_event") {
    const event = decodeAuthInteractionEvent(value.event);
    if (event === undefined) return undefined;
    return {
      type: "auth_interaction_event",
      requestId,
      event,
    };
  }
  if (value.type === "catalog_command_result") {
    const result = decodeCatalogCommandResult(value.result);
    return result === undefined
      ? undefined
      : { type: "catalog_command_result", requestId, result };
  }
  if (value.type === "alias_command_result") {
    const result = decodeAliasCommandResult(value.result);
    return result === undefined
      ? undefined
      : { type: "alias_command_result", requestId, result };
  }
  if (value.type === "codex_integration_command_result") {
    const result = decodeCodexIntegrationCommandResult(value.result);
    return result === undefined
      ? undefined
      : { type: "codex_integration_command_result", requestId, result };
  }
  if (value.type === "subscribed" || value.type === "unsubscribed") {
    return { type: value.type, requestId };
  }
  if (
    value.type === "error" &&
    (value.code === "invalid_request" ||
      value.code === "unauthorized" ||
      value.code === "hello_required" ||
      value.code === "unknown_command")
  ) {
    return { type: "error", requestId, code: value.code };
  }
  return undefined;
}
