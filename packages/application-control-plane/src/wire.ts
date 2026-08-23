import type {
  RuntimeDiagnosticEvent,
  RuntimeDiagnosticsQueryResult,
} from "./diagnostics-contract.js";
import {
  controlPlaneVersion,
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
  type AgentIntegrationEffectProjection,
  type AgentIntegrationId,
  type AgentIntegrationObservedState,
  type AgentIntegrationOperationResult,
  type AgentIntegrationProjection,
  type AgentIntegrationsCommand,
  type AgentIntegrationsCommandResult,
  type AgentIntegrationsState,
  type CatalogModelAvailability,
  type CatalogModelProjection,
  type CatalogProviderProjection,
  type CatalogProviderState,
  type CatalogRefreshErrorProjection,
  type CatalogRefreshReportProjection,
  type CatalogSnapshotProjection,
  type CatalogStatusProjection,
  type DataPlaneFailure,
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
  type PublicModelsCommand,
  type PublicModelsCommandResult,
  type PublicModelsState,
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
import type {
  CredentialProfilesCommand,
  CredentialProfilesCommandResult,
  ProviderProfileAuthCommand,
  ProviderProfileAuthCommandResult,
} from "./credential-profiles-contract.js";
import {
  decodeCredentialProfilesCommand,
  decodeCredentialProfilesCommandResult,
  decodeCredentialProfilesProjection,
  decodeProviderProfileAuthCommand,
  decodeProviderProfileAuthCommandResult,
} from "./wire-credential-profiles.js";
import {
  type AuthInfoLink,
  type AuthInteractionEvent,
  type AuthInteractionResponse,
  type AuthPromptOption,
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
      readonly type: "credential_profiles_command";
      readonly requestId: string;
      readonly command: CredentialProfilesCommand;
    }
  | {
      readonly type: "provider_profile_auth_command";
      readonly requestId: string;
      readonly command: ProviderProfileAuthCommand;
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
      readonly type: "public_models_command";
      readonly requestId: string;
      readonly command: PublicModelsCommand;
    }
  | {
      readonly type: "agent_integrations_command";
      readonly requestId: string;
      readonly command: AgentIntegrationsCommand;
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
      readonly type: "credential_profiles_command_result";
      readonly requestId: string;
      readonly result: CredentialProfilesCommandResult;
    }
  | {
      readonly type: "provider_profile_auth_command_result";
      readonly requestId: string;
      readonly result: ProviderProfileAuthCommandResult;
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
      readonly type: "public_models_command_result";
      readonly requestId: string;
      readonly result: PublicModelsCommandResult;
    }
  | {
      readonly type: "agent_integrations_command_result";
      readonly requestId: string;
      readonly result: AgentIntegrationsCommandResult;
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
  if (value.credentials !== undefined) return undefined;
  const credentialProfiles = decodeCredentialProfilesProjection(
    value.credentialProfiles,
  );
  if (
    value.credentialProfiles !== undefined &&
    credentialProfiles === undefined
  ) {
    return undefined;
  }
  const catalog = decodeCatalogStatusProjection(value.catalog);
  if (value.catalog !== undefined && catalog === undefined) {
    return undefined;
  }
  if (value.aliases !== undefined) return undefined;
  if (value.confirmation !== undefined) return undefined;
  return {
    modelDataPlane: value.modelDataPlane,
    provider: value.provider,
    ...(dataPlane === undefined ? {} : { dataPlane }),
    ...(settings === undefined ? {} : { settings }),
    ...(models === undefined ? {} : { models }),
    ...(credentialProfiles === undefined ? {} : { credentialProfiles }),
    ...(catalog === undefined ? {} : { catalog }),
  };
}

function decodeRegisteredSetting(
  value: unknown,
): RegisteredSetting | undefined {
  const isSettingValue = (
    candidate: unknown,
  ): candidate is boolean | number | string | null =>
    candidate === null ||
    typeof candidate === "boolean" ||
    typeof candidate === "number" ||
    typeof candidate === "string";
  if (
    !isRecord(value) ||
    typeof value.key !== "string" ||
    (value.type !== "boolean" &&
      value.type !== "number" &&
      value.type !== "string" &&
      value.type !== "nullable-string") ||
    !isSettingValue(value.default) ||
    (value.sensitivity !== "public" && value.sensitivity !== "secret") ||
    (value.applyMode !== "hot-apply" &&
      value.applyMode !== "restart-required") ||
    !isSettingValue(value.value) ||
    (value.type === "nullable-string" &&
      value.value !== null &&
      typeof value.value !== "string")
  ) {
    return undefined;
  }
  const effective =
    value.effective === null ||
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

const agentIntegrationIds: ReadonlySet<string> = new Set(["codex", "pi"]);
const agentInjectionScopes: ReadonlySet<string> = new Set(["favorite", "full"]);
const agentObservedStates: ReadonlySet<string> = new Set([
  "native",
  "managed",
  "conflict",
  "unavailable",
]);

export function decodeAgentIntegrationsCommand(
  value: unknown,
): AgentIntegrationsCommand | undefined {
  if (!isRecord(value) || typeof value.command !== "string") return undefined;
  if (value.command === "query") return { command: "query" };
  if (value.command === "sync") return { command: "sync" };
  if (
    value.command === "set_enabled" &&
    typeof value.agentId === "string" &&
    agentIntegrationIds.has(value.agentId) &&
    typeof value.enabled === "boolean"
  ) {
    return {
      command: "set_enabled",
      agentId: value.agentId as AgentIntegrationId,
      enabled: value.enabled,
    };
  }
  if (
    value.command === "set_scope" &&
    typeof value.agentId === "string" &&
    agentIntegrationIds.has(value.agentId) &&
    typeof value.scope === "string" &&
    agentInjectionScopes.has(value.scope)
  ) {
    return {
      command: "set_scope",
      agentId: value.agentId as AgentIntegrationId,
      scope: value.scope as "favorite" | "full",
    };
  }
  return undefined;
}

export function decodeAgentIntegrationProjection(
  value: unknown,
): AgentIntegrationProjection | undefined {
  if (
    !isRecord(value) ||
    typeof value.agentId !== "string" ||
    !agentIntegrationIds.has(value.agentId) ||
    typeof value.enabled !== "boolean" ||
    typeof value.scope !== "string" ||
    !agentInjectionScopes.has(value.scope) ||
    typeof value.modelCount !== "number" ||
    !Number.isSafeInteger(value.modelCount) ||
    value.modelCount < 0 ||
    typeof value.needsSync !== "boolean"
  ) {
    return undefined;
  }
  return Object.freeze({
    agentId: value.agentId as AgentIntegrationId,
    enabled: value.enabled,
    scope: value.scope as "favorite" | "full",
    modelCount: value.modelCount,
    needsSync: value.needsSync,
  });
}

function decodeAgentIntegrationEffect(
  value: unknown,
): AgentIntegrationEffectProjection | undefined {
  if (
    !isRecord(value) ||
    typeof value.observedState !== "string" ||
    !agentObservedStates.has(value.observedState) ||
    typeof value.modelCount !== "number" ||
    !Number.isSafeInteger(value.modelCount) ||
    value.modelCount < 0 ||
    !Array.isArray(value.warnings) ||
    value.warnings.some((warning) => typeof warning !== "string") ||
    typeof value.changed !== "boolean" ||
    (value.message !== undefined && typeof value.message !== "string")
  ) {
    return undefined;
  }
  return Object.freeze({
    observedState: value.observedState as AgentIntegrationObservedState,
    modelCount: value.modelCount,
    warnings: Object.freeze([...(value.warnings as string[])]),
    changed: value.changed,
    ...(value.message === undefined ? {} : { message: value.message }),
  });
}

export function decodeAgentIntegrationsCommandResult(
  value: unknown,
): AgentIntegrationsCommandResult | undefined {
  if (
    !isRecord(value) ||
    (value.outcome !== "ok" && value.outcome !== "partial" && value.outcome !== "failed") ||
    !isRecord(value.state) ||
    !Array.isArray(value.state.agents) ||
    !Array.isArray(value.results)
  ) {
    return undefined;
  }
  const agents = value.state.agents.map(decodeAgentIntegrationProjection);
  if (agents.some((agent) => agent === undefined)) return undefined;
  const seenAgents = new Set(agents.map((agent) => agent!.agentId));
  if (seenAgents.size !== agents.length) return undefined;
  const results: AgentIntegrationOperationResult[] = [];
  for (const entry of value.results) {
    if (
      !isRecord(entry) ||
      typeof entry.agentId !== "string" ||
      !agentIntegrationIds.has(entry.agentId) ||
      (entry.outcome !== "ok" && entry.outcome !== "failed")
    ) {
      return undefined;
    }
    const effect = entry.effect === undefined
      ? undefined
      : decodeAgentIntegrationEffect(entry.effect);
    if (entry.effect !== undefined && effect === undefined) return undefined;
    results.push(Object.freeze({
      agentId: entry.agentId as AgentIntegrationId,
      outcome: entry.outcome,
      ...(effect === undefined ? {} : { effect }),
    }));
  }
  const state: AgentIntegrationsState = Object.freeze({
    agents: Object.freeze(agents as AgentIntegrationProjection[]),
  });
  return Object.freeze({
    outcome: value.outcome,
    state,
    results: Object.freeze(results),
  });
}

export function decodePublicModelsCommand(
  value: unknown,
): PublicModelsCommand | undefined {
  if (!isRecord(value) || typeof value.command !== "string") return undefined;
  if (value.command === "query") return { command: "query" };
  const revision = value.revision;
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  ) {
    return undefined;
  }
  if (value.command === "set_port") {
    if (
      typeof value.port !== "number" ||
      !Number.isSafeInteger(value.port) ||
      value.port < 1 ||
      value.port > 65_535
    ) {
      return undefined;
    }
    return { command: "set_port", revision, port: value.port };
  }
  if (value.command === "set_provider") {
    if (
      typeof value.providerId !== "string" ||
      value.providerId.length === 0 ||
      typeof value.on !== "boolean"
    ) {
      return undefined;
    }
    return {
      command: "set_provider",
      revision,
      providerId: value.providerId,
      on: value.on,
    };
  }
  if (value.command === "set_model") {
    if (
      typeof value.providerId !== "string" ||
      value.providerId.length === 0 ||
      typeof value.modelId !== "string" ||
      value.modelId.length === 0 ||
      typeof value.on !== "boolean"
    ) {
      return undefined;
    }
    return {
      command: "set_model",
      revision,
      providerId: value.providerId,
      modelId: value.modelId,
      on: value.on,
    };
  }
  if (value.command === "set_provider_favorite") {
    if (
      typeof value.providerId !== "string" ||
      value.providerId.length === 0 ||
      typeof value.favorite !== "boolean"
    ) {
      return undefined;
    }
    return {
      command: "set_provider_favorite",
      revision,
      providerId: value.providerId,
      favorite: value.favorite,
    };
  }
  if (value.command === "set_model_favorite") {
    if (
      typeof value.providerId !== "string" ||
      value.providerId.length === 0 ||
      typeof value.modelId !== "string" ||
      value.modelId.length === 0 ||
      typeof value.favorite !== "boolean"
    ) {
      return undefined;
    }
    return {
      command: "set_model_favorite",
      revision,
      providerId: value.providerId,
      modelId: value.modelId,
      favorite: value.favorite,
    };
  }
  if (value.command === "reorder_models") {
    if (
      typeof value.providerId !== "string" ||
      value.providerId.length === 0 ||
      !Array.isArray(value.modelIds) ||
      value.modelIds.some(
        (modelId) => typeof modelId !== "string" || modelId.length === 0,
      )
    ) {
      return undefined;
    }
    return {
      command: "reorder_models",
      revision,
      providerId: value.providerId,
      modelIds: Object.freeze([...value.modelIds] as string[]),
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
        revision,
        providerId: value.providerId,
        modelId: value.modelId,
        modelName: value.modelName,
      };
    }
    return {
      command: "restore_model_name",
      revision,
      providerId: value.providerId,
      modelId: value.modelId,
    };
  }
  return undefined;
}

