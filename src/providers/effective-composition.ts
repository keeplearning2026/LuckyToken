import type {
  Api,
  Model,
  Provider,
} from "@earendil-works/pi-ai";
import {
  builtinProviders,
  radiusProvider,
} from "@earendil-works/pi-ai/providers/all";
import type {
  EffectiveCatalogCompositionError,
  EffectiveCatalogProjection,
  EffectiveModelCost,
  EffectiveModelLayer,
  EffectiveModelProjection,
  EffectiveProviderLayer,
  EffectiveProviderProjection,
} from "@token/application-control-plane/control-plane";

import { PI_COMPATIBILITY_BASELINE } from "./pi-baseline.js";
import type {
  ModelsJsonModelDefinition,
  ModelsJsonProviderConfig,
} from "./models-json.js";

/**
 * Ticket 09 effective composition — the single owner of how valid
 * models.json configuration applies over the Pi built-in base catalog.
 *
 * The semantics mirror the repository-pinned Pi implementation
 * (`pi-agent/packages/coding-agent/src/core/provider-composer.ts` in
 * `@earendil-works/pi-coding-agent` 0.84.2):
 *
 * - a custom Provider is created with the pinned required fields and
 *   defaults (`modelFromJson`): name falls back to id, reasoning to false,
 *   input to `["text"]`, cost to zeros, contextWindow to 128000 and
 *   maxTokens to 16384; api/baseUrl resolve model → Provider → base-model
 *   defaults;
 * - a models.json Provider entry overlays the matching built-in Provider
 *   (`applyModelsJson`): base models keep every unrelated fact, their
 *   baseUrl follows the Provider-level rule (except `oauth: "radius"`),
 *   and Provider compat merges into model compat;
 * - model entries upsert by canonical provider/model identity: a matching
 *   base model is replaced in place with the definition's defaulted facts,
 *   new definitions are appended in file order;
 * - `modelOverrides` apply last with pinned field-wise merge semantics
 *   (`applyModelOverride`) and never create models;
 * - composition failures are value-free pinned-Pi errors, isolated per
 *   Provider: a broken custom Provider disappears from the effective
 *   catalog, a broken overlay falls back to the untouched built-in base;
 * - a configured Provider with `oauth: "radius"` and a `baseUrl` first
 *   replaces its same-id built-in baseline with the Radius provider
 *   baseline (pinned model-runtime `configureRadiusProviders`), which
 *   starts with no built-in models — only configured models compose, and
 *   models lacking `api`/`baseUrl` defaults hit the exact pinned error
 *   instead of guessing from built-in facts.
 *
 * Credentials and request auth state (apiKey, headers, auth) never enter
 * the public projection; Ticket 10 owns header/auth compatibility and
 * Ticket 10/13 own Radius OAuth execution/login.
 *
 * The runtime registration (`src/providers/catalog.ts`) consumes the same
 * corrected baseline through `resolveCompositionBase`, so the served data
 * plane and the projected catalog can never diverge.
 */

/** Internal full model facts: everything Pi constructs, plus source-layer
 *  attribution for the public projection. */
export interface EffectiveModelFacts {
  readonly id: string;
  readonly name: string;
  readonly api: string;
  readonly provider: string;
  readonly baseUrl: string;
  readonly reasoning: boolean;
  readonly thinkingLevelMap?: Readonly<Record<string, string | null>>;
  readonly input: readonly ("text" | "image")[];
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly tiers?: ReadonlyArray<unknown>;
  };
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly samplingParams?: Readonly<Record<string, unknown>>;
  readonly compat?: Readonly<Record<string, unknown>>;
  /** Built-in static model headers (e.g. github-copilot/kimi-coding/nvidia).
   *  Internal runtime fact only: pinned applyModelsJson/applyModelOverride
   *  spread `{...model}` and thus preserve them; the public projection never
   *  carries header values. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly layer: EffectiveModelLayer;
  /** Projected fields the `modelOverrides` entry contributed. */
  readonly overriddenFields: readonly string[];
}

/** The composed result for one Provider id (runtime + projection core). */
export interface EffectiveProviderComposition {
  readonly name: string;
  readonly baseUrl: string | undefined;
  readonly models: readonly EffectiveModelFacts[];
}

/** Pinned `mergeCompat` (provider-composer.ts): shallow merge plus nested
 *  merge of the routing/kwargs keys. */
