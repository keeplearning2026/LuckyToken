import type {
  RequestArtifactChunkReadResult,
  RequestArtifactGetInput,
  RequestJourneyDetailReadResult,
  RequestJourneyGetInput,
  RequestJourneyQuery,
  RequestJourneyQueryReadResult,
  RequestJourneySubscriber,
  RuntimeEventQuery,
  RuntimeEventQueryReadResult,
  RuntimeEventSubscriber,
} from "./request-diagnostics-contract.js";
import type { AnalyticsManagementResult, AnalyticsQuery } from "./analytics-contract.js";
import type { RecoveryProjection } from "./backup-contract.js";
import type { BackupCreateCommand, BackupManagementResult } from "./backup-contract.js";
import type { AttentionProjection } from "./attention-contract.js";
import type {
  CredentialProfilesCommand,
  CredentialProfilesCommandResult,
  CredentialProfilesProjectionV1,
  ProviderProfileAuthCommand,
  ProviderProfileAuthCommandResult,
} from "./credential-profiles-contract.js";

export const controlPlaneVersion = 4 as const;

export interface ApplicationIdentity {
  readonly id: "Token";
  readonly version: string;
  /** Exact bundled Backend build identity when launched by a desktop shell.
   * Headless/legacy owners may omit it. */
  readonly buildId?: string;
}

/** Owner identity of the one active Token application instance (Ticket
 *  05). The Control Plane host runs inside the owner process; every client
 *  connection is therefore an attached non-owner viewer. */
export interface ApplicationOwnership {
  readonly owner: {
    readonly kind: "cli" | "desktop";
    readonly pid: number;
    readonly startedAt: string;
  };
}

export interface ApplicationStatus {
  readonly modelDataPlane:
    "stopped" | "starting" | "running" | "stopping" | "failed";
  readonly provider: "configured" | "unconfigured";
  /** Live in-flight requests owned by the running Data Plane. */
  readonly activeRequests?: number;
  readonly dataPlane?: DataPlaneStatus;
  /** Sanitized diagnostics storage facts; never contains captured content. */
  readonly diagnostics?: DiagnosticsStorageProjection;
}

export interface DiagnosticsStorageProjection {
  readonly available: boolean;
  readonly fullJourneyDirectory: string;
  readonly maxJsonArtifactBytes: number;
  readonly maxJourneyArtifactBytes: number;
  readonly isolation: "process";
}

export type DataPlaneFailureCode =
  "port_in_use" | "start_failed" | "stop_failed";

export interface DataPlaneFailure {
  readonly code: DataPlaneFailureCode;
  readonly message: string;
}

export interface DataPlaneStatus {
  readonly configuredOrigin: string;
  readonly configuredPort: number;
  readonly failure?: DataPlaneFailure;
}

export interface StatusSnapshot extends ApplicationStatus {
  readonly sequence: number;
  /** Optional registered settings catalog projection (Ticket 06). */
  readonly settings?: Readonly<Record<string, RegisteredSetting>>;
  /** Ticket 24: present when one or more Token-owned files cannot be
   * safely interpreted. The local Control Plane remains usable while the
   * unsafe Data Plane stays stopped. */
  readonly recovery?: RecoveryProjection;
  /** Ticket 25: value-free actionable conditions plus a recent request
   * failure count. Ordinary request failures never become conditions. */
  readonly attention?: AttentionProjection;
  /** Owner identity of the one active instance (Ticket 05). */
  readonly ownership?: ApplicationOwnership;
  /** Optional sanitized models.json projection (Ticket 08). */
  readonly models?: ModelsProjection;
  /** Sanitized per-Provider Credential Profile projection. */
  readonly credentialProfiles?: CredentialProfilesProjectionV1;
  /** Optional sanitized catalog lifecycle projection (Ticket 11). */
  readonly catalog?: CatalogStatusProjection;
}

/** Registered setting: type, default, validation, sensitivity, and apply mode
 *  are declared by the backend's authoritative catalog; values are typed and
 *  validated. Restart-required settings also report the effective value. */
