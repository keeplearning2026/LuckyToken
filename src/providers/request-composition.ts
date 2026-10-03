import type { ChatModels } from "../chat-models.js";
import { AsyncLocalStorage } from "node:async_hooks";
/** Token-owned models.json auth and header composition.
 * Provider auth and Models.transformHeaders are upstream public extension points.
 * Pi Models owns authentication application, Context normalization and dispatch.
 * Credentials and configuration sources never enter semantic state.
 * Configuration syntax remains based on pi-coding-agent 0.84.2 independently. */

import type {
  Api,
  AnyModel,
  ApiKeyAuth,
  AuthContext,
  AuthResult,
  Credential,
  Model,
  ModelAuth,
  ModelsRequestTransforms,
  OAuthAuth,
  Provider,
  ProviderAuth,
  ProviderHeaders,
  ProviderRequestOptions,
} from "@earendil-works/pi-ai";
import { isModelType } from "@earendil-works/pi-ai";
import type { ConfigValueResolver } from "./config-value.js";
import type {
  ModelsJsonConfig,
  ModelsJsonProviderConfig,
} from "./models-json.js";

export interface RequestCompositionAdapters {
  readonly configValues: ConfigValueResolver;
}

// Infrastructure-only request scope: the public Provider auth result supplies
// env to the public Models header transform, without resolving auth twice.
const requestAuthEnv = new AsyncLocalStorage<(env: AuthResult["env"]) => void>();

/** Pinned model-runtime `mergeHeaders`: override wins case-insensitively. */
export function mergeHeaders(
  base: ProviderHeaders | undefined,
  override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
  if (!base && !override) return undefined;
  const merged: ProviderHeaders = { ...base };
  for (const [name, value] of Object.entries(override ?? {})) {
    const lowerName = name.toLowerCase();
    for (const existingName of Object.keys(merged)) {
      if (existingName.toLowerCase() === lowerName) delete merged[existingName];
    }
    merged[name] = value;
  }
  return merged;
}

/** Pinned `configuredHeaders`: models.json provider-level headers. */
function configuredHeaders(
  config: ModelsJsonProviderConfig | undefined,
): Record<string, string> | undefined {
  return config?.headers;
}

/** Pinned `withConfiguredAuth`. */
function withConfiguredAuth(
  auth: ModelAuth,
  headers: ProviderHeaders | undefined,
  authHeader: boolean,
): ModelAuth {
  let mergedHeaders: ProviderHeaders | undefined =
    auth.headers || headers ? { ...auth.headers, ...headers } : undefined;
  if (authHeader) {
    if (!auth.apiKey) throw new Error("authHeader requires a resolved API key");
    mergedHeaders = {
      ...mergedHeaders,
      Authorization: `Bearer ${auth.apiKey}`,
    };
  }
  return {
    ...auth,
    ...(mergedHeaders === undefined ? {} : { headers: mergedHeaders }),
  };
}

/**
 * Pinned AuthStorage.read semantics for stored api-key credentials: the
 * stored value may be a literal, a `$ENV`/`${ENV}` reference or a
 * `!command` source, and is resolved with the same Ticket 10 resolver used
 * for configured keys (uncached per request; never at status/scrub time).
 * An unresolvable reference reads as no key, so the ambient source takes
 * over exactly like Pi's `resolveConfigValue` returning undefined. The raw
 * slot is never mutated — resolution is per read.
 */
async function resolveStoredApiKeyCredential(
  providerId: string,
  stored: Extract<Credential, { readonly type: "api_key" }>,
  resolver: ConfigValueResolver,
): Promise<Extract<Credential, { readonly type: "api_key" }>> {
  if (stored.key === undefined) return stored;
  try {
    const resolved = resolver.resolveValueOrThrow(
      stored.key,
      `stored API key for provider "${providerId}"`,
    );
    return { ...stored, key: resolved };
  } catch {
    // An unresolvable reference reads as no key (pinned `resolveConfigValue`
    // returning undefined), so the ambient source takes over.
    return {
      type: "api_key",
      ...(stored.env === undefined ? {} : { env: stored.env }),
    };
  }
}

