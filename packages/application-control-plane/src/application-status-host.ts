import {
  assertControlPlaneEndpoint,
  controlPlaneVersion,
  type ApplicationIdentity,
  type ApplicationStatus,
  type ControlPlaneEndpoint,
  type RunningControlPlane,
  type RuntimeCommandExecution,
  type RuntimeCommandHandler,
  type StatusSnapshot,
} from "./contracts.js";
import { readFrame, writeFrame } from "./framing.js";
import {
  assertPipeAccess,
  type PipeAccessRequirement,
  type PipeConnection,
  type PipeServerFactory,
} from "./pipe-transport.js";
import {
  compatibleHello,
  decodeApplicationStatus,
  decodeClientRequest,
  decodeRuntimeCommandExecution,
  incompatibleHello,
  isRecord,
  type ControlPlaneErrorCode,
} from "./wire.js";

export interface StartControlPlaneOptions {
  readonly endpoint: ControlPlaneEndpoint;
  readonly application: ApplicationIdentity;
  readonly initialStatus: ApplicationStatus;
  readonly pipeServerFactory: PipeServerFactory;
  readonly access: PipeAccessRequirement;
  readonly runtimeCommandHandler?: RuntimeCommandHandler;
}

interface ConnectionState {
  readonly connection: PipeConnection;
  authorized: boolean;
  subscribed: boolean;
}

export async function startApplicationStatusHost(
  options: StartControlPlaneOptions,
): Promise<RunningControlPlane> {
  assertControlPlaneEndpoint(options.endpoint);
  const initialStatus = decodeApplicationStatus(options.initialStatus);
  if (initialStatus === undefined) {
    throw new Error("Invalid initial application status");
  }

  const server = await options.pipeServerFactory.listen(
    options.endpoint.pipeName,
  );
  try {
    assertPipeAccess(server.securityPolicy(), options.access);
  } catch (error) {
    await server.close();
    throw error;
  }

  let current: StatusSnapshot = { ...initialStatus, sequence: 0 };
  let closed = false;
  let publishQueue = Promise.resolve();
  const states = new Set<ConnectionState>();
  const tasks = new Set<Promise<void>>();
  const sendError = async (
    connection: PipeConnection,
    requestId: string,
    code: ControlPlaneErrorCode,
  ) => {
    await writeFrame(connection, {
      type: "error",
      requestId:
        requestId === options.endpoint.capability ? "" : requestId,
      code,
    });
  };

  const serveConnection = async (state: ConnectionState): Promise<void> => {
    try {
      for (;;) {
        const frame = await readFrame(state.connection);
        if (frame.type === "end") return;
        if (frame.type === "oversized") return;
        if (frame.type === "malformed") {
          state.authorized = false;
          state.subscribed = false;
          await sendError(state.connection, "", "invalid_request");
          continue;
        }
        if (isRecord(frame.value) && frame.value.type === "hello") {
          state.authorized = false;
          state.subscribed = false;
        }
        const decoded = decodeClientRequest(frame.value);
        if (decoded.type === "invalid") {
          await sendError(
            state.connection,
            decoded.requestId,
            decoded.code,
          );
          continue;
        }
        const request = decoded.request;
        if (request.requestId === options.endpoint.capability) {
          await sendError(state.connection, request.requestId, "invalid_request");
          continue;
        }
        if (request.type === "hello") {
          if (request.capability !== options.endpoint.capability) {
            await sendError(state.connection, request.requestId, "unauthorized");
          } else if (request.contractVersion !== controlPlaneVersion) {
            await writeFrame(state.connection, {
              type: "hello_result",
              requestId: request.requestId,
              result: incompatibleHello(request.contractVersion),
            });
          } else {
            state.authorized = true;
            await writeFrame(state.connection, {
              type: "hello_result",
              requestId: request.requestId,
              result: compatibleHello(options.application),
            });
          }
          continue;
        }
        if (!state.authorized) {
          await sendError(state.connection, request.requestId, "hello_required");
          continue;
        }
        if (request.type === "get_status") {
          await writeFrame(state.connection, {
            type: "status_result",
            requestId: request.requestId,
            snapshot: current,
          });
        } else if (request.type === "runtime_command") {
          let execution: RuntimeCommandExecution;
          if (options.runtimeCommandHandler === undefined) {
            execution = {
              outcome: "conflict",
              conflict: {
                code: "runtime_unavailable",
                message:
                  "Runtime lifecycle commands are unavailable in this application.",
              },
            };
          } else {
            const handled = await options.runtimeCommandHandler(
              request.command,
              async (status) => {
                await publishStatus(status);
              },
            );
            execution = decodeRuntimeCommandExecution(handled) ?? {
              outcome: "failed",
            };
          }
          await writeFrame(state.connection, {
            type: "runtime_command_result",
            requestId: request.requestId,
            result: {
              command: request.command,
              ...execution,
              snapshot: current,
            },
          });
        } else if (request.type === "subscribe") {
          state.subscribed = true;
          await writeFrame(state.connection, {
            type: "subscribed",
            requestId: request.requestId,
          });
        } else {
          state.subscribed = false;
          await writeFrame(state.connection, {
            type: "unsubscribed",
            requestId: request.requestId,
          });
        }
      }
    } finally {
      states.delete(state);
      await state.connection.close().catch(() => undefined);
    }
  };

  const acceptTask = (async () => {
    while (!closed) {
      let connection: PipeConnection | null;
      try {
        connection = await server.accept();
      } catch {
        return;
      }
      if (connection === null) return;
      if (closed) {
        await connection.close().catch(() => undefined);
        return;
      }
      const state: ConnectionState = {
        connection,
        authorized: false,
        subscribed: false,
      };
      states.add(state);
      const task = serveConnection(state).catch(() => undefined);
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
    }
  })();

  const publishStatus = (status: ApplicationStatus): Promise<void> => {
    const safeStatus = decodeApplicationStatus(status);
    if (safeStatus === undefined) {
      return Promise.reject(new Error("Invalid application status"));
    }
    if (closed) {
      return Promise.reject(new Error("Control Plane is closed"));
    }
    publishQueue = publishQueue.then(async () => {
      current = { ...safeStatus, sequence: current.sequence + 1 };
      const event = {
        type: "event",
        event: {
          type: "status_changed",
          sequence: current.sequence,
          snapshot: current,
        },
      } as const;
      await Promise.all(
        [...states]
          .filter((state) => state.subscribed)
          .map(async (state) => {
            try {
              await writeFrame(state.connection, event);
            } catch {
              state.subscribed = false;
              await state.connection.close().catch(() => undefined);
            }
          }),
      );
    });
    return publishQueue;
  };

  return {
    endpoint: options.endpoint,
    publishStatus,
    async close() {
      if (closed) return;
      closed = true;
      await publishQueue.catch(() => undefined);
      await Promise.all(
        [...states].map((state) =>
          state.connection.close().catch(() => undefined),
        ),
      );
      await server.close();
      await acceptTask;
      await Promise.all(tasks);
    },
  };
}
