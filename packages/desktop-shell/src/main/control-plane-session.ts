import {
  connectControlPlane,
  controlPlaneVersion,
  createNodePipeTransport,
  type ApplicationIdentity,
  type ControlPlaneClient,
  type ControlPlaneEndpoint,
  type StatusSnapshot,
} from "@token/application-control-plane/control-plane";
import { randomUUID } from "node:crypto";
import type { DesktopBackendState } from "../shared/desktop-api.js";

export type TrayHealth = "ready" | "starting" | "attention" | "stopped";

export interface ControlPlaneSessionDependencies {
  readonly connect: (endpoint: ControlPlaneEndpoint) => Promise<ControlPlaneClient>;
}

export interface ControlPlaneSession {
  connect(endpoint: ControlPlaneEndpoint): Promise<StatusSnapshot>;
  reconnect(endpoint: ControlPlaneEndpoint): Promise<StatusSnapshot>;
  client(): ControlPlaneClient;
  application(): ApplicationIdentity;
  state(): DesktopBackendState;
  trayHealth(): TrayHealth;
  subscribeState(listener: (state: DesktopBackendState) => void): () => void;
  dispose(): Promise<void>;
}

function deriveTrayHealth(state: DesktopBackendState): TrayHealth {
  switch (state.kind) {
    case "connecting":
    case "reconnecting":
      return "starting";
    case "unavailable":
      return "attention";
    case "ready":
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
}

export function createControlPlaneSession(
  dependencies: ControlPlaneSessionDependencies,
): ControlPlaneSession {
  let revision = 0;
  let currentState: DesktopBackendState = Object.freeze({
    revision,
    kind: "connecting",
  });
  let currentClient: ControlPlaneClient | undefined;
  let currentApplication: ApplicationIdentity | undefined;
  let unsubscribeStatus: (() => Promise<void>) | undefined;
  let generation = 0;
  const listeners = new Set<(state: DesktopBackendState) => void>();

  const publish = (
    state:
      | { readonly kind: "connecting" | "reconnecting" | "unavailable" }
      | { readonly kind: "ready"; readonly status: StatusSnapshot },
  ): void => {
    revision += 1;
    currentState = Object.freeze({ revision, ...state }) as DesktopBackendState;
    for (const listener of listeners) listener(currentState);
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
        throw new Error("Token Control Plane version is incompatible");
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
        throw new Error("Token Control Plane connection was replaced");
      }
      if (latest === undefined || snapshot.sequence >= latest.sequence) latest = snapshot;
      publish({ kind: "ready", status: latest });

      void client.disconnected.then((disconnect) => {
        if (myGeneration !== generation || disconnect.reason === "closed") return;
        currentClient = undefined;
        currentApplication = undefined;
        unsubscribeStatus = undefined;
        publish({ kind: "unavailable" });
      });
      return latest;
    } catch (error) {
      if (myGeneration === generation) {
        await releaseCurrent();
        publish({ kind: "unavailable" });
      }
      throw error;
    }
  };

  return Object.freeze({
    connect: (endpoint: ControlPlaneEndpoint) => establish(endpoint, false),
    reconnect: (endpoint: ControlPlaneEndpoint) => establish(endpoint, true),
    client(): ControlPlaneClient {
      if (currentClient === undefined || currentState.kind !== "ready") {
        throw new Error("Token Control Plane is unavailable");
      }
      return currentClient;
    },
    application(): ApplicationIdentity {
      if (currentApplication === undefined || currentState.kind !== "ready") {
        throw new Error("Token Control Plane is unavailable");
      }
      return currentApplication;
    },
    state: () => currentState,
    trayHealth: () => deriveTrayHealth(currentState),
    subscribeState(listener: (state: DesktopBackendState) => void) {
      listeners.add(listener);
      listener(currentState);
      return () => listeners.delete(listener);
    },
    async dispose(): Promise<void> {
      generation += 1;
      await releaseCurrent();
      publish({ kind: "unavailable" });
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
