import type {
  ModelsCommandResult,
  ModelsFileError,
  ModelsProjection,
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
  /** Full models.json catalog result from a models command (Ticket 08). */
  readonly models?: ModelsCommandResult;
}

export interface ConnectedControlPlaneState extends StatusSnapshot {
  readonly revision: number;
  readonly kind: "connected";
  readonly applicationVersion: string;
  readonly contractVersion: 1;
  /** Latest full models.json catalog result (raw editor content, parsed
   *  providers, revision, errors); present after a models command. */
  readonly modelsResult?: ModelsCommandResult;
  /** Sanitized models.json projection from the status snapshot (Ticket 08). */
  readonly modelsProjection?: ModelsProjection;
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

const modelsErrorKinds: ReadonlySet<string> = new Set([
  "parse",
  "schema",
  "load",
  "storage",
]);

function decodeModelsFileError(value: unknown): ModelsFileError | undefined {
  if (
    !isRecord(value) ||
    typeof value.kind !== "string" ||
    !modelsErrorKinds.has(value.kind) ||
    typeof value.message !== "string" ||
    value.message.length === 0
  ) {
    return undefined;
  }
  const location = decodeModelsErrorLocation(value.location);
  if (value.location !== undefined && location === undefined) {
    return undefined;
  }
  return Object.freeze({
    kind: value.kind as ModelsFileError["kind"],
    message: value.message,
    ...(location === undefined ? {} : { location }),
  });
}

function decodeModelsErrorLocation(value: unknown): {
  readonly line: number;
  readonly column: number;
  readonly position?: number;
} | undefined {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.line) ||
    (value.line as number) < 1 ||
    !Number.isSafeInteger(value.column) ||
    (value.column as number) < 1
  ) {
    return undefined;
  }
  const position = value.position;
  if (
    position !== undefined &&
    (typeof position !== "number" || !Number.isSafeInteger(position))
  ) {
    return undefined;
  }
  return Object.freeze({
    line: value.line as number,
    column: value.column as number,
    ...(position === undefined ? {} : { position: position as number }),
  });
}

/**
 * Strict structural decode of the full models.json catalog result crossing
 * the bridge; the renderer keeps only value-free errors and exact bytes.
 *
 * Boundary decision: this decoder is deliberately independent from the
 * Control Plane package's wire decoders — the bridge is a trust boundary and
 * the renderer validates defensively — but it is kept aligned with the wire
 * validation rules so both sides accept and reject the same shapes. Any
 * divergence must be covered by focused tests on both sides.
 */
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
  const state = value.state;
  if (
    !isRecord(state) ||
    !Number.isSafeInteger(state.revision) ||
    (state.revision as number) < 0 ||
    typeof state.path !== "string" ||
    state.path.length === 0 ||
    typeof state.present !== "boolean" ||
    typeof state.valid !== "boolean" ||
    typeof state.raw !== "string"
  ) {
    return undefined;
  }
  const error = decodeModelsFileError(state.error);
  if (state.error !== undefined && error === undefined) return undefined;
  if (state.valid && error !== undefined) return undefined;
  const providers = state.providers;
  if (providers !== undefined && !isRecord(providers)) return undefined;
  if (!state.present && providers !== undefined) return undefined;
  if (providers !== undefined && !state.valid) return undefined;
  if (providers === undefined && state.present && state.valid) {
    return undefined;
  }
  const commandError = decodeModelsFileError(value.error);
  if (value.error !== undefined && commandError === undefined) {
    return undefined;
  }
  if (value.outcome === "invalid") {
    if (commandError === undefined) return undefined;
  }
  if (value.outcome === "storage_failure") {
    if (commandError === undefined || commandError.kind !== "storage") {
      return undefined;
    }
  }
  if (value.outcome !== "invalid" && value.outcome !== "storage_failure") {
    if (commandError !== undefined) return undefined;
  }
  return Object.freeze({
    outcome: value.outcome as ModelsCommandResult["outcome"],
    state: Object.freeze({
      revision: state.revision as number,
      path: state.path,
      present: state.present,
      valid: state.valid,
      raw: state.raw,
      ...(providers === undefined ? {} : { providers }),
      ...(error === undefined ? {} : { error }),
    }),
    ...(commandError === undefined ? {} : { error: commandError }),
  });
}

/** Sanitized models.json projection from the status snapshot: revision,
 *  location, presence, validity and value-free error — never content. */
export function decodeModelsProjection(
  value: unknown,
): ModelsProjection | undefined {
  if (
    !isRecord(value) ||
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
    const modelsProjection =
      payload.snapshot.models === undefined
        ? undefined
        : decodeModelsProjection(payload.snapshot.models);
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
      ...(modelsProjection === undefined ? {} : { modelsProjection }),
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
