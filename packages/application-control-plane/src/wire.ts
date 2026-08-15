import {
  controlPlaneVersion,
  type ApplicationIdentity,
  type ApplicationStatus,
  type DataPlaneFailure,
  type HelloResult,
  type LanConfirmation,
  type RegisteredSetting,
  type RuntimeCommand,
  type RuntimeCommandConflict,
  type RuntimeCommandExecution,
  type RuntimeCommandResult,
  type SettingsCommand,
  type SettingsCommandResult,
  type StatusEvent,
  type StatusSnapshot,
} from "./contracts.js";

export type RecordValue = Record<string, unknown>;

export type ClientRequest =
  | {
      readonly type: "hello";
      readonly requestId: string;
      readonly contractVersion: number;
      readonly capability: string;
    }
  | { readonly type: "get_status"; readonly requestId: string }
  | {
      readonly type: "runtime_command";
      readonly requestId: string;
      readonly command: RuntimeCommand;
    }
  | {
      readonly type: "settings_command";
      readonly requestId: string;
      readonly command: SettingsCommand;
    }
  | { readonly type: "subscribe"; readonly requestId: string }
  | { readonly type: "unsubscribe"; readonly requestId: string };

export type ControlPlaneErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "hello_required"
  | "unknown_command";

export type ServerMessage =
  | {
      readonly type: "hello_result";
      readonly requestId: string;
      readonly result: HelloResult;
    }
  | {
      readonly type: "status_result";
      readonly requestId: string;
      readonly snapshot: StatusSnapshot;
    }
  | {
      readonly type: "runtime_command_result";
      readonly requestId: string;
      readonly result: RuntimeCommandResult;
    }
  | {
      readonly type: "settings_command_result";
      readonly requestId: string;
      readonly result: SettingsCommandResult;
    }
  | { readonly type: "subscribed"; readonly requestId: string }
  | { readonly type: "unsubscribed"; readonly requestId: string }
  | {
      readonly type: "error";
      readonly requestId: string;
      readonly code: ControlPlaneErrorCode;
    }
  | { readonly type: "event"; readonly event: StatusEvent };

export type DecodedClientRequest =
  | { readonly type: "valid"; readonly request: ClientRequest }
  | {
      readonly type: "invalid";
      readonly requestId: string;
      readonly code: "invalid_request" | "unknown_command";
    };

export function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeRequestId(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/u.test(value)
    ? value
    : undefined;
}

export function decodeApplicationStatus(
  value: unknown,
): ApplicationStatus | undefined {
  if (
    !isRecord(value) ||
    (value.provider !== "configured" && value.provider !== "unconfigured") ||
    (value.modelDataPlane !== "stopped" &&
      value.modelDataPlane !== "starting" &&
      value.modelDataPlane !== "running" &&
      value.modelDataPlane !== "stopping" &&
      value.modelDataPlane !== "failed")
  ) {
    return undefined;
  }
  const dataPlane = decodeDataPlaneStatus(value.dataPlane);
  if (
    (value.dataPlane !== undefined && dataPlane === undefined) ||
    (value.modelDataPlane === "failed" && dataPlane?.failure === undefined) ||
    (value.modelDataPlane !== "failed" && dataPlane?.failure !== undefined)
  ) {
    return undefined;
  }
  const settings = decodeSettingsProjection(value.settings);
  if (value.settings !== undefined && settings === undefined) {
    return undefined;
  }
  const confirmation =
    value.confirmation === undefined
      ? undefined
      : decodeLanConfirmation(value.confirmation);
  if (value.confirmation !== undefined && confirmation === undefined) {
    return undefined;
  }
  if (confirmation !== undefined && settings === undefined) {
    return undefined;
  }
  return {
    modelDataPlane: value.modelDataPlane,
    provider: value.provider,
    ...(dataPlane === undefined ? {} : { dataPlane }),
    ...(settings === undefined ? {} : { settings }),
    ...(confirmation === undefined ? {} : { confirmation }),
  };
}

