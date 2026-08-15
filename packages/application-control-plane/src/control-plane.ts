export {
  controlPlaneVersion,
  type ApplicationIdentity,
  type ApplicationStatus,
  type ControlPlaneClient,
  type ControlPlaneDisconnect,
  type ControlPlaneEndpoint,
  type HelloResult,
  type RunningControlPlane,
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
