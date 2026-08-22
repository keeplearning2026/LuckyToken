import type { Model } from "@earendil-works/pi-ai";

import { findCommandCodeModel } from "./models.js";

/**
 * CommandCode Private provider-owned model construction.
 *
 * The CommandCode upstream endpoint and model catalog projection are fixed, so
 * users are ready after login without any models.json configuration. This
 * module is fully internal to the provider; external code never imports it.
 */

export { COMMANDCODE_BASE_URL, COMMANDCODE_PROVIDER_ID, COMMANDCODE_API_ID } from "./constants.js";

/**
 * Built-in default model selected from the shared CommandCode capability
 * catalog.
 */
export const COMMANDCODE_DEFAULT_MODEL_ID = "deepseek/deepseek-v4-flash";

export function createCommandCodeDefaultModel(
): Model<string> {
  const catalogModel = findCommandCodeModel(COMMANDCODE_DEFAULT_MODEL_ID);
  if (catalogModel === undefined) {
    throw new Error(
      `CommandCode catalog is missing the default model: ${COMMANDCODE_DEFAULT_MODEL_ID}`,
    );
  }
  return catalogModel;
}
