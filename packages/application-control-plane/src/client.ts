import type {
  RuntimeDiagnosticEvent,
  RuntimeDiagnosticQuery,
  RuntimeDiagnosticsQueryResult,
} from "./diagnostics-contract.js";
import type {
  RequestLedgerEvent,
  RequestLedgerQuery,
  RequestLedgerQueryResult,
} from "./ledger-contract.js";
import type {
  CaptureEvent,
  CaptureQuery,
  CaptureQueryResult,
} from "./capture-contract.js";
import type {
  AnalyticsOptionsResult,
  AnalyticsQuery,
  AnalyticsResult,
} from "./analytics-contract.js";
import { decodeAnalyticsResult } from "./wire-analytics.js";
import type {
  HistoryAcknowledgeResult,
  HistoryDeleteCommand,
  HistoryDeleteResult,
  HistoryExportCommand,
  HistoryExportResult,
  HistoryQueryResult,
  HistoryRange,
} from "./history-contract.js";
import type { BackupCreateCommand, BackupResult } from "./backup-contract.js";
import {
  assertControlPlaneEndpoint,
  type AliasCommand,
  type AliasCommandResult,
  type ApplicationCommand,
  type ApplicationCommandResult,
  type AuthCommand,
  type AuthCommandResult,
  type AuthInteractionEvent,
  type AuthInteractionResponse,
  type CatalogCommand,
  type CatalogCommandResult,
  type ClientTokenCommand,
  type ClientTokenCommandResult,
  type CredentialCommand,
  type CredentialCommandResult,
  type ControlPlaneClient,
  type ControlPlaneDisconnect,
  type ControlPlaneEndpoint,
  type HelloResult,
  type ModelsCommand,
  type ModelsCommandResult,
  type RequestIdentitiesQueryResult,
  type RuntimeCommand,
  type RuntimeCommandResult,
  type SettingsCommand,
  type SettingsCommandResult,
  type StatusEvent,
  type StatusSnapshot,
} from "./contracts.js";
import { readFrame, writeFrame } from "./framing.js";
import type { PipeConnector } from "./pipe-transport.js";
import {
  decodeAliasCommandResult,
  decodeAuthCommandResult,
  decodeCatalogCommandResult,
  decodeClientTokenCommandResult,
  decodeCredentialCommandResult,
  decodeRequestId,
  decodeServerMessage,
  type RecordValue,
  type ServerMessage,
} from "./wire.js";
import {
  decodeHistoryAcknowledgeResult,
  decodeHistoryDeleteResult,
  decodeHistoryExportResult,
  decodeHistoryQueryResult,
} from "./wire-history.js";
import { decodeBackupResult } from "./wire-backup.js";

export interface ControlPlaneClientDependencies {
  readonly createRequestId: () => string;
  readonly pipeConnector: PipeConnector;
}

interface PendingRequest {
  readonly resolve: (value: ServerMessage) => void;
  readonly reject: (error: Error) => void;
}

/** One in-flight Provider-auth flow (Ticket 13): interaction events are
 *  dispatched to the caller until the terminal result arrives. */
interface PendingAuthFlow {
  readonly command: AuthCommand;
  readonly onInteraction: (event: AuthInteractionEvent) => void;
  readonly resolve: (result: AuthCommandResult) => void;
  readonly reject: (error: Error) => void;
}

