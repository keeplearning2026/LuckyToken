import type { StatusSnapshot } from "@luckytoken/application-control-plane/control-plane";

export interface ConnectedControlPlaneBridgePayload
  extends Readonly<Record<string, unknown>> {
  readonly revision: number;
  readonly connection: "connected";
  readonly applicationVersion: string;
  readonly contractVersion: 1;
  readonly snapshot: StatusSnapshot & Readonly<Record<string, unknown>>;
}

export interface ConnectedControlPlaneState extends StatusSnapshot {
  readonly revision: number;
  readonly kind: "connected";
  readonly applicationVersion: string;
  readonly contractVersion: 1;
}

export interface VersionMismatchBridgePayload
  extends Readonly<Record<string, unknown>> {
  readonly revision: number;
  readonly connection: "version_mismatch";
  readonly requestedVersion: number;
  readonly supportedVersions: readonly number[];
}

export type ControlPlaneUnavailableReason =
  | "descriptor_missing"
  | "descriptor_invalid"
  | "pipe_unavailable"
  | "protocol_error";

export interface UnavailableBridgePayload
  extends Readonly<Record<string, unknown>> {
  readonly revision: number;
  readonly connection: "unavailable";
  readonly reason: ControlPlaneUnavailableReason;
}

export interface DisconnectedBridgePayload
  extends Readonly<Record<string, unknown>> {
  readonly revision: number;
  readonly connection: "disconnected";
  readonly reason: "transport_lost";
}

export type ControlPlaneBridgePayload =
  | ConnectedControlPlaneBridgePayload
  | VersionMismatchBridgePayload
  | UnavailableBridgePayload
  | DisconnectedBridgePayload;

export interface ControlPlaneErrorState {
  readonly revision: number;
  readonly kind: "error";
  readonly code:
    | "version_mismatch"
    | ControlPlaneUnavailableReason
    | "transport_lost";
  readonly title: string;
  readonly detail: string;
  readonly action: string;
}

export type ControlPlaneState =
  | ConnectedControlPlaneState
  | ControlPlaneErrorState;

const unavailableCopy: Readonly<
  Record<
    ControlPlaneUnavailableReason,
    Omit<ControlPlaneErrorState, "revision" | "kind" | "code">
  >
> = {
  descriptor_missing: {
    title: "LuckyToken backend is not available",
    detail: "No active local Control Plane was found.",
    action: "Start LuckyToken, then reconnect.",
  },
  descriptor_invalid: {
    title: "LuckyToken connection information is invalid",
    detail: "The local Control Plane descriptor could not be validated.",
    action: "Restart LuckyToken, then reconnect.",
  },
  pipe_unavailable: {
    title: "LuckyToken backend is not reachable",
    detail: "The active local Control Plane could not be opened.",
    action: "Restart LuckyToken, then reconnect.",
  },
  protocol_error: {
    title: "LuckyToken connection failed",
    detail: "The local Control Plane returned an invalid response.",
    action: "Restart LuckyToken; update it if the problem continues.",
  },
};

export function projectControlPlaneState(
  payload: ControlPlaneBridgePayload,
): ControlPlaneState {
  if (payload.connection === "connected") {
    const dataPlane = payload.snapshot.dataPlane;
    return Object.freeze({
      revision: payload.revision,
      kind: "connected",
      applicationVersion: payload.applicationVersion,
      contractVersion: payload.contractVersion,
      sequence: payload.snapshot.sequence,
      modelDataPlane: payload.snapshot.modelDataPlane,
      provider: payload.snapshot.provider,
      ...(dataPlane === undefined
        ? {}
        : {
            dataPlane: Object.freeze({
              configuredOrigin: dataPlane.configuredOrigin,
              configuredPort: dataPlane.configuredPort,
              ...(dataPlane.failure === undefined
                ? {}
                : {
                    failure: Object.freeze({
                      code: dataPlane.failure.code,
                      message:
                        dataPlaneFailureCopy[dataPlane.failure.code],
                    }),
                  }),
            }),
          }),
    });
  }
  if (payload.connection === "version_mismatch") {
    const supported = payload.supportedVersions.join(", ");
    return Object.freeze({
      revision: payload.revision,
      kind: "error",
      code: "version_mismatch",
      title: "Desktop update required",
      detail: `This desktop supports Control Plane v${payload.requestedVersion}; the active backend supports v${supported}.`,
      action: "Install matching LuckyToken desktop and backend versions.",
    });
  }
  if (payload.connection === "disconnected") {
    return Object.freeze({
      revision: payload.revision,
      kind: "error",
      code: "transport_lost",
      title: "Connection to LuckyToken was lost",
      detail: "The active local Control Plane disconnected.",
      action: "Restart LuckyToken, then reconnect.",
    });
  }
  return Object.freeze({
    revision: payload.revision,
    kind: "error",
    code: payload.reason,
    ...unavailableCopy[payload.reason],
  });
}

const dataPlaneFailureCopy = {
  port_in_use:
    "The configured port is already in use. Stop the other application or choose a different port.",
  start_failed:
    "The model gateway could not start. Check its configured address and try again.",
  stop_failed:
    "The model gateway could not stop cleanly. Restart LuckyToken before trying again.",
} as const;
