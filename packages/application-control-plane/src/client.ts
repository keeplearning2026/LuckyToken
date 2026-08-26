import type {
  RequestArtifactChunkReadResult,
  RequestArtifactFileReferenceReadResult,
  RequestArtifactFileResolveInput,
  RequestArtifactGetInput,
  RequestJourneyDetailReadResult,
  RequestJourneyGetInput,
  RequestJourneyQuery,
  RequestJourneyQueryReadResult,
  RequestJourneySubscriber,
  RuntimeEventQuery,
  RuntimeEventQueryReadResult,
  RuntimeEventSubscriber,
} from "./request-diagnostics-contract.js";
import type { AnalyticsManagementResult, AnalyticsQuery } from "./analytics-contract.js";
import { decodeAnalyticsManagementResult } from "./wire-analytics.js";
import type {
  HistoryDeleteCommand,
  HistoryDeleteManagementResult,
  HistoryExportCommand,
  HistoryExportManagementResult,
  HistoryQueryManagementResult,
  HistoryRange,
} from "./history-contract.js";
import type { BackupCreateCommand, BackupManagementResult } from "./backup-contract.js";
import {
  assertControlPlaneEndpoint,
  type ApplicationCommand,
  type ApplicationCommandResult,
  type AuthInteractionEvent,
  type AuthInteractionResponse,
  type CatalogCommand,
  type CatalogCommandResult,
  type AgentIntegrationsCommand,
  type AgentIntegrationsCommandResult,
  type ControlPlaneClient,
  type ControlPlaneDisconnect,
  type ControlPlaneEndpoint,
  type HelloResult,
  type ModelsCommand,
  type ModelsCommandResult,
  type PublicModelsCommand,
  type PublicModelsCommandResult,
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
  decodeCatalogCommandResult,
  decodeAgentIntegrationsCommandResult,
  decodePublicModelsCommandResult,
  decodeRequestId,
  decodeServerMessage,
  type RecordValue,
  type ServerMessage,
} from "./wire.js";
import {
  decodeHistoryDeleteManagementResult,
  decodeHistoryExportManagementResult,
  decodeHistoryQueryManagementResult,
} from "./wire-history.js";
import { decodeBackupManagementResult } from "./wire-backup.js";
import type {
  CredentialProfilesCommand,
  CredentialProfilesCommandResult,
  ProviderProfileAuthCommand,
  ProviderProfileAuthCommandResult,
} from "./credential-profiles-contract.js";
import {
  decodeCredentialProfilesCommandResult,
  decodeProviderProfileAuthCommandResult,
} from "./wire-credential-profiles.js";

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
interface PendingProfileAuthFlow {
  readonly command: ProviderProfileAuthCommand;
  readonly onInteraction: (event: AuthInteractionEvent) => void;
  readonly resolve: (result: ProviderProfileAuthCommandResult) => void;
  readonly reject: (error: Error) => void;
}