export interface RegisteredSetting {
  readonly key: string;
  readonly type: "boolean" | "number" | "string" | "nullable-string";
  readonly default: boolean | number | string | null;
  readonly validation: unknown;
  readonly sensitivity: "public" | "secret";
  readonly applyMode: "hot-apply" | "restart-required";
  readonly value: boolean | number | string | null;
  readonly effective?: boolean | number | string | null;
}

/**
 * Sanitized models.json file projection (Ticket 08). Merged into published
 * status snapshots: only the revision, file location, presence, validity and
 * a value-free error are visible; raw content and provider data never reach
 * the status stream.
 */
export interface ModelsProjection {
  readonly revision: number;
  readonly path: string;
  readonly present: boolean;
  readonly valid: boolean;
  readonly error?: ModelsFileError;
}

export type ModelsFileErrorKind = "parse" | "schema" | "load" | "storage";

/** Exact source location for syntax errors: 1-based line/column plus the
 *  character position within the parsed (comment-stripped) text. */
export interface ModelsFileErrorLocation {
  readonly line: number;
  readonly column: number;
  readonly position?: number;
}

export interface ModelsFileError {
  readonly kind: ModelsFileErrorKind;
  readonly message: string;
  readonly location?: ModelsFileErrorLocation;
}

/** Full authoritative models.json state returned by the models commands.
 *  `raw` is the exact current file content (or "" when the file is absent)
 *  so the raw editor can round-trip bytes; `providers` is the parsed record
 *  for the structured editor and carries provider/model extension fields.
 *  `catalog` (Ticket 09) is the effective built-in + user catalog projection
 *  and is present exactly when `valid` is true; it never carries credentials
 *  or request auth state. */
export interface ModelsFileState {
  readonly revision: number;
  readonly path: string;
  readonly present: boolean;
  readonly valid: boolean;
  readonly raw: string;
  readonly providers?: Readonly<Record<string, unknown>>;
  /** Effective Provider/model catalog (Ticket 09). */
  readonly catalog?: EffectiveCatalogProjection;
  readonly error?: ModelsFileError;
}

/**
 * The repository-pinned Pi implementation that the effective catalog
 * composition is compatible with. Every effective catalog projection
 * identifies its baseline so consumers can tell which schema/semantics
 * produced the result.
 */
export interface EffectiveCatalogBaseline {
  readonly package: "@earendil-works/pi-coding-agent";
  readonly version: "0.84.2";
  readonly schema: "pi-coding-agent-0.84.2-models-json-schema";
}

/** Source layer of an effective Provider entry. */
export type EffectiveProviderLayer = "builtin" | "user" | "overlaid";

/** Source layer of an effective model entry. `overridden` is the topmost
 *  layer: a model that is also overridden is labeled `overridden` and its
 *  `overriddenFields` names the fields the modelOverrides contributed. */
export type EffectiveModelLayer =
  "builtin" | "user" | "upserted" | "overridden";

/** Public cost facts of an effective model (pinned shape). */
export interface EffectiveModelCost {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly tiers?: readonly unknown[];
}

/**
 * One effective model: the exact facts Pi would construct from the same
 * valid input. Credential and request-state fields (apiKey, headers, auth)
 * never appear here — Ticket 10 owns header/auth compatibility.
 */
export interface EffectiveModelProjection {
  readonly id: string;
  readonly name: string;
  readonly api: string;
  readonly provider: string;
  readonly baseUrl: string;
  readonly reasoning: boolean;
  readonly input: readonly ("text" | "image")[];
  readonly cost: EffectiveModelCost;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly layer: EffectiveModelLayer;
  /** Fields the provider `modelOverrides` contributed to this model. */
  readonly overriddenFields?: readonly string[];
  readonly thinkingLevelMap?: Readonly<Record<string, string | null>>;
  readonly compat?: Readonly<Record<string, unknown>>;
}

