import type { Event } from "@tauri-apps/api/event";

import {
  projectControlPlaneState,
  type ControlPlaneBridgePayload,
  type ControlPlaneState,
} from "./control-plane-projection.js";

export type ShellCommand = "shell_snapshot" | "shell_retry";

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
  disconnectControlPlane(): Promise<void>;
  subscribeControlPlane(
    listener: (state: ControlPlaneState) => void,
  ): () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
        snapshot.modelDataPlane !== "running" &&
        snapshot.modelDataPlane !== "stopping") ||
      (snapshot.provider !== "configured" &&
        snapshot.provider !== "unconfigured")
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
