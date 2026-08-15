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

export interface ControlPlaneClient {
  readonly disconnected: Promise<ControlPlaneDisconnect>;
  hello(version: number): Promise<HelloResult>;
  getStatus(): Promise<StatusSnapshot>;
  executeRuntimeCommand(command: RuntimeCommand): Promise<RuntimeCommandResult>;
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
