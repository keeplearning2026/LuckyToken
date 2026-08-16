import { getApiProvider } from "@earendil-works/pi-ai/compat";
import {
  createProvider,
  type Api,
  type Model,
  type MutableModels,
  type Provider,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

import type { ConfigValueResolver } from "./config-value.js";
import {
  composeConfiguredProvider,
  resolveCompositionBase,
  type EffectiveModelFacts,
} from "./effective-composition.js";
import type {
  ModelsJsonConfig,
  ModelsJsonProviderConfig,
} from "./models-json.js";
import {
  composeConfiguredAuth,
  type RequestCompositionAdapters,
} from "./request-composition.js";

/**
 * LuckyToken base provider catalog.
 *
 * This imports Pi's own builtin implementations and applies the valid
 * models.json configuration over them with the same composition the
 * effective catalog projects (Ticket 09): a Provider entry overlays the
 * matching built-in Provider without losing unrelated built-in facts
 * (including static built-in model headers), model entries upsert by
 * canonical provider/model identity, and model overrides apply last. A
 * configured Provider with `oauth: "radius"` and a `baseUrl` first swaps
 * its same-id built-in baseline for the empty Radius baseline (pinned
 * configureRadiusProviders), so only configured models compose. The served
 * data plane therefore can never diverge from the projected catalog.
 *
 * Auth (Ticket 10): every configured Provider enters through the pinned
 * request composition contract (`composeConfiguredAuth` — provider-composer
 * composeApiKeyAuth/composeOAuthAuth): a stored credential wins, then the
 * configured models.json `apiKey` (literal / `$ENV` / `!command`, resolved
 * per request through injected adapters), then the inherited built-in
 * auth; provider-level headers resolve per request into the auth result and
 * `authHeader` adds `Authorization: Bearer` at this Provider-facing
 * boundary only. OAuth declarations compose generically from the base
 * Provider's oauth auth — no Provider-specific flow is hardcoded.
 *
 * Composition failures follow the pinned model-runtime isolation: a failed
 * custom Provider is dropped, a failed overlay keeps the untouched
 * built-in base, and the Control Plane catalog reports the same errors.
 *
 * External Provider Packages are loaded only after this base catalog is
 * complete, so their IDs cannot shadow Pi builtins or models.json entries.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Dispatch streams to the API implementation each model declares. */
function dispatchApiStreams(): ProviderStreams {
  const implFor = (model: Model<Api>): NonNullable<ReturnType<typeof getApiProvider>> => {
    const impl = getApiProvider(model.api);
    if (impl === undefined) {
      throw new Error(`No API provider registered for api: ${model.api}`);
    }
    return impl;
  };
  return {
    stream: (model, context, options) =>
      implFor(model).stream(model, context, options),
    streamSimple: (model, context, options) =>
      implFor(model).streamSimple(model, context, options),
  };
}

/** Build the runtime Provider for a models.json custom (user) Provider. */
function createCustomProvider(
  providerId: string,
  config: ModelsJsonProviderConfig,
  composition: { readonly name: string; readonly baseUrl: string | undefined; readonly models: readonly EffectiveModelFacts[] },
  adapters: RequestCompositionAdapters,
): Provider {
  return createProvider({
    id: providerId,
    name: composition.name,
    ...(composition.baseUrl === undefined
      ? {}
      : { baseUrl: composition.baseUrl }),
    models: composition.models as unknown as readonly Model<Api>[],
    auth: composeConfiguredAuth(providerId, undefined, config, adapters),
    api: dispatchApiStreams(),
  });
}

/**
 * Overlay a built-in Provider: every unrelated built-in fact (stream
 * behavior, dynamic model refresh, filters) survives; only name, baseUrl,
 * auth and the effective model list are replaced by the composition.
 */
function createOverlaidProvider(
  providerId: string,
  base: Provider,
  config: ModelsJsonProviderConfig | undefined,
  composition: { readonly name: string; readonly baseUrl: string | undefined; readonly models: readonly EffectiveModelFacts[] },
  adapters: RequestCompositionAdapters,
): Provider {
  return {
    ...base,
    name: composition.name,
    ...(composition.baseUrl === undefined
      ? {}
      : { baseUrl: composition.baseUrl }),
    auth: composeConfiguredAuth(providerId, base, config, adapters),
    getModels: () => composition.models as unknown as readonly Model<Api>[],
  };
}

export interface LuckyTokenProviderDependencies {
  /** Optional parsed models.json for user-registered custom providers. */
  readonly modelsJson?: ModelsJsonConfig;
  /** Ticket 10 per-request config value resolution (deterministic in tests). */
  readonly configValues: ConfigValueResolver;
}

/**
 * Register Pi builtins and the effective models.json Providers into a Pi
 * `Models` collection. External Provider Packages are loaded only after
 * this base catalog is complete, so their IDs cannot shadow Pi builtins or
 * models.json entries. Returns every models.json provider id (whether its
 * composition succeeded or was isolated per pinned behavior).
 */
export function registerLuckyTokenProviders(
  models: MutableModels,
  dependencies: LuckyTokenProviderDependencies,
): readonly string[] {
  const adapters = Object.freeze({ configValues: dependencies.configValues });
  // Pi built-in providers are part of the LuckyToken provider collection:
  // every Pi provider (openai, anthropic, deepseek, ...) is registered so it
  // can be logged in and served through the same Anthropic endpoint.
  const builtins = builtinProviders();
  for (const provider of builtins) {
    models.setProvider(provider);
  }
  if (dependencies.modelsJson === undefined) return Object.freeze([]);

  const registeredProviderIds: string[] = [];
  for (const [providerId, rawConfig] of Object.entries(
    dependencies.modelsJson.providers,
  )) {
    const config = isRecord(rawConfig)
      ? (rawConfig as ModelsJsonProviderConfig)
      : undefined;
    // Pinned pre-composition baseline (configureRadiusProviders): a Radius
    // config swaps the same-id built-in baseline for the empty Radius
    // baseline, exactly as the effective catalog projection resolves it.
    const base = resolveCompositionBase(
      providerId,
      builtins.find((provider) => provider.id === providerId),
      config,
    );
    try {
      const composition = composeConfiguredProvider(providerId, base, config);
      if (base !== undefined) {
        models.setProvider(
          createOverlaidProvider(providerId, base, config, composition, adapters),
        );
      } else {
        models.setProvider(
          createCustomProvider(providerId, config ?? {}, composition, adapters),
        );
      }
    } catch {
      // Pinned per-Provider isolation: the broken Provider never enters the
      // data plane; a failed overlay keeps the untouched built-in base.
      if (base !== undefined) models.setProvider(base);
    }
    registeredProviderIds.push(providerId);
  }
  return Object.freeze(registeredProviderIds);
}