function decodeRegisteredSetting(
  value: unknown,
): RegisteredSetting | undefined {
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

export function decodeSettingsProjection(
  value: unknown,
): Readonly<Record<string, RegisteredSetting>> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  const result: Record<string, RegisteredSetting> = Object.create(null);
  for (const [key, raw] of Object.entries(value)) {
    const setting = decodeRegisteredSetting(raw);
    if (setting === undefined || setting.key !== key) return undefined;
    result[key] = setting;
  }
  return Object.freeze(result);
}

function decodeLanConfirmation(value: unknown): LanConfirmation | undefined {
  if (
    !isRecord(value) ||
    typeof value.actionId !== "string" ||
    value.actionId.length === 0 ||
    value.settingKey !== "server.bindHost" ||
    typeof value.value !== "string" ||
    typeof value.message !== "string"
  ) {
    return undefined;
  }
  return Object.freeze({
    actionId: value.actionId,
    settingKey: "server.bindHost",
    value: value.value,
    message: value.message,
  });
}

function decodeSettingsCommand(value: unknown): SettingsCommand | undefined {
  if (!isRecord(value)) return undefined;
  if (value.command === "query") {
    if (value.keys === undefined) return { command: "query" };
    if (
      Array.isArray(value.keys) &&
      value.keys.every((key) => typeof key === "string")
    ) {
      return { command: "query", keys: value.keys as string[] };
    }
    return undefined;
  }
  if (value.command === "set") {
    if (typeof value.key !== "string" || value.key.length === 0) {
      return undefined;
    }
    return { command: "set", key: value.key, value: value.value };
  }
  if (value.command === "confirm") {
    if (typeof value.actionId !== "string" || value.actionId.length === 0) {
      return undefined;
    }
    return { command: "confirm", actionId: value.actionId };
  }
  return undefined;
}

export function decodeSettingsCommandResult(
  value: unknown,
): SettingsCommandResult | undefined {
  if (
    !isRecord(value) ||
    (value.outcome !== "ok" &&
      value.outcome !== "applied" &&
      value.outcome !== "pending" &&
      value.outcome !== "confirmation_required" &&
      value.outcome !== "unknown_key" &&
      value.outcome !== "invalid_value")
  ) {
    return undefined;
  }
  const settings = decodeSettingsProjection(value.settings);
  if (settings === undefined) return undefined;
  if (
    value.outcome === "confirmation_required" &&
    value.confirmation === undefined
  ) {
    return undefined;
  }
  if (value.outcome !== "confirmation_required" && value.confirmation !== undefined) {
    return undefined;
  }
  const confirmation =
    value.confirmation === undefined
      ? undefined
      : decodeLanConfirmation(value.confirmation);
  if (value.confirmation !== undefined && confirmation === undefined) {
    return undefined;
  }
  if (value.outcome === "invalid_value" && typeof value.error !== "string") {
    return undefined;
  }
  return Object.freeze({
    outcome: value.outcome,
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    ...(confirmation === undefined ? {} : { confirmation }),
    settings,
  });
}

const failureMessages: Readonly<Record<DataPlaneFailure["code"], string>> = {
  port_in_use:
    "The configured port is already in use. Stop the other application or choose a different port.",
  start_failed:
    "The model gateway could not start. Check its configured address and try again.",
  stop_failed:
    "The model gateway could not stop cleanly. Restart LuckyToken before trying again.",
};

function decodeDataPlaneFailure(value: unknown): DataPlaneFailure | undefined {
  if (
    !isRecord(value) ||
    (value.code !== "port_in_use" &&
      value.code !== "start_failed" &&
      value.code !== "stop_failed")
  ) {
    return undefined;
  }
  return { code: value.code, message: failureMessages[value.code] };
}