/** One effective Provider: built-in base facts overlaid by user config. */
export interface EffectiveProviderProjection {
  readonly id: string;
  readonly name: string;
  readonly baseUrl?: string;
  readonly layer: EffectiveProviderLayer;
  readonly models: readonly EffectiveModelProjection[];
}

/** Value-free per-Provider composition failure (pinned Pi wording). */
export interface EffectiveCatalogCompositionError {
  readonly providerId: string;
  readonly message: string;
}

/**
 * The authoritative effective Provider/model catalog (Ticket 09): Pi
 * built-ins as the lower layer with valid models.json configuration applied
 * above them with pinned Pi semantics. One projection, no credentials.
 */
export interface EffectiveCatalogProjection {
  readonly schemaVersion: "token-effective-catalog-v1";
  readonly baseline: EffectiveCatalogBaseline;
  readonly providers: readonly EffectiveProviderProjection[];
  readonly compositionErrors: readonly EffectiveCatalogCompositionError[];
}

/**
 * Catalog refresh lifecycle (Ticket 11): the refresh state of one Provider
 * in the authoritative active catalog snapshot. `known` is a static
 * Provider (no dynamic refresh); `cached` means dynamic facts were restored
 * from the validated Token-owned cache before any network refresh;
 * `refreshing` is an in-flight refresh; `succeeded`/`failed` are the last
 * network refresh outcome (a failed Provider keeps its cached/built-in
 * facts and carries a value-safe error).
 */
export type CatalogProviderState =
  "known" | "cached" | "refreshing" | "succeeded" | "failed";

/** Auth-based model usability in the active catalog snapshot. */
export type CatalogModelAvailability = "available" | "unavailable" | "unknown";

/** What started a refresh run. */
export type CatalogRefreshTrigger =
  "startup" | "login" | "page_open" | "manual";

/** One model in the active catalog snapshot. `dynamic` marks facts that
 *  came from the Provider's dynamic catalog overlay (cache or network). */
export interface CatalogModelProjection {
  readonly id: string;
  readonly dynamic: boolean;
  readonly availability: CatalogModelAvailability;
}

/** One Provider in the active catalog snapshot. */
export interface CatalogProviderProjection {
  readonly providerId: string;
  readonly name: string;
  /** Provider has a dynamic refresh implementation. */
  readonly dynamic: boolean;
  readonly state: CatalogProviderState;
  /** Value-safe failure summary; present only when state is "failed". */
  readonly error?: string;
  /** Value-safe failure category; present only when state is "failed". */
  readonly errorCode?: string;
  readonly refreshedAt?: number;
  readonly cachedAt?: number;
  readonly models: readonly CatalogModelProjection[];
}

/** One value-safe Provider refresh failure (fixed template, safe category). */
export interface CatalogRefreshErrorProjection {
  readonly providerId: string;
  readonly code: string;
  readonly message: string;
}

/**
 * One authoritative active catalog snapshot (Ticket 11): versioned and
 * atomically swapped after each refresh cycle. New requests resolve the
 * served catalog from the swapped snapshot; in-flight invocations keep the
 * Model objects they already captured. Never carries credentials, headers,
 * environment values or raw Provider errors.
 */
export interface CatalogSnapshotProjection {
  readonly version: number;
  readonly modelsJsonValid: boolean;
  /** Value-free models.json file error when the file is not loadable. */
  readonly modelsJsonError?: ModelsFileError;
  readonly refreshedAt?: number;
  readonly providers: readonly CatalogProviderProjection[];
  /** The last refresh run's Provider failures, aggregated. */
  readonly refreshErrors: readonly CatalogRefreshErrorProjection[];
}

/** Bounded per-Provider results of a completed manual refresh. */
export interface CatalogRefreshReportProjection {
  readonly trigger: "manual";
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly providers: readonly {
    readonly providerId: string;
    readonly outcome: "succeeded" | "failed" | "skipped";
    readonly error?: string;
    readonly errorCode?: string;
  }[];
}

