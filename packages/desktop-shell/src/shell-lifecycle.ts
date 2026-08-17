import type { ControlPlaneState } from "./control-plane-projection.js";
import type {
  AliasCommand,
  AliasCommandResult,
  BackupCreateCommand,
  BackupResult,
  AuthCommand,
  AuthCommandResult,
  AuthInteractionEvent,
  AuthInteractionResponse,
  CatalogCommand,
  CatalogCommandResult,
  ClientTokenCommand,
  ClientTokenCommandResult,
  CredentialCommand,
  CredentialCommandResult,
  HistoryDeleteCommand,
  HistoryDeleteResult,
  HistoryExportCommand,
  HistoryExportResult,
  HistoryQueryResult,
  HistoryRange,
  ModelsCommand,
  RequestIdentitiesQueryResult,
  RequestLedgerEvent,
  RequestLedgerQuery,
  RequestLedgerQueryResult,
  RuntimeCommand,
  SettingsCommand,
  AnalyticsOptionsResult,
  AnalyticsQuery,
  AnalyticsResult,
} from "@luckytoken/application-control-plane/control-plane";
import type { DiagnosticsWarning } from "./tauri-shell-runtime.js";

export const productPages = Object.freeze([
  { id: "dashboard", label: "Dashboard" },
  { id: "requests", label: "Requests" },
  { id: "analytics", label: "Analytics" },
  { id: "providers", label: "Providers" },
  { id: "models-aliases", label: "Models & Aliases" },
  { id: "credentials", label: "Credentials" },
  { id: "client-tokens", label: "Client Tokens" },
  { id: "diagnostics", label: "Diagnostics" },
  { id: "settings-developer-lab", label: "Settings / Developer Lab" },
] as const);

export type ProductPageId = (typeof productPages)[number]["id"];

/** Effective Windows login auto-start registration status (Ticket 05). */
export interface AutoStartProjection {
  readonly enabled: boolean;
}

export interface DesktopShellRuntime {
  connectControlPlane(): Promise<ControlPlaneState>;
  subscribeControlPlane(
    listener: (state: ControlPlaneState) => void,
  ): () => void;
  subscribeNavigation?(listener: (page: ProductPageId) => void): () => void;
  executeRuntimeCommand(command: RuntimeCommand): Promise<ControlPlaneState>;
  executeSettingsCommand(command: SettingsCommand): Promise<ControlPlaneState>;
  /** Ticket 23: acknowledges the audit-unavailable state; returns the fresh
   *  projected state so the banner updates immediately. Acknowledgment only
   *  silences the urgent presentation; it never claims storage recovered. */
  acknowledgePersistence(): Promise<ControlPlaneState>;
  queryHistory(range?: HistoryRange): Promise<HistoryQueryResult>;
  executeHistoryExport(command: HistoryExportCommand): Promise<HistoryExportResult>;
  confirmHistoryExport(actionId: string): Promise<HistoryExportResult>;
  executeHistoryDelete(command: HistoryDeleteCommand): Promise<HistoryDeleteResult>;
  confirmHistoryDelete(actionId: string): Promise<HistoryDeleteResult>;
  pickHistoryExportDestination(): Promise<string | undefined>;
  executeBackup?(command: BackupCreateCommand): Promise<BackupResult>;
  confirmBackup?(actionId: string): Promise<BackupResult>;
  pickBackupDestination?(): Promise<string | undefined>;
  getAutoStartStatus(): Promise<AutoStartProjection>;
  setAutoStartEnabled(enabled: boolean): Promise<AutoStartProjection>;
  executeModelsCommand(command: ModelsCommand): Promise<ControlPlaneState>;
  executeCatalogCommand(command: CatalogCommand): Promise<CatalogCommandResult>;
  executeAliasCommand(command: AliasCommand): Promise<AliasCommandResult>;
  executeClientTokenCommand(
    command: ClientTokenCommand,
  ): Promise<ClientTokenCommandResult>;
  executeCredentialCommand(
    command: CredentialCommand,
  ): Promise<CredentialCommandResult>;
  executeAuthCommand(
    command: AuthCommand,
    onInteraction?: (event: AuthInteractionEvent) => void,
  ): Promise<AuthCommandResult>;
  respondAuthInteraction(response: AuthInteractionResponse): Promise<void>;
  openUrl(url: string): Promise<void>;
  queryDiagnosticsWarnings(): Promise<readonly DiagnosticsWarning[]>;

  /** Native directory picker: the picked absolute path or undefined on
   *  cancel. The backend canonicalizes the path. */
  pickDirectory(): Promise<string | undefined>;
  getRequestIdentities(): Promise<RequestIdentitiesQueryResult>;

  /** Ticket 21: bounded versioned analytics query over the Request Ledger. */
  getAnalytics(
    query: AnalyticsQuery,
  ): Promise<AnalyticsResult | AnalyticsOptionsResult>;