export async function connectApplicationControlPlane(
  endpoint: ControlPlaneEndpoint,
  dependencies: ControlPlaneClientDependencies,
): Promise<ControlPlaneClient> {
  assertControlPlaneEndpoint(endpoint);
  const connection = await dependencies.pipeConnector.connect(
    endpoint.address,
  );
  const pending = new Map<string, PendingRequest>();
  const pendingAuth = new Map<string, PendingProfileAuthFlow>();
  let activeAuthRequestId: string | undefined;
  let listener: ((event: StatusEvent) => void) | undefined;
  let requestJourneyListener: RequestJourneySubscriber | undefined;
  let runtimeEventListener: RuntimeEventSubscriber | undefined;
  let settled = false;
  let closeRequested = false;
  let resolveDisconnect:
    ((disconnect: ControlPlaneDisconnect) => void) | undefined;
  const disconnected = new Promise<ControlPlaneDisconnect>((resolve) => {
    resolveDisconnect = resolve;
  });

  const deliverDiagnosticsEvent = <T>(
    target: ((value: T) => void | PromiseLike<void>) | undefined,
    value: T,
  ): void => {
    if (target === undefined) return;
    try {
      void Promise.resolve(target(value)).catch(() => undefined);
    } catch {
      // A subscriber is never allowed to tear down the transport read loop.
    }
  };

  const settle = (reason: ControlPlaneDisconnect["reason"], error: Error) => {
    if (settled) return;
    settled = true;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    for (const flow of pendingAuth.values()) flow.reject(error);
    pendingAuth.clear();
    listener = undefined;
    requestJourneyListener = undefined;
    runtimeEventListener = undefined;
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
          if (message.event.type === "request_journey") {
            deliverDiagnosticsEvent(requestJourneyListener, message.event.record);
          } else if (message.event.type === "runtime_event") {
            deliverDiagnosticsEvent(runtimeEventListener, message.event.record);
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
        if (message.type === "provider_profile_auth_command_result") {
          const flow = pendingAuth.get(message.requestId);
          if (flow === undefined) continue;
          pendingAuth.delete(message.requestId);
          const result = decodeProviderProfileAuthCommandResult(message.result);
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
    async queryRequestJourneys(
      query: RequestJourneyQuery | undefined,
    ): Promise<RequestJourneyQueryReadResult> {
      const response = await request({
        type: "query_request_journeys",
        ...(query === undefined ? {} : { query }),
      });
      if (response.type !== "request_journeys_result") {
        throw new Error("Control Plane response is malformed");
      }
      return response.result;
    },
    async getRequestJourney(
      input: RequestJourneyGetInput,
    ): Promise<RequestJourneyDetailReadResult> {
      const response = await request({ type: "get_request_journey", input });
      if (response.type !== "request_journey_result") {
        throw new Error("Control Plane response is malformed");
      }
      return response.result;
    },
    async getRequestArtifact(
      input: RequestArtifactGetInput,
    ): Promise<RequestArtifactChunkReadResult> {
      const response = await request({ type: "get_request_artifact", input });
      if (response.type !== "request_artifact_result") {
        throw new Error("Control Plane response is malformed");
      }
      return response.result;
    },
    async resolveRequestArtifactFile(
      input: RequestArtifactFileResolveInput,
    ): Promise<RequestArtifactFileReferenceReadResult> {
      const response = await request({
        type: "resolve_request_artifact_file",
        input,
      });
      if (response.type !== "request_artifact_file_result") {
        throw new Error("Control Plane response is malformed");
      }
      return response.result;
    },
    async queryRuntimeEvents(
      query: RuntimeEventQuery | undefined,
    ): Promise<RuntimeEventQueryReadResult> {
      const response = await request({
        type: "query_runtime_events",
        ...(query === undefined ? {} : { query }),
      });
      if (response.type !== "runtime_events_result") {
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
    async executeCredentialProfilesCommand(
      command: CredentialProfilesCommand,
    ): Promise<CredentialProfilesCommandResult> {
      const response = await request({
        type: "credential_profiles_command",
        command,
      });
      if (response.type !== "credential_profiles_command_result") {
        throw new Error("Control Plane response is malformed");
      }
      const result = decodeCredentialProfilesCommandResult(response.result);
      if (result === undefined) {
        throw new Error("Control Plane response is malformed");
      }
      return result;
    },
    async executeProviderProfileAuthCommand(
      command: ProviderProfileAuthCommand,
      onInteraction?: (event: AuthInteractionEvent) => void,
    ): Promise<ProviderProfileAuthCommandResult> {
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
      const result = new Promise<ProviderProfileAuthCommandResult>((resolve, reject) => {
        pendingAuth.set(requestId, {
          command,
          onInteraction: onInteraction ?? (() => undefined),
          resolve,
          reject,
        });
        if (command.command !== "query" && activeAuthRequestId === undefined) {
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
          type: "provider_profile_auth_command",
          command,
          requestId,
        });
      } catch (error) {
        const safeError = error instanceof Error
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
    async getAnalytics(
      query: AnalyticsQuery,
    ): Promise<AnalyticsManagementResult> {
      const response = await request({ type: "get_analytics", query });
      if (response.type !== "analytics_result") {
        throw new Error("Control Plane response is malformed");
      }
      // Strict re-decode at the client boundary: an analytics result that
      // fails the allowlist (including any monetary key) is never trusted.
      const result = decodeAnalyticsManagementResult(response.result);
      if (result === undefined) {
        throw new Error("Control Plane response is malformed");
      }
      return result;
    },
    async subscribeRequestJourneys(
      next: RequestJourneySubscriber,
    ): Promise<() => Promise<void>> {
      if (requestJourneyListener !== undefined) {
        throw new Error(
          "Control Plane client is already subscribed to Request Journeys",
        );
      }
      requestJourneyListener = next;
      let response: ServerMessage;
      try {
        response = await request({ type: "request_journeys_subscribe" });
      } catch (error) {
        requestJourneyListener = undefined;
        throw error;
      }
      if (response.type !== "subscribed") {
        requestJourneyListener = undefined;
        throw new Error("Control Plane response is malformed");
      }
      let subscribed = true;
      return async () => {
        if (!subscribed) return;
        const result = await request({ type: "request_journeys_unsubscribe" });
        if (result.type !== "unsubscribed") {
          throw new Error("Control Plane response is malformed");
        }
        subscribed = false;
        requestJourneyListener = undefined;
      };
    },
    async subscribeRuntimeEvents(
      next: RuntimeEventSubscriber,
    ): Promise<() => Promise<void>> {
      if (runtimeEventListener !== undefined) {
        throw new Error(
          "Control Plane client is already subscribed to Runtime Events",
        );
      }
      runtimeEventListener = next;
      let response: ServerMessage;
      try {
        response = await request({ type: "runtime_events_subscribe" });
      } catch (error) {
        runtimeEventListener = undefined;
        throw error;
      }
      if (response.type !== "subscribed") {
        runtimeEventListener = undefined;
        throw new Error("Control Plane response is malformed");
      }
      let subscribed = true;
      return async () => {
        if (!subscribed) return;
        const result = await request({ type: "runtime_events_unsubscribe" });
        if (result.type !== "unsubscribed") {
          throw new Error("Control Plane response is malformed");
        }
        subscribed = false;
        runtimeEventListener = undefined;
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
    async executePublicModelsCommand(
      command: PublicModelsCommand,
    ): Promise<PublicModelsCommandResult> {
      const response = await request({
        type: "public_models_command",
        command,
      });
      if (response.type !== "public_models_command_result") {
        throw new Error("Control Plane response is malformed");
      }
      const result = decodePublicModelsCommandResult(response.result);
      if (result === undefined) {
        throw new Error("Control Plane response is malformed");
      }
      return result;
    },
    async executeAgentIntegrationsCommand(
      command: AgentIntegrationsCommand,
    ): Promise<AgentIntegrationsCommandResult> {
      const response = await request({
        type: "agent_integrations_command",
        command,
      });
      if (response.type !== "agent_integrations_command_result") {
        throw new Error("Control Plane response is malformed");
      }
      const result = decodeAgentIntegrationsCommandResult(response.result);
      if (result === undefined) {
        throw new Error("Control Plane response is malformed");
      }
      return result;
    },
    async queryHistory(range?: HistoryRange): Promise<HistoryQueryManagementResult> {
      const response = await request({
        type: "history_query",
        ...(range === undefined ? {} : { range }),
      });
      if (response.type !== "history_query_result") {
        throw new Error("Control Plane response is malformed");
      }
      const result = decodeHistoryQueryManagementResult(response.result);
      if (result === undefined) {
        throw new Error("Control Plane response is malformed");
      }
      return result;
    },
    async executeHistoryExport(
      command: HistoryExportCommand,
    ): Promise<HistoryExportManagementResult> {
      const response = await request({ type: "history_export_command", command });
      if (response.type !== "history_export_result") {
        throw new Error("Control Plane response is malformed");
      }
      const result = decodeHistoryExportManagementResult(response.result);
      if (result === undefined) {
        throw new Error("Control Plane response is malformed");
      }
      return result;
    },
    async confirmHistoryExport(actionId: string): Promise<HistoryExportManagementResult> {
      const response = await request({
        type: "history_export_confirm",
        actionId,
      });
      if (response.type !== "history_export_result") {
        throw new Error("Control Plane response is malformed");
      }
      const result = decodeHistoryExportManagementResult(response.result);
      if (result === undefined) {
        throw new Error("Control Plane response is malformed");
      }
      return result;
    },
    async executeHistoryDelete(
      command: HistoryDeleteCommand,
    ): Promise<HistoryDeleteManagementResult> {
      const response = await request({ type: "history_delete_command", command });
      if (response.type !== "history_delete_result") {
        throw new Error("Control Plane response is malformed");
      }
      const result = decodeHistoryDeleteManagementResult(response.result);
      if (result === undefined) {
        throw new Error("Control Plane response is malformed");
      }
      return result;
    },
    async confirmHistoryDelete(actionId: string): Promise<HistoryDeleteManagementResult> {
      const response = await request({
        type: "history_delete_confirm",
        actionId,
      });
      if (response.type !== "history_delete_result") {
        throw new Error("Control Plane response is malformed");
      }
      const result = decodeHistoryDeleteManagementResult(response.result);
      if (result === undefined) {
        throw new Error("Control Plane response is malformed");
      }
      return result;
    },
    async executeBackup(command: BackupCreateCommand): Promise<BackupManagementResult> {
      const response = await request({
        type: "backup_command",
        command: { command: "create", ...command },
      });
      if (response.type !== "backup_result") {
        throw new Error("Control Plane response is malformed");
      }
      const result = decodeBackupManagementResult(response.result);
      if (result === undefined) {
        throw new Error("Control Plane response is malformed");
      }
      return result;
    },
    async confirmBackup(actionId: string): Promise<BackupManagementResult> {
      const response = await request({
        type: "backup_command",
        command: { command: "confirm", actionId },
      });
      if (response.type !== "backup_result") {
        throw new Error("Control Plane response is malformed");
      }
      const result = decodeBackupManagementResult(response.result);
      if (result === undefined) {
        throw new Error("Control Plane response is malformed");
      }
      return result;
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
