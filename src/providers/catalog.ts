import { getApiProvider } from "@earendil-works/pi-ai/compat";
import {
  createProvider,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

import {
  modelsJsonApiKeyAuth,
  modelsJsonModel,
  type ModelsJsonConfig,
} from "./models-json.js";

/**
 * LuckyToken base provider catalog.
 *
 * This imports Pi's own builtin implementations and constructs models.json
 * Providers. External Provider implementations stay behind package-loader.ts.
 */

export interface LuckyTokenProviderDependencies {
  /** Optional parsed models.json for user-registered custom providers. */
  readonly modelsJson?: ModelsJsonConfig;
}

/**
 * Register Pi builtins and models.json Providers into a Pi `Models` collection.
 * External Provider Packages are loaded only after this base catalog is
 * complete, so their IDs cannot shadow Pi builtins or models.json entries.
 */
export function registerLuckyTokenProviders(
  models: MutableModels,
  dependencies: LuckyTokenProviderDependencies,
): readonly string[] {
  // Pi built-in providers are part of the LuckyToken provider collection:
  // every Pi provider (openai, anthropic, deepseek, ...) is registered so it
  // can be logged in and served through the same Anthropic endpoint.
  for (const provider of builtinProviders()) {
    models.setProvider(provider);
  }

  return registerModelsJsonProviders(models, dependencies.modelsJson);
}

function registerModelsJsonProviders(
  models: MutableModels,
  modelsJson: ModelsJsonConfig | undefined,
): readonly string[] {
  if (modelsJson === undefined) return Object.freeze([]);
  const registeredProviderIds: string[] = [];
  for (const [providerId, config] of Object.entries(modelsJson.providers)) {
    // Pi builtins win over models.json with the same provider id.
    if (models.getProvider(providerId) !== undefined) continue;
    const api = config.api;
    if (api === undefined) {
      throw new Error(
        `models.json provider ${providerId}: no "api" specified`,
      );
    }
    const apiImpl = getApiProvider(api);
    if (apiImpl === undefined) {
      throw new Error(
        `models.json provider ${providerId}: unknown api "${api}"`,
      );
    }
    const baseUrl = config.baseUrl;
    if (baseUrl === undefined) {
      throw new Error(
        `models.json provider ${providerId}: no "baseUrl" specified`,
      );
    }
    const modelList = (config.models ?? []).map((definition) =>
      modelsJsonModel(providerId, definition, config),
    );
    if (modelList.length === 0) {
      throw new Error(
        `models.json provider ${providerId}: no models defined`,
      );
    }
    const auth = modelsJsonApiKeyAuth(config);
    models.setProvider(
      createProvider({
        id: providerId,
        name: config.name ?? providerId,
        baseUrl,
        models: modelList,
        auth: { apiKey: auth },
        api: {
          stream: apiImpl.stream,
          streamSimple: apiImpl.streamSimple,
        },
      }),
    );
    registeredProviderIds.push(providerId);
  }
  return Object.freeze(registeredProviderIds);
}