function decodeDataPlaneStatus(
  value: unknown,
): ApplicationStatus["dataPlane"] | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    typeof value.configuredOrigin !== "string" ||
    !Number.isSafeInteger(value.configuredPort) ||
    (value.configuredPort as number) < 0 ||
    (value.configuredPort as number) > 65_535
  ) {
    return undefined;
  }
  let origin: URL;
  try {
    origin = new URL(value.configuredOrigin);
  } catch {
    return undefined;
  }
  const originPort =
    origin.port === "" ? 80 : Number.parseInt(origin.port, 10);
  if (
    origin.protocol !== "http:" ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    originPort !== value.configuredPort
  ) {
    return undefined;
  }
  const failure = decodeDataPlaneFailure(value.failure);
  if (value.failure !== undefined && failure === undefined) return undefined;
  return {
    configuredOrigin: value.configuredOrigin,
    configuredPort: value.configuredPort as number,
    ...(failure === undefined ? {} : { failure }),
  };
}

export function decodeClientRequest(value: unknown): DecodedClientRequest {
  if (!isRecord(value)) {
    return { type: "invalid", requestId: "", code: "invalid_request" };
  }
  const requestId = decodeRequestId(value.requestId);
  if (requestId === undefined || typeof value.type !== "string") {
    return {
      type: "invalid",
      requestId: requestId ?? "",
      code: "invalid_request",
    };
  }
  if (value.type === "hello") {
    if (
      !Number.isSafeInteger(value.contractVersion) ||
      typeof value.capability !== "string"
    ) {
      return { type: "invalid", requestId, code: "invalid_request" };
    }
    return {
      type: "valid",
      request: {
        type: "hello",
        requestId,
        contractVersion: value.contractVersion as number,
        capability: value.capability,
      },
    };
  }
  if (
    value.type === "get_status" ||
    value.type === "subscribe" ||
    value.type === "unsubscribe"
  ) {
    return { type: "valid", request: { type: value.type, requestId } };
  }
  if (value.type === "runtime_command") {
    if (
      value.command !== "start" &&
      value.command !== "stop" &&
      value.command !== "restart"
    ) {
      return { type: "invalid", requestId, code: "invalid_request" };
    }
    return {
      type: "valid",
      request: { type: "runtime_command", requestId, command: value.command },
    };
  }
  if (value.type === "settings_command") {
    const command = decodeSettingsCommand(value.command);
    if (command === undefined) {
      return { type: "invalid", requestId, code: "invalid_request" };
    }
    return {
      type: "valid",
      request: {
        type: "settings_command",
        requestId,
        command,
      },
    };
  }
  return { type: "invalid", requestId, code: "unknown_command" };
}

export function compatibleHello(
  application: ApplicationIdentity,
): HelloResult {
  return {
    type: "compatible",
    application,
    contractVersion: controlPlaneVersion,
  };
}

export function incompatibleHello(requestedVersion: number): HelloResult {
  return {
    type: "incompatible",
    requestedVersion,
    supportedVersions: [controlPlaneVersion],
  };
}

export function decodeHello(value: unknown): HelloResult | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.type === "incompatible" &&
    typeof value.requestedVersion === "number" &&
    Number.isSafeInteger(value.requestedVersion) &&
    Array.isArray(value.supportedVersions) &&
    value.supportedVersions.length === 1 &&
    value.supportedVersions[0] === controlPlaneVersion
  ) {
    return {
      type: "incompatible",
      requestedVersion: value.requestedVersion,
      supportedVersions: [controlPlaneVersion],
    };
  }
  if (
    value.type === "compatible" &&
    value.contractVersion === controlPlaneVersion &&
    isRecord(value.application) &&
    value.application.id === "luckytoken" &&
    typeof value.application.version === "string"
  ) {
    return {
      type: "compatible",
      application: {
        id: "luckytoken",
        version: value.application.version,
      },
      contractVersion: controlPlaneVersion,
    };
  }
  return undefined;
}

export function decodeSnapshot(value: unknown): StatusSnapshot | undefined {
  const safeStatus = decodeApplicationStatus(value);
  const sequence = isRecord(value) ? value.sequence : undefined;
  return safeStatus !== undefined &&
    typeof sequence === "number" &&
    Number.isSafeInteger(sequence) &&
    sequence >= 0
    ? { ...safeStatus, sequence }
    : undefined;
}

