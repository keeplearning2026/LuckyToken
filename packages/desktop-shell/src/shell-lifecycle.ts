import type { ControlPlaneState } from "./control-plane-projection.js";
import type {

  ClientTokenCommand,
  ClientTokenCommandResult,

  ModelsCommand,

  RuntimeCommand,
  SettingsCommand,
} from "@luckytoken/application-control-plane/control-plane";
import type { DiagnosticsWarning } from "./tauri-shell-runtime.js";

export const productPages = Object.freeze([
  { id: "dashboard", label: "Dashboard" },
  { id: "requests", label: "Requests" },
  { id: "analytics", label: "Analytics" },
  { id: "providers", label: "Providers" },
  { id: "models-aliases", label: "Models & Aliases" },
  { id: "client-tokens", label: "Client Tokens" },
  { id: "diagnostics", label: "Diagnostics" },
  { id: "settings-developer-lab", label: "Settings / Developer Lab" },
] as const);

export type ProductPageId = (typeof productPages)[number]["id"];

export interface DesktopShellRuntime {
  connectControlPlane(): Promise<ControlPlaneState>;
  subscribeControlPlane(
    listener: (state: ControlPlaneState) => void,
  ): () => void;
  executeRuntimeCommand(command: RuntimeCommand): Promise<ControlPlaneState>;
  executeSettingsCommand(command: SettingsCommand): Promise<ControlPlaneState>;

  executeClientTokenCommand(
    command: ClientTokenCommand,
  ): Promise<ClientTokenCommandResult>;
  queryDiagnosticsWarnings(): Promise<readonly DiagnosticsWarning[]>;

  executeModelsCommand(command: ModelsCommand): Promise<ControlPlaneState>;

  disconnectControlPlane(): Promise<void>;
}

export interface OpenDesktopShellSnapshot {
  readonly lifecycle: "open";
  readonly activePage: ProductPageId;
  readonly connection: ControlPlaneState;
}

export interface ClosedDesktopShellSnapshot {
  readonly lifecycle: "closed";
  readonly activePage: ProductPageId;
  readonly connection: ControlPlaneState;
}

export type DesktopShellSnapshot =
  | OpenDesktopShellSnapshot
  | ClosedDesktopShellSnapshot;

export interface WindowsShellHost {
  launch(): Promise<DesktopShellSnapshot>;
  navigate(page: ProductPageId): DesktopShellSnapshot;
  snapshot(): DesktopShellSnapshot;
  subscribe(listener: (snapshot: DesktopShellSnapshot) => void): () => void;
  executeRuntimeCommand(command: RuntimeCommand): Promise<DesktopShellSnapshot>;
  executeSettingsCommand(command: SettingsCommand): Promise<DesktopShellSnapshot>;

  executeClientTokenCommand(
    command: ClientTokenCommand,
  ): Promise<ClientTokenCommandResult>;
  queryDiagnosticsWarnings(): Promise<readonly DiagnosticsWarning[]>;

  executeModelsCommand(command: ModelsCommand): Promise<DesktopShellSnapshot>;

  dispose(): Promise<void>;
}

export function createWindowsShellHost(
  runtime: DesktopShellRuntime,
): WindowsShellHost {
  let launch: Promise<DesktopShellSnapshot> | undefined;
  let cleanup: Promise<void> | undefined;
  let disposal: Promise<void> | undefined;
  let stopObserving: (() => void) | undefined;
  let disposed = false;
  const subscribers = new Set<(snapshot: DesktopShellSnapshot) => void>();
  let connection: ControlPlaneState = Object.freeze({
    revision: 0,
    kind: "error",
    code: "protocol_error",
    title: "LuckyToken connection failed",
    detail: "The local Control Plane returned an invalid response.",
    action: "Restart LuckyToken; update it if the problem continues.",
  });
  let current: DesktopShellSnapshot = Object.freeze({
    lifecycle: "closed",
    activePage: "dashboard",
    connection,
  });
  const emit = () => {
    for (const subscriber of subscribers) subscriber(current);
  };
  const settleResources = (): Promise<void> => {
    cleanup ??= (async () => {
      const unsubscribe = stopObserving;
      stopObserving = undefined;
      unsubscribe?.();
      try {
        await runtime.disconnectControlPlane();
      } finally {
        current = Object.freeze({ ...current, lifecycle: "closed" });
        emit();
      }
    })();
    return cleanup;
  };
  return {
    launch() {
      if (disposed) return Promise.resolve(current);
      launch ??= (async () => {
        stopObserving = runtime.subscribeControlPlane((state) => {
          connection = state;
          if (current.lifecycle === "open") {
            current = Object.freeze({ ...current, connection });
            emit();
          }
        });
        try {
          connection = await runtime.connectControlPlane();
        } catch (error) {
          await settleResources().catch(() => undefined);
          throw error;
        }
        if (disposed) {
          await settleResources();
          return current;
        }
        current = Object.freeze({
          lifecycle: "open" as const,
          activePage: "dashboard" as const,
          connection,
        });
        emit();
        return current;
      })();
      return launch;
    },
    navigate(page) {
      if (current.lifecycle !== "open") {
        throw new Error("Desktop shell is not open");
      }
      current = Object.freeze({ ...current, activePage: page });
      emit();
      return current;
    },
    snapshot() {
      return current;
    },
    subscribe(listener) {
      subscribers.add(listener);
      if (current.lifecycle === "open") listener(current);
      return () => subscribers.delete(listener);
    },
    async executeRuntimeCommand(command) {
      if (current.lifecycle !== "open") {
        throw new Error("Desktop shell is not open");
      }
      const result = await runtime.executeRuntimeCommand(command);
      if (
        current.lifecycle === "open" &&
        result.revision > current.connection.revision
      ) {
        connection = result;
        current = Object.freeze({ ...current, connection });
        emit();
      }
      return current;
    },
    async executeSettingsCommand(command) {
      if (current.lifecycle !== "open") {
        throw new Error("Desktop shell is not open");
      }
      const result = await runtime.executeSettingsCommand(command);
      if (
        current.lifecycle === "open" &&
        result.revision > current.connection.revision
      ) {
        connection = result;
        current = Object.freeze({ ...current, connection });
        emit();
      }
      return current;
    },

    executeClientTokenCommand(command) {
      if (current.lifecycle !== "open") {
        return Promise.reject(new Error("Desktop shell is not open"));
      }
      return runtime.executeClientTokenCommand(command);
    },
    queryDiagnosticsWarnings() {
      if (current.lifecycle !== "open") {
        return Promise.reject(new Error("Desktop shell is not open"));
      }
      return runtime.queryDiagnosticsWarnings();
    },

    async executeModelsCommand(command) {
      if (current.lifecycle !== "open") {
        throw new Error("Desktop shell is not open");
      }
      const result = await runtime.executeModelsCommand(command);
      if (
        current.lifecycle === "open" &&
        result.revision > current.connection.revision
      ) {
        connection = result;
        current = Object.freeze({ ...current, connection });
        emit();
      }
      return current;

    },
    dispose() {
      disposed = true;
      disposal ??= (async () => {
        await launch?.catch(() => undefined);
        await settleResources();
      })();
      return disposal;
    },
  };
}
