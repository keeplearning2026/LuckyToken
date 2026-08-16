import type { Event } from "@tauri-apps/api/event";
import type {
  AliasCommand,
  AliasCommandResult,
  ApplicationOwnership,
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
  MaskedClientTokenScope,
  ModelsCommand,
  RegisteredSetting,
  RequestIdentitiesQueryResult,
  RequestIdentityRecord,
  RequestLedgerEvent,
  RequestLedgerQuery,
  RequestLedgerQueryResult,
  RuntimeCommand,
  SettingsCommand,
} from "@luckytoken/application-control-plane/control-plane";
import {
  decodeRequestLedgerRecord,
  decodeRequestLedgerResult,
} from "@luckytoken/application-control-plane/control-plane";

import {
  decodeAliasCommandResult,
  decodeAliasStatusProjection,
  decodeAuthCommandResult,
  decodeAuthInteractionEvent,
  decodeCatalogCommandResult,
  decodeCredentialCommandResult,
  decodeModelsCommandResult,
  decodeModelsProjection,
  projectControlPlaneState,
  type ControlPlaneBridgePayload,
  type ControlPlaneState,
} from "./control-plane-projection.js";
import type { AutoStartProjection } from "./shell-lifecycle.js";

export type ShellCommand =
  | "shell_snapshot"
  | "shell_retry"
  | "shell_start"
  | "shell_stop"
  | "shell_restart"
  | "shell_settings_query"
  | "shell_settings_set"
  | "shell_settings_confirm"
  | "shell_auto_start_status"
  | "shell_auto_start_enable"
  | "shell_auto_start_disable"
  | "shell_client_tokens_list"
  | "shell_client_tokens_create"
  | "shell_client_tokens_reveal"
  | "shell_client_tokens_rotate"
  | "shell_client_tokens_remove"
  | "shell_diagnostics_warnings"
  | "shell_pick_directory"
  | "shell_request_identities"
  | "shell_models_query"
  | "shell_models_write_raw"
  | "shell_models_write_structured"
  | "shell_credentials_query"
  | "shell_credentials_login"
  | "shell_credentials_logout"
  | "shell_credentials_import_preview"
  | "shell_credentials_import_apply"
  | "shell_auth_query"
  | "shell_auth_login"
  | "shell_auth_respond"
  | "shell_open_url"
  | "shell_catalog_query"
  | "shell_catalog_refresh"
  | "shell_aliases_query"
  | "shell_aliases_write"
  | "shell_request_ledger_query"
  | "shell_request_ledger_subscribe"
  | "shell_request_ledger_unsubscribe";

export interface NativeTauriBridge {
  invoke(command: ShellCommand, args?: unknown): Promise<unknown>;
  listen(
    event: "luckytoken://shell-state",
    listener: (
      event: Pick<Event<ControlPlaneBridgePayload>, "payload">,
    ) => void,
  ): Promise<() => void>;
  /** Typed Provider-auth interaction events (Ticket 13): the native shell
   *  forwards allowlisted events here while a login flow is pending. The
   *  payload is opaque JSON; the runtime strictly re-decodes it. Required
   *  for the account/subscription login flow; the runtime fails that flow
   *  explicitly when a bridge does not provide it. */
  listenAuthEvent?(
    listener: (event: Pick<Event<unknown>, "payload">) => void,
  ): Promise<() => void>;
  /** Typed Request Ledger committed-record events (Ticket 19): the native
   *  shell forwards allowlisted records while a ledger subscription is
   *  active. The payload is opaque JSON; the runtime strictly re-decodes
   *  it. Required for live list/detail updates; the runtime fails the
   *  subscription explicitly when a bridge does not provide it. */
  listenLedgerEvent?(
    listener: (event: Pick<Event<unknown>, "payload">) => void,
  ): Promise<() => void>;
}

/** Sanitized Dashboard warning projection (Ticket 16): only the safe fields
 *  of a diagnostics record are forwarded from the native bridge. */
