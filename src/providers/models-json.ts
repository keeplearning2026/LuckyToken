import {
  ModelConfig,
  type ModelsJsonModel,
  type ModelsJsonProvider,
} from "./models-json-schema.js";

/**
 * LuckyToken models.json loader.
 *
 * Schema validation is owned by `models-json-schema.ts` (extracted from Pi's
 * coding-agent ModelConfig), so user models.json files are schema-compatible
 * with the Pi ecosystem. This module parses/loads validated provider configs;
 * the effective built-in + user model composition lives in
 * `effective-composition.ts` (Ticket 09) and the request-time auth/header
 * composition lives in `request-composition.ts` (Ticket 10).
 */

export type ModelsJsonModelDefinition = ModelsJsonModel;
export type ModelsJsonProviderConfig = ModelsJsonProvider;

export interface ModelsJsonConfig {
  providers: Readonly<Record<string, ModelsJsonProviderConfig>>;
}

/** Parse and validate models.json text with the Pi-compatible schema. */
export function parseModelsJson(text: string): ModelsJsonConfig {
  const config = ModelConfig.parse(text);
  const error = config.getError();
  if (error !== undefined) {
    throw new Error(error);
  }
  const providers: Record<string, ModelsJsonProviderConfig> = {};
  for (const providerId of config.getProviderIds()) {
    const provider = config.getProvider(providerId);
    if (provider !== undefined) providers[providerId] = provider;
  }
  return Object.freeze({
    providers: Object.freeze(providers),
  });
}

/** Load and parse models.json; returns undefined when the file is absent. */
export async function loadModelsJson(
  path: string | undefined,
): Promise<ModelsJsonConfig | undefined> {
  if (path === undefined) return undefined;
  const config = await ModelConfig.load(path);
  const error = config.getError();
  if (error !== undefined) {
    throw new Error(error);
  }
  const providers: Record<string, ModelsJsonProviderConfig> = {};
  for (const providerId of config.getProviderIds()) {
    const provider = config.getProvider(providerId);
    if (provider !== undefined) providers[providerId] = provider;
  }
  if (Object.keys(providers).length === 0) return undefined;
  return Object.freeze({
    providers: Object.freeze(providers),
  });
}
