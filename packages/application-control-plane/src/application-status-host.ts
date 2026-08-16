import {
  assertControlPlaneEndpoint,
  controlPlaneVersion,
  type AliasCommandHandler,
  type AliasCommandResult,
  type AliasStatusProjection,
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
  type AuthCommandHandler,
  type AuthCommandResult,
  type AuthInteractionChannel,
  type AuthInteractionEvent,
  type CredentialCommandHandler,
  type CredentialCommandResult,
  type CredentialProjection,
} from "./contracts.js";
import {
  type ControlPlaneDiagnostics,
  normalizeDiagnosticQuery,
} from "./diagnostics-contract.js";
import type { ControlPlaneRequestLedger } from "./ledger-contract.js";
import { readFrame, writeFrame } from "./framing.js";
import {
  assertPipeAccess,
  type PipeAccessRequirement,
  type PipeConnection,
  type PipeServerFactory,
} from "./pipe-transport.js";
import { decodeDiagnosticQuery } from "./wire-diagnostics.js";
import {
  decodeRequestLedgerQuery,
  decodeRequestLedgerRecord,
} from "./wire-ledger.js";
import {
  compatibleHello,
  decodeAliasCommandResult,
  decodeApplicationCommandExecution,
  decodeApplicationStatus,
  decodeAuthCommandResult,
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
   * Optional Provider-auth command handler (Ticket 13): serves the
   * versioned auth query/login commands. A login gets a live interaction
   * channel bound to the requesting connection; typed interaction events
   * and prompt responses round-trip through it until the terminal result.
   */
  readonly authCommandHandler?: AuthCommandHandler;
  /**
   * Optional catalog command handler (Ticket 11): serves the versioned
   * catalog query/refresh commands against the authoritative active
   * catalog snapshot.
   */
  readonly catalogCommandHandler?: CatalogCommandHandler;
  /** Optional alias registry command handler (Ticket 14): serves the
   *  versioned alias commands against the live model-aliases.json
   *  authority. */
  readonly aliasCommandHandler?: AliasCommandHandler;
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
  /** Live sanitized model-aliases.json projection merged into every
   *  published snapshot (Ticket 14). */
  readonly aliasesProjection?: () => AliasStatusProjection;
  /**
   * Explicit diagnostics ownership (Ticket 07): when present, the Control
   * Plane serves bounded diagnostics queries and typed diagnostic events to
   * subscribers that requested them. Status subscribers never receive
   * diagnostic events.
   */
  readonly diagnostics?: ControlPlaneDiagnostics;
  /**
   * Explicit Request Ledger ownership (Ticket 18): when present, the
   * Control Plane serves bounded ledger queries and opt-in typed committed-
   * record events. Status and diagnostics subscribers never receive ledger
   * events, and an absent ledger is served as `unknown_command` (legacy
   * clients are unaffected).
   */
  readonly requestLedger?: ControlPlaneRequestLedger;
}