export interface DiagnosticsWarning {
  readonly id: number;
  readonly level: "warning" | "error" | "critical";
  readonly time: number;
  readonly text: string;
}

export interface TauriDesktopRuntime {
  connectControlPlane(): Promise<ControlPlaneState>;
  retryControlPlane(): Promise<ControlPlaneState>;
  executeRuntimeCommand(command: RuntimeCommand): Promise<ControlPlaneState>;
  executeSettingsCommand(command: SettingsCommand): Promise<ControlPlaneState>;
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
  /** Ticket 13: Provider-owned login commands (query | login) over the
   *  typed interaction channel; interaction events are dispatched to
   *  `onInteraction` as they arrive and the promise resolves with the
   *  terminal outcome. */
  executeAuthCommand(
    command: AuthCommand,
    onInteraction?: (event: AuthInteractionEvent) => void,
  ): Promise<AuthCommandResult>;
  /** Ticket 13: routes one typed response (prompt answer or cancel) into
   *  the active login flow. */
  respondAuthInteraction(response: AuthInteractionResponse): Promise<void>;
  /** Ticket 13: opens a browser/verification URL through the OS. Only
   *  http/https URLs are accepted; the UI always keeps the URL visible
   *  and copyable as the manual fallback. */
  openUrl(url: string): Promise<void>;
  queryDiagnosticsWarnings(): Promise<readonly DiagnosticsWarning[]>;

  /** Native directory picker: the picked absolute path or undefined on
   *  cancel. The backend canonicalizes the path; the renderer never becomes
   *  a filesystem authority. */
  pickDirectory(): Promise<string | undefined>;
  getRequestIdentities(): Promise<RequestIdentitiesQueryResult>;
  /** Bounded newest-first Request Ledger query (Ticket 19). */
  getRequestLedger(
    query: RequestLedgerQuery | undefined,
  ): Promise<RequestLedgerQueryResult>;
  /** Listen-first typed ledger subscription (Ticket 19): registers the
   *  event listener before the native subscribe so no committed record is
   *  missed; the promise resolves once the native side confirmed. An
   *  invalid stream event ends the subscription and reports through
   *  `onError`. */
  subscribeRequestLedger(
    listener: (event: RequestLedgerEvent) => void,
    onError?: (error: Error) => void,
  ): Promise<() => Promise<void>>;
  disconnectControlPlane(): Promise<void>;
  subscribeControlPlane(
    listener: (state: ControlPlaneState) => void,
  ): () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const dataPlaneFailureMessages = {
  port_in_use:
    "The configured port is already in use. Stop the other application or choose a different port.",
  start_failed:
    "The model gateway could not start. Check its configured address and try again.",
  stop_failed:
    "The model gateway could not stop cleanly. Restart LuckyToken before trying again.",
} as const;

/** Strict http/https URL guard for OS browser opening (Ticket 13): the
 *  renderer never opens URLs itself and never passes a non-http(s) URL to
 *  the native shell. */
function isHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    parsed.username === "" &&
    parsed.password === ""
  );
}

function decodeDataPlaneStatus(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.configuredOrigin !== "string" ||
    !Number.isSafeInteger(value.configuredPort) ||
    (value.configuredPort as number) < 0 ||
    (value.configuredPort as number) > 65_535
  ) {
    return undefined;
  }
  let origin: URL;
  try {
    origin = new URL(value.configuredOrigin);
  } catch {
    return undefined;
  }
  if (
    origin.protocol !== "http:" ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    (origin.port === "" ? 80 : Number.parseInt(origin.port, 10)) !==
      value.configuredPort
  ) {
    return undefined;
  }
  let failure:
    | {
        readonly code: keyof typeof dataPlaneFailureMessages;
        readonly message: string;
      }
    | undefined;
  if (value.failure !== undefined) {
    if (
      !isRecord(value.failure) ||
      (value.failure.code !== "port_in_use" &&
        value.failure.code !== "start_failed" &&
        value.failure.code !== "stop_failed")
    ) {
      return undefined;
    }
    failure = {
      code: value.failure.code,
      message: dataPlaneFailureMessages[value.failure.code],
    };
  }
  return {
    configuredOrigin: value.configuredOrigin,
    configuredPort: value.configuredPort as number,
    ...(failure === undefined ? {} : { failure }),
  };
}