/**
 * Sanitized catalog lifecycle projection merged into status snapshots:
 * version, in-flight refresh flag and the failed Provider ids (for precise
 * badges). Bounded; the full per-Provider/model facts ride only on catalog
 * query/refresh command results.
 */
export interface CatalogStatusProjection {
  readonly version: number;
  readonly refreshing: boolean;
  readonly refreshedAt?: number;
  readonly failedProviderIds: readonly string[];
}

/**
 * Versioned catalog commands (Ticket 11): query the one authoritative
 * active catalog snapshot, schedule a non-blocking background refresh, or
 * run a forced manual refresh that resolves with bounded per-Provider
 * results. `page_open` (background) is how the Models & Aliases page
 * triggers its refresh; `manual` is the explicit Refresh action.
 */
export type CatalogCommand =
  | { readonly command: "query" }
  | {
      readonly command: "refresh";
      readonly mode: "background" | "manual";
    };

export type CatalogCommandOutcome = "ok" | "scheduled" | "unavailable";

export interface CatalogCommandResult {
  readonly outcome: CatalogCommandOutcome;
  readonly snapshot: CatalogSnapshotProjection;
  /** Present only for a completed manual refresh. */
  readonly refresh?: CatalogRefreshReportProjection;
}

/** Handles versioned catalog commands against the refresh controller. */
export type CatalogCommandHandler = (
  command: CatalogCommand,
) => Promise<CatalogCommandResult>;

/**
 * Token's one Public Model runtime projection. The Backend owns this
 * state; product clients never read or edit public-models.json directly.
 * Provider `on` is the current total-switch state (saved user switch gated by
 * effective login). Model `on` is the saved user model switch and remains
 * independently editable while its Provider is OFF.
 */
export interface PublicModelsEndpointProjection {
  readonly host: string;
  readonly port: number;
}

export interface PublicModelProjection {
  readonly alias: string;
  readonly target: string;
  readonly on: boolean;
  readonly favorite: boolean;
}

export interface PublicProviderProjection {
  readonly providerId: string;
  readonly on: boolean;
  readonly favorite: boolean;
  readonly models: readonly PublicModelProjection[];
}

export interface PublicModelsState {
  readonly revision: number;
  readonly version: number;
  readonly endpoint: PublicModelsEndpointProjection;
  readonly providers: readonly PublicProviderProjection[];
}

export type PublicModelsCommand =
  | { readonly command: "query" }
  | {
      readonly command: "set_port";
      readonly revision: number;
      readonly port: number;
    }
  | {
      readonly command: "set_provider";
      readonly revision: number;
      readonly providerId: string;
      readonly on: boolean;
    }
  | {
      readonly command: "set_model";
      readonly revision: number;
      readonly providerId: string;
      readonly modelId: string;
      readonly on: boolean;
    }
  | {
      readonly command: "set_provider_favorite";
      readonly revision: number;
      readonly providerId: string;
      readonly favorite: boolean;
    }
  | {
      readonly command: "set_model_favorite";
      readonly revision: number;
      readonly providerId: string;
      readonly modelId: string;
      readonly favorite: boolean;
    }
  | {
      readonly command: "reorder_models";
      readonly revision: number;
      readonly providerId: string;
      readonly modelIds: readonly string[];
    }
  | {
      readonly command: "rename_model";
      readonly revision: number;
      readonly providerId: string;
      readonly modelId: string;
      readonly modelName: string;
    }
  | {
      readonly command: "restore_model_name";
      readonly revision: number;
      readonly providerId: string;
      readonly modelId: string;
    };

export type PublicModelsCommandOutcome =
  | "ok"
  | "conflict"
  | "invalid"
  | "limit_exceeded"
  | "unavailable"
  | "storage_failure";

export interface PublicModelsCommandResult {
  readonly outcome: PublicModelsCommandOutcome;
  readonly state: PublicModelsState;
}

export type PublicModelsCommandHandler = (
  command: PublicModelsCommand,
) => Promise<PublicModelsCommandResult>;

