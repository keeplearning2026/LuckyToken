import {
  assertControlPlaneEndpoint,
  controlPlaneVersion,
  type ApplicationCommandHandler,
  type ApplicationCommandResult,
  type ApplicationCommandResultDeliveredHandler,
  type ApplicationIdentity,
  type ApplicationOwnership,
  type ApplicationStatus,
  type CatalogCommandHandler,
  type CatalogCommandResult,
  type CatalogStatusProjection,
  type ControlPlaneEndpoint,
  type ModelsCommandHandler,
  type ModelsProjection,
  type RunningControlPlane,
  type RuntimeCommandExecution,
  type RuntimeCommandHandler,
  type SettingsCommandHandler,
  type SettingsProjection,
  type StatusSnapshot,
} from "./contracts.js";
import {
  type ClientTokenCommandHandler,
  type ClientTokenCommandResult,
  type RequestIdentitiesQueryHandler,
  type RequestIdentityRecord,
} from "./contracts.js";
import {
  type CredentialCommandHandler,
  type CredentialCommandResult,
  type CredentialProjection,
} from "./contracts.js";
import {
  type ControlPlaneDiagnostics,
  normalizeDiagnosticQuery,
} from "./diagnostics-contract.js";
import { readFrame, writeFrame } from "./framing.js";
import {
  assertPipeAccess,
  type PipeAccessRequirement,
  type PipeConnection,
  type PipeServerFactory,
} from "./pipe-transport.js";
import { decodeDiagnosticQuery } from "./wire-diagnostics.js";
import {
  compatibleHello,
  decodeApplicationCommandExecution,
  decodeApplicationStatus,
  decodeCatalogCommandResult,
  decodeClientRequest,
  decodeClientTokenCommandResult,
  decodeCredentialCommandResult,
  decodeModelsCommandResult,
  decodeRequestIdentityRecord,
  decodeRuntimeCommandExecution,
  decodeSettingsCommandResult,
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
  /** Optional Settings command handler (Ticket 06). */
  readonly settingsCommandHandler?: SettingsCommandHandler;
  /** Optional application ownership/lifecycle handler (Ticket 05). */
  readonly applicationCommandHandler?: ApplicationCommandHandler;
  /** Notified once an application command result is visible to the client
   *  (Ticket 05); the owner uses it to tear down and exit after a quit. */
  readonly onApplicationCommandResultDelivered?: ApplicationCommandResultDeliveredHandler;
  /** Owner identity merged into every snapshot (Ticket 05). */
  readonly ownership?: ApplicationOwnership;

  /**
   * Optional Client Token command handler (Ticket 16): serves the versioned
   * Client Token commands used by UI and CLI against the live per-protocol
   * authorities.
   */
  readonly clientTokenCommandHandler?: ClientTokenCommandHandler;

  /** Optional request identity query handler (Ticket 17 identity seam):
   *  serves the recent authorized request identities used by the Requests
   *  surface and Ticket 18's ledger. */
  readonly requestIdentitiesHandler?: RequestIdentitiesQueryHandler;
  /** Optional models.json catalog command handler (Ticket 08). */
  readonly modelsCommandHandler?: ModelsCommandHandler;
  /** Optional Credential command handler (Ticket 12): serves the versioned
   *  credential management commands used by UI and CLI against the live
   *  Credential Authority. */
  readonly credentialCommandHandler?: CredentialCommandHandler;
  /**
   * Optional catalog command handler (Ticket 11): serves the versioned
   * catalog query/refresh commands against the authoritative active
   * catalog snapshot.
   */
  readonly catalogCommandHandler?: CatalogCommandHandler;
  /** Live settings projection merged into every published snapshot. */
  readonly settingsProjection?: () => SettingsProjection;
  /** Live sanitized models.json projection merged into every snapshot. */
  readonly modelsProjection?: () => ModelsProjection;
  /** Live sanitized auth.json credential projection merged into every
   *  snapshot (Ticket 12); absent until the Data Plane authority runs. */
  readonly credentialProjection?: () => CredentialProjection | undefined;
  /** Live sanitized catalog lifecycle projection merged into every
   *  published snapshot (Ticket 11). */
  readonly catalogProjection?: () => CatalogStatusProjection;
  /**
   * Explicit diagnostics ownership (Ticket 07): when present, the Control
   * Plane serves bounded diagnostics queries and typed diagnostic events to
   * subscribers that requested them. Status subscribers never receive
   * diagnostic events.
   */
  readonly diagnostics?: ControlPlaneDiagnostics;
}

interface ConnectionState {
  readonly connection: PipeConnection;
  authorized: boolean;
  subscribed: boolean;
  diagnosticsSubscribed: boolean;
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

