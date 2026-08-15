export const controlPlaneVersion = 1 as const;

export interface ApplicationIdentity {
  readonly id: "luckytoken";
  readonly version: string;
}

export interface ApplicationStatus {
  readonly modelDataPlane: "stopped" | "running" | "stopping";
  readonly provider: "configured" | "unconfigured";
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

export interface ControlPlaneClient {
  readonly disconnected: Promise<ControlPlaneDisconnect>;
  hello(version: number): Promise<HelloResult>;
  getStatus(): Promise<StatusSnapshot>;
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