export type AgentIntegrationId = "codex" | "pi";
export type AgentInjectionScope = "favorite" | "full";
export type AgentIntegrationObservedState =
  | "native"
  | "managed"
  | "conflict"
  | "unavailable";

export interface AgentIntegrationEffectProjection {
  readonly observedState: AgentIntegrationObservedState;
  readonly modelCount: number;
  readonly warnings: readonly string[];
  readonly changed: boolean;
  readonly message?: string;
}

export interface AgentIntegrationProjection {
  readonly agentId: AgentIntegrationId;
  readonly enabled: boolean;
  readonly scope: AgentInjectionScope;
  readonly modelCount: number;
  readonly needsSync: boolean;
}

export interface AgentIntegrationsState {
  readonly agents: readonly AgentIntegrationProjection[];
}

export interface AgentIntegrationOperationResult {
  readonly agentId: AgentIntegrationId;
  readonly outcome: "ok" | "failed";
  readonly effect?: AgentIntegrationEffectProjection;
}

export type AgentIntegrationsCommand =
  | { readonly command: "query" }
  | {
      readonly command: "set_enabled";
      readonly agentId: AgentIntegrationId;
      readonly enabled: boolean;
    }
  | {
      readonly command: "set_scope";
      readonly agentId: AgentIntegrationId;
      readonly scope: AgentInjectionScope;
    }
  | { readonly command: "sync" };

export interface AgentIntegrationsCommandResult {
  readonly outcome: "ok" | "partial" | "failed";
  readonly state: AgentIntegrationsState;
  readonly results: readonly AgentIntegrationOperationResult[];
}

export type AgentIntegrationsCommandHandler = (
  command: AgentIntegrationsCommand,
) => Promise<AgentIntegrationsCommandResult>;

export type ModelsCommand =
  | { readonly command: "query" }
  | {
      readonly command: "write_raw";
      readonly revision: number;
      readonly content: string;
    }
  | {
      readonly command: "write_structured";
      readonly revision: number;
      readonly providers: Readonly<Record<string, unknown>>;
    };

export type ModelsCommandOutcome =
  "ok" | "conflict" | "invalid" | "storage_failure";

export interface ModelsCommandResult {
  readonly outcome: ModelsCommandOutcome;
  /** The authoritative state after the attempt (current revision). */
  readonly state: ModelsFileState;
  /** Value-free failure detail: the rejected proposal's validation error
   *  (`invalid`) or the sanitized storage fault (`storage_failure`). */
  readonly error?: ModelsFileError;
}

/** Provider product origin (Provider Activation Spec v1.0 §9): where a
 *  Provider identity came from. Pi built-ins are the pinned Pi catalog;
 *  `token_bundled` is a Token product-bundled Provider (e.g.
 *  CommandCode Private); `user` is a custom models.json Provider or an
 *  external user Provider Package. */
export type ProviderSource =
  | "pi_builtin"
  | "token_bundled"
  | "user";

export interface AuthInfoLink {
  readonly url: string;
  readonly label?: string;
}

/** One option of a Provider-owned select prompt. */
export interface AuthPromptOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

/**
 * Typed interaction events projected from the Provider-owned
 * AuthInteraction. Browser/device URLs cross only the typed desktop seam so
 * Electron Main can open them with the OS browser; Renderer may retain a
 * bounded retry action without exposing the raw URL as product copy. Prompts
 * carry a correlation id so responses never cross flows. No credential or
 * submitted code value is projected back out of the flow. Cancellation,
 * success and failure are terminal outcomes of the login command result.
 */
export type AuthInteractionEvent =
  | {
      readonly type: "info";
      readonly message: string;
      readonly links?: readonly AuthInfoLink[];
    }
  | {
      readonly type: "auth_url";
      readonly url: string;
      readonly instructions?: string;
    }
  | {
      readonly type: "device_code";
      readonly userCode: string;
      readonly verificationUri: string;
      readonly intervalSeconds?: number;
      readonly expiresInSeconds?: number;
    }
  | { readonly type: "progress"; readonly message: string }
  | {
      readonly type: "prompt";
      readonly promptId: string;
      readonly kind: "text" | "secret" | "manual_code" | "select";
      readonly message: string;
      readonly placeholder?: string;
      readonly options?: readonly AuthPromptOption[];
    };

