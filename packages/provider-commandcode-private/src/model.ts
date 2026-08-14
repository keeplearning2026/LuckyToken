import type { Model } from "@earendil-works/pi-ai";

import { findCommandCodeModel } from "./models.js";

/**
 * CommandCode Private provider-owned model construction.
 *
 * The CommandCode upstream endpoint is fixed and the provider ships one
 * built-in model, so users are ready after login without any models.json
 * configuration. This module is fully internal to the provider; external code
 * never imports it.
 */

export { COMMANDCODE_BASE_URL, COMMANDCODE_PROVIDER_ID, COMMANDCODE_API_ID } from "./constants.js";

/**
 * Built-in default model. The CommandCode provider ships with this model so
 * users are ready to go after login without any models.json configuration.
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
