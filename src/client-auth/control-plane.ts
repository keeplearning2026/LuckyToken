import type {
  ClientTokenCommand,
  ClientTokenCommandHandler,
  ClientTokenCommandResult,
  RuntimeDiagnosticsStore,
  SettingsCommandHandler,
} from "@luckytoken/application-control-plane/control-plane";

import {
  ClientTokenDirectoryRejectionError,
  ClientTokenInvalidValueError,
  ClientTokenScopeExistsError,
  ClientTokenScopeNotFoundError,
  ClientTokenStaleRevisionError,
  type ClientTokenDirectoryRejectionReason,
  type LiveClientTokenAuthority,
} from "./live-authority.js";

/**
 * Client Token Control Plane adapters (Ticket 16).
 *
 * `createClientTokenControlPlaneHandler` serves the versioned Client Token
 * commands against the live per-protocol authorities; the host owns the
 * strict wire validation, so list/mutation results can never carry a raw
 * token and Reveal returns only the requested active secret.
 *
 * `createProtocolEnablementSettingsHandler` wraps the Settings command
 * channel: enabling a Client Protocol creates exactly one protocol-global
 * token when that scope has none (the enable transition; boot-time enabling
 * is handled by the composition).
 */

export interface ClientTokenControlPlaneHandlerOptions {
  /** Protocol id → live authority; read at command time so the handler
   *  always targets the authorities of the currently running Data Plane. */
  readonly authorities: () => Readonly<Record<string, LiveClientTokenAuthority>>;
  /** Protocol id → display name used in sanitized warning texts. */
  readonly protocolNames?: Readonly<Record<string, string>>;
  /** Optional diagnostics store: a protocol that loses its last token emits
   *  a sanitized warning here (visible in Dashboard/Diagnostics). */
  readonly diagnostics?: RuntimeDiagnosticsStore;
}

export function createClientTokenControlPlaneHandler(
  options: ClientTokenControlPlaneHandlerOptions,
): ClientTokenCommandHandler {
  const protocolName = (protocolId: string): string =>
    options.protocolNames?.[protocolId] ?? protocolId;
  return async (
    command: ClientTokenCommand,
  ): Promise<ClientTokenCommandResult> => {
    const authority = options.authorities()[command.protocolId];
    if (authority === undefined) {
      return {
        outcome: "unknown_protocol",
        revision: 0,
        error: `Client Protocol is not installed: ${command.protocolId}`,
      };
    }
    try {
      if (command.command === "list") {
        const listing = await authority.list();
        return { outcome: "ok", revision: listing.revision, scopes: listing.scopes };
      }
      if (command.command === "create") {
        // Only the backend canonicalizes: the raw picker/CLI path resolves
        // at the authority boundary and no duplicate scope can be created.
        if (command.scope.type === "global") {
          const created = await authority.ensureGlobal();
          const listing = await authority.list();
          return {
            outcome: created ? "ok" : "already_exists",
            revision: listing.revision,
            scopes: listing.scopes,
          };
        }
        const created = await authority.createProject(
          command.scope.projectDir,
          command.token,
        );
        return {
          outcome: "ok",
          revision: created.listing.revision,
          scopes: created.listing.scopes,
        };
      }
      if (command.command === "reveal") {
        const token =
          command.scope?.type === "project"
            ? await authority.revealProject(command.scope.projectDir)
            : await authority.reveal();
        return { outcome: "ok", revision: authority.revision, token };
      }
      if (command.command === "rotate") {
        const listing =
          command.scope?.type === "project"
            ? await authority.rotateProject(
                command.expectedRevision,
                command.scope.projectDir,
                command.token,
              )
            : await authority.rotate(command.expectedRevision, command.token);
        return { outcome: "ok", revision: listing.revision, scopes: listing.scopes };
      }
      const listing =
        command.scope?.type === "project"
          ? await authority.removeProject(
              command.expectedRevision,
              command.scope.projectDir,
            )
          : await authority.remove(command.expectedRevision);
      if (listing.scopes.length === 0) {
        // The protocol lost its last token: requests now return 401. Emit a
        // sanitized warning through the single Ticket 07 redaction boundary.
        options.diagnostics?.append({
          level: "warning",
          text: `${protocolName(command.protocolId)} has no active client token; model requests return 401 until a token is created.`,
        });
      }
      return { outcome: "ok", revision: listing.revision, scopes: listing.scopes };
    } catch (error) {
      if (error instanceof ClientTokenStaleRevisionError) {
        return {
          outcome: "conflict",
          revision: authority.revision,
          error: error.message,
        };
      }
      if (error instanceof ClientTokenScopeNotFoundError) {
        return {
          outcome: "not_found",
          revision: authority.revision,
          error: error.message,
        };
      }
      if (error instanceof ClientTokenScopeExistsError) {
        return {
          outcome: "already_exists",
          revision: authority.revision,
          error: error.message,
        };
      }
      if (error instanceof ClientTokenDirectoryRejectionError) {
        // Value-free canonicalization rejection: the raw input path never
        // reaches the wire.
        const reason: ClientTokenDirectoryRejectionReason = error.reason;
        return {
          outcome: "invalid_directory",
          revision: authority.revision,
          reason,
          error: error.message,
        };
      }
      if (error instanceof ClientTokenInvalidValueError) {
        return {
          outcome: "invalid_value",
          revision: authority.revision,
          error: error.message,
        };
      }
      return {
        outcome: "unavailable",
        revision: authority.revision,
        error: "Client Token Authority is unavailable",
      };
    }
  };
}

export interface ProtocolEnablementSettingsHandlerOptions {
  readonly settingsHandler: SettingsCommandHandler;
  /** Protocol id → live authority; a disabled protocol's authority may be
   *  absent while the Data Plane is stopped (boot-time enabling covers it). */
  readonly authorities: () => Readonly<Record<string, LiveClientTokenAuthority>>;
  readonly protocolNames?: Readonly<Record<string, string>>;
  /** Optional diagnostics store: a failed enable-time token creation emits a
   *  sanitized warning (requests then return 401 until one exists). */
  readonly diagnostics?: RuntimeDiagnosticsStore;
}

export function createProtocolEnablementSettingsHandler(
  options: ProtocolEnablementSettingsHandlerOptions,
): SettingsCommandHandler {
  return async (command) => {
    const result = await options.settingsHandler(command);
    if (
      command.command === "set" &&
      command.value === true &&
      result.outcome === "applied"
    ) {
      const match = /^protocols\.([^.]+)\.enabled$/u.exec(command.key);
      const protocolId = match?.[1];
      if (protocolId !== undefined) {
        const authority = options.authorities()[protocolId];
        if (authority !== undefined) {
          await authority.ensureGlobal().catch(() => {
            options.diagnostics?.append({
              level: "warning",
              text: `${options.protocolNames?.[protocolId] ?? protocolId} is enabled but no client token could be created; model requests return 401 until a token exists.`,
            });
          });
        }
      }
    }
    return result;
  };
}