function decodeRegisteredSettings(
  value: unknown,
): Readonly<Record<string, RegisteredSetting>> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, RegisteredSetting> = Object.create(null);
  for (const [key, setting] of Object.entries(value)) {
    if (!isRecord(setting) || typeof setting.key !== "string") {
      return undefined;
    }
    // Minimal structural check; the renderer projection (projectSettings)
    // performs the strict allowlist validation before anything renders.
    result[key] = setting as unknown as RegisteredSetting;
  }
  return Object.keys(result).length === 0 ? undefined : Object.freeze(result);
}

function decodeLanConfirmation(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.actionId !== "string" ||
    value.actionId.length === 0 ||
    value.settingKey !== "server.bindHost" ||
    typeof value.value !== "string" ||
    typeof value.message !== "string"
  ) {
    return undefined;
  }
  return {
    actionId: value.actionId,
    settingKey: "server.bindHost" as const,
    value: value.value,
    message: value.message,
  };
}

function decodeOwnership(value: unknown): ApplicationOwnership | undefined {
  if (
    !isRecord(value) ||
    !isRecord(value.owner) ||
    (value.owner.kind !== "cli" && value.owner.kind !== "desktop") ||
    !Number.isSafeInteger(value.owner.pid) ||
    (value.owner.pid as number) <= 0 ||
    typeof value.owner.startedAt !== "string" ||
    Number.isNaN(Date.parse(value.owner.startedAt))
  ) {
    return undefined;
  }
  return Object.freeze({
    owner: Object.freeze({
      kind: value.owner.kind as "cli" | "desktop",
      pid: value.owner.pid as number,
      startedAt: value.owner.startedAt as string,
    }),
  });
}

function decodeAutoStartProjection(
  value: unknown,
): AutoStartProjection | undefined {
  return isRecord(value) && typeof value.enabled === "boolean"
    ? { enabled: value.enabled }
    : undefined;
}

function decodeMaskedClientTokenScope(
  value: unknown,
): MaskedClientTokenScope | undefined {
  if (
    !isRecord(value) ||
    (value.type !== "global" && value.type !== "project") ||
    typeof value.maskedToken !== "string" ||
    value.maskedToken.length === 0 ||
    // The mask marker guarantees a masked field never carries a raw token.
    !value.maskedToken.includes("\u2026")
  ) {
    return undefined;
  }
  if (value.type === "global") {
    return value.projectDir === undefined
      ? { type: "global", maskedToken: value.maskedToken }
      : undefined;
  }
  return typeof value.projectDir === "string" && value.projectDir.length > 0
    ? {
        type: "project",
        projectDir: value.projectDir,
        maskedToken: value.maskedToken,
      }
    : undefined;
}

