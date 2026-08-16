export {
  controlPlaneVersion,
  type ApplicationIdentity,
  type ApplicationStatus,
  type ControlPlaneDiagnostics,
  type ControlPlaneClient,
  type ControlPlaneDisconnect,
  type ControlPlaneEndpoint,
  type DataPlaneFailure,
  type DataPlaneFailureCode,
  type DataPlaneStatus,
  type HelloResult,
  type LanConfirmation,
  type RegisteredSetting,
  type RunningControlPlane,
  type RuntimeCommand,
  type RuntimeCommandConflict,
  type RuntimeCommandConflictCode,
  type RuntimeCommandExecution,
  type RuntimeCommandHandler,
  type RuntimeCommandOutcome,
  type RuntimeCommandResult,
  type RuntimeStatusPublisher,
  type SettingsCommand,
  type SettingsCommandHandler,
  type SettingsCommandOutcome,
  type SettingsCommandResult,
  type SettingsProjection,
  type StatusEvent,
  type StatusSnapshot,
  type RuntimeDiagnosticDraft,
  type RuntimeDiagnosticEvent,
  type RuntimeDiagnosticLevel,
  type RuntimeDiagnosticMessage,
  type RuntimeDiagnosticQuery,
  type RuntimeDiagnosticRecord,
  type RuntimeDiagnosticsQueryResult,
  type RuntimeDiagnosticsStore,
  type RuntimeDiagnosticsStoreFactory,
} from "./contracts.js";
export {
  RUNTIME_DIAGNOSTIC_LEVELS,
  RUNTIME_DIAGNOSTIC_SEVERITY,
  assertRuntimeDiagnosticLevel,
  severityAtLeast,
  normalizeDiagnosticQuery,
} from "./diagnostics-contract.js";
export {
  nodePipeFallbackAccess,
  type PipeAccessRequirement,
  type PipeConnection,
  type PipeConnector,
  type PipeSecurityPolicy,
  type PipeServer,
  type PipeServerFactory,
  type PipeTransport,
} from "./pipe-transport.js";
export { createNodePipeTransport } from "./node-pipe-transport.js";

import {
  connectApplicationControlPlane,
  type ControlPlaneClientDependencies,
} from "./client.js";
import {
  startApplicationStatusHost,
  type StartControlPlaneOptions,
} from "./application-status-host.js";

export type ControlPlaneDependencies = ControlPlaneClientDependencies;

export const connectControlPlane = connectApplicationControlPlane;
export const startControlPlane = startApplicationStatusHost;
export type { StartControlPlaneOptions };
