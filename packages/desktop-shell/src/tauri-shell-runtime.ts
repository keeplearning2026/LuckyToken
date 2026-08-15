import type { Event } from "@tauri-apps/api/event";
import type {
  RuntimeCommand,
  SettingsCommand,
} from "@luckytoken/application-control-plane/control-plane";

import {
  projectControlPlaneState,
  type ControlPlaneBridgePayload,
  type ControlPlaneState,
} from "./control-plane-projection.js";

export type ShellCommand =
  | "shell_snapshot"
  | "shell_retry"
  | "shell_start"
  | "shell_stop"
  | "shell_restart"
  | "shell_settings_query"
  | "shell_settings_set"
  | "shell_settings_confirm";

export interface NativeTauriBridge {
  invoke(command: ShellCommand, args?: never): Promise<unknown>;
  listen(
    event: "luckytoken://shell-state",
    listener: (event: Pick<Event<ControlPlaneBridgePayload>, "payload">) => void,
  ): Promise<() => void>;
}

export interface TauriDesktopRuntime {
  connectControlPlane(): Promise<ControlPlaneState>;
  retryControlPlane(): Promise<ControlPlaneState>;
  executeRuntimeCommand(command: RuntimeCommand): Promise<ControlPlaneState>;
  executeSettingsCommand(command: SettingsCommand): Promise<ControlPlaneState>;
  disconnectControlPlane(): Promise<void>;
  subscribeControlPlane(
    listener: (state: ControlPlaneState) => void,
  ): () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const dataPlaneFailureMessages = {
  port_in_use:
    "The configured port is already in use. Stop the other application or choose a different port.",
  start_failed:
    "The model gateway could not start. Check its configured address and try again.",
  stop_failed:
    "The model gateway could not stop cleanly. Restart LuckyToken before trying again.",
} as const;

function decodeDataPlaneStatus(value: unknown) {
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
  if (
    origin.protocol !== "http:" ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    (origin.port === "" ? 80 : Number.parseInt(origin.port, 10)) !==
      value.configuredPort
  ) {
    return undefined;
  }
  let failure:
    | {
        readonly code: keyof typeof dataPlaneFailureMessages;
        readonly message: string;
      }
    | undefined;
  if (value.failure !== undefined) {
    if (
      !isRecord(value.failure) ||
      (value.failure.code !== "port_in_use" &&
        value.failure.code !== "start_failed" &&
        value.failure.code !== "stop_failed")
    ) {
      return undefined;
    }
    failure = {
      code: value.failure.code,
      message: dataPlaneFailureMessages[value.failure.code],
    };
  }
  return {
    configuredOrigin: value.configuredOrigin,
    configuredPort: value.configuredPort as number,
    ...(failure === undefined ? {} : { failure }),
  };
}

function decodeBridgePayload(value: unknown): ControlPlaneBridgePayload | undefined {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0
  ) {
    return undefined;
  }
  const revision = value.revision as number;
  if (value.connection === "connected") {
    const snapshot = value.snapshot;
    if (
      value.contractVersion !== 1 ||
      typeof value.applicationVersion !== "string" ||
      !isRecord(snapshot) ||
      !Number.isSafeInteger(snapshot.sequence) ||
      (snapshot.sequence as number) < 0 ||
      (snapshot.modelDataPlane !== "stopped" &&
        snapshot.modelDataPlane !== "starting" &&
        snapshot.modelDataPlane !== "running" &&
        snapshot.modelDataPlane !== "stopping" &&
        snapshot.modelDataPlane !== "failed") ||
      (snapshot.provider !== "configured" &&
        snapshot.provider !== "unconfigured")
    ) {
      return undefined;
    }
    const dataPlane =
      snapshot.dataPlane === undefined
        ? undefined
        : decodeDataPlaneStatus(snapshot.dataPlane);
    if (
      (snapshot.dataPlane !== undefined && dataPlane === undefined) ||
      (snapshot.modelDataPlane === "failed" &&
        dataPlane?.failure === undefined) ||
      (snapshot.modelDataPlane !== "failed" && dataPlane?.failure !== undefined)
    ) {
      return undefined;
    }
    return {
      revision,
      connection: "connected",
      applicationVersion: value.applicationVersion,
      contractVersion: 1,
      snapshot: {
        sequence: snapshot.sequence as number,
        modelDataPlane: snapshot.modelDataPlane,
        provider: snapshot.provider,
        ...(dataPlane === undefined ? {} : { dataPlane }),
      },
    };
  }
  if (
    value.connection === "version_mismatch" &&
    Number.isSafeInteger(value.requestedVersion) &&
    Array.isArray(value.supportedVersions) &&
    value.supportedVersions.every(Number.isSafeInteger)
  ) {
    return {
      revision,
      connection: "version_mismatch",
      requestedVersion: value.requestedVersion as number,
      supportedVersions: value.supportedVersions as number[],
    };
  }
  if (
    value.connection === "unavailable" &&
    (value.reason === "descriptor_missing" ||
      value.reason === "descriptor_invalid" ||
      value.reason === "pipe_unavailable" ||
      value.reason === "protocol_error")
  ) {
    return { revision, connection: "unavailable", reason: value.reason };
  }
  if (
    value.connection === "disconnected" &&
    value.reason === "transport_lost"
  ) {
    return { revision, connection: "disconnected", reason: value.reason };
  }
  return undefined;
}

export function createTauriDesktopRuntime(
  bridge: NativeTauriBridge,
): TauriDesktopRuntime {
  let latest: ControlPlaneState | undefined;
  let listenTask: Promise<void> | undefined;
  let unlisten: (() => void) | undefined;
  const subscribers = new Set<(state: ControlPlaneState) => void>();

  const accept = (raw: unknown): ControlPlaneState => {
    const payload = decodeBridgePayload(raw) ?? {
      revision: (latest?.revision ?? -1) + 1,
      connection: "unavailable" as const,
      reason: "protocol_error" as const,
    };
    if (latest !== undefined && payload.revision <= latest.revision) {
      return latest;
    }
    latest = projectControlPlaneState(payload);
    for (const subscriber of subscribers) subscriber(latest);
    return latest;
  };

  const ensureListening = async (): Promise<void> => {
    listenTask ??= bridge
      .listen("luckytoken://shell-state", (event) => {
        accept(event.payload);
      })
      .then((stop) => {
        unlisten = stop;
      });
    await listenTask;
  };

  const invokeState = async (command: ShellCommand): Promise<ControlPlaneState> => {
    await ensureListening();
    return accept(await bridge.invoke(command));
  };

  return {
    connectControlPlane: () => invokeState("shell_snapshot"),
    retryControlPlane: () => invokeState("shell_retry"),
    executeRuntimeCommand: (command) =>
      invokeState(
        command === "start"
          ? "shell_start"
          : command === "stop"
            ? "shell_stop"
            : "shell_restart",
      ),
    executeSettingsCommand: (command) =>
      invokeState(
        command.command === "query"
          ? "shell_settings_query"
          : command.command === "set"
            ? "shell_settings_set"
            : "shell_settings_confirm",
      ),
    async disconnectControlPlane() {
      await listenTask;
      unlisten?.();
      unlisten = undefined;
    },
    subscribeControlPlane(listener) {
      subscribers.add(listener);
      if (latest !== undefined) listener(latest);
      return () => subscribers.delete(listener);
    },
  };
}