function decodeClientTokenCommandResult(
  value: unknown,
  command: ClientTokenCommand,
): ClientTokenCommandResult | undefined {
  if (
    !isRecord(value) ||
    (value.outcome !== "ok" &&
      value.outcome !== "conflict" &&
      value.outcome !== "not_found" &&
      value.outcome !== "invalid_value" &&
      value.outcome !== "already_exists" &&
      value.outcome !== "invalid_directory" &&
      value.outcome !== "unknown_protocol" &&
      value.outcome !== "unavailable") ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0
  ) {
    return undefined;
  }
  const outcome = value.outcome as ClientTokenCommandResult["outcome"];
  const revision = value.revision as number;
  if (outcome !== "ok") {
    const reason =
      outcome === "invalid_directory" &&
      typeof value.reason === "string" &&
      (value.reason === "not_found" ||
        value.reason === "not_a_directory" ||
        value.reason === "inaccessible" ||
        value.reason === "race" ||
        value.reason === "invalid")
        ? value.reason
        : undefined;
    if (
      typeof value.error !== "string" ||
      value.error.length === 0 ||
      value.token !== undefined ||
      value.scopes !== undefined ||
      (outcome === "invalid_directory" && reason === undefined) ||
      (outcome !== "invalid_directory" && value.reason !== undefined)
    ) {
      return undefined;
    }
    return {
      outcome,
      revision,
      ...(reason === undefined ? {} : { reason }),
      error: value.error,
    };
  }
  if (command.command === "reveal") {
    if (typeof value.token !== "string" || value.token.length === 0) {
      return undefined;
    }
    return { outcome, revision, token: value.token };
  }
  if (value.token !== undefined || !Array.isArray(value.scopes)) {
    return undefined;
  }
  const scopes = value.scopes
    .map((entry) => decodeMaskedClientTokenScope(entry))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  if (scopes.length !== value.scopes.length) return undefined;
  return { outcome, revision, scopes };
}

const REQUEST_IDENTITY_KEYS = new Set([
  "id",
  "time",
  "protocolId",
  "clientSessionId",
  "projectDir",
]);
const REQUEST_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Strict request identity record decode (Ticket 17 identity seam): the
 *  allowed key set has no effective-session field, so a record that ever
 *  carries the internal `effectiveSessionId` is rejected at the bridge. */
function decodeRequestIdentityRecord(
  value: unknown,
): RequestIdentityRecord | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of Object.keys(value)) {
    if (!REQUEST_IDENTITY_KEYS.has(key)) return undefined;
  }
  if (
    !Number.isSafeInteger(value.id) ||
    (value.id as number) < 1 ||
    !Number.isSafeInteger(value.time) ||
    (value.time as number) < 0 ||
    typeof value.protocolId !== "string" ||
    value.protocolId.length === 0
  ) {
    return undefined;
  }
  const clientSessionId = value.clientSessionId;
  if (
    clientSessionId !== undefined &&
    (typeof clientSessionId !== "string" ||
      !REQUEST_SESSION_ID_PATTERN.test(clientSessionId))
  ) {
    return undefined;
  }
  const projectDir = value.projectDir;
  if (
    projectDir !== undefined &&
    (typeof projectDir !== "string" || projectDir.length === 0)
  ) {
    return undefined;
  }
  return {
    id: value.id as number,
    time: value.time as number,
    protocolId: value.protocolId,
    ...(clientSessionId === undefined
      ? {}
      : { clientSessionId: clientSessionId as string }),
    ...(projectDir === undefined ? {} : { projectDir: projectDir as string }),
  };
}

function decodeRequestIdentitiesResult(
  value: unknown,
): RequestIdentitiesQueryResult | undefined {
  if (!isRecord(value) || !Array.isArray(value.records)) return undefined;
  const records = value.records
    .map((entry) => decodeRequestIdentityRecord(entry))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  if (records.length !== value.records.length) return undefined;
  return { records };
}

function decodeDiagnosticsWarning(
  value: unknown,
): DiagnosticsWarning | undefined {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.id) ||
    (value.level !== "warning" &&
      value.level !== "error" &&
      value.level !== "critical") ||
    !Number.isSafeInteger(value.time) ||
    typeof value.text !== "string" ||
    value.text.length === 0
  ) {
    return undefined;
  }
  return {
    id: value.id as number,
    level: value.level,
    time: value.time as number,
    text: value.text,
  };
}

