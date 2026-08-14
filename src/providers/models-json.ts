import type {
  Api,
  ApiKeyAuth,
  Model,
} from "@earendil-works/pi-ai";

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
 * with the Pi ecosystem. This module converts validated provider configs
 * into Pi `Model` objects and api-key auth.
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

/**
 * Build a Pi `Model` from a models.json definition.
 *
 * `baseUrl` and `api` fall back to the provider-level values so a provider
 * can declare them once and models inherit them.
 */
export function modelsJsonModel(
  providerId: string,
  definition: ModelsJsonModelDefinition,
  providerConfig: ModelsJsonProviderConfig,
): Model<string> {
  const api = definition.api ?? providerConfig.api;
  if (api === undefined) {
    throw new Error(
      `models.json provider ${providerId}, model ${definition.id}: no "api" specified`,
    );
  }
  const baseUrl = definition.baseUrl ?? providerConfig.baseUrl;
  if (baseUrl === undefined) {
    throw new Error(
      `models.json provider ${providerId}, model ${definition.id}: no "baseUrl" specified`,
    );
  }
  const input = [...(definition.input ?? ["text"])];
  const cost = definition.cost
    ? {
        input: definition.cost.input,
        output: definition.cost.output,
        cacheRead: definition.cost.cacheRead,
        cacheWrite: definition.cost.cacheWrite,
      }
    : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  Object.freeze(input);
  Object.freeze(cost);
  return Object.freeze({
    id: definition.id,
    name: definition.name ?? definition.id,
    api: api as Api,
    provider: providerId,
    baseUrl,
    reasoning: definition.reasoning ?? false,
    ...(definition.thinkingLevelMap === undefined
      ? {}
      : { thinkingLevelMap: definition.thinkingLevelMap }),
    input,
    cost,
    contextWindow: definition.contextWindow ?? 128_000,
    maxTokens: definition.maxTokens ?? 16_384,
  });
}

/**
 * Compose the api-key auth for a models.json provider.
 *
 * The stored credential (from `login <provider>`) takes precedence; the
 * models.json `apiKey` field is a configured fallback, mirroring the
 * Pi Provider API-key auth pattern.
 */
export function modelsJsonApiKeyAuth(
  providerConfig: ModelsJsonProviderConfig,
): ApiKeyAuth {
  const configuredApiKey = providerConfig.apiKey?.trim();
  if (configuredApiKey !== undefined && configuredApiKey.length === 0) {
    throw new Error(
      "models.json provider apiKey must be non-empty when present",
    );
  }
  return {
    name: "API key",
    login: async (interaction) => {
      interaction.signal.throwIfAborted();
      const key = (
        await interaction.prompt({
          type: "secret",
          message: "Enter the API key",
        })
      ).trim();
      interaction.signal.throwIfAborted();
      if (key.length === 0) {
        throw new Error("API key must be non-empty");
      }
      return { type: "api_key", key };
    },
    resolve: async ({ credential, signal }) => {
      signal.throwIfAborted();
      const storedApiKey = credential?.key?.trim();
      if (storedApiKey !== undefined && storedApiKey.length > 0) {
        return {
          auth: { apiKey: storedApiKey },
          source: "stored credential",
        };
      }
      return configuredApiKey !== undefined
        ? { auth: { apiKey: configuredApiKey }, source: "configured api key" }
        : undefined;
    },
  };
}
