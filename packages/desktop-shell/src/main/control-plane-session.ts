import {
  connectControlPlane,
  controlPlaneVersion,
  createNodePipeTransport,
  type ApplicationIdentity,
  type ControlPlaneClient,
  type ControlPlaneEndpoint,
  type StatusSnapshot,
} from "@luckytoken/application-control-plane/control-plane";
import { randomUUID } from "node:crypto";

export type TrayHealth = "ready" | "starting" | "attention" | "stopped";

export type MainControlPlaneState =
  | { readonly kind: "idle" }
  | { readonly kind: "connecting" }
  | { readonly kind: "reconnecting" }
  | { readonly kind: "ready"; readonly status: StatusSnapshot }
  | { readonly kind: "unavailable" };

export interface ControlPlaneSessionDependencies {
  readonly connect: (endpoint: ControlPlaneEndpoint) => Promise<ControlPlaneClient>;
}

export interface ControlPlaneSession {
  connect(endpoint: ControlPlaneEndpoint): Promise<StatusSnapshot>;
  reconnect(endpoint: ControlPlaneEndpoint): Promise<StatusSnapshot>;
  client(): ControlPlaneClient;
  application(): ApplicationIdentity;
  state(): MainControlPlaneState;
  trayHealth(): TrayHealth;
  subscribeState(listener: (state: MainControlPlaneState) => void): () => void;
  dispose(): Promise<void>;
}

function deriveTrayHealth(state: MainControlPlaneState): TrayHealth {
  if (state.kind === "connecting" || state.kind === "reconnecting") return "starting";
  if (state.kind === "idle" || state.kind === "unavailable") return "attention";
  if (state.status.attention?.conditions.length) return "attention";
  switch (state.status.modelDataPlane) {
    case "running":
      return "ready";
    case "starting":
    case "stopping":
      return "starting";
    case "failed":
      return "attention";
    case "stopped":
      return "stopped";
  }
}

export function createControlPlaneSession(
  dependencies: ControlPlaneSessionDependencies,
): ControlPlaneSession {
  let currentState: MainControlPlaneState = Object.freeze({ kind: "idle" });
  let currentClient: ControlPlaneClient | undefined;
  let currentApplication: ApplicationIdentity | undefined;
  let unsubscribeStatus: (() => Promise<void>) | undefined;
  let generation = 0;
  const listeners = new Set<(state: MainControlPlaneState) => void>();

  const publish = (state: MainControlPlaneState): void => {
    currentState = state;
    for (const listener of listeners) listener(state);
  };

  const releaseCurrent = async (): Promise<void> => {
    const unsubscribe = unsubscribeStatus;
    unsubscribeStatus = undefined;
    const client = currentClient;
    currentClient = undefined;
    currentApplication = undefined;
    await unsubscribe?.().catch(() => undefined);
    await client?.close().catch(() => undefined);
  };

  const establish = async (
    endpoint: ControlPlaneEndpoint,
    reconnecting: boolean,
  ): Promise<StatusSnapshot> => {
    const myGeneration = ++generation;
    publish(Object.freeze({ kind: reconnecting ? "reconnecting" : "connecting" }));
    await releaseCurrent();
    const client = await dependencies.connect(endpoint);
    currentClient = client;
    try {
      const hello = await client.hello(controlPlaneVersion);
      if (hello.type !== "compatible") {
        throw new Error("LuckyToken Control Plane version is incompatible");
      }
      currentApplication = hello.application;
      let latest: StatusSnapshot | undefined;
      unsubscribeStatus = await client.subscribe((event) => {
        if (myGeneration !== generation) return;
        if (latest === undefined || event.snapshot.sequence >= latest.sequence) {
          latest = event.snapshot;
          publish(Object.freeze({ kind: "ready", status: latest }));
        }
      });
      const snapshot = await client.getStatus();
      if (myGeneration !== generation) {
        throw new Error("LuckyToken Control Plane connection was replaced");
      }
      if (latest === undefined || snapshot.sequence >= latest.sequence) latest = snapshot;
      publish(Object.freeze({ kind: "ready", status: latest }));

      void client.disconnected.then((disconnect) => {
        if (myGeneration !== generation || disconnect.reason === "closed") return;
        currentClient = undefined;
        currentApplication = undefined;
        unsubscribeStatus = undefined;
        publish(Object.freeze({ kind: "unavailable" }));
      });
      return latest;
    } catch (error) {
      if (myGeneration === generation) {
        await releaseCurrent();
        publish(Object.freeze({ kind: "unavailable" }));
      }
      throw error;
    }
  };

  return Object.freeze({
    connect: (endpoint: ControlPlaneEndpoint) => establish(endpoint, false),
    reconnect: (endpoint: ControlPlaneEndpoint) => establish(endpoint, true),
    client(): ControlPlaneClient {
      if (currentClient === undefined || currentState.kind !== "ready") {
        throw new Error("LuckyToken Control Plane is unavailable");
      }
      return currentClient;
    },
    application(): ApplicationIdentity {
      if (currentApplication === undefined || currentState.kind !== "ready") {
        throw new Error("LuckyToken Control Plane is unavailable");
      }
      return currentApplication;
    },
    state: () => currentState,
    trayHealth: () => deriveTrayHealth(currentState),
    subscribeState(listener: (state: MainControlPlaneState) => void) {
      listeners.add(listener);
      listener(currentState);
      return () => listeners.delete(listener);
    },
    async dispose(): Promise<void> {
      generation += 1;
      await releaseCurrent();
      publish(Object.freeze({ kind: "idle" }));
      listeners.clear();
    },
  });
}

export function createMainControlPlaneSession(): ControlPlaneSession {
  return createControlPlaneSession({
    connect: (endpoint) =>
      connectControlPlane(endpoint, {
        createRequestId: randomUUID,
        pipeConnector: createNodePipeTransport(),
      }),
  });
}