function decodePublicModelsState(value: unknown): PublicModelsState | undefined {
  if (
    !isRecord(value) ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    typeof value.version !== "number" ||
    !Number.isSafeInteger(value.version) ||
    value.version < 0 ||
    !isRecord(value.endpoint) ||
    typeof value.endpoint.host !== "string" ||
    value.endpoint.host.length === 0 ||
    typeof value.endpoint.port !== "number" ||
    !Number.isSafeInteger(value.endpoint.port) ||
    value.endpoint.port < 1 ||
    value.endpoint.port > 65_535 ||
    !Array.isArray(value.providers)
  ) {
    return undefined;
  }
  const providers = value.providers.map((provider) => {
    if (
      !isRecord(provider) ||
      typeof provider.providerId !== "string" ||
      provider.providerId.length === 0 ||
      typeof provider.on !== "boolean" ||
      typeof provider.favorite !== "boolean" ||
      !Array.isArray(provider.models)
    ) {
      return undefined;
    }
    const models = provider.models.map((model) => {
      if (
        !isRecord(model) ||
        typeof model.alias !== "string" ||
        model.alias.length === 0 ||
        typeof model.target !== "string" ||
        model.target.length === 0 ||
        typeof model.on !== "boolean" ||
        typeof model.favorite !== "boolean"
      ) {
        return undefined;
      }
      return Object.freeze({
        alias: model.alias,
        target: model.target,
        on: model.on,
        favorite: model.favorite,
      });
    });
    if (models.some((model) => model === undefined)) return undefined;
    return Object.freeze({
      providerId: provider.providerId,
      on: provider.on,
      favorite: provider.favorite,
      models: Object.freeze(
        models.filter(
          (model): model is {
            readonly alias: string;
            readonly target: string;
            readonly on: boolean;
            readonly favorite: boolean;
          } =>
            model !== undefined,
        ),
      ),
    });
  });
  if (providers.some((provider) => provider === undefined)) return undefined;
  return Object.freeze({
    revision: value.revision,
    version: value.version,
    endpoint: Object.freeze({
      host: value.endpoint.host,
      port: value.endpoint.port,
    }),
    providers: Object.freeze(
      providers.filter(
        (provider): provider is {
          readonly providerId: string;
          readonly on: boolean;
          readonly favorite: boolean;
          readonly models: readonly {
            readonly alias: string;
            readonly target: string;
            readonly on: boolean;
            readonly favorite: boolean;
          }[];
        } => provider !== undefined,
      ),
    ),
  });
}

