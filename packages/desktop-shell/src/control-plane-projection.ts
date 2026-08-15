import type {
  RegisteredSetting,
  StatusSnapshot,
} from "@luckytoken/application-control-plane/control-plane";

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

/** Registered settings allowlist projected into renderer state. Only fields
 *  registered in the backend catalog reach the renderer; unregistered keys,
 *  ambient internal variables, and secrets never appear. */
export type RendererRegisteredSetting = RegisteredSetting;

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

function decodeRendererSetting(
  value: unknown,
): RendererRegisteredSetting | undefined {
  if (
    !isRecord(value) ||
    typeof value.key !== "string" ||
    (value.type !== "boolean" && value.type !== "number" && value.type !== "string") ||
    (typeof value.default !== "boolean" &&
      typeof value.default !== "number" &&
      typeof value.default !== "string") ||
    (value.sensitivity !== "public" && value.sensitivity !== "secret") ||
    (value.applyMode !== "hot-apply" && value.applyMode !== "restart-required") ||
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Developer Lab exposes only the settings the product UI actively renders.
 *  Unknown keys, ambient internal variables, unregistered experimental flags,
 *  and secret values never reach the renderer. */
const rendererSettingKeys: ReadonlySet<string> = new Set([
  "protocols.anthropic-messages.enabled",
  "protocols.openai-responses.enabled",
  "server.port",
  "server.bindHost",
]);

function projectSettings(
  raw: unknown,
): Readonly<Record<string, RendererRegisteredSetting>> | undefined {
  if (!isRecord(raw)) return undefined;
  const result: Record<string, RendererRegisteredSetting> = Object.create(null);
  for (const [key, value] of Object.entries(raw)) {
    if (!rendererSettingKeys.has(key)) continue;
    const setting = decodeRendererSetting(value);
    if (setting === undefined || setting.key !== key) continue;
    if (setting.sensitivity !== "public") continue;
    result[key] = setting;
  }
  return Object.freeze(result);
}

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
    const settings = projectSettings(payload.snapshot.settings);
    const confirmation = payload.snapshot.confirmation;
    const projectedConfirmation =
      confirmation === undefined ||
      !isRecord(confirmation) ||
      typeof confirmation.actionId !== "string" ||
      confirmation.actionId.length === 0 ||
      confirmation.settingKey !== "server.bindHost" ||
      typeof confirmation.value !== "string" ||
      typeof confirmation.message !== "string"
        ? undefined
        : Object.freeze({
            actionId: confirmation.actionId,
            settingKey: "server.bindHost" as const,
            value: confirmation.value,
            message: confirmation.message,
          });
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
      ...(settings === undefined ? {} : { settings }),
      ...(projectedConfirmation === undefined
        ? {}
        : { confirmation: projectedConfirmation }),
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
