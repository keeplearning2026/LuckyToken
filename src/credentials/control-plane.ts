import type {
  CredentialCommand,
  CredentialCommandHandler,
  CredentialCommandResult,
  CredentialProjection,
} from "@luckytoken/application-control-plane/control-plane";

import type { LiveCredentialAuthority } from "./authority.js";

/**
 * Adapts the Credential Authority to the Control Plane credential command
 * channel. The authority is the sole authority on auth.json, revision/CAS
 * semantics, import sessions and status facts; this adapter only forwards
 * the closed outcomes and sanitized projection onto the versioned wire
 * contract and reports a fixed sanitized failure when the authority is not
 * available (e.g. before the Data Plane composition is running).
 */
export function createCredentialControlPlaneHandler(options: {
  readonly authority: () => LiveCredentialAuthority | undefined;
}): CredentialCommandHandler {
  return async (
    command: CredentialCommand,
  ): Promise<CredentialCommandResult> => {
    const authority = options.authority();
    if (authority === undefined) {
      return unavailableResult();
    }
    try {
      switch (command.command) {
        case "query":
          return authority.query();
        case "login":
          return authority.login(command);
        case "logout":
          return authority.logout(command);
        case "import_preview":
          return authority.importPreview(command);
        case "import_apply":
          return authority.importApply(command);
      }
    } catch {
      return unavailableResult();
    }
  };
}

function unavailableResult(): CredentialCommandResult {
  const state: CredentialProjection = Object.freeze({
    revision: 0,
    path: "",
    present: false,
    valid: false,
    providers: Object.freeze([]),
  });
  return Object.freeze({
    outcome: "unavailable",
    revision: 0,
    state,
    error: "Credential Authority is unavailable",
  });
}
