import type { Model } from "@earendil-works/pi-ai";
import {
  COMMANDCODE_MODEL_FACTS,
  projectCommandCodeModel,
  selectCommandCodeModelApi,
  type CommandCodeModelApi,
  type CommandCodeModelFacts,
} from "@token/commandcode-model-catalog";

import {
  COMMANDCODE_GOAT_OPENAI_BASE_URL,
  COMMANDCODE_GOAT_PROVIDER_ID,
  COMMANDCODE_GOAT_PROVIDER_ROOT,
} from "./constants.js";

function commandCodeGoatBaseUrl(api: CommandCodeModelApi): string {
  switch (api) {
    case "anthropic-messages":
      return COMMANDCODE_GOAT_PROVIDER_ROOT;
    case "openai-responses":
    case "openai-completions":
      return COMMANDCODE_GOAT_OPENAI_BASE_URL;
  }
}

function projectCommandCodeGoatModel(
  facts: CommandCodeModelFacts,
): Model<CommandCodeModelApi> {
  const api = selectCommandCodeModelApi(facts);
  const projected = projectCommandCodeModel(facts, {
    provider: COMMANDCODE_GOAT_PROVIDER_ID,
    api,
    baseUrl: commandCodeGoatBaseUrl(api),
  });
  return api === "openai-completions"
    ? Object.freeze({
        ...projected,
        compat: Object.freeze({
          thinkingFormat: "openai" as const,
          supportsReasoningEffort: true,
        }),
      })
    : projected;
}

export function createCommandCodeGoatModels(
  facts: readonly CommandCodeModelFacts[],
): readonly Model<CommandCodeModelApi>[] {
  return Object.freeze(
    facts
      .filter(
        ({ minimumPlan }) => minimumPlan === "go" || minimumPlan === "goat",
      )
      .map(projectCommandCodeGoatModel),
  );
}

/** JSON-derived bootstrap projection used only by tests/tools that do not own Backend startup. */
export const COMMANDCODE_GOAT_MODELS: readonly Model<CommandCodeModelApi>[] =
  createCommandCodeGoatModels(COMMANDCODE_MODEL_FACTS);