  /** Bounded newest-first Request Ledger query (Ticket 19). */
  getRequestLedger(
    query: RequestLedgerQuery | undefined,
  ): Promise<RequestLedgerQueryResult>;
  /** Listen-first typed ledger subscription: the caller must subscribe
   *  before its head query so no committed record is ever missed. The
   *  returned stop ends the subscription; an invalid stream event is
   *  reported through `onError` (the subscription then ends itself). */
  subscribeRequestLedger(
    listener: (event: RequestLedgerEvent) => void,
    onError?: (error: Error) => void,
  ): Promise<() => Promise<void>>;

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
  OpenDesktopShellSnapshot | ClosedDesktopShellSnapshot;

export interface WindowsShellHost {
  launch(): Promise<DesktopShellSnapshot>;
  navigate(page: ProductPageId): DesktopShellSnapshot;
  snapshot(): DesktopShellSnapshot;
  subscribe(listener: (snapshot: DesktopShellSnapshot) => void): () => void;
  executeRuntimeCommand(command: RuntimeCommand): Promise<DesktopShellSnapshot>;
  executeSettingsCommand(
    command: SettingsCommand,
  ): Promise<DesktopShellSnapshot>;
  acknowledgePersistence(): Promise<DesktopShellSnapshot>;
  queryHistory(range?: HistoryRange): Promise<HistoryQueryResult>;
  executeHistoryExport(command: HistoryExportCommand): Promise<HistoryExportResult>;
  confirmHistoryExport(actionId: string): Promise<HistoryExportResult>;
  executeHistoryDelete(command: HistoryDeleteCommand): Promise<HistoryDeleteResult>;
  confirmHistoryDelete(actionId: string): Promise<HistoryDeleteResult>;
  pickHistoryExportDestination(): Promise<string | undefined>;
  executeBackup?(command: BackupCreateCommand): Promise<BackupResult>;
  confirmBackup?(actionId: string): Promise<BackupResult>;
  pickBackupDestination?(): Promise<string | undefined>;
  getAutoStartStatus(): Promise<AutoStartProjection>;
  setAutoStartEnabled(enabled: boolean): Promise<AutoStartProjection>;
  executeModelsCommand(command: ModelsCommand): Promise<DesktopShellSnapshot>;
  executeCatalogCommand(command: CatalogCommand): Promise<CatalogCommandResult>;
  executeAliasCommand(command: AliasCommand): Promise<AliasCommandResult>;
  executeClientTokenCommand(
    command: ClientTokenCommand,
  ): Promise<ClientTokenCommandResult>;

  executeCredentialCommand(
    command: CredentialCommand,
  ): Promise<CredentialCommandResult>;

  executeAuthCommand(
    command: AuthCommand,
    onInteraction?: (event: AuthInteractionEvent) => void,
  ): Promise<AuthCommandResult>;

  respondAuthInteraction(response: AuthInteractionResponse): Promise<void>;

  openUrl(url: string): Promise<void>;

  queryDiagnosticsWarnings(): Promise<readonly DiagnosticsWarning[]>;