function decodeBridgePayload(
  value: unknown,
): ControlPlaneBridgePayload | undefined {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0
  ) {
    return undefined;
  }
  const revision = value.revision as number;
  if (value.connection === "connected") {
    const snapshot = value.snapshot;
    if (
      value.contractVersion !== 1 ||
      typeof value.applicationVersion !== "string" ||
      !isRecord(snapshot) ||
      !Number.isSafeInteger(snapshot.sequence) ||
      (snapshot.sequence as number) < 0 ||
      (snapshot.modelDataPlane !== "stopped" &&
        snapshot.modelDataPlane !== "starting" &&
        snapshot.modelDataPlane !== "running" &&
        snapshot.modelDataPlane !== "stopping" &&
        snapshot.modelDataPlane !== "failed") ||
      (snapshot.provider !== "configured" &&
        snapshot.provider !== "unconfigured")
    ) {
      return undefined;
    }
    const dataPlane =
      snapshot.dataPlane === undefined
        ? undefined
        : decodeDataPlaneStatus(snapshot.dataPlane);
    if (
      (snapshot.dataPlane !== undefined && dataPlane === undefined) ||
      (snapshot.modelDataPlane === "failed" &&
        dataPlane?.failure === undefined) ||
      (snapshot.modelDataPlane !== "failed" && dataPlane?.failure !== undefined)
    ) {
      return undefined;
    }
    // The settings and LAN-confirmation projections are validated by the
    // renderer allowlist; forward the raw snapshot fields unchanged. The
    // sanitized models projection is decoded strictly here and the full
    // models command result rides alongside the payload.
    const settings = decodeRegisteredSettings(snapshot.settings);
    const confirmation = decodeLanConfirmation(snapshot.confirmation);
    const ownership = decodeOwnership(snapshot.ownership);
    if (snapshot.ownership !== undefined && ownership === undefined) {
      return undefined;
    }
    const modelsProjection = decodeModelsProjection(snapshot.models);
    if (snapshot.models !== undefined && modelsProjection === undefined) {
      return undefined;
    }
    const aliasesProjection = decodeAliasStatusProjection(snapshot.aliases);
    if (snapshot.aliases !== undefined && aliasesProjection === undefined) {
      return undefined;
    }
    const models = decodeModelsCommandResult(value.models);
    if (value.models !== undefined && models === undefined) {
      return undefined;
    }
    return {
      revision,
      connection: "connected",
      applicationVersion: value.applicationVersion,
      contractVersion: 1,
      snapshot: {
        sequence: snapshot.sequence as number,
        modelDataPlane: snapshot.modelDataPlane,
        provider: snapshot.provider,
        ...(dataPlane === undefined ? {} : { dataPlane }),
        ...(settings === undefined ? {} : { settings }),
        ...(modelsProjection === undefined ? {} : { models: modelsProjection }),
        ...(aliasesProjection === undefined
          ? {}
          : { aliases: aliasesProjection }),
        ...(confirmation === undefined ? {} : { confirmation }),
        ...(ownership === undefined ? {} : { ownership }),
      },
      ...(models === undefined ? {} : { models }),
    };
  }
  if (
    value.connection === "version_mismatch" &&
    Number.isSafeInteger(value.requestedVersion) &&
    Array.isArray(value.supportedVersions) &&
    value.supportedVersions.every(Number.isSafeInteger)
  ) {
    return {
      revision,
      connection: "version_mismatch",
      requestedVersion: value.requestedVersion as number,
      supportedVersions: value.supportedVersions as number[],
    };
  }
  if (
    value.connection === "unavailable" &&
    (value.reason === "descriptor_missing" ||
      value.reason === "descriptor_invalid" ||
      value.reason === "pipe_unavailable" ||
      value.reason === "protocol_error")
  ) {
    return { revision, connection: "unavailable", reason: value.reason };
  }
  if (
    value.connection === "disconnected" &&
    value.reason === "transport_lost"
  ) {
    return { revision, connection: "disconnected", reason: value.reason };
  }
  return undefined;
}

