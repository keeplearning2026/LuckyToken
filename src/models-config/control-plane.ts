import type {
  ModelsCommand,
  ModelsCommandHandler,
  ModelsCommandResult,
} from "@token/application-control-plane/control-plane";

import type { ModelsJsonAuthority } from "./authority.js";

/**
 * Adapts the models.json authority to the Control Plane models command
 * channel. The authority is the sole authority on the file, validation,
 * locking, atomic replacement, and revision semantics; this adapter only
 * forwards the closed outcomes and state onto the versioned wire contract.
 */
export function createModelsControlPlaneHandler(
  authority: ModelsJsonAuthority,
): ModelsCommandHandler {
  return async (command: ModelsCommand): Promise<ModelsCommandResult> => {
    if (command.command === "query") {
      return { outcome: "ok", state: await authority.query() };
    }
    if (command.command === "write_raw") {
      return authority.writeRaw({
        revision: command.revision,
        content: command.content,
      });
    }
    return authority.writeStructured({
      revision: command.revision,
      providers: command.providers,
    });
  };
}