interface ConnectionState {
  readonly connection: PipeConnection;
  authorized: boolean;
  subscribed: boolean;
  diagnosticsSubscribed: boolean;
  ledgerSubscribed: boolean;
  /** One in-flight Provider-auth login flow on this connection (Ticket
   *  13); interaction events/prompt responses are routed by its id. */
  authFlow: AuthFlowState | undefined;
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

/** Minimal value-free projection for unavailable/busy results (the
 *  authority is not running, so no path exists yet). */
const EMPTY_CREDENTIAL_PROJECTION: CredentialProjection = Object.freeze({
  revision: 0,
  path: "",
  present: false,
  valid: false,
  providers: Object.freeze([]),
});

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
    const aliasesProjection = options.aliasesProjection?.();
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
      ...(aliasesProjection === undefined
        ? {}
        : { aliases: aliasesProjection }),
    };
  };
  let current: StatusSnapshot = { ...mergedStatus(initialStatus), sequence: 0 };
  let closed = false;
  let publishQueue = Promise.resolve();
  const states = new Set<ConnectionState>();
  const tasks = new Set<Promise<void>>();
  const diagnostics = options.diagnostics;
  const ledger = options.requestLedger;
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
  const emitLedger =
    ledger === undefined
      ? undefined
      : () => {
          const subscription = ledger.subscribe((event) => {
            for (const state of states) {
              if (!state.ledgerSubscribed) continue;
              void writeFrame(state.connection, {
                type: "event",
                event: {
                  type: "request_ledger",
                  record: event.record,
                },
              }).catch(() => {
                state.ledgerSubscribed = false;
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

  const fallbackAuthState = (): CredentialProjection =>
    options.credentialProjection?.() ?? EMPTY_CREDENTIAL_PROJECTION;

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
        } else if (request.type === "get_request_ledger") {
          if (ledger === undefined) {
            await sendError(
              state.connection,
              request.requestId,
              "unknown_command",
            );
          } else {
            const query = decodeRequestLedgerQuery(request.query);
            if (query === undefined && request.query !== undefined) {
              await sendError(
                state.connection,
                request.requestId,
                "invalid_request",
              );
            } else {
              let result;
              try {
                result = ledger.query(query);
              } catch {
                await sendError(
                  state.connection,
                  request.requestId,
                  "invalid_request",
                );
                continue;
              }
              // Strict per-record validation at the wire boundary: a record
              // with an unknown key, an invalid bounded value, or the
              // effective session identity projected as the client id is
              // rejected instead of delivered.
              const records = result.records
                .map((record) => decodeRequestLedgerRecord(record))
                .filter(
                  (record): record is NonNullable<typeof record> =>
                    record !== undefined,
                );
              if (
                records.length !== result.records.length ||
                typeof result.hasMore !== "boolean"
              ) {
                await sendError(
                  state.connection,
                  request.requestId,
                  "invalid_request",
                );
                continue;
              }
              await writeFrame(state.connection, {
                type: "request_ledger_result",
                requestId: request.requestId,
                result: { records, hasMore: result.hasMore },
              });
            }
          }
        } else if (request.type === "ledger_subscribe") {
          if (ledger === undefined) {
            await sendError(
              state.connection,
              request.requestId,
              "unknown_command",
            );
          } else {
            state.ledgerSubscribed = true;
            await writeFrame(state.connection, {
              type: "subscribed",
              requestId: request.requestId,
            });
          }
        } else if (request.type === "ledger_unsubscribe") {
          state.ledgerSubscribed = false;
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
        } else if (request.type === "alias_command") {
          if (options.aliasCommandHandler === undefined) {
            await writeFrame(state.connection, {
              type: "error",
              requestId: request.requestId,
              code: "unknown_command",
            });
            continue;
          }
          // An alias command publishes only when it changed the
          // authoritative revision (external edits discovered by a query or
          // a successful write); read-only queries never broadcast.
          const aliasesBefore = options.aliasesProjection?.();
          let handled: AliasCommandResult;
          try {
            handled = await options.aliasCommandHandler(request.command);
          } catch {
            await writeFrame(state.connection, {
              type: "error",
              requestId: request.requestId,
              code: "invalid_request",
            });
            continue;
          }
          const result = decodeAliasCommandResult(handled);
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
            aliasesBefore !== undefined &&
            result.state.revision !== aliasesBefore.revision
          ) {
            await publishStatus({
              modelDataPlane: current.modelDataPlane,
              provider: current.provider,
              ...(current.dataPlane === undefined
                ? {}
                : { dataPlane: current.dataPlane }),
            });
          }
          await writeFrame(state.connection, {
            type: "alias_command_result",
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
        } else if (request.type === "auth_command") {
          if (options.authCommandHandler === undefined) {
            await sendError(state.connection, request.requestId, "unknown_command");
            continue;
          }
          if (request.command.command === "login") {
            if (state.authFlow !== undefined) {
              // One in-flight login per connection: a second login is
              // refused instead of racing the Provider-owned flow.
              await writeFrame(state.connection, {
                type: "auth_command_result",
                requestId: request.requestId,
                result: {
                  outcome: "conflict",
                  state: fallbackAuthState(),
                  error: "Another sign-in is already in progress",
                },
              });
              continue;
            }
            // The login runs as a task: interaction responses arrive on
            // this connection while the Provider-owned flow is pending.
            const { flow, channel } = createAuthFlow(state, request.requestId);
            state.authFlow = flow;
            void (async () => {
              const credentialsBefore = options.credentialProjection?.();
              let handled: AuthCommandResult;
              try {
                handled = await options.authCommandHandler!(
                  request.command,
                  channel,
                );
              } catch {
                handled = {
                  outcome: "unavailable",
                  state: fallbackAuthState(),
                  error: "Provider sign-in is unavailable",
                };
              }
              const result = decodeAuthCommandResult(handled, request.command);
              if (result === undefined) {
                await sendError(
                  state.connection,
                  request.requestId,
                  "invalid_request",
                );
              } else {
                await writeFrame(state.connection, {
                  type: "auth_command_result",
                  requestId: request.requestId,
                  result,
                }).catch(() => undefined);
                if (
                  result.outcome === "ok" &&
                  credentialsBefore !== undefined &&
                  result.state.revision !== credentialsBefore.revision
                ) {
                  // A successful login changed the authoritative file:
                  // publish the resulting credential projection (and the
                  // scheduled Ticket 11 catalog refresh) to subscribers.
                  await publishStatus({
                    modelDataPlane: current.modelDataPlane,
                    provider: current.provider,
                    ...(current.dataPlane === undefined
                      ? {}
                      : { dataPlane: current.dataPlane }),
                  });
                }
              }
              if (state.authFlow === flow) state.authFlow = undefined;
              abortAuthFlow(
                flow,
                new Error("Sign-in flow finished"),
              );
            })();
            continue;
          }
          // query: never uses the interaction channel.
          let handled: AuthCommandResult;
          try {
            handled = await options.authCommandHandler(
              request.command,
              NOOP_AUTH_CHANNEL,
            );
          } catch {
            handled = {
              outcome: "unavailable",
              state: fallbackAuthState(),
              error: "Provider sign-in is unavailable",
            };
          }
          const result = decodeAuthCommandResult(handled, request.command);
          if (result === undefined) {
            await sendError(state.connection, request.requestId, "invalid_request");
          } else {
            await writeFrame(state.connection, {
              type: "auth_command_result",
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
          state.diagnosticsSubscribed = false;
          state.ledgerSubscribed = false;
          await writeFrame(state.connection, {
            type: "unsubscribed",
            requestId: request.requestId,
          });
        }
      }
    } finally {
      states.delete(state);
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
        diagnosticsSubscribed: false,
        ledgerSubscribed: false,
        authFlow: undefined,
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
  const ledgerListener = emitLedger?.();

  return {
    endpoint: options.endpoint,
    publishStatus,
    async close() {
      if (closed) return;
      closed = true;
      diagnosticsListener?.();
      ledgerListener?.();
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