export function decodeEvent(value: unknown): StatusEvent | undefined {
  if (
    !isRecord(value) ||
    value.type !== "status_changed" ||
    typeof value.sequence !== "number" ||
    !Number.isSafeInteger(value.sequence)
  ) {
    return undefined;
  }
  const snapshot = decodeSnapshot(value.snapshot);
  return snapshot !== undefined && snapshot.sequence === value.sequence
    ? {
        type: "status_changed",
        sequence: value.sequence,
        snapshot,
      }
    : undefined;
}

function decodeRuntimeCommandConflict(
  value: unknown,
): RuntimeCommandConflict | undefined {
  if (!isRecord(value)) return undefined;
  if (value.code === "restart_requires_running") {
    return {
      code: value.code,
      message: "Start the model gateway before restarting it.",
    };
  }
  if (value.code === "runtime_unavailable") {
    return {
      code: value.code,
      message: "Runtime lifecycle commands are unavailable in this application.",
    };
  }
  if (value.code === "application_restart_required") {
    return {
      code: value.code,
      message: "Restart LuckyToken before starting the model gateway again.",
    };
  }
  return undefined;
}

export function decodeRuntimeCommandExecution(
  value: unknown,
): RuntimeCommandExecution | undefined {
  if (
    !isRecord(value) ||
    (value.outcome !== "completed" &&
      value.outcome !== "unchanged" &&
      value.outcome !== "failed" &&
      value.outcome !== "conflict")
  ) {
    return undefined;
  }
  const conflict = decodeRuntimeCommandConflict(value.conflict);
  if (
    (value.outcome === "conflict" && conflict === undefined) ||
    (value.outcome !== "conflict" && value.conflict !== undefined)
  ) {
    return undefined;
  }
  return {
    outcome: value.outcome,
    ...(conflict === undefined ? {} : { conflict }),
  };
}

function decodeRuntimeCommandResult(
  value: unknown,
): RuntimeCommandResult | undefined {
  if (
    !isRecord(value) ||
    (value.command !== "start" &&
      value.command !== "stop" &&
      value.command !== "restart")
  ) {
    return undefined;
  }
  const snapshot = decodeSnapshot(value.snapshot);
  const execution = decodeRuntimeCommandExecution(value);
  if (snapshot === undefined || execution === undefined) return undefined;
  return {
    command: value.command as RuntimeCommand,
    ...execution,
    snapshot,
  };
}

export function decodeServerMessage(value: unknown): ServerMessage | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.type === "event") {
    const event = decodeEvent(value.event);
    return event === undefined ? undefined : { type: "event", event };
  }
  const requestId = decodeRequestId(value.requestId);
  if (requestId === undefined) return undefined;
  if (value.type === "hello_result") {
    const result = decodeHello(value.result);
    return result === undefined
      ? undefined
      : { type: "hello_result", requestId, result };
  }
  if (value.type === "status_result") {
    const snapshot = decodeSnapshot(value.snapshot);
    return snapshot === undefined
      ? undefined
      : { type: "status_result", requestId, snapshot };
  }
  if (value.type === "runtime_command_result") {
    const result = decodeRuntimeCommandResult(value.result);
    return result === undefined
      ? undefined
      : { type: "runtime_command_result", requestId, result };
  }
  if (value.type === "settings_command_result") {
    const result = decodeSettingsCommandResult(value.result);
    return result === undefined
      ? undefined
      : { type: "settings_command_result", requestId, result };
  }
  if (value.type === "subscribed" || value.type === "unsubscribed") {
    return { type: value.type, requestId };
  }
  if (
    value.type === "error" &&
    (value.code === "invalid_request" ||
      value.code === "unauthorized" ||
      value.code === "hello_required" ||
      value.code === "unknown_command")
  ) {
    return { type: "error", requestId, code: value.code };
  }
  return undefined;
}
