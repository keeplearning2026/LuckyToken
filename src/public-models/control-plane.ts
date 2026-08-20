import type {
  PublicModelsCommand,
  PublicModelsCommandHandler,
  PublicModelsCommandResult,
  PublicModelsState,
} from "@luckytoken/application-control-plane/control-plane";

import type {
  PublicModelAuthority,
  PublicModelCommandResult,
  PublicModelState,
} from "./authority.js";

function projectState(state: PublicModelState): PublicModelsState {
  return Object.freeze({
    revision: state.revision,
    version: state.snapshot.version,
    endpoint: state.snapshot.endpoint,
    providers: state.snapshot.providers,
  });
}

function projectResult(result: PublicModelCommandResult): PublicModelsCommandResult {
  return Object.freeze({
    outcome: result.outcome,
    state: projectState(result.state),
  });
}

/** Application Control Plane adapter over the one Backend-lifetime Public
 * Model runtime authority. Product clients never read or edit the backing
 * JSON file and every mutation operates on the live immutable snapshot. */
export function createPublicModelsControlPlaneHandler(
  authority: PublicModelAuthority,
): PublicModelsCommandHandler {
  return async (command: PublicModelsCommand): Promise<PublicModelsCommandResult> => {
    if (command.command === "query") {
      return Object.freeze({ outcome: "ok", state: projectState(authority.state()) });
    }
    if (command.command === "set_port") {
      return projectResult(
        await authority.setPort({ revision: command.revision, port: command.port }),
      );
    }
    if (command.command === "set_provider") {
      return projectResult(
        await authority.setProviderOn({
          revision: command.revision,
          providerId: command.providerId,
          on: command.on,
        }),
      );
    }
    if (command.command === "set_model") {
      return projectResult(
        await authority.setModelOn({
          revision: command.revision,
          providerId: command.providerId,
          modelId: command.modelId,
          on: command.on,
        }),
      );
    }
    if (command.command === "rename_model") {
      return projectResult(
        await authority.renameModel({
          revision: command.revision,
          providerId: command.providerId,
          modelId: command.modelId,
          modelName: command.modelName,
        }),
      );
    }
    return projectResult(
      await authority.restoreModelName({
        revision: command.revision,
        providerId: command.providerId,
        modelId: command.modelId,
      }),
    );
  };
}
