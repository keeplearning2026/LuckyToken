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

import { bundledProviderIds } from "./bundled.js";
import { isSafeProviderId } from "./provider-id.js";
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
 * Token base provider catalog.
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
 *
 * Pinned Pi `composeModelProvider` semantics: the composed model list is a
 * closure over the base Provider's LIVE `getModels()` — the models.json
 * overlay (baseUrl rule, upserts, overrides) re-applies on every call, so
 * restored/refreshed dynamic base facts flow into the served catalog
 * instead of freezing the composition-time list.
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
      ? {} : { baseUrl: composition.baseUrl }),
    auth: composeConfiguredAuth(providerId, base, config, adapters),
    // The registered composition validated eagerly at registration (a
    // failing composition keeps the untouched base); from then on the
    // closure re-composes the same deterministic inputs per call, with the
    // base catalog read live exactly like the pinned composer.
    getModels: () =>
      composeConfiguredProvider(providerId, base, config).models as unknown as readonly Model<Api>[],
  };
}

export interface TokenProviderDependencies {
  /** Optional parsed models.json for user-registered custom providers. */
  readonly modelsJson?: ModelsJsonConfig;
  /** Ticket 10 per-request config value resolution (deterministic in tests). */
  readonly configValues: ConfigValueResolver;
  /**
   * The built-in base catalog the models.json composition overlays
   * (pinned `builtinProviders()`). Injectable for deterministic tests,
   * mirroring `composeEffectiveCatalog(providers, builtins?)`.
   */
  readonly builtins?: readonly Provider[];
}

/**
 * Apply the Token provider composition to a mutable collection
 * (pinned `ModelRuntime.rebuildProviders`): Pi built-ins as the lower
 * layer, valid models.json Providers composed above them with per-Provider
 * isolation, and previously registered user Providers that are no longer
 * configured removed. External Provider Packages are never touched, so
 * their ids cannot shadow Pi builtins or models.json entries and their
 * dynamic refresh state survives recomposition.
 *
 * The initial registration and every Ticket 11 refresh recomposition go
 * through the same function, so the served data plane and the projected
 * catalog can never diverge. Returns every models.json provider id
 * (whether its composition succeeded or was isolated per pinned behavior).
 */
export function applyTokenProviderComposition(
  models: MutableModels,
  dependencies: TokenProviderDependencies & {
    /** User provider ids registered by the previous application. */
    readonly previousUserProviderIds: ReadonlySet<string>;
  },
): readonly string[] {
  const adapters = Object.freeze({ configValues: dependencies.configValues });
  // Provider Activation (Spec v1.0 §8.4, §12.2): a user models.json
  // Provider claiming a reserved bundled Provider ID is invalid under the
  // current contract — bundled identity is product-owned and cannot be
  // replaced by models.json. Fail with a clear configuration error; never
  // resolve the collision by precedence or silent override.
  for (const providerId of Object.keys(dependencies.modelsJson?.providers ?? {})) {
    if (!isSafeProviderId(providerId)) {
      throw new Error(
        `models.json Provider ID must be a safe Provider namespace of 1-64 characters ([A-Za-z0-9][A-Za-z0-9._-]{0,63}): ${providerId}`,
      );
    }
    if (bundledProviderIds.has(providerId)) {
      throw new Error(
        `models.json Provider "${providerId}" is a Token bundled product Provider and cannot be overridden by models.json. Remove it from the configuration.`,
      );
    }
  }
  const newUserProviderIds = new Set(
    Object.keys(dependencies.modelsJson?.providers ?? {}),
  );
  // Composition replacement deletes user Providers omitted by the supplied
  // startup models.json generation. Production does not call this after startup.
  for (const providerId of dependencies.previousUserProviderIds) {
    if (newUserProviderIds.has(providerId)) continue;
    if (models.getProvider(providerId) !== undefined) {
      models.deleteProvider(providerId);
    }
  }
  // Pi built-in providers are part of the Token provider collection:
  // every Pi provider (openai, anthropic, deepseek, ...) is registered so it
  // can be logged in and served through the same Anthropic endpoint.
  const builtins = dependencies.builtins ?? builtinProviders();
  for (const provider of builtins) {
    models.setProvider(provider);
  }
  if (dependencies.modelsJson === undefined) {
    return Object.freeze([...newUserProviderIds]);
  }

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

/**
 * Register Pi builtins and the effective models.json Providers into a Pi
 * `Models` collection (initial composition). External Provider Packages are
 * loaded only after this base catalog is complete, so their IDs cannot
 * shadow Pi builtins or models.json entries. Returns every models.json
 * provider id (whether its composition succeeded or was isolated per
 * pinned behavior).
 */
export function registerTokenProviders(
  models: MutableModels,
  dependencies: TokenProviderDependencies,
): readonly string[] {
  return applyTokenProviderComposition(models, {
    ...dependencies,
    previousUserProviderIds: Object.freeze(new Set<string>()),
  });
}