  pickDirectory(): Promise<string | undefined>;
  getRequestIdentities(): Promise<RequestIdentitiesQueryResult>;
  getAnalytics(
    query: AnalyticsQuery,
  ): Promise<AnalyticsResult | AnalyticsOptionsResult>;
  getRequestLedger(
    query: RequestLedgerQuery | undefined,
  ): Promise<RequestLedgerQueryResult>;
  subscribeRequestLedger(
    listener: (event: RequestLedgerEvent) => void,
    onError?: (error: Error) => void,
  ): Promise<() => Promise<void>>;
  dispose(): Promise<void>;
}

export function createWindowsShellHost(
  runtime: DesktopShellRuntime,
): WindowsShellHost {
  let launch: Promise<DesktopShellSnapshot> | undefined;
  let cleanup: Promise<void> | undefined;
  let disposal: Promise<void> | undefined;
  let stopObserving: (() => void) | undefined;
  let stopNavigation: (() => void) | undefined;
  let pendingNavigation: ProductPageId | undefined;
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
      stopNavigation?.();
      stopNavigation = undefined;
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
        stopNavigation = runtime.subscribeNavigation?.((page) => {
          if (current.lifecycle === "open") {
            current = Object.freeze({ ...current, activePage: page });
            emit();
          } else {
            pendingNavigation = page;
          }
        });
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
          activePage: pendingNavigation ?? ("dashboard" as const),
          connection,
        });
        pendingNavigation = undefined;
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
    async acknowledgePersistence() {
      if (current.lifecycle !== "open") {
        throw new Error("Desktop shell is not open");
      }
      const result = await runtime.acknowledgePersistence();
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
    queryHistory(range) {
      if (current.lifecycle !== "open") {
        return Promise.reject(new Error("Desktop shell is not open"));
      }
      return runtime.queryHistory(range);
    },
    executeHistoryExport(command) {
      if (current.lifecycle !== "open") {
        return Promise.reject(new Error("Desktop shell is not open"));
      }
      return runtime.executeHistoryExport(command);
    },
    confirmHistoryExport(actionId) {
      if (current.lifecycle !== "open") {
        return Promise.reject(new Error("Desktop shell is not open"));
      }
      return runtime.confirmHistoryExport(actionId);
    },
    executeHistoryDelete(command) {
      if (current.lifecycle !== "open") {
        return Promise.reject(new Error("Desktop shell is not open"));
      }
      return runtime.executeHistoryDelete(command);
    },
    confirmHistoryDelete(actionId) {
      if (current.lifecycle !== "open") {
        return Promise.reject(new Error("Desktop shell is not open"));
      }
      return runtime.confirmHistoryDelete(actionId);
    },
    pickHistoryExportDestination() {
      if (current.lifecycle !== "open") {
        return Promise.reject(new Error("Desktop shell is not open"));
      }
      return runtime.pickHistoryExportDestination();
    },
    executeBackup(command) {
      if (current.lifecycle !== "open") {
        return Promise.reject(new Error("Desktop shell is not open"));
      }
      return runtime.executeBackup === undefined
        ? Promise.reject(new Error("Backup is unavailable"))
        : runtime.executeBackup(command);
    },
    confirmBackup(actionId) {
      if (current.lifecycle !== "open") {
        return Promise.reject(new Error("Desktop shell is not open"));
      }
      return runtime.confirmBackup === undefined
        ? Promise.reject(new Error("Backup is unavailable"))
        : runtime.confirmBackup(actionId);
    },
    pickBackupDestination() {
      if (current.lifecycle !== "open") {
        return Promise.reject(new Error("Desktop shell is not open"));
      }
      return runtime.pickBackupDestination === undefined
        ? Promise.reject(new Error("Backup is unavailable"))
        : runtime.pickBackupDestination();
    },
    getAutoStartStatus() {
      return runtime.getAutoStartStatus();
    },
    setAutoStartEnabled(enabled) {
      return runtime.setAutoStartEnabled(enabled);
    },
    executeClientTokenCommand(command) {
      if (current.lifecycle !== "open") {
        return Promise.reject(new Error("Desktop shell is not open"));
      }
      return runtime.executeClientTokenCommand(command);
    },
    executeCredentialCommand(command) {
      if (current.lifecycle !== "open") {
        return Promise.reject(new Error("Desktop shell is not open"));
      }
      return runtime.executeCredentialCommand(command);
    },
    executeAuthCommand(command, onInteraction) {
      if (current.lifecycle !== "open") {
        return Promise.reject(new Error("Desktop shell is not open"));
      }
      return runtime.executeAuthCommand(command, onInteraction);
    },
    respondAuthInteraction(response) {
      if (current.lifecycle !== "open") {
        return Promise.reject(new Error("Desktop shell is not open"));
      }
      return runtime.respondAuthInteraction(response);
    },
    openUrl(url) {
      if (current.lifecycle !== "open") {
        return Promise.reject(new Error("Desktop shell is not open"));
      }
      return runtime.openUrl(url);
    },
    executeCatalogCommand(command) {
      if (current.lifecycle !== "open") {
        return Promise.reject(new Error("Desktop shell is not open"));
      }
      return runtime.executeCatalogCommand(command);
    },
    executeAliasCommand(command) {
      if (current.lifecycle !== "open") {
        return Promise.reject(new Error("Desktop shell is not open"));
      }
      return runtime.executeAliasCommand(command);
    },
    pickDirectory() {
      if (current.lifecycle !== "open") {
        return Promise.reject(new Error("Desktop shell is not open"));
      }
      return runtime.pickDirectory();
    },
    getRequestIdentities() {
      if (current.lifecycle !== "open") {
        return Promise.reject(new Error("Desktop shell is not open"));
      }
      return runtime.getRequestIdentities();
    },
    getAnalytics(query) {
      if (current.lifecycle !== "open") {
        return Promise.reject(new Error("Desktop shell is not open"));
      }
      return runtime.getAnalytics(query);
    },
    getRequestLedger(query) {
      if (current.lifecycle !== "open") {
        return Promise.reject(new Error("Desktop shell is not open"));
      }
      return runtime.getRequestLedger(query);
    },
    subscribeRequestLedger(listener, onError) {
      if (current.lifecycle !== "open") {
        return Promise.reject(new Error("Desktop shell is not open"));
      }
      return runtime.subscribeRequestLedger(listener, onError);
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