function mergeCompat(
  base: Readonly<Record<string, unknown>> | undefined,
  override: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (!override) return base;
  const merged: Record<string, unknown> = { ...base, ...override };
  for (const key of [
    "openRouterRouting",
    "vercelGatewayRouting",
    "chatTemplateKwargs",
    "chatTemplateArgs",
  ] as const) {
    const baseValue = base?.[key];
    const overrideValue = override[key];
    if (
      (typeof baseValue === "object" && baseValue !== null) ||
      (typeof overrideValue === "object" && overrideValue !== null)
    ) {
      merged[key] = {
        ...(baseValue as object | undefined),
        ...(overrideValue as object | undefined),
      };
    }
  }
  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Projected fields `modelOverrides` may contribute (Ticket 09 scope). */
const overrideProjectedFields: readonly string[] = [
  "name",
  "reasoning",
  "thinkingLevelMap",
  "input",
  "cost",
  "contextWindow",
  "maxTokens",
  "samplingParams",
  "compat",
];

/** Pinned `applyModelOverride` (provider-composer.ts), with attribution. */
function applyModelOverride(
  model: EffectiveModelFacts,
  override: NonNullable<ModelsJsonProviderConfig["modelOverrides"]>[string],
): EffectiveModelFacts {
  const overriddenFields = overrideProjectedFields.filter((key) =>
    Object.hasOwn(override, key),
  );
  const cost = override.cost
    ? {
        input: override.cost.input ?? model.cost.input,
        output: override.cost.output ?? model.cost.output,
        cacheRead: override.cost.cacheRead ?? model.cost.cacheRead,
        cacheWrite: override.cost.cacheWrite ?? model.cost.cacheWrite,
        ...(override.cost.tiers === undefined
          ? model.cost.tiers === undefined
            ? {}
            : { tiers: model.cost.tiers }
          : { tiers: override.cost.tiers }),
      }
    : model.cost;
  const overrideCompat = override.compat as
    | Readonly<Record<string, unknown>>
    | undefined;
  const mergedCompat = mergeCompat(model.compat, overrideCompat);
  const thinkingLevelMap = override.thinkingLevelMap
    ? { ...model.thinkingLevelMap, ...override.thinkingLevelMap }
    : model.thinkingLevelMap;
  return {
    ...model,
    name: override.name ?? model.name,
    reasoning: override.reasoning ?? model.reasoning,
    ...(thinkingLevelMap === undefined
      ? {}
      : { thinkingLevelMap }),
    input: (override.input as ("text" | "image")[] | undefined) ?? model.input,
    cost,
    contextWindow: override.contextWindow ?? model.contextWindow,
    maxTokens: override.maxTokens ?? model.maxTokens,
    ...(override.samplingParams === undefined
      ? {}
      : {
          samplingParams: {
            ...model.samplingParams,
            ...override.samplingParams,
          },
        }),
    ...(mergedCompat === undefined ? {} : { compat: mergedCompat }),
    layer: "overridden",
    overriddenFields: Object.freeze(overriddenFields),
  };
}

/** Pinned `modelFromJson` (provider-composer.ts) plus attribution. */
function modelFromConfig(
  providerId: string,
  definition: ModelsJsonModelDefinition,
  providerConfig: ModelsJsonProviderConfig,
  defaults: EffectiveModelFacts | undefined,
  layer: "user" | "upserted",
): EffectiveModelFacts {
  const api = definition.api ?? providerConfig.api ?? defaults?.api;
  if (!api) {
    throw new Error(
      `Provider ${providerId}, model ${definition.id}: no "api" specified. Set at provider or model level.`,
    );
  }
  const baseUrl = definition.baseUrl ?? providerConfig.baseUrl ?? defaults?.baseUrl;
  if (!baseUrl) {
    throw new Error(
      `Provider ${providerId}: "baseUrl" is required when defining custom models.`,
    );
  }
  if (definition.contextWindow !== undefined && definition.contextWindow <= 0) {
    throw new Error(
      `Provider ${providerId}, model ${definition.id}: invalid contextWindow`,
    );
  }
  if (definition.maxTokens !== undefined && definition.maxTokens <= 0) {
    throw new Error(
      `Provider ${providerId}, model ${definition.id}: invalid maxTokens`,
    );
  }
  const definitionCompat = definition.compat as
    | Readonly<Record<string, unknown>>
    | undefined;
  const providerCompat = providerConfig.compat as
    | Readonly<Record<string, unknown>>
    | undefined;
  const compat = mergeCompat(providerCompat, definitionCompat);
  return Object.freeze({
    id: definition.id,
    name: definition.name ?? definition.id,
    api,
    provider: providerId,
    baseUrl,
    reasoning: definition.reasoning ?? false,
    ...(definition.thinkingLevelMap === undefined
      ? {}
      : { thinkingLevelMap: definition.thinkingLevelMap }),
    input: Object.freeze([...(definition.input ?? ["text"])]),
    cost: Object.freeze(
      definition.cost
        ? {
            input: definition.cost.input,
            output: definition.cost.output,
            cacheRead: definition.cost.cacheRead,
            cacheWrite: definition.cost.cacheWrite,
            ...(definition.cost.tiers === undefined
              ? {}
              : { tiers: definition.cost.tiers }),
          }
        : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ),
    contextWindow: definition.contextWindow ?? 128_000,
    maxTokens: definition.maxTokens ?? 16_384,
    ...(definition.samplingParams === undefined
      ? {}
      : { samplingParams: definition.samplingParams }),
    ...(compat === undefined ? {} : { compat }),
    layer,
    overriddenFields: Object.freeze([]),
  });
}

/** Base model facts from a built-in Provider (layer `builtin`). */
function baseModelFacts(model: Model<Api>): EffectiveModelFacts {
  return Object.freeze({
    id: model.id,
    name: model.name,
    api: model.api,
    provider: model.provider,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap === undefined
      ? {}
      : { thinkingLevelMap: model.thinkingLevelMap }),
    input: Object.freeze([...model.input]),
    cost: Object.freeze({ ...model.cost }),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.samplingParams === undefined
      ? {}
      : { samplingParams: model.samplingParams }),
    ...(model.compat === undefined
      ? {}
      : { compat: model.compat as Readonly<Record<string, unknown>> }),
    ...(model.headers === undefined
      ? {}
      : { headers: Object.freeze({ ...model.headers }) }),
    layer: "builtin" as const,
    overriddenFields: Object.freeze([]),
  });
}