  const mergedStatus = (
    status: ApplicationStatus,
  ): Omit<StatusSnapshot, "sequence"> => {
    const projection = options.settingsProjection?.();
    const modelsProjection = options.modelsProjection?.();
    const credentialProjection = options.credentialProjection?.();
    const catalogProjection = options.catalogProjection?.();
    return {
      ...status,
      ...(options.ownership === undefined
        ? {}
        : { ownership: options.ownership }),
      ...(projection === undefined
        ? {}
        : {
            settings: projection.settings,
            ...(projection.confirmation === undefined
              ? {}
              : { confirmation: projection.confirmation }),
          }),
      ...(modelsProjection === undefined ? {} : { models: modelsProjection }),
      ...(credentialProjection === undefined
        ? {}
        : { credentials: credentialProjection }),
      ...(catalogProjection === undefined
        ? {}
        : { catalog: catalogProjection }),
    };
  };
  let current: StatusSnapshot = { ...mergedStatus(initialStatus), sequence: 0 };
  let closed = false;
  let publishQueue = Promise.resolve();
  const states = new Set<ConnectionState>();
  const tasks = new Set<Promise<void>>();
  const diagnostics = options.diagnostics;
  const emitDiagnostics =
    diagnostics === undefined
      ? undefined
      : () => {
          const subscription = diagnostics.subscribe((event) => {
            for (const state of states) {
              if (!state.diagnosticsSubscribed) continue;
              void writeFrame(state.connection, {
                type: "event",
                event: {
                  type: "diagnostic",
                  record: event.record,
                },
              }).catch(() => {
                state.diagnosticsSubscribed = false;
                void state.connection.close().catch(() => undefined);
              });
            }
          });
          return subscription.unsubscribe;
        };
  const sendError = async (
    connection: PipeConnection,
    requestId: string,
    code: ControlPlaneErrorCode,
  ) => {
    await writeFrame(connection, {
      type: "error",
      requestId: requestId === options.endpoint.capability ? "" : requestId,
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
          state.diagnosticsSubscribed = false;
          await sendError(state.connection, "", "invalid_request");
          continue;
        }
        if (isRecord(frame.value) && frame.value.type === "hello") {
          state.authorized = false;
          state.subscribed = false;
          state.diagnosticsSubscribed = false;
        }
        const decoded = decodeClientRequest(frame.value);
        if (decoded.type === "invalid") {
          await sendError(state.connection, decoded.requestId, decoded.code);
          continue;
        }
        const request = decoded.request;
        if (request.requestId === options.endpoint.capability) {
          await sendError(
            state.connection,
            request.requestId,
            "invalid_request",
          );
          continue;
        }
        if (request.type === "hello") {
          if (request.capability !== options.endpoint.capability) {
            await sendError(
              state.connection,
              request.requestId,
              "unauthorized",
            );
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
          await sendError(
            state.connection,
            request.requestId,
            "hello_required",
          );
          continue;
        }
        if (request.type === "get_status") {
          await writeFrame(state.connection, {
            type: "status_result",
            requestId: request.requestId,
            snapshot: current,
          });
        } else if (request.type === "get_diagnostics") {
          if (diagnostics === undefined) {
            await sendError(
              state.connection,
              request.requestId,
              "unknown_command",
            );
          } else {
            const query = decodeDiagnosticQuery(request.query);
            if (query === undefined && request.query !== undefined) {
              await sendError(
                state.connection,
                request.requestId,
                "invalid_request",
              );
            } else {
              await writeFrame(state.connection, {
                type: "diagnostics_result",
                requestId: request.requestId,
                result: diagnostics.query(normalizeDiagnosticQuery(query)),
              });
            }
          }
        } else if (request.type === "get_request_identities") {
          if (options.requestIdentitiesHandler === undefined) {
            await sendError(
              state.connection,
              request.requestId,
              "unknown_command",
            );
          } else {
            let records: RequestIdentityRecord[];
            try {
              const result = await options.requestIdentitiesHandler();
              // Strict per-record validation at the wire boundary: a record
              // that ever carries the internal effective session identity
              // (or any unknown key) is rejected instead of projected.
              records = result.records
                .map((record) => decodeRequestIdentityRecord(record))
                .filter(
                  (record): record is NonNullable<typeof record> =>
                    record !== undefined,
                );
              if (records.length !== result.records.length) {
                await sendError(
                  state.connection,
                  request.requestId,
                  "invalid_request",
                );
                continue;
              }
            } catch {
              await sendError(
                state.connection,
                request.requestId,
                "invalid_request",
              );
              continue;
            }
            await writeFrame(state.connection, {
              type: "request_identities_result",
              requestId: request.requestId,
              result: { records },
            });
          }
        } else if (request.type === "diagnostics_subscribe") {
          if (diagnostics === undefined) {
            await sendError(
              state.connection,
              request.requestId,
              "unknown_command",
            );
          } else {
            state.diagnosticsSubscribed = true;
            await writeFrame(state.connection, {
              type: "subscribed",
              requestId: request.requestId,
            });
          }
        } else if (request.type === "diagnostics_unsubscribe") {
          state.diagnosticsSubscribed = false;
          await writeFrame(state.connection, {
            type: "unsubscribed",
            requestId: request.requestId,
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
        } else if (request.type === "settings_command") {
          if (options.settingsCommandHandler === undefined) {
            await writeFrame(state.connection, {
              type: "error",
              requestId: request.requestId,
              code: "unknown_command",
            });
            continue;
          }
          const handled = await options.settingsCommandHandler(request.command);
          const result = decodeSettingsCommandResult({
            outcome: handled.outcome,
            ...(handled.error === undefined ? {} : { error: handled.error }),
            ...(handled.confirmation === undefined
              ? {}
              : { confirmation: handled.confirmation }),
            settings: handled.settings,
          });
          if (result === undefined) {
            await writeFrame(state.connection, {
              type: "error",
              requestId: request.requestId,
              code: "invalid_request",
            });
            continue;
          }
          if (
            handled.outcome === "applied" ||
            handled.outcome === "pending" ||
            handled.outcome === "confirmation_required"
          ) {
            // The live projection is merged by publishStatus, so the base
            // status alone is enough to emit the settings_changed event.
            await publishStatus({
              modelDataPlane: current.modelDataPlane,
              provider: current.provider,
              ...(current.dataPlane === undefined
                ? {}
                : { dataPlane: current.dataPlane }),
            });
          }
          await writeFrame(state.connection, {
            type: "settings_command_result",
            requestId: request.requestId,
            result,
          });
        } else if (request.type === "application_command") {
          let execution: ReturnType<typeof decodeApplicationCommandExecution>;
          if (
            request.command.command === "quit" &&
            request.command.acknowledged !== true
          ) {
            // Wire contract (Ticket 05): a non-owner Quit is explicit. An
            // unacknowledged quit can never silently kill the user-started
            // headless process; it is refused before reaching the handler.
            execution = {
              outcome: "conflict",
              conflict: {
                code: "quit_requires_explicit_confirmation",
                message:
                  "Quitting would stop the LuckyToken gateway that another process started. Acknowledge the quit explicitly to continue.",
              },
            };
          } else if (options.applicationCommandHandler === undefined) {
            await writeFrame(state.connection, {
              type: "error",
              requestId: request.requestId,
              code: "unknown_command",
            });
            continue;
          } else {
            const handled = await options.applicationCommandHandler(
              request.command,
              async (status) => {
                await publishStatus(status);
              },
            );
            execution = decodeApplicationCommandExecution(handled) ?? {
              outcome: "failed",
            };
          }
          const result: ApplicationCommandResult = {
            command: request.command.command,
            ...execution,
            snapshot: current,
          };
          await writeFrame(state.connection, {
            type: "application_command_result",
            requestId: request.requestId,
            result,
          });
          await options.onApplicationCommandResultDelivered?.(
            request.command,
            result,
          );
        } else if (request.type === "client_token_command") {
          if (options.clientTokenCommandHandler === undefined) {
            await writeFrame(state.connection, {
              type: "error",
              requestId: request.requestId,
              code: "unknown_command",
            });
            continue;
          }
          let handled: ClientTokenCommandResult;
          try {
            handled = await options.clientTokenCommandHandler(request.command);
          } catch {
            handled = {
              outcome: "unavailable",
              revision: 0,
              error: "Client Token Authority is unavailable",
            };
          }
          // Validate the handler result against the request command before
          // it is written: a masked scope field can never carry a raw token
          // and a Reveal can only return the requested active secret.
          const result = decodeClientTokenCommandResult(
            handled,
            request.command,
          );
          if (result === undefined) {
            await writeFrame(state.connection, {
              type: "error",
              requestId: request.requestId,
              code: "invalid_request",
            });
            continue;
          }
          await writeFrame(state.connection, {
            type: "client_token_command_result",
            requestId: request.requestId,
            result,
          });
        } else if (request.type === "catalog_command") {
          if (options.catalogCommandHandler === undefined) {
            await writeFrame(state.connection, {
              type: "error",
              requestId: request.requestId,
              code: "unknown_command",
            });
            continue;
          }
          let handled: CatalogCommandResult;
          try {
            handled = await options.catalogCommandHandler(request.command);
          } catch {
            handled = {
              outcome: "unavailable",
              snapshot: Object.freeze({
                version: 0,
                modelsJsonValid: true,
                providers: Object.freeze([]),
                refreshErrors: Object.freeze([]),
              }),
            };
          }
          const result = decodeCatalogCommandResult(handled);
          if (result === undefined) {
            await writeFrame(state.connection, {
              type: "error",
              requestId: request.requestId,
              code: "invalid_request",
            });
            continue;
          }
          await writeFrame(state.connection, {
            type: "catalog_command_result",
            requestId: request.requestId,
            result,
          });
        } else if (request.type === "models_command") {
          if (options.modelsCommandHandler === undefined) {
            await writeFrame(state.connection, {
              type: "error",
              requestId: request.requestId,
              code: "unknown_command",
            });
            continue;
          }
          // A models command publishes only when it changed the authoritative
          // revision: reads (query) are side-effect free, and byte-identical
          // no-op writes do not broadcast a state change. A revision change
          // discovered by a command (e.g. an external edit) is a real file
          // mutation and does publish, keeping subscribers current.
          const modelsBefore = options.modelsProjection?.();
          const handled = await options.modelsCommandHandler(request.command);
          const result = decodeModelsCommandResult(handled);
          if (result === undefined) {
            await writeFrame(state.connection, {
              type: "error",
              requestId: request.requestId,
              code: "invalid_request",
            });
            continue;
          }
          if (
            handled.outcome === "ok" &&
            modelsBefore !== undefined &&
            result.state.revision !== modelsBefore.revision
          ) {
            // A successful write changed the authoritative file: publish the
            // resulting models projection (and revision) to every subscriber.
            await publishStatus({
              modelDataPlane: current.modelDataPlane,
              provider: current.provider,
              ...(current.dataPlane === undefined
                ? {}
                : { dataPlane: current.dataPlane }),
            });
          }
          await writeFrame(state.connection, {
            type: "models_command_result",
            requestId: request.requestId,
            result,
          });
        } else if (request.type === "credential_command") {
          if (options.credentialCommandHandler === undefined) {
            await writeFrame(state.connection, {
              type: "error",
              requestId: request.requestId,
              code: "unknown_command",
            });
            continue;
          }
          // A credential command publishes only when it changed the
          // authoritative revision: reads (query) are side-effect free and
          // no-op writes do not broadcast. A revision change discovered by
          // a command (e.g. an external edit) is a real file mutation and
          // does publish, keeping subscribers current.
          const credentialsBefore = options.credentialProjection?.();
          let handled: CredentialCommandResult;
          try {
            handled = await options.credentialCommandHandler(request.command);
          } catch {
            handled = {
              outcome: "unavailable",
              revision: 0,
              state: {
                revision: 0,
                path: "",
                present: false,
                valid: false,
                providers: [],
              },
              error: "Credential Authority is unavailable",
            };
          }
          // Validate the handler result against the request command before
          // it is written: credential values or raw credential shapes can
          // never pass the wire boundary.
          const result = decodeCredentialCommandResult(
            handled,
            request.command,
          );
          if (result === undefined) {
            await writeFrame(state.connection, {
              type: "error",
              requestId: request.requestId,
              code: "invalid_request",
            });
            continue;
          }
          if (
            handled.outcome === "ok" &&
            credentialsBefore !== undefined &&
            handled.revision !== credentialsBefore.revision
          ) {
            // A successful write changed the authoritative file: publish
            // the resulting credential projection to every subscriber.
            await publishStatus({
              modelDataPlane: current.modelDataPlane,
              provider: current.provider,
              ...(current.dataPlane === undefined
                ? {}
                : { dataPlane: current.dataPlane }),
            });
          }
          await writeFrame(state.connection, {
            type: "credential_command_result",
            requestId: request.requestId,
            result,
          });
        } else if (request.type === "subscribe") {
          state.subscribed = true;
          await writeFrame(state.connection, {
            type: "subscribed",
            requestId: request.requestId,
          });
        } else {
          state.subscribed = false;
          state.diagnosticsSubscribed = false;
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
        diagnosticsSubscribed: false,
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
      current = { ...mergedStatus(safeStatus), sequence: current.sequence + 1 };
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

  const diagnosticsListener = emitDiagnostics?.();

  return {
    endpoint: options.endpoint,
    publishStatus,
    async close() {
      if (closed) return;
      closed = true;
      diagnosticsListener?.();
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
