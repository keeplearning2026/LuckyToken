import { getApiProvider } from "@earendil-works/pi-ai/compat";
import {
  createProvider,
  type FetchFunction,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { randomUUID } from "node:crypto";

import { createCommandCodePrivateProvider } from "./commandcode-private/provider.js";
import type { CommandCodeConfiguration } from "./commandcode-private/configuration.js";
import { COMMANDCODE_MODELS } from "./commandcode-private/models.js";
import {
  modelsJsonApiKeyAuth,
  modelsJsonModel,
  type ModelsJsonConfig,
} from "./models-json.js";
import {
  createNodeProjectSnapshot,
  type ProjectSnapshot,
} from "./commandcode-private/project.js";

export type { ProjectSnapshot } from "./commandcode-private/project.js";
export type { CommandCodeCompatibilityPolicy } from "./commandcode-private/provider.js";
export { commandCodePrivateProviderId } from "./commandcode-private/provider.js";
export { COMMANDCODE_DEFAULT_MODEL_ID as commandCodePrivateDefaultModelId } from "./commandcode-private/model.js";

/**
 * LuckyToken built-in provider catalog.
 *
 * This is the only module that imports concrete Provider implementations.
 * Composition roots and external callers interact with providers exclusively
 * through the Pi `Models` interface and provider id / model id — never through
 * provider implementation code.
 */

export interface LuckyTokenProviderDependencies {
  readonly commandCodeConfiguration?: CommandCodeConfiguration;
  readonly fetch: FetchFunction;
  /** Optional parsed models.json for user-registered custom providers. */
  readonly modelsJson?: ModelsJsonConfig;
  readonly now?: () => number;
  readonly projectSnapshot?: ProjectSnapshot;
  readonly createSessionId?: () => string;
}

/**
 * Register every LuckyToken built-in provider into a Pi `Models` collection.
 * Concrete provider dependencies are injected here — the only place that
 * touches provider implementations.
 */
export function registerLuckyTokenProviders(
  models: MutableModels,
  dependencies: LuckyTokenProviderDependencies,
): void {
  // Pi built-in providers are part of the LuckyToken provider collection:
  // every Pi provider (openai, anthropic, deepseek, ...) is registered so it
  // can be logged in and served through the same Anthropic endpoint.
  for (const provider of builtinProviders()) {
    models.setProvider(provider);
  }

  const provider = createCommandCodePrivateProvider({
    ...(dependencies.commandCodeConfiguration === undefined ? {} : { configuration: dependencies.commandCodeConfiguration }),
    // CommandCode owns bounded request-local failure acquisition.
    fetch: dependencies.fetch,
    now: dependencies.now ?? Date.now,
    projectSnapshot: dependencies.projectSnapshot ?? createNodeProjectSnapshot(),
    createSessionId: dependencies.createSessionId ?? randomUUID,
    models: COMMANDCODE_MODELS,
  });
  models.setProvider(provider);

  registerModelsJsonProviders(models, dependencies.modelsJson);
}

function registerModelsJsonProviders(
  models: MutableModels,
  modelsJson: ModelsJsonConfig | undefined,
): void {
  if (modelsJson === undefined) return;
  for (const [providerId, config] of Object.entries(modelsJson.providers)) {
    // Built-in providers win over models.json with the same provider id, so a
    // stale models.json can never shadow the curated CommandCode catalog.
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
  }
}