/**
 * Compose one Provider id from its resolved built-in/Radius baseline (see
 * `resolveCompositionBase`) and its models.json entry (when one exists),
 * with pinned Pi semantics. Throws the pinned value-free error on semantic
 * failure; callers own per-Provider isolation (the projection records
 * errors, the runtime keeps the base).
 */
export function composeConfiguredProvider(
  providerId: string,
  base: Provider | undefined,
  config: ModelsJsonProviderConfig | undefined,
): EffectiveProviderComposition {
  if (config === undefined) {
    return {
      name: base?.name ?? providerId,
      baseUrl: base?.baseUrl,
      models: Object.freeze((base?.getModels() ?? []).map(baseModelFacts)),
    };
  }
  const providerCompat = config.compat as
    | Readonly<Record<string, unknown>>
    | undefined;
  if (config.oauth && !config.baseUrl) {
    throw new Error(`Provider ${providerId}: "baseUrl" is required when "oauth" is set.`);
  }
  const hasOverrides =
    config.modelOverrides !== undefined &&
    Object.keys(config.modelOverrides).length > 0;
  if (
    !config.models?.length &&
    !config.baseUrl &&
    !config.headers &&
    !config.compat &&
    !hasOverrides &&
    !config.apiKey &&
    !config.oauth &&
    config.authHeader === undefined
  ) {
    throw new Error(
      `Provider ${providerId}: must specify "baseUrl", "headers", "compat", "modelOverrides", or "models".`,
    );
  }

  // Pinned applyModelsJson step 1: overlay every base model with the
  // Provider-level baseUrl and compat precedence.
  const models: EffectiveModelFacts[] = (base?.getModels() ?? []).map(
    (model) => {
      const facts = baseModelFacts(model);
      const compat = mergeCompat(facts.compat, providerCompat);
      const overlaid = {
        ...facts,
        baseUrl:
          config.oauth === "radius"
            ? facts.baseUrl
            : (config.baseUrl ?? facts.baseUrl),
        ...(compat === undefined ? {} : { compat }),
      };
      return Object.freeze(overlaid);
    },
  );
  // Pinned applyModelsJson step 2: upsert or append definitions by model id.
  for (const definition of config.models ?? []) {
    const existingIndex = models.findIndex(
      (model) => model.id === definition.id,
    );
    const defaults =
      existingIndex >= 0 ? models[existingIndex] : models[0];
    const model = modelFromConfig(
      providerId,
      definition,
      config,
      defaults,
      existingIndex >= 0 ? "upserted" : "user",
    );
    if (existingIndex >= 0) models[existingIndex] = model;
    else models.push(model);
  }
  // Pinned getModels step: modelOverrides are the topmost user-config layer.
  const overrides = config.modelOverrides;
  const composed =
    overrides === undefined
      ? models
      : models.map((model) => {
          const override = overrides[model.id];
          return override === undefined ? model : applyModelOverride(model, override);
        });
  return {
    name: config.name ?? base?.name ?? providerId,
    baseUrl: config.baseUrl ?? base?.baseUrl,
    models: Object.freeze(composed),
  };
}

/**
 * Pinned pre-composition baseline swap (model-runtime
 * `configureRadiusProviders()`): a configured Provider with
 * `oauth: "radius"` and a `baseUrl` replaces its same-id built-in baseline
 * with `radiusProvider({ id, name, gateway })` — the Radius baseline starts
 * with no built-in models and no baseUrl. Applies to every configured
 * Provider id, custom or same-id built-in. This is the single
 * implementation of the swap; the projection and the runtime registration
 * both resolve through it.
 */