export function createTauriDesktopRuntime(
  bridge: NativeTauriBridge,
): TauriDesktopRuntime {
  let latest: ControlPlaneState | undefined;
  let listenTask: Promise<void> | undefined;
  let unlisten: (() => void) | undefined;
  const subscribers = new Set<(state: ControlPlaneState) => void>();

  const accept = (raw: unknown): ControlPlaneState => {
    const payload = decodeBridgePayload(raw) ?? {
      revision: (latest?.revision ?? -1) + 1,
      connection: "unavailable" as const,
      reason: "protocol_error" as const,
    };
    if (latest !== undefined && payload.revision <= latest.revision) {
      return latest;
    }
    const projected = projectControlPlaneState(payload);
    if (projected.kind === "connected") {
      // The full models result from a models command sticks on the state
      // until a newer one arrives; status events (which never carry one)
      // keep the last result so the editors never lose their data.
      const models =
        payload.connection === "connected" && payload.models !== undefined
          ? payload.models
          : latest?.kind === "connected" && latest.modelsResult !== undefined
            ? latest.modelsResult
            : undefined;
      latest =
        models === undefined
          ? projected
          : { ...projected, modelsResult: models };
    } else {
      latest = projected;
    }
    for (const subscriber of subscribers) subscriber(latest);
    return latest;
  };

  const ensureListening = async (): Promise<void> => {
    listenTask ??= bridge
      .listen("luckytoken://shell-state", (event) => {
        accept(event.payload);
      })
      .then((stop) => {
        unlisten = stop;
      });
    await listenTask;
  };

  const invokeState = async (
    command: ShellCommand,
    args?: unknown,
  ): Promise<ControlPlaneState> => {
    await ensureListening();
    return accept(await bridge.invoke(command, args));
  };

  const invokeAutoStart = async (
    command: ShellCommand,
  ): Promise<AutoStartProjection> => {
    await ensureListening();
    const result = decodeAutoStartProjection(await bridge.invoke(command));
    if (result === undefined) {
      throw new Error("Native auto-start response is malformed");
    }
    return result;
  };

  return {
    connectControlPlane: () => invokeState("shell_snapshot"),
    retryControlPlane: () => invokeState("shell_retry"),
    executeRuntimeCommand: (command) =>
      invokeState(
        command === "start"
          ? "shell_start"
          : command === "stop"
            ? "shell_stop"
            : "shell_restart",
      ),
    executeSettingsCommand: (command) =>
      invokeState(
        command.command === "query"
          ? "shell_settings_query"
          : command.command === "set"
            ? "shell_settings_set"
            : "shell_settings_confirm",
      ),
    getAutoStartStatus: () => invokeAutoStart("shell_auto_start_status"),
    setAutoStartEnabled: (enabled) =>
      invokeAutoStart(
        enabled ? "shell_auto_start_enable" : "shell_auto_start_disable",
      ),

    async executeClientTokenCommand(command) {
      // Client Token commands return their own result (masked scopes or the
      // explicitly revealed secret); they never merge into the status
      // projection. Project scope inputs are raw picker paths; only the
      // backend canonicalizes them.
      const scopeArgs =
        command.command === "list" || command.scope === undefined
          ? {}
          : { scope: command.scope };
      const raw =
        command.command === "list"
          ? await bridge.invoke("shell_client_tokens_list", {
              protocolId: command.protocolId,
            })
          : command.command === "create"
            ? await bridge.invoke("shell_client_tokens_create", {
                protocolId: command.protocolId,
                scope: command.scope,
                ...(command.token === undefined
                  ? {}
                  : { token: command.token }),
              })
            : command.command === "reveal"
              ? await bridge.invoke("shell_client_tokens_reveal", {
                  protocolId: command.protocolId,
                  ...scopeArgs,
                })
              : command.command === "rotate"
                ? await bridge.invoke("shell_client_tokens_rotate", {
                    protocolId: command.protocolId,
                    expectedRevision: command.expectedRevision,
                    ...scopeArgs,
                    ...(command.token === undefined
                      ? {}
                      : { token: command.token }),
                  })
                : await bridge.invoke("shell_client_tokens_remove", {
                    protocolId: command.protocolId,
                    expectedRevision: command.expectedRevision,
                    ...scopeArgs,
                  });
      const decoded = decodeClientTokenCommandResult(raw, command);
      if (decoded === undefined) {
        throw new Error("LuckyToken returned an invalid client token result");
      }
      return decoded;
    },
    async executeCredentialCommand(command) {
      // Credential commands return the sanitized projection and closed
      // outcomes only; they never merge raw credential values.
      const raw =
        command.command === "query"
          ? await bridge.invoke("shell_credentials_query")
          : command.command === "login"
            ? await bridge.invoke("shell_credentials_login", {
                providerId: command.providerId,
                expectedRevision: command.expectedRevision,
                value: command.value,
                overwrite: command.overwrite,
              })
            : command.command === "logout"
              ? await bridge.invoke("shell_credentials_logout", {
                  providerId: command.providerId,
                  expectedRevision: command.expectedRevision,
                })
              : command.command === "import_preview"
                ? await bridge.invoke("shell_credentials_import_preview", {
                    expectedRevision: command.expectedRevision,
                    content: command.content,
                  })
                : await bridge.invoke("shell_credentials_import_apply", {
                    expectedRevision: command.expectedRevision,
                    importId: command.importId,
                    selections: command.selections,
                  });
      const decoded = decodeCredentialCommandResult(raw, command);
      if (decoded === undefined) {
        throw new Error("LuckyToken returned an invalid credential result");
      }
      return decoded;
    },
    async executeAuthCommand(command, onInteraction) {
      if (command.command === "query") {
        const raw = await bridge.invoke("shell_auth_query");
        const decoded = decodeAuthCommandResult(raw);
        if (decoded === undefined || decoded.options === undefined) {
          throw new Error("LuckyToken returned an invalid auth result");
        }
        return decoded;
      }
      // Login: subscribe to the auth-event channel before invoking so no
      // typed event is ever lost. Only strictly decoded events are
      // dispatched; an undecodable event is a protocol violation that
      // fails the whole flow (a skipped prompt could silently hang the
      // Provider-owned flow).
      if (bridge.listenAuthEvent === undefined) {
        throw new Error("Native bridge does not support auth events");
      }
      let interactionError: Error | undefined;
      const unlisten = await bridge.listenAuthEvent((event) => {
        const decoded = decodeAuthInteractionEvent(event.payload);
        if (decoded === undefined) {
          interactionError ??= new Error(
            "LuckyToken returned an invalid auth interaction event",
          );
          return;
        }
        onInteraction?.(decoded);
      });
      try {
        const raw = await bridge.invoke("shell_auth_login", {
          providerId: command.providerId,
          authType: command.authType,
        });
        if (interactionError !== undefined) throw interactionError;
        const decoded = decodeAuthCommandResult(raw);
        if (decoded === undefined || decoded.options !== undefined) {
          throw new Error("LuckyToken returned an invalid auth result");
        }
        return decoded;
      } finally {
        // The terminal result ends the flow: no further events can be
        // prompted after it, so the per-flow listener is released.
        await unlisten();
      }
    },
    async respondAuthInteraction(response) {
      // The response is typed at the call site; the native bridge
      // re-validates the wire shape strictly before routing it.
      await bridge.invoke("shell_auth_respond", { response });
    },
    async openUrl(url) {
      // The OS layer re-validates; this guard prevents even attempting a
      // non-http(s) open from the renderer.
      if (!isHttpUrl(url)) {
        throw new Error("Refusing to open a non-http(s) URL");
      }
      await bridge.invoke("shell_open_url", { url });
    },
    async queryDiagnosticsWarnings() {
      const raw = await bridge.invoke("shell_diagnostics_warnings");
      if (!Array.isArray(raw)) {
        throw new Error("LuckyToken returned an invalid diagnostics result");
      }
      const warnings = raw
        .map((entry) => decodeDiagnosticsWarning(entry))
        .filter(
          (entry): entry is NonNullable<typeof entry> => entry !== undefined,
        );
      if (warnings.length !== raw.length) {
        throw new Error("LuckyToken returned an invalid diagnostics result");
      }
      return Object.freeze(warnings);
    },

    async pickDirectory() {
      const raw = await bridge.invoke("shell_pick_directory");
      if (raw === null || raw === undefined) return undefined;
      if (typeof raw !== "string" || raw.length === 0) {
        throw new Error("LuckyToken returned an invalid picker result");
      }
      return raw;
    },
    async getRequestIdentities() {
      const raw = await bridge.invoke("shell_request_identities");
      const decoded = decodeRequestIdentitiesResult(raw);
      if (decoded === undefined) {
        throw new Error(
          "LuckyToken returned an invalid request identities result",
        );
      }
      return decoded;
    },

    async getRequestLedger(query) {
      const raw = await bridge.invoke("shell_request_ledger_query", {
        ...(query === undefined ? {} : { query }),
      });
      const decoded = decodeRequestLedgerResult(raw);
      if (decoded === undefined) {
        throw new Error(
          "LuckyToken returned an invalid request ledger result",
        );
      }
      return decoded;
    },

    async subscribeRequestLedger(listener, onError) {
      // Listen-first: the Tauri event listener is registered before the
      // native subscribe is invoked, so a committed record can never slip
      // between the two. Every payload is strictly re-decoded at this
      // boundary; an undecodable record is a protocol violation that ends
      // the subscription and reports through onError (a silently skipped
      // record could corrupt the live view).
      if (bridge.listenLedgerEvent === undefined) {
        throw new Error("Native bridge does not support ledger events");
      }
      let unlisten: (() => void) | undefined = undefined;
      let active = true;
      let invalid: Error | undefined;
      const failStream = (error: Error) => {
        if (!active) return;
        active = false;
        invalid = error;
        unlisten?.();
        void bridge
          .invoke("shell_request_ledger_unsubscribe")
          .catch(() => undefined);
        onError?.(error);
      };
      unlisten = await bridge.listenLedgerEvent((event) => {
        const record = decodeRequestLedgerRecord(event.payload);
        if (record === undefined) {
          failStream(
            new Error(
              "LuckyToken returned an invalid request ledger event",
            ),
          );
          return;
        }
        if (active) listener({ type: "request_ledger", record });
      });
      try {
        await bridge.invoke("shell_request_ledger_subscribe");
      } catch (error) {
        unlisten?.();
        throw error;
      }
      if (invalid !== undefined) throw invalid;
      return async () => {
        if (!active) return;
        active = false;
        unlisten?.();
        await bridge
          .invoke("shell_request_ledger_unsubscribe")
          .catch(() => undefined);
      };
    },

    executeModelsCommand: (command) =>
      invokeState(
        command.command === "query"
          ? "shell_models_query"
          : command.command === "write_raw"
            ? "shell_models_write_raw"
            : "shell_models_write_structured",
        command.command === "query"
          ? undefined
          : command.command === "write_raw"
            ? { revision: command.revision, content: command.content }
            : { revision: command.revision, providers: command.providers },
      ),
    async executeCatalogCommand(command) {
      const raw =
        command.command === "query"
          ? await bridge.invoke("shell_catalog_query")
          : await bridge.invoke("shell_catalog_refresh", {
              mode: command.mode,
            });
      const decoded = decodeCatalogCommandResult(raw);
      if (decoded === undefined) {
        throw new Error("LuckyToken returned an invalid catalog result");
      }
      return decoded;
    },
    async executeAliasCommand(command) {
      const raw =
        command.command === "query"
          ? await bridge.invoke("shell_aliases_query")
          : await bridge.invoke("shell_aliases_write", {
              revision: command.revision,
              aliases: command.aliases,
            });
      const decoded = decodeAliasCommandResult(raw);
      if (decoded === undefined) {
        throw new Error("LuckyToken returned an invalid alias result");
      }
      return decoded;
    },

    async disconnectControlPlane() {
      await listenTask;
      unlisten?.();
      unlisten = undefined;
    },
    subscribeControlPlane(listener) {
      subscribers.add(listener);
      if (latest !== undefined) listener(latest);
      return () => subscribers.delete(listener);
    },
  };
}
