import type { Model } from "@earendil-works/pi-ai";
import {
  COMMANDCODE_MODEL_FACTS,
  projectCommandCodeModel,
  type CommandCodeModelFacts,
} from "@token/commandcode-model-catalog";

import {
  COMMANDCODE_API_ID,
  COMMANDCODE_BASE_URL,
  COMMANDCODE_PROVIDER_ID,
} from "./constants.js";

export function createCommandCodeModels(
  facts: readonly CommandCodeModelFacts[],
): readonly Model<typeof COMMANDCODE_API_ID>[] {
  return Object.freeze(
    facts.map((entry) =>
      projectCommandCodeModel(entry, {
        provider: COMMANDCODE_PROVIDER_ID,
        api: COMMANDCODE_API_ID,
        baseUrl: COMMANDCODE_BASE_URL,
      }),
    ),
  );
}

/** Bootstrap-only projection used by tests/tools that do not own Backend startup. */
export const COMMANDCODE_MODELS: readonly Model<typeof COMMANDCODE_API_ID>[] =
  createCommandCodeModels(COMMANDCODE_MODEL_FACTS);

export function findCommandCodeModel(
  id: string,
  models: readonly Model<typeof COMMANDCODE_API_ID>[] = COMMANDCODE_MODELS,
): Model<typeof COMMANDCODE_API_ID> | undefined {
  return models.find((entry) => entry.id === id);
}