export function resolveCompositionBase(
  providerId: string,
  base: Provider | undefined,
  config: ModelsJsonProviderConfig | undefined,
): Provider | undefined {
  if (
    config !== undefined &&
    config.oauth === "radius" &&
    config.baseUrl !== undefined
  ) {
    return radiusProvider({
      id: providerId,
      name: config.name ?? providerId,
      gateway: config.baseUrl.replace(/\/v1\/?$/u, ""),
    });
  }
  return base;
}

/** Cast one parsed (schema-validated) providers record entry. */
function providerConfig(
  value: unknown,
): ModelsJsonProviderConfig | undefined {
  return isRecord(value) ? (value as ModelsJsonProviderConfig) : undefined;
}

function projectModel(model: EffectiveModelFacts): EffectiveModelProjection {
  const projected: EffectiveModelProjection = Object.freeze({
    id: model.id,
    name: model.name,
    api: model.api,
    provider: model.provider,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    input: Object.freeze([...model.input]),
    cost: Object.freeze({ ...model.cost }) as EffectiveModelCost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    layer: model.layer,
    ...(model.overriddenFields.length === 0
      ? {}
      : { overriddenFields: Object.freeze([...model.overriddenFields]) }),
    ...(model.thinkingLevelMap === undefined
      ? {}
      : { thinkingLevelMap: model.thinkingLevelMap }),
    ...(model.compat === undefined ? {} : { compat: model.compat }),
  });
  return projected;
}

function projectProvider(
  providerId: string,
  layer: EffectiveProviderLayer,
  composition: EffectiveProviderComposition,
): EffectiveProviderProjection {
  return Object.freeze({
    id: providerId,
    name: composition.name,
    ...(composition.baseUrl === undefined
      ? {}
      : { baseUrl: composition.baseUrl }),
    layer,
    models: Object.freeze(composition.models.map(projectModel)),
  });
}

/**
 * The authoritative effective catalog: Pi built-ins as the lower layer,
 * valid models.json configuration applied above them with pinned Pi
 * semantics. Deterministic: same parsed providers record (whatever its
 * origin — UI structured write or CLI raw write) yields the same catalog.
 */
export function composeEffectiveCatalog(
  providers: Readonly<Record<string, unknown>>,
  builtins: readonly Provider[] = builtinProviders(),
): EffectiveCatalogProjection {
  const configIds = Object.keys(providers);
  const builtinIds = new Set(builtins.map((provider) => provider.id));
  const providerEntries: EffectiveProviderProjection[] = [];
  const compositionErrors: EffectiveCatalogCompositionError[] = [];

  const composeEntry = (
    providerId: string,
    base: Provider | undefined,
    config: ModelsJsonProviderConfig | undefined,
  ): void => {
    // Pinned pre-composition baseline: a Radius config swaps the same-id
    // built-in baseline for the empty Radius baseline before composition.
    // The layer still follows the default built-in existence: a custom
    // Radius Provider is user-defined even though it gains a Radius base.
    const effectiveBase = resolveCompositionBase(providerId, base, config);
    const layer: EffectiveProviderLayer =
      base !== undefined ? (config === undefined ? "builtin" : "overlaid") : "user";
    try {
      providerEntries.push(
        projectProvider(
          providerId,
          layer,
          composeConfiguredProvider(providerId, effectiveBase, config),
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      compositionErrors.push(
        Object.freeze({ providerId, message }),
      );
      if (effectiveBase !== undefined && config !== undefined) {
        // Pinned model-runtime behavior: a failed overlay falls back to the
        // untouched resolved baseline (for Radius configs that is the empty
        // Radius baseline — which also exists for custom Radius ids),
        // never to half-applied facts.
        providerEntries.push(
          projectProvider(
            providerId,
            layer === "overlaid" ? "builtin" : layer,
            composeConfiguredProvider(providerId, effectiveBase, undefined),
          ),
        );
      }
    }
  };

  // Built-ins first (lower layer), overlaid in place by config entries.
  for (const base of builtins) {
    composeEntry(base.id, base, providerConfig(providers[base.id]));
  }
  // Custom Providers follow in file order.
  for (const providerId of configIds) {
    if (builtinIds.has(providerId)) continue;
    composeEntry(providerId, undefined, providerConfig(providers[providerId]));
  }

  return Object.freeze({
    schemaVersion: "token-effective-catalog-v1",
    baseline: PI_COMPATIBILITY_BASELINE,
    providers: Object.freeze(providerEntries),
    compositionErrors: Object.freeze(compositionErrors),
  });
}