/** Pinned `configContextEnv`: collect ctx.env values for referenced names. */
async function configContextEnv(
  values: readonly string[],
  ctx: AuthContext,
  resolver: ConfigValueResolver,
  explicit?: Readonly<Record<string, string>>,
): Promise<Record<string, string> | undefined> {
  const env: Record<string, string> = { ...explicit };
  for (const name of new Set(
    values.flatMap((value) => resolver.getEnvVarNames(value)),
  )) {
    if (env[name] !== undefined) continue;
    const value = await ctx.env(name);
    if (value !== undefined) env[name] = value;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

/**
 * Pinned `composeApiKeyAuth` (Token has no extension layer): stored
 * credential, then configured models.json key, then inherited built-in
 * auth; provider headers + authHeader compose at resolve time.
 */
function composeApiKeyAuth(
  providerId: string,
  base: Provider | undefined,
  config: ModelsJsonProviderConfig | undefined,
  adapters: RequestCompositionAdapters,
): ApiKeyAuth | undefined {
  const inherited = base?.auth.apiKey;
  const rawKey = config?.apiKey;
  const oauth = base?.auth.oauth;
  // OAuth-only providers get no fabricated API-key login method.
  if (!inherited && rawKey === undefined && oauth) return undefined;
  const rawHeaders = configuredHeaders(config);
  const authHeader = config?.authHeader ?? false;

  return {
    name: inherited?.name ?? "API key",
    login:
      inherited?.login ??
      (async (interaction) => ({
        type: "api_key",
        key: await interaction.prompt({
          type: "secret",
          message: "Enter API key",
        }),
      })),
    check: async (input) => {
      if (input.credential) {
        const credential = await resolveStoredApiKeyCredential(
          providerId,
          input.credential,
          adapters.configValues,
        );
        if (inherited?.check) return inherited.check({ ...input, credential });
        if (credential.key)
          return { type: "api_key", source: "stored credential" };
        const resolved = await inherited?.resolve(input);
        return resolved
          ? resolved.source === undefined
            ? { type: "api_key" }
            : { type: "api_key", source: resolved.source }
          : undefined;
      }
      if (rawKey !== undefined) {
        if (adapters.configValues.isCommandConfigValue(rawKey)) {
          return { type: "api_key", source: "configured API key" };
        }
        const envNames = adapters.configValues.getEnvVarNames(rawKey);
        for (const name of envNames) {
          if ((await input.ctx.env(name)) === undefined) return undefined;
        }
        return { type: "api_key", source: "configured API key" };
      }
      if (inherited?.check) return inherited.check(input);
      const resolved = await inherited?.resolve(input);
      return resolved
        ? resolved.source === undefined
          ? { type: "api_key" }
          : { type: "api_key", source: resolved.source }
        : undefined;
    },
    resolve: async (input) => {
      let result: AuthResult | undefined;
      if (input.credential) {
        const credential = await resolveStoredApiKeyCredential(
          providerId,
          input.credential,
          adapters.configValues,
        );
        result = inherited
          ? await inherited.resolve({ ...input, credential })
          : credential.key
            ? {
                auth: { apiKey: credential.key },
                ...(credential.env === undefined
                  ? {}
                  : { env: credential.env }),
                source: "stored credential",
              }
            : undefined;
      } else if (rawKey !== undefined) {
        const env = await configContextEnv(
          [rawKey],
          input.ctx,
          adapters.configValues,
        );
        const key = adapters.configValues.resolveValueOrThrow(
          rawKey,
          `API key for provider "${providerId}"`,
          env,
        );
        result = inherited
          ? await inherited.resolve({
              ...input,
              credential: { type: "api_key", key },
            })
          : { auth: { apiKey: key }, source: "configured API key" };
      } else {
        result = await inherited?.resolve(input);
      }
      if (!result) return undefined;
      requestAuthEnv.getStore()?.(result.env);
      const explicitEnv = {
        ...(input.credential?.env ?? {}),
        ...(result.env ?? {}),
      };
      const headerEnv = await configContextEnv(
        Object.values(rawHeaders ?? {}),
        input.ctx,
        adapters.configValues,
        explicitEnv,
      );
      const headers = adapters.configValues.resolveHeadersOrThrow(
        rawHeaders,
        `provider "${providerId}"`,
        headerEnv,
      );
      return {
        ...result,
        auth: withConfiguredAuth(result.auth, headers, authHeader),
      };
    },
  };
}

/** Pinned `composeOAuthAuth`: wrap the base OAuth toAuth with configured
 *  headers + authHeader. Generic: no Provider-specific flow is hardcoded. */
function composeOAuthAuth(
  providerId: string,
  base: Provider | undefined,
  config: ModelsJsonProviderConfig | undefined,
  adapters: RequestCompositionAdapters,
): OAuthAuth | undefined {
  const oauth = base?.auth.oauth;
  if (!oauth) return undefined;
  const rawHeaders = configuredHeaders(config);
  const authHeader = config?.authHeader ?? false;
  return {
    ...oauth,
    toAuth: async (credential) => {
      const auth = await oauth.toAuth(credential);
      const env = credential.env;
      const headers = adapters.configValues.resolveHeadersOrThrow(
        rawHeaders,
        `provider "${providerId}"`,
        typeof env === "object" && env !== null
          ? (env as Record<string, string>)
          : undefined,
      );
      return withConfiguredAuth(auth, headers, authHeader);
    },
  };
}

/** Pinned `composeModelProvider` auth half: apiKey + oauth. */
export function composeConfiguredAuth(
  providerId: string,
  base: Provider | undefined,
  config: ModelsJsonProviderConfig | undefined,
  adapters: RequestCompositionAdapters,
): ProviderAuth {
  const apiKey = composeApiKeyAuth(providerId, base, config, adapters);
  const oauth = composeOAuthAuth(providerId, base, config, adapters);
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(oauth ? { oauth } : {}),
  };
}

/**
 * Pinned `rawModelHeaders` + `resolveHeadersOrThrow`: the model-level
 * configured headers (modelOverrides entry, then model definition) resolved
 * per request. Never touches the Model object itself.
 */
export function resolveConfiguredModelHeaders(
  model: Model<Api>,
  config: ModelsJsonProviderConfig | undefined,
  adapters: RequestCompositionAdapters,
  env?: Readonly<Record<string, string>>,
): ProviderHeaders | undefined {
  const definition = config?.models?.find((entry) => entry.id === model.id);
  const headers = {
    ...config?.modelOverrides?.[model.id]?.headers,
    ...definition?.headers,
  };
  const resolved = adapters.configValues.resolveHeadersOrThrow(
    Object.keys(headers).length > 0 ? headers : undefined,
    `model "${model.provider}/${model.id}"`,
    env,
  );
  return resolved as ProviderHeaders | undefined;
}

/**
 * Pinned `resolveCloudflareModel` (cloudflare-stream.ts), mirrored as the
 * equivalent bounded generic rule: every `{NAME}` token in the model baseUrl
 * whose NAME is a valid environment-variable name is substituted from the
 * resolved auth env. Pinned substitutes exactly the Cloudflare account/
 * gateway env names with the literal fallback `env[NAME] ?? "{NAME}"`; the
 * generic token rule is identical for those names (a token without a
 * resolved env value stays literal) and applies to nothing else unless a
 * baseUrl declares a token for an auth-resolved env name.
 */
const BASE_URL_TOKEN_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/gu;

function materializeBaseUrlTokens(
  baseUrl: string,
  env: Readonly<Record<string, string>> | undefined,
): string {
  if (env === undefined) return baseUrl;
  let materialized = baseUrl;
  for (const match of baseUrl.matchAll(BASE_URL_TOKEN_RE)) {
    const name = match[1]!;
    const value = env[name];
    if (value === undefined) continue;
    materialized = materialized.split(`{${name}}`).join(value);
  }
  return materialized;
}

/**
 * The request-local effective model for one request (pinned ModelRuntime
 * `prepareRequest` + cloudflare-stream `resolveCloudflareModel`): the auth
 * resolution's `baseUrl` override wins; otherwise the catalog baseUrl is
 * materialized from the resolved auth env tokens. Always derives a new
 * object — the catalog model is never mutated and the auth env never
 * escapes into it.
 */
export function resolveRequestModel(
  model: Model<Api>,
  resolution: AuthResult | undefined,
): Model<Api> {
  if (resolution === undefined) return model;
  const effectiveBaseUrl =
    resolution.auth.baseUrl ??
    materializeBaseUrlTokens(model.baseUrl, resolution.env);
  return effectiveBaseUrl === model.baseUrl
    ? model
    : { ...model, baseUrl: effectiveBaseUrl };
}

/**
 * Chat-only facade. Native getAuth receives configured model headers;
 * Semantic execution delegates to Pi using its public header transform.
 */
export function createRequestCompositionModels(
  models: ChatModels,
  config: ModelsJsonConfig | undefined,
  adapters: RequestCompositionAdapters,
  options: { readonly readConfig?: () => ModelsJsonConfig | undefined } = {},
): ChatModels {
  const providerConfig = (
    providerId: string,
  ): ModelsJsonProviderConfig | undefined =>
    (options.readConfig === undefined ? config : options.readConfig())
      ?.providers[providerId];

  const getAuth = (
    providerOrModel: string | AnyModel,
    overrides: Parameters<ChatModels["getAuth"]>[1] = {},
  ): Promise<AuthResult | undefined> => {
    if (typeof providerOrModel === "string") {
      return models.getAuth(providerOrModel, overrides);
    }
    if (!isModelType(providerOrModel, "chat")) {
      return models.getAuth(providerOrModel, overrides);
    }
    return models.getAuth(providerOrModel, overrides).then((resolution) => {
      if (!resolution) return undefined;
      const configuredHeaders = resolveConfiguredModelHeaders(
        providerOrModel,
        providerConfig(providerOrModel.provider),
        adapters,
        { ...(resolution.env ?? {}), ...(overrides.env ?? {}) },
      );
      return configuredHeaders === undefined
        ? resolution
        : (() => {
            const merged = mergeHeaders(
              resolution.auth.headers,
              configuredHeaders,
            );
            return {
              ...resolution,
              auth: {
                ...resolution.auth,
                ...(merged === undefined ? {} : { headers: merged }),
              },
            };
          })();
    });
  };

  const withConfiguredHeaders = <
    TOptions extends ProviderRequestOptions & ModelsRequestTransforms,
    TResult,
  >(
    model: Model<Api>,
    options: TOptions | undefined,
    run: (options: TOptions | undefined) => TResult,
  ): TResult => {
    const config = providerConfig(model.provider);
    const definition = config?.models?.find((entry) => entry.id === model.id);
    if (
      definition?.headers === undefined &&
      config?.modelOverrides?.[model.id]?.headers === undefined
    ) {
      return run(options);
    }
    let resolvedEnv: AuthResult["env"];
    return requestAuthEnv.run((env) => { resolvedEnv = env; }, () =>
      run({
        ...options,
        transformHeaders: async (headers: ProviderHeaders) => {
          const configured = resolveConfiguredModelHeaders(
            model,
            providerConfig(model.provider),
            adapters,
            { ...resolvedEnv, ...options?.env },
          );
          const composed = mergeHeaders(
            mergeHeaders(headers, configured),
            options?.headers,
          ) ?? {};
          return options?.transformHeaders === undefined
            ? composed
            : options.transformHeaders(composed);
        },
      } as TOptions),
    );
  };

  return Object.freeze<ChatModels>({
    getProviders: () => models.getProviders(),
    getProvider: (id) => models.getProvider(id),
    getModels: (provider) => models.getModels(provider),
    getModel: (provider, id) => models.getModel(provider, id),
    refresh: (options) => models.refresh(options),
    checkAuth: (providerId, options) => models.checkAuth(providerId, options),
    getAvailable: (providerId, options) => models.getAvailable(providerId, options),
    getAuth,
    login: (...args) => models.login(...args),
    logout: (providerId, options) => models.logout(providerId, options),
    stream: (model, context, options) => withConfiguredHeaders(
      model, options, (prepared) => models.stream(model, context, prepared),
    ),
    complete: (model, context, options) => withConfiguredHeaders(
      model, options, (prepared) => models.complete(model, context, prepared),
    ),
    streamSimple: (model, context, options) => withConfiguredHeaders(
      model, options, (prepared) => models.streamSimple(model, context, prepared),
    ),
    completeSimple: (model, context, options) => withConfiguredHeaders(
      model, options, (prepared) => models.completeSimple(model, context, prepared),
    ),
    fetchDeferred: (model, handle, options) => withConfiguredHeaders(
      model, options, (prepared) => models.fetchDeferred(model, handle, prepared),
    ),
    cancelDeferred: (model, handle, options) => withConfiguredHeaders(
      model, options, (prepared) => models.cancelDeferred(model, handle, prepared),
    ),
  });
}
