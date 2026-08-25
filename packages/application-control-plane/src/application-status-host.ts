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
  type AgentIntegrationsCommandHandler,
  type AgentIntegrationsCommandResult,
  type ControlPlaneEndpoint,
  type ModelsCommandHandler,
  type ModelsProjection,
  type PublicModelsCommandHandler,
  type PublicModelsCommandResult,
  type RunningControlPlane,
  type RuntimeCommandExecution,
  type RuntimeCommandHandler,
  type SettingsCommandHandler,
  type SettingsProjection,
  type StatusSnapshot,
} from "./contracts.js";
import {
  type AuthInteractionChannel,
  type AuthInteractionEvent,
  type HistoryCommandHandler,
} from "./contracts.js";
import type {
  CredentialProfilesCommandHandler,
  CredentialProfilesCommandResult,
  CredentialProfilesProjectionV1,
  ProviderProfileAuthCommandHandler,
  ProviderProfileAuthCommandResult,
} from "./credential-profiles-contract.js";
import type {
  BackupCommandHandler,
  RecoveryProjection,
} from "./backup-contract.js";
import type { AttentionProjection } from "./attention-contract.js";
import type {
  DiagnosticsReadResult,
  DiagnosticsSubscription,
  UnifiedDiagnosticsManagement,
} from "./request-diagnostics-contract.js";
import { readFrame, writeFrame } from "./framing.js";
import {
  assertPipeAccess,
  type PipeAccessRequirement,
  type PipeConnection,
  type PipeServerFactory,
} from "./pipe-transport.js";
import {
  decodeRequestArtifactChunkReadResult,
  decodeRequestJourneyDetailReadResult,
  decodeRequestJourneyQueryReadResult,
  decodeRequestJourneySummary,
  decodeRuntimeEventQueryReadResult,
  decodeRuntimeEventRecord,
} from "./wire-request-diagnostics.js";
import { decodeAnalyticsManagementResult } from "./wire-analytics.js";
import type { AnalyticsQueryHandler } from "./analytics-contract.js";
import {
  compatibleHello,
  decodeApplicationCommandExecution,
  decodeApplicationStatus,
  decodeCatalogCommandResult,
  decodeAgentIntegrationsCommandResult,
  decodeClientRequest,
  decodeModelsCommandResult,
  decodePublicModelsCommandResult,
  decodeRuntimeCommandExecution,
  decodeSettingsCommandResult,
  incompatibleHello,
  isRecord,
  type ControlPlaneErrorCode,
} from "./wire.js";
import {
  decodeCredentialProfilesCommandResult,
  decodeProviderProfileAuthCommandResult,
} from "./wire-credential-profiles.js";
import { decodeHistoryCommandResult } from "./wire-history.js";
import { decodeBackupManagementResult } from "./wire-backup.js";
import type { HistoryCommand, HistoryCommandResult, HistoryRange } from "./history-contract.js";

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

  /** Optional models.json catalog command handler (Ticket 08). */
  readonly modelsCommandHandler?: ModelsCommandHandler;
  readonly credentialProfilesCommandHandler?: CredentialProfilesCommandHandler;
  /**
   * Optional Provider-auth command handler (Ticket 13): serves the
   * versioned auth query/login commands. A login gets a live interaction
   * channel bound to the requesting connection; typed interaction events
   * and prompt responses round-trip through it until the terminal result.
   */
  readonly providerProfileAuthCommandHandler?: ProviderProfileAuthCommandHandler;
  /**
   * Optional catalog command handler (Ticket 11): serves the versioned
   * catalog query/refresh commands against the authoritative active
   * catalog snapshot.
   */
  readonly catalogCommandHandler?: CatalogCommandHandler;
  /** The one live Public Model command seam used by desktop/CLI product
   * clients. The backing JSON file is never a Control Plane surface. */
  readonly publicModelsCommandHandler?: PublicModelsCommandHandler;
  /** Optional Codex/Pi external Agent integration control seam. */
  readonly agentIntegrationsCommandHandler?: AgentIntegrationsCommandHandler;
  /** Live settings projection merged into every published snapshot. */
  readonly settingsProjection?: () => SettingsProjection;
  /** Live sanitized models.json projection merged into every snapshot. */
  readonly modelsProjection?: () => ModelsProjection;
  readonly credentialProfilesProjection?: () =>
    CredentialProfilesProjectionV1 | undefined;
  /** Live sanitized catalog lifecycle projection merged into every
   *  published snapshot (Ticket 11). */
  readonly catalogProjection?: () => CatalogStatusProjection;
  /** Unified Request Journey and Runtime diagnostics management authority. */
  readonly diagnostics?: UnifiedDiagnosticsManagement;
  /**
   * Explicit Request Analytics ownership (Ticket 21): when present, the
   * Control Plane serves bounded, versioned analytics aggregates computed
   * at query time over the Request Ledger. The query is already normalized
   * by the contract decoder when it reaches the handler; the handler is a
   * narrow result provider and performs no wire logic. An absent analytics
   * handler is served as `unknown_command` (legacy clients are unaffected).
   */
  readonly analyticsHandler?: AnalyticsQueryHandler;
  /**
   * Explicit history command handler (Ticket 23): serves the versioned
   * history query/export/delete/acknowledge commands against the live
   * authorities. An absent handler is served as `unknown_command` (legacy
   * clients are unaffected). The per-command signal aborts when the
   * requesting connection closes, so an in-flight export never publishes
   * after its client is gone.
   */
  readonly historyCommandHandler?: HistoryCommandHandler;
  /** Ticket 24 backup command authority. */
  readonly backupCommandHandler?: BackupCommandHandler;
  /** Ticket 24 incompatible-owned-file projection. */
  readonly recoveryProjection?: () => RecoveryProjection | undefined;
  /** Ticket 25 owner-side actionable condition projection. */
  readonly attentionProjection?: (
    status: ApplicationStatus,
  ) => AttentionProjection | undefined;
}

