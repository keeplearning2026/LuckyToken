import type {
  RuntimeDiagnosticEvent,
  RuntimeDiagnosticQuery,
  RuntimeDiagnosticsQueryResult,
} from "./diagnostics-contract.js";

export const controlPlaneVersion = 1 as const;

export interface ApplicationIdentity {
  readonly id: "luckytoken";
  readonly version: string;
}

export interface ApplicationStatus {
  readonly modelDataPlane:
    | "stopped"
    | "starting"
    | "running"
    | "stopping"
    | "failed";
  readonly provider: "configured" | "unconfigured";
  readonly dataPlane?: DataPlaneStatus;
}

export type DataPlaneFailureCode =
  | "port_in_use"
  | "start_failed"
  | "stop_failed";

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
  /** Present only while a non-loopback bind action waits for confirmation. */
  readonly confirmation?: LanConfirmation;
  /** Optional sanitized models.json projection (Ticket 08). */
  readonly models?: ModelsProjection;
}

/** Registered setting: type, default, validation, sensitivity, and apply mode
 *  are declared by the backend's authoritative catalog; values are typed and
 *  validated. Restart-required settings also report the effective value. */
export interface RegisteredSetting {
  readonly key: string;
  readonly type: "boolean" | "number" | "string";
  readonly default: boolean | number | string;
  readonly validation: unknown;
  readonly sensitivity: "public" | "secret";
  readonly applyMode: "hot-apply" | "restart-required";
  readonly value: boolean | number | string;
  readonly effective?: boolean | number | string;
}

export interface LanConfirmation {
  readonly actionId: string;
  readonly settingKey: "server.bindHost";
  readonly value: string;
  readonly message: string;
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
 *  for the structured editor and carries provider/model extension fields. */
export interface ModelsFileState {
  readonly revision: number;
  readonly path: string;
  readonly present: boolean;
  readonly valid: boolean;
  readonly raw: string;
  readonly providers?: Readonly<Record<string, unknown>>;
  readonly error?: ModelsFileError;
}

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
  | "ok"
  | "conflict"
  | "invalid"
  | "storage_failure";

export interface ModelsCommandResult {
  readonly outcome: ModelsCommandOutcome;
  /** The authoritative state after the attempt (current revision). */
  readonly state: ModelsFileState;
  /** Value-free failure detail: the rejected proposal's validation error
   *  (`invalid`) or the sanitized storage fault (`storage_failure`). */
  readonly error?: ModelsFileError;
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
    }
  | {
      readonly command: "confirm";
      readonly actionId: string;
    };

export type SettingsCommandOutcome =
  | "ok"
  | "applied"
  | "pending"
  | "confirmation_required"
  | "unknown_key"
  | "invalid_value";

export interface SettingsCommandResult {
  readonly outcome: SettingsCommandOutcome;
  readonly error?: string;
  readonly confirmation?: LanConfirmation;
  readonly settings: Readonly<Record<string, RegisteredSetting>>;
}

export interface StatusEvent {
  readonly type: "status_changed";
  readonly sequence: number;
  readonly snapshot: StatusSnapshot;
}

export interface ControlPlaneEndpoint {
  readonly pipeName: string;
  readonly capability: string;
}

export type {
  ControlPlaneDiagnostics,
  RuntimeDiagnosticDraft,
  RuntimeDiagnosticEvent,
  RuntimeDiagnosticLevel,
  RuntimeDiagnosticMessage,
  RuntimeDiagnosticQuery,
  RuntimeDiagnosticRecord,
  RuntimeDiagnosticsQueryResult,
  RuntimeDiagnosticsStore,
  RuntimeDiagnosticsStoreFactory,
} from "./diagnostics-contract.js";

export type HelloResult =
  | {
      readonly type: "compatible";
      readonly application: ApplicationIdentity;
      readonly contractVersion: 1;
    }
  | {
      readonly type: "incompatible";
      readonly requestedVersion: number;
      readonly supportedVersions: readonly [1];
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
  | "completed"
  | "unchanged"
  | "failed"
  | "conflict";

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
export type SettingsCommandHandler = (
  command: SettingsCommand,
) => Promise<{
  readonly outcome: SettingsCommandOutcome;
  readonly error?: string;
  readonly confirmation?: LanConfirmation;
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
  readonly confirmation?: LanConfirmation;
}

export interface ControlPlaneClient {
  readonly disconnected: Promise<ControlPlaneDisconnect>;
  hello(version: number): Promise<HelloResult>;
  getStatus(): Promise<StatusSnapshot>;
  executeRuntimeCommand(command: RuntimeCommand): Promise<RuntimeCommandResult>;
  executeSettingsCommand(command: SettingsCommand): Promise<SettingsCommandResult>;
  executeModelsCommand(command: ModelsCommand): Promise<ModelsCommandResult>;
  getDiagnostics(
    query?: RuntimeDiagnosticQuery,
  ): Promise<RuntimeDiagnosticsQueryResult>;
  subscribeDiagnostics(
    listener: (event: RuntimeDiagnosticEvent) => void,
  ): Promise<() => Promise<void>>;
  subscribe(
    listener: (event: StatusEvent) => void,
  ): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

export function assertControlPlaneEndpoint(
  endpoint: ControlPlaneEndpoint,
): void {
  if (
    !endpoint.pipeName.startsWith("\\\\.\\pipe\\") ||
    endpoint.pipeName.length <= "\\\\.\\pipe\\".length ||
    endpoint.capability.length < 32
  ) {
    throw new Error("Invalid local Control Plane endpoint");
  }
}
