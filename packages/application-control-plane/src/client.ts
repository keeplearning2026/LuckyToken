import type {
  RuntimeDiagnosticEvent,
  RuntimeDiagnosticQuery,
  RuntimeDiagnosticsQueryResult,
} from "./diagnostics-contract.js";
import {
  assertControlPlaneEndpoint,
  type ClientTokenCommand,
  type ClientTokenCommandResult,
  type ControlPlaneClient,
  type ControlPlaneDisconnect,
  type ControlPlaneEndpoint,
  type HelloResult,
  type ModelsCommand,
  type ModelsCommandResult,
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
  decodeClientTokenCommandResult,
  decodeRequestId,
  decodeServerMessage,
  type RecordValue,
  type ServerMessage,
} from "./wire.js";

export interface ControlPlaneClientDependencies {
  readonly createRequestId: () => string;
  readonly pipeConnector: PipeConnector;
}

interface PendingRequest {
  readonly resolve: (value: ServerMessage) => void;
  readonly reject: (error: Error) => void;
}

export async function connectApplicationControlPlane(
  endpoint: ControlPlaneEndpoint,
  dependencies: ControlPlaneClientDependencies,
): Promise<ControlPlaneClient> {
  assertControlPlaneEndpoint(endpoint);
  const connection = await dependencies.pipeConnector.connect(endpoint.pipeName);
  const pending = new Map<string, PendingRequest>();
  let listener: ((event: StatusEvent) => void) | undefined;
  let diagnosticsListener: ((event: RuntimeDiagnosticEvent) => void) | undefined;
  let settled = false;
  let closeRequested = false;
  let resolveDisconnect:
    | ((disconnect: ControlPlaneDisconnect) => void)
    | undefined;
  const disconnected = new Promise<ControlPlaneDisconnect>((resolve) => {
    resolveDisconnect = resolve;
  });

  const settle = (reason: ControlPlaneDisconnect["reason"], error: Error) => {
    if (settled) return;
    settled = true;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
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
          } else {
            listener?.(message.event);
          }
          continue;
        }
        const request = pending.get(message.requestId);
        if (request === undefined) continue;
        pending.delete(message.requestId);
        if (message.type === "error") {
          request.reject(
            new Error(`Control Plane request failed: ${message.code}`),
          );
        } else {
          request.resolve(message);
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
    async subscribeDiagnostics(
      next: (event: RuntimeDiagnosticEvent) => void,
    ): Promise<() => Promise<void>> {
      if (diagnosticsListener !== undefined) {
        throw new Error("Control Plane client is already subscribed to diagnostics");
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