interface ConnectionState {
  readonly connection: PipeConnection;
  authorized: boolean;
  subscribed: boolean;
  requestJourneysSubscription: DiagnosticsSubscription | undefined;
  runtimeEventsSubscription: DiagnosticsSubscription | undefined;
  /** One in-flight Provider-auth login flow on this connection (Ticket
   *  13); interaction events/prompt responses are routed by its id. */
  authFlow: AuthFlowState | undefined;
  /** Aborts in-flight long-running history commands (Ticket 23) when this
   *  connection closes or is torn down. */
  historyAbort: AbortController;
  /** Aborts an in-flight backup if the requesting connection is lost. */
  backupAbort: AbortController;
}

/** One in-flight Provider-auth login flow (Ticket 13). */
interface AuthFlowState {
  readonly requestId: string;
  readonly controller: AbortController;
  pendingPrompt: {
    readonly promptId: string;
    resolve(value: string): void;
    reject(error: Error): void;
  } | undefined;
  /** True once the terminal result was written or the flow was aborted. */
  settled: boolean;
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
    options.endpoint.address,
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
    const credentialProfilesProjection = options.credentialProfilesProjection?.();
    const catalogProjection = options.catalogProjection?.();
    const recoveryProjection = options.recoveryProjection?.();
    const attentionProjection = options.attentionProjection?.(status);
    return {
      ...status,
      ...(options.ownership === undefined
        ? {}
        : { ownership: options.ownership }),
      ...(projection === undefined
        ? {}
        : { settings: projection.settings }),
      ...(modelsProjection === undefined ? {} : { models: modelsProjection }),
      ...(credentialProfilesProjection === undefined
        ? {}
        : { credentialProfiles: credentialProfilesProjection }),
      ...(catalogProjection === undefined
        ? {}
        : { catalog: catalogProjection }),
      ...(recoveryProjection === undefined
        ? {}
        : { recovery: recoveryProjection }),
      ...(attentionProjection === undefined
        ? {}
        : { attention: attentionProjection }),
    };
  };
  let current: StatusSnapshot = { ...mergedStatus(initialStatus), sequence: 0 };
  let closed = false;
  let publishQueue = Promise.resolve();
  const states = new Set<ConnectionState>();
  const tasks = new Set<Promise<void>>();
  const diagnostics = options.diagnostics;
  const analyticsHandler = options.analyticsHandler;
  const unsubscribeRequestJourneys = (state: ConnectionState): void => {
    const subscription = state.requestJourneysSubscription;
    state.requestJourneysSubscription = undefined;
    try {
      subscription?.unsubscribe();
    } catch {
      // Diagnostics cleanup cannot disrupt the connection lifecycle.
    }
  };
  const unsubscribeRuntimeEvents = (state: ConnectionState): void => {
    const subscription = state.runtimeEventsSubscription;
    state.runtimeEventsSubscription = undefined;
    try {
      subscription?.unsubscribe();
    } catch {
      // Diagnostics cleanup cannot disrupt the connection lifecycle.
    }
  };
  const unsubscribeDiagnostics = (state: ConnectionState): void => {
    unsubscribeRequestJourneys(state);
    unsubscribeRuntimeEvents(state);
  };
  const diagnosticsUnavailable = Object.freeze({
    outcome: "unavailable" as const,
    error: Object.freeze({
      code: "diagnostics_unavailable" as const,
      classification: "diagnostics_storage_unavailable" as const,
      message: "Diagnostics storage is unavailable" as const,
    }),
  });
  const executeDiagnosticsRead = async <T>(
    read: () => Promise<T>,
    decode: (value: unknown) => DiagnosticsReadResult<T> | undefined,
  ): Promise<DiagnosticsReadResult<T> | undefined> => {
    try {
      return decode({ outcome: "ok", result: await read() });
    } catch (error) {
      if (
        isRecord(error) &&
        error.code === "diagnostics_unavailable" &&
        error.classification === "diagnostics_storage_unavailable"
      ) {
        return diagnosticsUnavailable;
      }
      return undefined;
    }
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

  /** A channel for commands that never interact (query). */
  const NOOP_AUTH_CHANNEL: AuthInteractionChannel = Object.freeze({
    signal: new AbortController().signal,
    notify: async () => undefined,
    prompt: async () => {
      throw new Error("Interaction is not available for this command");
    },
  });

  /** Abort a flow and reject its pending prompt (cancel / connection
   *  loss / completion). */
  const abortAuthFlow = (flow: AuthFlowState, reason: Error): void => {
    flow.settled = true;
    flow.controller.abort(reason);
    const pending = flow.pendingPrompt;
    flow.pendingPrompt = undefined;
    pending?.reject(reason);
  };

  /** One in-flight login flow: typed events are written to the owning
   *  connection, prompt responses resolve the pending prompt, and a lost
   *  connection or cancel aborts the whole Provider-owned flow. */
  const createAuthFlow = (
    state: ConnectionState,
    requestId: string,
  ): { readonly flow: AuthFlowState; readonly channel: AuthInteractionChannel } => {
    const controller = new AbortController();
    let promptSequence = 0;
    const flow: AuthFlowState = {
      requestId,
      controller,
      pendingPrompt: undefined,
      settled: false,
    };
    const channel: AuthInteractionChannel = Object.freeze({
      signal: controller.signal,
      notify(event: AuthInteractionEvent): Promise<void> {
        return writeFrame(state.connection, {
          type: "auth_interaction_event",
          requestId,
          event,
        }).catch(() => {
          // The client is gone: never leave the Provider-owned login
          // running forever against a dead connection.
          abortAuthFlow(flow, new Error("Control Plane connection lost"));
        });
      },
      prompt(input: {
        readonly kind: "text" | "secret" | "manual_code" | "select";
        readonly message: string;
        readonly placeholder?: string;
        readonly options?: readonly {
          readonly id: string;
          readonly label: string;
          readonly description?: string;
        }[];
      }): Promise<string> {
        return new Promise<string>((resolve, reject) => {
          if (flow.pendingPrompt !== undefined || flow.settled) {
            reject(new Error("Sign-in prompt is not available"));
            return;
          }
          promptSequence += 1;
          const promptId = `${requestId}-prompt-${promptSequence}`;
          flow.pendingPrompt = { promptId, resolve, reject };
          void writeFrame(state.connection, {
            type: "auth_interaction_event",
            requestId,
            event: { type: "prompt", promptId, ...input },
          }).catch(() => {
            if (flow.pendingPrompt?.promptId === promptId) {
              flow.pendingPrompt = undefined;
            }
            abortAuthFlow(flow, new Error("Control Plane connection lost"));
          });
        });
      },
    });
    return { flow, channel };
  };

  const fallbackCredentialProfilesState = (): CredentialProfilesProjectionV1 =>
    options.credentialProfilesProjection?.() ?? Object.freeze({ providers: [] });

  const serveConnection = async (state: ConnectionState): Promise<void> => {
    try {
      for (;;) {
        const frame = await readFrame(state.connection);
        if (frame.type === "end") return;
        if (frame.type === "oversized") return;
        if (frame.type === "malformed") {
          state.authorized = false;
          state.subscribed = false;
          unsubscribeDiagnostics(state);
          await sendError(state.connection, "", "invalid_request");
          continue;
        }
        if (isRecord(frame.value) && frame.value.type === "hello") {
          state.authorized = false;
          state.subscribed = false;
          unsubscribeDiagnostics(state);
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
        } else if (request.type === "query_request_journeys") {
          if (diagnostics === undefined) {
            await sendError(
              state.connection,
              request.requestId,
              "unknown_command",
            );
          } else {
            const result = await executeDiagnosticsRead(
              () => diagnostics.queryRequestJourneys(request.query),
              decodeRequestJourneyQueryReadResult,
            );
            if (result === undefined) {
              await sendError(state.connection, request.requestId, "invalid_request");
              continue;
            }
            await writeFrame(state.connection, {
              type: "request_journeys_result",
              requestId: request.requestId,
              result,
            });
          }
        } else if (request.type === "get_request_journey") {
          if (diagnostics === undefined) {
            await sendError(
              state.connection,
              request.requestId,
              "unknown_command",
            );
          } else {
            const result = await executeDiagnosticsRead(
              () => diagnostics.getRequestJourney(request.input),
              decodeRequestJourneyDetailReadResult,
            );
            if (result === undefined) {
              await sendError(state.connection, request.requestId, "invalid_request");
              continue;
            }
            await writeFrame(state.connection, {
              type: "request_journey_result",
              requestId: request.requestId,
              result,
            });
          }
        } else if (request.type === "get_request_artifact") {
          if (diagnostics === undefined) {
            await sendError(
              state.connection,
              request.requestId,
              "unknown_command",
            );
          } else {
            const result = await executeDiagnosticsRead(
              () => diagnostics.getRequestArtifact(request.input),
              decodeRequestArtifactChunkReadResult,
            );
            if (result === undefined) {
              await sendError(state.connection, request.requestId, "invalid_request");
              continue;
            }
            await writeFrame(state.connection, {
              type: "request_artifact_result",
              requestId: request.requestId,
              result,
            });
          }
        } else if (request.type === "query_runtime_events") {
          if (diagnostics === undefined) {
            await sendError(
              state.connection,
              request.requestId,
              "unknown_command",
            );
          } else {
            const result = await executeDiagnosticsRead(
              () => diagnostics.queryRuntimeEvents(request.query),
              decodeRuntimeEventQueryReadResult,
            );
            if (result === undefined) {
              await sendError(state.connection, request.requestId, "invalid_request");
              continue;
            }
            await writeFrame(state.connection, {
              type: "runtime_events_result",
              requestId: request.requestId,
              result,
            });
          }
        } else if (request.type === "request_journeys_subscribe") {
          if (diagnostics === undefined) {
            await sendError(state.connection, request.requestId, "unknown_command");
            continue;
          }
          if (state.requestJourneysSubscription === undefined) {
            try {
              state.requestJourneysSubscription =
                diagnostics.subscribeRequestJourneys((record) => {
                  const decoded = decodeRequestJourneySummary(record);
                  if (decoded === undefined) return;
                  void writeFrame(state.connection, {
                    type: "event",
                    event: { type: "request_journey", record: decoded },
                  }).catch(() => {
                    unsubscribeRequestJourneys(state);
                    void state.connection.close().catch(() => undefined);
                  });
                });
            } catch {
              await sendError(state.connection, request.requestId, "invalid_request");
              continue;
            }
          }
          await writeFrame(state.connection, {
            type: "subscribed",
            requestId: request.requestId,
          });
        } else if (request.type === "request_journeys_unsubscribe") {
          unsubscribeRequestJourneys(state);
          await writeFrame(state.connection, {
            type: "unsubscribed",
            requestId: request.requestId,
          });
        } else if (request.type === "runtime_events_subscribe") {
          if (diagnostics === undefined) {
            await sendError(state.connection, request.requestId, "unknown_command");
            continue;
          }
          if (state.runtimeEventsSubscription === undefined) {
            try {
              state.runtimeEventsSubscription = diagnostics.subscribeRuntimeEvents(
                (record) => {
                  const decoded = decodeRuntimeEventRecord(record);
                  if (decoded === undefined) return;
                  void writeFrame(state.connection, {
                    type: "event",
                    event: { type: "runtime_event", record: decoded },
                  }).catch(() => {
                    unsubscribeRuntimeEvents(state);
                    void state.connection.close().catch(() => undefined);
                  });
                },
              );
            } catch {
              await sendError(state.connection, request.requestId, "invalid_request");
              continue;
            }
          }
          await writeFrame(state.connection, {
            type: "subscribed",
            requestId: request.requestId,
          });
        } else if (request.type === "runtime_events_unsubscribe") {
          unsubscribeRuntimeEvents(state);
          await writeFrame(state.connection, {
            type: "unsubscribed",
            requestId: request.requestId,
          });
        } else if (request.type === "get_analytics") {
          if (analyticsHandler === undefined) {
            await sendError(
              state.connection,
              request.requestId,
              "unknown_command",
            );
          } else {
            let result;
            try {
              result = await analyticsHandler(request.query);
            } catch (error) {
              if (
                isRecord(error) &&
                error.code === "diagnostics_unavailable" &&
                error.classification === "diagnostics_storage_unavailable"
              ) {
                result = diagnosticsUnavailable;
              } else {
                await sendError(
                  state.connection,
                  request.requestId,
                  "invalid_request",
                );
                continue;
              }
            }
            // Strict result validation at the wire boundary: a result with
            // an unknown key (including any monetary field), a broken
            // aggregation identity, or an unsafe integer is rejected.
            if (decodeAnalyticsManagementResult(result) === undefined) {
              await sendError(
                state.connection,
                request.requestId,
                "invalid_request",
              );
              continue;
            }
            await writeFrame(state.connection, {
              type: "analytics_result",
              requestId: request.requestId,
              result,
            });
          }
        } else if (
          request.type === "history_query" ||
          request.type === "history_export_command" ||
          request.type === "history_export_confirm" ||
          request.type === "history_delete_command" ||
          request.type === "history_delete_confirm"
        ) {
          if (options.historyCommandHandler === undefined) {
            await writeFrame(state.connection, {
              type: "error",
              requestId: request.requestId,
              code: "unknown_command",
            });
            continue;
          }
          // The strict wire decoder already validated the frame; the decoded
          // request is reassembled into the versioned HistoryCommand.
          let command: HistoryCommand;
          if (request.type === "history_query") {
            const range = request.range as HistoryRange | undefined;
            command =
              range === undefined
                ? { command: "query" as const }
                : { command: "query" as const, range };
          } else if (request.type === "history_export_command") {
            command = { command: "export" as const, ...request.command };
          } else if (request.type === "history_export_confirm") {
            command = {
              command: "export_confirm" as const,
              actionId: request.actionId,
            };
          } else if (request.type === "history_delete_command") {
            command = { command: "delete" as const, ...request.command };
          } else {
            command = {
              command: "delete_confirm" as const,
              actionId: request.actionId,
            };
          }
          let handled: HistoryCommandResult | undefined;
          try {
            handled = await options.historyCommandHandler(
              command,
              state.historyAbort.signal,
            );
          } catch (error) {
            if (
              isRecord(error) &&
              error.code === "diagnostics_unavailable" &&
              error.classification === "diagnostics_storage_unavailable"
            ) {
              await writeFrame(state.connection, {
                type:
                  command.command === "query"
                    ? "history_query_result"
                    : command.command === "export" || command.command === "export_confirm"
                      ? "history_export_result"
                      : "history_delete_result",
                requestId: request.requestId,
                result: diagnosticsUnavailable,
              });
              continue;
            } else {
              handled = undefined;
            }
          }
          const decoded =
            handled === undefined
              ? undefined
              : decodeHistoryCommandResult(command.command, handled.result);
          if (decoded === undefined) {
            await writeFrame(state.connection, {
              type: "error",
              requestId: request.requestId,
              code: "invalid_request",
            });
            continue;
          }
          if (decoded.kind === "query") {
            await writeFrame(state.connection, {
              type: "history_query_result",
              requestId: request.requestId,
              result: decoded.result,
            });
          } else if (decoded.kind === "export") {
            await writeFrame(state.connection, {
              type: "history_export_result",
              requestId: request.requestId,
              result: decoded.result,
            });
          } else {
            await writeFrame(state.connection, {
              type: "history_delete_result",
              requestId: request.requestId,
              result: decoded.result,
            });
          }
        } else if (request.type === "backup_command") {
          if (options.backupCommandHandler === undefined) {
            await writeFrame(state.connection, {
              type: "error",
              requestId: request.requestId,
              code: "unknown_command",
            });
            continue;
          }
          let handled;
          try {
            handled = await options.backupCommandHandler(
              request.command,
              state.backupAbort.signal,
            );
          } catch (error) {
            handled =
              isRecord(error) &&
              error.code === "diagnostics_unavailable" &&
              error.classification === "diagnostics_storage_unavailable"
                ? diagnosticsUnavailable
                : undefined;
          }
          const decoded = decodeBackupManagementResult(handled);
          if (decoded === undefined) {
            await writeFrame(state.connection, {
              type: "error",
              requestId: request.requestId,
              code: "invalid_request",
            });
            continue;
          }
          await writeFrame(state.connection, {
            type: "backup_result",
            requestId: request.requestId,
            result: decoded,
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
            handled.outcome === "pending"
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
                  "Quitting would stop the Token gateway that another process started. Acknowledge the quit explicitly to continue.",
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
        } else if (request.type === "public_models_command") {
          if (options.publicModelsCommandHandler === undefined) {
            await writeFrame(state.connection, {
              type: "error",
              requestId: request.requestId,
              code: "unknown_command",
            });
            continue;
          }
          let handled: PublicModelsCommandResult;
          try {
            handled = await options.publicModelsCommandHandler(request.command);
          } catch {
            await writeFrame(state.connection, {
              type: "error",
              requestId: request.requestId,
              code: "invalid_request",
            });
            continue;
          }
          const result = decodePublicModelsCommandResult(handled);
          if (result === undefined) {
            await writeFrame(state.connection, {
              type: "error",
              requestId: request.requestId,
              code: "invalid_request",
            });
            continue;
          }
          if (handled.outcome === "ok" && request.command.command !== "query") {
            await publishStatus({
              modelDataPlane: current.modelDataPlane,
              provider: current.provider,
              ...(current.dataPlane === undefined
                ? {}
                : { dataPlane: current.dataPlane }),
            });
          }
          await writeFrame(state.connection, {
            type: "public_models_command_result",
            requestId: request.requestId,
            result,
          });
        } else if (request.type === "agent_integrations_command") {
          if (options.agentIntegrationsCommandHandler === undefined) {
            await writeFrame(state.connection, {
              type: "error",
              requestId: request.requestId,
              code: "unknown_command",
            });
            continue;
          }
          let handled: AgentIntegrationsCommandResult;
          try {
            handled = await options.agentIntegrationsCommandHandler(request.command);
          } catch {
            await writeFrame(state.connection, {
              type: "error",
              requestId: request.requestId,
              code: "invalid_request",
            });
            continue;
          }
          const result = decodeAgentIntegrationsCommandResult(handled);
          if (result === undefined) {
            await writeFrame(state.connection, {
              type: "error",
              requestId: request.requestId,
              code: "invalid_request",
            });
            continue;
          }
          await writeFrame(state.connection, {
            type: "agent_integrations_command_result",
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
        } else if (request.type === "credential_profiles_command") {
          if (options.credentialProfilesCommandHandler === undefined) {
            await sendError(state.connection, request.requestId, "unknown_command");
            continue;
          }
          let handled: CredentialProfilesCommandResult;
          try {
            handled = await options.credentialProfilesCommandHandler(
              request.command,
            );
          } catch {
            handled = {
              outcome: "unavailable",
              state: fallbackCredentialProfilesState(),
              error: "Credential Profiles are unavailable",
            };
          }
          const result = decodeCredentialProfilesCommandResult(handled);
          if (result === undefined) {
            await sendError(state.connection, request.requestId, "invalid_request");
            continue;
          }
          await writeFrame(state.connection, {
            type: "credential_profiles_command_result",
            requestId: request.requestId,
            result,
          });
        } else if (request.type === "provider_profile_auth_command") {
          if (options.providerProfileAuthCommandHandler === undefined) {
            await sendError(state.connection, request.requestId, "unknown_command");
            continue;
          }
          if (request.command.command !== "query") {
            if (state.authFlow !== undefined) {
              await writeFrame(state.connection, {
                type: "provider_profile_auth_command_result",
                requestId: request.requestId,
                result: {
                  outcome: "conflict",
                  state: fallbackCredentialProfilesState(),
                  error: "Another sign-in is already in progress",
                },
              });
              continue;
            }
            const { flow, channel } = createAuthFlow(state, request.requestId);
            state.authFlow = flow;
            void (async () => {
              let handled: ProviderProfileAuthCommandResult;
              try {
                handled = await options.providerProfileAuthCommandHandler!(
                  request.command,
                  channel,
                );
              } catch {
                handled = {
                  outcome: "unavailable",
                  state: fallbackCredentialProfilesState(),
                  error: "Provider sign-in is unavailable",
                };
              }
              const result = decodeProviderProfileAuthCommandResult(handled);
              if (result === undefined) {
                await sendError(
                  state.connection,
                  request.requestId,
                  "invalid_request",
                );
              } else {
                await writeFrame(state.connection, {
                  type: "provider_profile_auth_command_result",
                  requestId: request.requestId,
                  result,
                }).catch(() => undefined);
              }
              if (state.authFlow === flow) state.authFlow = undefined;
              abortAuthFlow(flow, new Error("Sign-in flow finished"));
            })();
            continue;
          }
          let handled: ProviderProfileAuthCommandResult;
          try {
            handled = await options.providerProfileAuthCommandHandler(
              request.command,
              NOOP_AUTH_CHANNEL,
            );
          } catch {
            handled = {
              outcome: "unavailable",
              state: fallbackCredentialProfilesState(),
              error: "Provider sign-in is unavailable",
            };
          }
          const result = decodeProviderProfileAuthCommandResult(handled);
          if (result === undefined) {
            await sendError(state.connection, request.requestId, "invalid_request");
          } else {
            await writeFrame(state.connection, {
              type: "provider_profile_auth_command_result",
              requestId: request.requestId,
              result,
            });
          }
        } else if (request.type === "auth_interaction_response") {
          const flow = state.authFlow;
          if (
            flow === undefined ||
            flow.settled ||
            request.requestId !== flow.requestId
          ) {
            await sendError(
              state.connection,
              request.requestId,
              "invalid_request",
            );
            continue;
          }
          if (request.response.type === "cancel") {
            // Reject the pending prompt and abort the flow; the login
            // resolves with a terminal cancelled result.
            abortAuthFlow(
              flow,
              new Error("Sign-in cancelled"),
            );
            continue;
          }
          const pending = flow.pendingPrompt;
          if (pending === undefined || pending.promptId !== request.response.promptId) {
            await sendError(
              state.connection,
              request.requestId,
              "invalid_request",
            );
            continue;
          }
          flow.pendingPrompt = undefined;
          pending.resolve(request.response.value);
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
      unsubscribeDiagnostics(state);
      // A closed/lost connection aborts any in-flight history command (e.g.
      // a long export), so it never publishes an artifact its requester can
      // no longer receive.
      state.historyAbort.abort();
      state.backupAbort.abort();
      if (state.authFlow !== undefined) {
        abortAuthFlow(
          state.authFlow,
          new Error("Control Plane connection closed"),
        );
      }
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
        requestJourneysSubscription: undefined,
        runtimeEventsSubscription: undefined,
        authFlow: undefined,
        historyAbort: new AbortController(),
        backupAbort: new AbortController(),
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
