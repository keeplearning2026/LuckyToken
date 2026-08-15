export {
  controlPlaneVersion,
  type ApplicationIdentity,
  type ApplicationStatus,
  type DataPlaneFailure,
  type DataPlaneFailureCode,
  type DataPlaneStatus,
  type ControlPlaneClient,
  type ControlPlaneDisconnect,
  type ControlPlaneEndpoint,
  type HelloResult,
  type RunningControlPlane,
  type RuntimeCommand,
  type RuntimeCommandConflict,
  type RuntimeCommandConflictCode,
  type RuntimeCommandExecution,
  type RuntimeCommandHandler,
  type RuntimeCommandOutcome,
  type RuntimeCommandResult,
  type RuntimeStatusPublisher,
  type StatusEvent,
  type StatusSnapshot,
} from "./contracts.js";
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
