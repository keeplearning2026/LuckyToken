import type { Model } from "@earendil-works/pi-ai";
import { createCommandCodeModelCatalog } from "@luckytoken/commandcode-model-catalog";

import {
  COMMANDCODE_API_ID,
  COMMANDCODE_BASE_URL,
  COMMANDCODE_PROVIDER_ID,
} from "./constants.js";

/** CommandCode Private projection of the shared model capability catalog. */
export const COMMANDCODE_MODELS: readonly Model<typeof COMMANDCODE_API_ID>[] =
  createCommandCodeModelCatalog({
    provider: COMMANDCODE_PROVIDER_ID,
    api: COMMANDCODE_API_ID,
    baseUrl: COMMANDCODE_BASE_URL,
  });

export function findCommandCodeModel(
  id: string,
): Model<typeof COMMANDCODE_API_ID> | undefined {
  return COMMANDCODE_MODELS.find((entry) => entry.id === id);
}
