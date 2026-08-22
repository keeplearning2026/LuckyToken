import type { Model } from "@earendil-works/pi-ai";
import {
  COMMANDCODE_MODEL_FACTS,
  projectCommandCodeModel,
} from "@luckytoken/commandcode-model-catalog";

import {
  COMMANDCODE_GOAT_API_ID,
  COMMANDCODE_GOAT_BASE_URL,
  COMMANDCODE_GOAT_PROVIDER_ID,
} from "./constants.js";

/** CommandCode Goat projection of the shared model capability catalog. */
export const COMMANDCODE_GOAT_MODELS: readonly Model<
  typeof COMMANDCODE_GOAT_API_ID
>[] = Object.freeze(
  COMMANDCODE_MODEL_FACTS.filter(
    ({ minimumPlan }) => minimumPlan === "go" || minimumPlan === "goat",
  ).map((facts) =>
    projectCommandCodeModel(facts, {
      provider: COMMANDCODE_GOAT_PROVIDER_ID,
      api: COMMANDCODE_GOAT_API_ID,
      baseUrl: COMMANDCODE_GOAT_BASE_URL,
    }),
  ),
);