export function decodePublicModelsCommandResult(
  value: unknown,
): PublicModelsCommandResult | undefined {
  if (
    !isRecord(value) ||
    (value.outcome !== "ok" &&
      value.outcome !== "conflict" &&
      value.outcome !== "invalid" &&
      value.outcome !== "limit_exceeded" &&
      value.outcome !== "unavailable" &&
      value.outcome !== "storage_failure")
  ) {
    return undefined;
  }
  const state = decodePublicModelsState(value.state);
  if (state === undefined) return undefined;
  return Object.freeze({
    outcome: value.outcome as PublicModelsCommandResult["outcome"],
    state,
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
    value.baseline.package !== "@earendil-works/pi-coding-agent" ||
    value.baseline.version !== "0.84.2" ||
    value.baseline.schema !== "pi-coding-agent-0.84.2-models-json-schema" ||
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
      version: value.baseline.version as "0.84.2",
      schema: value.baseline
        .schema as "pi-coding-agent-0.84.2-models-json-schema",
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

export function decodeSettingsCommandResult(
  value: unknown,
): SettingsCommandResult | undefined {
  if (
    !isRecord(value) ||
    (value.outcome !== "ok" &&
      value.outcome !== "applied" &&
      value.outcome !== "pending" &&
      value.outcome !== "unknown_key" &&
      value.outcome !== "invalid_value" &&
      value.outcome !== "storage_failure")
  ) {
    return undefined;
  }
  const settings = decodeSettingsProjection(value.settings);
  if (settings === undefined) return undefined;
  if (value.confirmation !== undefined) return undefined;
  if (
    (value.outcome === "invalid_value" || value.outcome === "storage_failure") &&
    typeof value.error !== "string"
  ) {
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
  if (value.type === "credential_profiles_command") {
    const command = decodeCredentialProfilesCommand(value.command);
    if (command === undefined) {
      return { type: "invalid", requestId, code: "invalid_request" };
    }
    return {
      type: "valid",
      request: {
        type: "credential_profiles_command",
        requestId,
        command,
      },
    };
  }
  if (value.type === "provider_profile_auth_command") {
    const command = decodeProviderProfileAuthCommand(value.command);
    if (command === undefined) {
      return { type: "invalid", requestId, code: "invalid_request" };
    }
    return {
      type: "valid",
      request: {
        type: "provider_profile_auth_command",
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
  if (value.type === "public_models_command") {
    const command = decodePublicModelsCommand(value.command);
    if (command === undefined) {
      return { type: "invalid", requestId, code: "invalid_request" };
    }
    return {
      type: "valid",
      request: {
        type: "public_models_command",
        requestId,
        command,
      },
    };
  }
  if (value.type === "agent_integrations_command") {
    const command = decodeAgentIntegrationsCommand(value.command);
    if (command === undefined) {
      return { type: "invalid", requestId, code: "invalid_request" };
    }
    return {
      type: "valid",
      request: {
        type: "agent_integrations_command",
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
  if (value.type === "credential_profiles_command_result") {
    const result = decodeCredentialProfilesCommandResult(value.result);
    return result === undefined
      ? undefined
      : { type: "credential_profiles_command_result", requestId, result };
  }
  if (value.type === "provider_profile_auth_command_result") {
    const result = decodeProviderProfileAuthCommandResult(value.result);
    return result === undefined
      ? undefined
      : { type: "provider_profile_auth_command_result", requestId, result };
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
  if (value.type === "public_models_command_result") {
    const result = decodePublicModelsCommandResult(value.result);
    return result === undefined
      ? undefined
      : { type: "public_models_command_result", requestId, result };
  }
  if (value.type === "agent_integrations_command_result") {
    const result = decodeAgentIntegrationsCommandResult(value.result);
    return result === undefined
      ? undefined
      : { type: "agent_integrations_command_result", requestId, result };
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