export async function connectApplicationControlPlane(
  endpoint: ControlPlaneEndpoint,
  dependencies: ControlPlaneClientDependencies,
): Promise<ControlPlaneClient> {
  assertControlPlaneEndpoint(endpoint);
  const connection = await dependencies.pipeConnector.connect(
    endpoint.pipeName,
  );
  const pending = new Map<string, PendingRequest>();
  const pendingAuth = new Map<string, PendingAuthFlow>();
  let activeAuthRequestId: string | undefined;
  let listener: ((event: StatusEvent) => void) | undefined;
  let diagnosticsListener:
    ((event: RuntimeDiagnosticEvent) => void) | undefined;
  let ledgerListener: ((event: RequestLedgerEvent) => void) | undefined;
  let captureListener: ((event: CaptureEvent) => void) | undefined;
  let settled = false;
  let closeRequested = false;
  let resolveDisconnect:
    ((disconnect: ControlPlaneDisconnect) => void) | undefined;
  const disconnected = new Promise<ControlPlaneDisconnect>((resolve) => {
    resolveDisconnect = resolve;
  });

  const settle = (reason: ControlPlaneDisconnect["reason"], error: Error) => {
    if (settled) return;
    settled = true;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    for (const flow of pendingAuth.values()) flow.reject(error);
    pendingAuth.clear();
    resolveDisconnect?.({ reason });
  };

  const readTask = (async () => {
    try {
      for (;;) {
        const frame = await readFrame(connection);
        if (frame.type === "end") {
          settle(
            closeRequested ? "closed" : "transport_lost",
            new Error("Control Plane disconnected"),
          );
          return;
        }
        if (frame.type !== "frame") {
          throw new Error("Control Plane response is malformed");
        }
        const message = decodeServerMessage(frame.value);
        if (message === undefined) {
          throw new Error("Control Plane response is malformed");
        }
        if (message.type === "event") {
          if (message.event.type === "diagnostic") {
            diagnosticsListener?.(message.event);
          } else if (message.event.type === "request_ledger") {
            ledgerListener?.(message.event);
          } else if (message.event.type === "capture_state_changed") {
            captureListener?.(message.event);
          } else {
            listener?.(message.event);
          }
          continue;
        }
        const request = pending.get(message.requestId);
        if (request !== undefined) {
          pending.delete(message.requestId);
          if (message.type === "error") {
            request.reject(
              new Error(`Control Plane request failed: ${message.code}`),
            );
          } else {
            request.resolve(message);
          }
          continue;
        }
        // Ticket 13: auth interaction events and the terminal result of an
        // in-flight login are routed by their flow requestId, never through
        // the generic request/response machinery.
        if (message.type === "auth_interaction_event") {
          const flow = pendingAuth.get(message.requestId);
          if (flow !== undefined) {
            try {
              flow.onInteraction(message.event);
            } catch {
              // A listener failure never tears down the connection.
            }
          }
          continue;
        }
        if (message.type === "auth_command_result") {
          const flow = pendingAuth.get(message.requestId);
          if (flow === undefined) continue;
          pendingAuth.delete(message.requestId);
          const result = decodeAuthCommandResult(message.result, flow.command);
          if (result === undefined) {
            flow.reject(new Error("Control Plane response is malformed"));
          } else {
            flow.resolve(result);
          }
          continue;
        }
      }
    } catch (error) {
      const safeError =
        error instanceof Error
          ? new Error(`Control Plane disconnected: ${error.message}`)
          : new Error("Control Plane disconnected");
      settle(closeRequested ? "closed" : "transport_lost", safeError);
      await connection.close().catch(() => undefined);
    }
  })();

  const request = async (value: RecordValue): Promise<ServerMessage> => {
    const requestId = decodeRequestId(dependencies.createRequestId());
    if (settled || requestId === undefined || pending.has(requestId)) {
      throw new Error("Control Plane request is unavailable");
    }
    const response = new Promise<ServerMessage>((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
    });
    void response.catch(() => undefined);
    try {
      await writeFrame(connection, { ...value, requestId });
    } catch (error) {
      const safeError =
        error instanceof Error
          ? new Error(`Control Plane disconnected: ${error.message}`)
          : new Error("Control Plane disconnected");
      settle("transport_lost", safeError);
      await connection.close().catch(() => undefined);
    }
    return response;
  };

  return {
    disconnected,
    async hello(version): Promise<HelloResult> {
      const response = await request({
        type: "hello",
        contractVersion: version,
        capability: endpoint.capability,
      });
      if (response.type !== "hello_result") {
        throw new Error("Control Plane response is malformed");
      }
      return response.result;
    },
    async getStatus(): Promise<StatusSnapshot> {
      const response = await request({ type: "get_status" });
      if (response.type !== "status_result") {
        throw new Error("Control Plane response is malformed");
      }
      return response.snapshot;
    },
    async executeRuntimeCommand(
      command: RuntimeCommand,
    ): Promise<RuntimeCommandResult> {
      const response = await request({ type: "runtime_command", command });
      if (response.type !== "runtime_command_result") {
        throw new Error("Control Plane response is malformed");
      }
      return response.result;
    },
    async getDiagnostics(
      query: RuntimeDiagnosticQuery | undefined,
    ): Promise<RuntimeDiagnosticsQueryResult> {
      const response = await request({
        type: "get_diagnostics",
        ...(query === undefined ? {} : { query }),
      });
      if (response.type !== "diagnostics_result") {
        throw new Error("Control Plane response is malformed");
      }
      return response.result;
    },
    async executeSettingsCommand(
      command: SettingsCommand,
    ): Promise<SettingsCommandResult> {
      const response = await request({
        type: "settings_command",
        command,
      });
      if (response.type !== "settings_command_result") {
        throw new Error("Control Plane response is malformed");
      }
      return response.result;
    },
    async executeApplicationCommand(
      command: ApplicationCommand,
    ): Promise<ApplicationCommandResult> {
      const response = await request({
        type: "application_command",
        command,
      });
      if (response.type !== "application_command_result") {
        throw new Error("Control Plane response is malformed");
      }
      return response.result;
    },
    async executeClientTokenCommand(
      command: ClientTokenCommand,
    ): Promise<ClientTokenCommandResult> {
      const response = await request({
        type: "client_token_command",
        command,
      });
      if (response.type !== "client_token_command_result") {
        throw new Error("Control Plane response is malformed");
      }
      // The result shape depends on the command that was sent: only a
      // Reveal may carry the active secret and list/mutation results must
      // expose masked scopes only. Re-validate against the local command.
      const result = decodeClientTokenCommandResult(response.result, command);
      if (result === undefined) {
        throw new Error("Control Plane response is malformed");
      }
      return result;
    },
    async executeCredentialCommand(
      command: CredentialCommand,
    ): Promise<CredentialCommandResult> {
      const response = await request({
        type: "credential_command",
        command,
      });
      if (response.type !== "credential_command_result") {
        throw new Error("Control Plane response is malformed");
      }
      // The result shape depends on the command that was sent: credential
      // values or raw credential shapes can never cross the wire. Re-
      // validate against the local command.
      const result = decodeCredentialCommandResult(response.result, command);
      if (result === undefined) {
        throw new Error("Control Plane response is malformed");
      }
      return result;
    },
    async executeAuthCommand(
      command: AuthCommand,
      onInteraction?: (event: AuthInteractionEvent) => void,
    ): Promise<AuthCommandResult> {
      // A login command stays pending across typed interaction events; it
      // resolves only with the terminal `auth_command_result` frame.
      if (settled) {
        throw new Error("Control Plane request is unavailable");
      }
      const requestId = decodeRequestId(dependencies.createRequestId());
      if (
        requestId === undefined ||
        pending.has(requestId) ||
        pendingAuth.has(requestId)
      ) {
        throw new Error("Control Plane request is unavailable");
      }
      const result = new Promise<AuthCommandResult>((resolve, reject) => {
        pendingAuth.set(requestId, {
          command,
          onInteraction: onInteraction ?? (() => undefined),
          resolve,
          reject,
        });
        // The host allows one in-flight login per connection: the first
        // login owns the interaction response slot until it settles.
        if (command.command === "login" && activeAuthRequestId === undefined) {
          activeAuthRequestId = requestId;
        }
      });
      void result.catch(() => undefined);
      void result.then(
        () => {
          if (activeAuthRequestId === requestId) activeAuthRequestId = undefined;
        },
        () => {
          if (activeAuthRequestId === requestId) activeAuthRequestId = undefined;
        },
      );
      try {
        await writeFrame(connection, {
          type: "auth_command",
          command,
          requestId,
        });
      } catch (error) {
        const safeError =
          error instanceof Error
            ? new Error(`Control Plane disconnected: ${error.message}`)
            : new Error("Control Plane disconnected");
        settle("transport_lost", safeError);
        await connection.close().catch(() => undefined);
      }
      return result;
    },
    async respondAuthInteraction(
      response: AuthInteractionResponse,
    ): Promise<void> {
      const requestId = activeAuthRequestId;
      if (settled || requestId === undefined || !pendingAuth.has(requestId)) {
        throw new Error("No sign-in is waiting for a response");
      }
      try {
        await writeFrame(connection, {
          type: "auth_interaction_response",
          requestId,
          response,
        });
      } catch (error) {
        const safeError =
          error instanceof Error
            ? new Error(`Control Plane disconnected: ${error.message}`)
            : new Error("Control Plane disconnected");
        settle("transport_lost", safeError);
        await connection.close().catch(() => undefined);
        throw safeError;
      }
    },
    async getRequestIdentities(): Promise<RequestIdentitiesQueryResult> {
      const response = await request({ type: "get_request_identities" });
      if (response.type !== "request_identities_result") {
        throw new Error("Control Plane response is malformed");
      }
      return response.result;
    },
    async getAnalytics(
      query: AnalyticsQuery,
    ): Promise<AnalyticsResult | AnalyticsOptionsResult> {
      const response = await request({ type: "get_analytics", query });
      if (response.type !== "analytics_result") {
        throw new Error("Control Plane response is malformed");
      }
      // Strict re-decode at the client boundary: an analytics result that
      // fails the allowlist (including any monetary key) is never trusted.
      const result = decodeAnalyticsResult(response.result);
      if (result === undefined) {
        throw new Error("Control Plane response is malformed");
      }
      return result;
    },
    async getRequestLedger(
      query: RequestLedgerQuery | undefined,
    ): Promise<RequestLedgerQueryResult> {
      const response = await request({
        type: "get_request_ledger",
        ...(query === undefined ? {} : { query }),
      });
      if (response.type !== "request_ledger_result") {
        throw new Error("Control Plane response is malformed");
      }
      return response.result;
    },
    async subscribeRequestLedger(
      next: (event: RequestLedgerEvent) => void,
    ): Promise<() => Promise<void>> {
      if (ledgerListener !== undefined) {
        throw new Error(
          "Control Plane client is already subscribed to the request ledger",
        );
      }
      ledgerListener = next;
      let response: ServerMessage;
      try {
        response = await request({ type: "ledger_subscribe" });
      } catch (error) {
        ledgerListener = undefined;
        throw error;
      }
      if (response.type !== "subscribed") {
        ledgerListener = undefined;
        throw new Error("Control Plane response is malformed");
      }
      let subscribed = true;
      return async () => {
        if (!subscribed) return;
        const result = await request({ type: "ledger_unsubscribe" });
        if (result.type !== "unsubscribed") {
          throw new Error("Control Plane response is malformed");
        }
        subscribed = false;
        ledgerListener = undefined;
      };
    },
    async executeModelsCommand(
      command: ModelsCommand,
    ): Promise<ModelsCommandResult> {
      const response = await request({
        type: "models_command",
        command,
      });
      if (response.type !== "models_command_result") {
        throw new Error("Control Plane response is malformed");
      }
      return response.result;
    },
    async executeCatalogCommand(
      command: CatalogCommand,
    ): Promise<CatalogCommandResult> {
      const response = await request({
        type: "catalog_command",
        command,
      });
      if (response.type !== "catalog_command_result") {
        throw new Error("Control Plane response is malformed");
      }
      // Strictly validate the projection crossing the pipe: the catalog
      // snapshot must never carry malformed or unexpected state.
      const result = decodeCatalogCommandResult(response.result);
      if (result === undefined) {
        throw new Error("Control Plane response is malformed");
      }
      return result;
    },
    async executeAliasCommand(command: AliasCommand): Promise<AliasCommandResult> {
      const response = await request({
        type: "alias_command",
        command,
      });
      if (response.type !== "alias_command_result") {
        throw new Error("Control Plane response is malformed");
      }
      // Strictly validate the state crossing the pipe: the alias registry
      // must never carry malformed or unexpected state.
      const result = decodeAliasCommandResult(response.result);
      if (result === undefined) {
        throw new Error("Control Plane response is malformed");
      }
      return result;
    },
    async getCapture(query: CaptureQuery): Promise<CaptureQueryResult> {
      const response = await request({
        type: "get_capture",
        query,
      });
      if (response.type !== "capture_result") {
        throw new Error("Control Plane response is malformed");
      }
      return response.result;
    },
    async subscribeCapture(
      next: (event: CaptureEvent) => void,
    ): Promise<() => Promise<void>> {
      if (captureListener !== undefined) {
        throw new Error(
          "Control Plane client is already subscribed to capture events",
        );
      }
      captureListener = next;
      let response: ServerMessage;
      try {
        response = await request({ type: "capture_subscribe" });
      } catch (error) {
        captureListener = undefined;
        throw error;
      }
      if (response.type !== "subscribed") {
        captureListener = undefined;
        throw new Error("Control Plane response is malformed");
      }
      let subscribed = true;
      return async () => {
        if (!subscribed) return;
        const result = await request({ type: "capture_unsubscribe" });
        if (result.type !== "unsubscribed") {
          throw new Error("Control Plane response is malformed");
        }
        subscribed = false;
        captureListener = undefined;
      };
    },
    async queryHistory(range?: HistoryRange): Promise<HistoryQueryResult> {
      const response = await request({
        type: "history_query",
        ...(range === undefined ? {} : { range }),
      });
      if (response.type !== "history_query_result") {
        throw new Error("Control Plane response is malformed");
      }
      const result = decodeHistoryQueryResult(response.result);
      if (result === undefined) {
        throw new Error("Control Plane response is malformed");
      }
      return result;
    },
    async executeHistoryExport(
      command: HistoryExportCommand,
    ): Promise<HistoryExportResult> {
      const response = await request({ type: "history_export_command", command });
      if (response.type !== "history_export_result") {
        throw new Error("Control Plane response is malformed");
      }
      const result = decodeHistoryExportResult(response.result);
      if (result === undefined) {
        throw new Error("Control Plane response is malformed");
      }
      return result;
    },
    async confirmHistoryExport(actionId: string): Promise<HistoryExportResult> {
      const response = await request({
        type: "history_export_confirm",
        actionId,
      });
      if (response.type !== "history_export_result") {
        throw new Error("Control Plane response is malformed");
      }
      const result = decodeHistoryExportResult(response.result);
      if (result === undefined) {
        throw new Error("Control Plane response is malformed");
      }
      return result;
    },
    async executeHistoryDelete(
      command: HistoryDeleteCommand,
    ): Promise<HistoryDeleteResult> {
      const response = await request({ type: "history_delete_command", command });
      if (response.type !== "history_delete_result") {
        throw new Error("Control Plane response is malformed");
      }
      const result = decodeHistoryDeleteResult(response.result);
      if (result === undefined) {
        throw new Error("Control Plane response is malformed");
      }
      return result;
    },
    async confirmHistoryDelete(actionId: string): Promise<HistoryDeleteResult> {
      const response = await request({
        type: "history_delete_confirm",
        actionId,
      });
      if (response.type !== "history_delete_result") {
        throw new Error("Control Plane response is malformed");
      }
      const result = decodeHistoryDeleteResult(response.result);
      if (result === undefined) {
        throw new Error("Control Plane response is malformed");
      }
      return result;
    },
    async acknowledgePersistence(): Promise<HistoryAcknowledgeResult> {
      const response = await request({ type: "history_acknowledge" });
      if (response.type !== "history_acknowledge_result") {
        throw new Error("Control Plane response is malformed");
      }
      const result = decodeHistoryAcknowledgeResult(response.result);
      if (result === undefined) {
        throw new Error("Control Plane response is malformed");
      }
      return result;
    },
    async executeBackup(command: BackupCreateCommand): Promise<BackupResult> {
      const response = await request({
        type: "backup_command",
        command: { command: "create", ...command },
      });
      if (response.type !== "backup_result") {
        throw new Error("Control Plane response is malformed");
      }
      const result = decodeBackupResult(response.result);
      if (result === undefined) {
        throw new Error("Control Plane response is malformed");
      }
      return result;
    },
    async confirmBackup(actionId: string): Promise<BackupResult> {
      const response = await request({
        type: "backup_command",
        command: { command: "confirm", actionId },
      });
      if (response.type !== "backup_result") {
        throw new Error("Control Plane response is malformed");
      }
      const result = decodeBackupResult(response.result);
      if (result === undefined) {
        throw new Error("Control Plane response is malformed");
      }
      return result;
    },
    async subscribeDiagnostics(
      next: (event: RuntimeDiagnosticEvent) => void,
    ): Promise<() => Promise<void>> {
      if (diagnosticsListener !== undefined) {
        throw new Error(
          "Control Plane client is already subscribed to diagnostics",
        );
      }
      diagnosticsListener = next;
      let response: ServerMessage;
      try {
        response = await request({ type: "diagnostics_subscribe" });
      } catch (error) {
        diagnosticsListener = undefined;
        throw error;
      }
      if (response.type !== "subscribed") {
        diagnosticsListener = undefined;
        throw new Error("Control Plane response is malformed");
      }
      let subscribed = true;
      return async () => {
        if (!subscribed) return;
        const result = await request({ type: "diagnostics_unsubscribe" });
        if (result.type !== "unsubscribed") {
          throw new Error("Control Plane response is malformed");
        }
        subscribed = false;
        diagnosticsListener = undefined;
      };
    },
    async subscribe(next): Promise<() => Promise<void>> {
      if (listener !== undefined) {
        throw new Error("Control Plane client is already subscribed");
      }
      listener = next;
      let response: ServerMessage;
      try {
        response = await request({ type: "subscribe" });
      } catch (error) {
        listener = undefined;
        throw error;
      }
      if (response.type !== "subscribed") {
        listener = undefined;
        throw new Error("Control Plane response is malformed");
      }
      let subscribed = true;
      return async () => {
        if (!subscribed) return;
        const result = await request({ type: "unsubscribe" });
        if (result.type !== "unsubscribed") {
          throw new Error("Control Plane response is malformed");
        }
        subscribed = false;
        listener = undefined;
      };
    },
    async close(): Promise<void> {
      let closeError: unknown;
      if (!settled) {
        closeRequested = true;
        try {
          await connection.close();
        } catch (error) {
          closeError = error;
        }
        settle("closed", new Error("Control Plane client closed"));
      }
      await disconnected;
      if (closeError !== undefined) throw closeError;
      void readTask.catch(() => undefined);
    },
  };
}
