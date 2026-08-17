import type {
  AliasCommand,
  AliasCommandHandler,
  AliasCommandResult,
} from "@luckytoken/application-control-plane/control-plane";

import type { AliasRegistryAuthority } from "./authority.js";

/**
 * Adapts the model-aliases.json authority to the Control Plane alias
 * command channel. The authority is the sole owner of the file facts,
 * validation, locking, atomic replacement, revisions, and the captured
 * resolver snapshots; this adapter only forwards the closed outcomes and
 * authoritative state onto the versioned wire contract.
 */
export function createAliasControlPlaneHandler(
  authority: AliasRegistryAuthority,
): AliasCommandHandler {
  return async (command: AliasCommand): Promise<AliasCommandResult> => {
    if (command.command === "query") {
      return { outcome: "ok", state: await authority.query() };
    }
    return authority.write({
      revision: command.revision,
      aliases: command.aliases,
    });
  };
}