/** A client response inside one in-flight Provider-owned login flow. */
export type AuthInteractionResponse =
  | {
      readonly type: "prompt_response";
      readonly promptId: string;
      readonly value: string;
    }
  | { readonly type: "cancel" };

/**
 * The interaction channel the Control Plane host provides to the auth
 * command handler for one in-flight login: `notify` projects typed events
 * to the client, `prompt` waits for the client's response to a typed
 * prompt, and `signal` aborts the whole flow (connection lost, cancel).
 */
export interface AuthInteractionChannel {
  readonly signal: AbortSignal;
  notify(event: AuthInteractionEvent): Promise<void>;
  prompt(input: {
    readonly kind: "text" | "secret" | "manual_code" | "select";
    readonly message: string;
    readonly placeholder?: string;
    readonly options?: readonly AuthPromptOption[];
  }): Promise<string>;
}

export type SettingsCommand =
  | {
      readonly command: "query";
      readonly keys?: readonly string[];
    }
  | {
      readonly command: "set";
      readonly key: string;
      readonly value: unknown;
    };

export type SettingsCommandOutcome =
  | "ok"
  | "applied"
  | "pending"
  | "unknown_key"
  | "invalid_value"
  | "storage_failure";

export interface SettingsCommandResult {
  readonly outcome: SettingsCommandOutcome;
  readonly error?: string;
  readonly settings: Readonly<Record<string, RegisteredSetting>>;
}

export interface StatusEvent {
  readonly type: "status_changed";
  readonly sequence: number;
  readonly snapshot: StatusSnapshot;
}

export interface ControlPlaneEndpoint {
  readonly address: string;
  readonly capability: string;
}

export type { TerminalUsageFact } from "@token/provider-contract/usage";

