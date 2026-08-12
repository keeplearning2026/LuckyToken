import type { Model } from "@earendil-works/pi-ai";

/**
 * CommandCode Private provider-owned model construction.
 *
 * The CommandCode upstream endpoint is fixed and the provider ships one
 * built-in model, so users are ready after login without any models.json
 * configuration. This module is fully internal to the provider; external code
 * never imports it.
 */

export const COMMANDCODE_BASE_URL = "https://api.commandcode.ai";
export const COMMANDCODE_PROVIDER_ID = "commandcode-private";
export const COMMANDCODE_API_ID = "commandcode-private";

/**
 * Built-in default model. The CommandCode provider ships with this model so
 * users are ready to go after login without any models.json configuration.
 */
export const COMMANDCODE_DEFAULT_MODEL_ID = "deepseek/deepseek-v4-flash";

export function createCommandCodeDefaultModel(
  baseUrlOverride?: string,
): Model<typeof COMMANDCODE_API_ID> {
  const input: Array<"text" | "image"> = ["text"];
  Object.freeze(input);
  return Object.freeze({
    id: COMMANDCODE_DEFAULT_MODEL_ID,
    name: COMMANDCODE_DEFAULT_MODEL_ID,
    api: COMMANDCODE_API_ID,
    provider: COMMANDCODE_PROVIDER_ID,
    baseUrl: baseUrlOverride ?? COMMANDCODE_BASE_URL,
    reasoning: true,
    input,
    cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    contextWindow: 200_000,
    maxTokens: 64_000,
  });
}