import type {
  HistoryCommand,
  HistoryCommandHandler,
  HistoryCommandResult,
  HistoryCounts,
  HistoryDeleteCommand,
  HistoryDeleteFailure,
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

export type {
  HistoryCommand,
  HistoryCommandHandler,
  HistoryCommandResult,
  HistoryCounts,
  HistoryDeleteCommand,
  HistoryDeleteFailure,
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
};

export type {
  AttentionCategory,
  AttentionCondition,
  AttentionPage,
  AttentionProjection,
  RecentRequestFailures,
} from "./attention-contract.js";
export { RECENT_REQUEST_FAILURE_WINDOW_MS } from "./attention-contract.js";

export type {
  BackupCommand,
  BackupCommandHandler,
  BackupCreateCommand,
  BackupFailure,
  BackupFailureCode,
  BackupManifestEntrySummary,
  BackupManifestSummary,
  BackupMode,
  BackupManagementResult,
  BackupResult,
  CompatibilityIssue,
  RecoveryProjection,
} from "./backup-contract.js";


export type HelloResult =
  | {
      readonly type: "compatible";
      readonly application: ApplicationIdentity;
      readonly contractVersion: typeof controlPlaneVersion;
    }
  | {
      readonly type: "incompatible";
      readonly requestedVersion: number;
      readonly supportedVersions: readonly [typeof controlPlaneVersion];
    };

export interface ControlPlaneDisconnect {
  readonly reason: "closed" | "transport_lost";
}

export interface RunningControlPlane {
  readonly endpoint: ControlPlaneEndpoint;
  publishStatus(status: ApplicationStatus): Promise<void>;
  close(): Promise<void>;
}

export type RuntimeCommand = "start" | "stop" | "restart";

export type RuntimeCommandConflictCode =
  | "restart_requires_running"
  | "application_restart_required"
  | "runtime_unavailable";

export interface RuntimeCommandConflict {
  readonly code: RuntimeCommandConflictCode;
  readonly message: string;
}

export type RuntimeCommandOutcome =
  "completed" | "unchanged" | "failed" | "conflict";

export interface RuntimeCommandExecution {
  readonly outcome: RuntimeCommandOutcome;
  readonly conflict?: RuntimeCommandConflict;
}

export interface RuntimeCommandResult extends RuntimeCommandExecution {
  readonly command: RuntimeCommand;
  readonly snapshot: StatusSnapshot;
}

export type RuntimeStatusPublisher = (
  status: ApplicationStatus,
) => Promise<void>;

export type RuntimeCommandHandler = (
  command: RuntimeCommand,
  publishStatus: RuntimeStatusPublisher,
) => Promise<RuntimeCommandExecution>;

/** Handles Settings commands and returns a closed outcome plus the settings
 *  projection. The host owns the snapshot merge and the settings_changed
 *  event; it publishes only when an outcome actually changes state. */
export type SettingsCommandHandler = (command: SettingsCommand) => Promise<{
  readonly outcome: SettingsCommandOutcome;
  readonly error?: string;
  readonly settings: Readonly<Record<string, RegisteredSetting>>;
}>;

/** Handles models.json catalog commands and returns a closed outcome plus
 *  the authoritative file state. The host owns the snapshot merge and the
 *  status publish on state-changing outcomes. */
export type ModelsCommandHandler = (
  command: ModelsCommand,
) => Promise<ModelsCommandResult>;

/** Live settings projection merged into every published status snapshot. */
export interface SettingsProjection {
  readonly settings: Readonly<Record<string, RegisteredSetting>>;
}

export type ApplicationCommand =
  | { readonly command: "attach" }
  | { readonly command: "quit"; readonly acknowledged: boolean }
  | {
      readonly command: "desktop_owner";
      readonly action: "claim" | "renew";
      readonly leaseId: string;
    }
  | {
      readonly command: "auto_start";
      readonly action: "status" | "enable" | "disable";
    };

export type ApplicationCommandOutcome =
  | "attached"
  | "lease_claimed"
  | "lease_renewed"
  | "drained"
  | "timed_out"
  | "conflict"
  | "ok"
  | "failed"
  | "unsupported";

export type ApplicationCommandConflictCode =
  | "quit_requires_explicit_confirmation"
  | "desktop_owner_lease_mismatch";

export interface ApplicationCommandConflict {
  readonly code: ApplicationCommandConflictCode;
  readonly message: string;
}

/** Effective Windows login auto-start registration status. */
export interface AutoStartRegistration {
  readonly enabled: boolean;
}

export interface ApplicationCommandExecution {
  readonly outcome: ApplicationCommandOutcome;
  readonly conflict?: ApplicationCommandConflict;
  readonly autoStart?: AutoStartRegistration;
  readonly error?: string;
}

export interface ApplicationCommandResult extends ApplicationCommandExecution {
  readonly command: "attach" | "desktop_owner" | "quit" | "auto_start";
  readonly snapshot: StatusSnapshot;
}

export type ApplicationCommandHandler = (
  command: ApplicationCommand,
  publishStatus: RuntimeStatusPublisher,
) => Promise<ApplicationCommandExecution>;

/** Notified after an application command result frame has been written to
 *  the requesting connection (Ticket 05): the outcome is visible to the
 *  client before the owner process tears down and exits. */
export type ApplicationCommandResultDeliveredHandler = (
  command: ApplicationCommand,
  result: ApplicationCommandResult,
) => Promise<void> | void;

export interface ControlPlaneClient {
  readonly disconnected: Promise<ControlPlaneDisconnect>;
  hello(version: number): Promise<HelloResult>;
  getStatus(): Promise<StatusSnapshot>;
  executeRuntimeCommand(command: RuntimeCommand): Promise<RuntimeCommandResult>;
  executeSettingsCommand(
    command: SettingsCommand,
  ): Promise<SettingsCommandResult>;
  executeApplicationCommand(
    command: ApplicationCommand,
  ): Promise<ApplicationCommandResult>;

  executeCredentialProfilesCommand(
    command: CredentialProfilesCommand,
  ): Promise<CredentialProfilesCommandResult>;

  executeProviderProfileAuthCommand(
    command: ProviderProfileAuthCommand,
    onInteraction?: (event: AuthInteractionEvent) => void,
  ): Promise<ProviderProfileAuthCommandResult>;

  /** Ticket 13: send a prompt response or cancellation into the one
   *  in-flight login flow of this connection. Rejects when no login is
   *  pending or the response is invalid. */
  respondAuthInteraction(response: AuthInteractionResponse): Promise<void>;

  executeModelsCommand(command: ModelsCommand): Promise<ModelsCommandResult>;
  executeCatalogCommand(command: CatalogCommand): Promise<CatalogCommandResult>;
  executePublicModelsCommand(
    command: PublicModelsCommand,
  ): Promise<PublicModelsCommandResult>;
  executeAgentIntegrationsCommand(
    command: AgentIntegrationsCommand,
  ): Promise<AgentIntegrationsCommandResult>;
  /** Ticket 21: bounded, versioned analytics aggregation over the Request
   *  Ledger, computed at query time (summary and options commands). The
   *  host result is strictly re-decoded at the client boundary. */
  getAnalytics(
    query: AnalyticsQuery,
  ): Promise<AnalyticsManagementResult>;
  queryRequestJourneys(
    query?: RequestJourneyQuery,
  ): Promise<RequestJourneyQueryReadResult>;
  getRequestJourney(
    input: RequestJourneyGetInput,
  ): Promise<RequestJourneyDetailReadResult>;
  getRequestArtifact(
    input: RequestArtifactGetInput,
  ): Promise<RequestArtifactChunkReadResult>;
  queryRuntimeEvents(
    query?: RuntimeEventQuery,
  ): Promise<RuntimeEventQueryReadResult>;
  subscribeRequestJourneys(
    listener: RequestJourneySubscriber,
  ): Promise<() => Promise<void>>;
  subscribeRuntimeEvents(
    listener: RuntimeEventSubscriber,
  ): Promise<() => Promise<void>>;
  /** Ticket 23: per-authority eligible-record counts over one history range
   *  (the preview used by export and irreversible deletion gates). */
  queryHistory(range?: HistoryRange): Promise<HistoryQueryManagementResult>;
  /** Start (or gate) one versioned unified diagnostics-history export. */
  executeHistoryExport(
    command: HistoryExportCommand,
  ): Promise<HistoryExportManagementResult>;
  /** Ticket 23: executes the single-use sensitive export confirmation. */
  confirmHistoryExport(actionId: string): Promise<HistoryExportManagementResult>;
  /** Ticket 23: gates an irreversible range/all deletion behind a count
   *  preview confirmation. */
  executeHistoryDelete(command: HistoryDeleteCommand): Promise<HistoryDeleteManagementResult>;
  /** Ticket 23: executes the single-use irreversible deletion confirmation. */
  confirmHistoryDelete(actionId: string): Promise<HistoryDeleteManagementResult>;
  /** Ticket 24: create an ordinary backup immediately or request the
   * explicit full-sensitive confirmation gate. */
  executeBackup(command: BackupCreateCommand): Promise<BackupManagementResult>;
  /** Ticket 24: execute the single-use full-sensitive backup gate. */
  confirmBackup(actionId: string): Promise<BackupManagementResult>;
  subscribe(
    listener: (event: StatusEvent) => void,
  ): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

export function assertControlPlaneEndpoint(
  endpoint: ControlPlaneEndpoint,
): void {
  if (
    endpoint.address.length === 0 ||
    endpoint.address.length > 1024 ||
    endpoint.address.includes("\0") ||
    endpoint.capability.length < 32
  ) {
    throw new Error("Invalid local Control Plane endpoint");
  }
}
