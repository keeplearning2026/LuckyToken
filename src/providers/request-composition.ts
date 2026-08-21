/**
 * Request-time Provider-facing composition: auth resolution, headers and
 * authHeader, mirroring the pinned Pi implementation
 * (`pi-agent/packages/coding-agent/src/core/provider-composer.ts` and
 * `model-runtime.ts` in @earendil-works/pi-coding-agent 0.84.2).
 *
 * Ownership: this is the single Provider-facing invocation boundary for
 * models.json auth/header facts. Client Protocol adapters, the Pi semantic
 * IR, and public model-visible projections never receive apiKey, header
 * values, env references or command text from here.
 *
 * Semantics mirrored from the pinned baseline:
 *
 * - `composeConfiguredAuth` mirrors `composeApiKeyAuth`/`composeOAuthAuth`:
 *   a stored credential wins, then the configured models.json `apiKey`
 *   (literal, `$ENV`/`${ENV}` template or `!command`, resolved UNCACHED on
 *   every request), then the inherited built-in auth; provider-level
 *   `headers` resolve per request and merge into the auth result;
 *   `authHeader` adds `Authorization: Bearer <key>` and throws the exact
 *   pinned error when no API key resolved; OAuth-only bases get no
 *   fabricated api-key login and their `toAuth` composes the same
 *   headers/authHeader generically;
 * - `mergeHeaders` mirrors model-runtime `mergeHeaders`: later sources win
 *   case-insensitively (same-name different casing collapses);
 * - `resolveConfiguredModelHeaders` mirrors `rawModelHeaders` +
 *   `resolveHeadersOrThrow`: modelOverrides headers, then model-definition
 *   headers (definition wins on exact key), resolved per request;
 * - `createRequestCompositionModels` mirrors ModelRuntime's
 *   `getAuth`/`prepareRequest`: model-level configured headers merge above
 *   auth headers (which already include the built-in static model headers
 *   via pi-ai `Models.getAuth`), request-option headers win last, and an
 *   auth `baseUrl` override replaces the request model's baseUrl.
 *
 * All env/command sources are injected deterministic adapters in tests;
 * production defaults to `process.env` and a bounded shell.
 */

import type {
  Api,
  ApiKeyAuth,
  AuthContext,
  AuthResult,
  Context,
  Credential,
  Model,
  ModelAuth,
  Models,
  ModelsApiStreamOptions,
  ModelsDeferredCancelOptions,
  ModelsDeferredFetchOptions,
  ModelsRefreshOptions,
  ModelsRefreshResult,
  ModelsRequestTransforms,
  ModelsSimpleStreamOptions,
  OAuthAuth,
  Provider,
  ProviderAuth,
  ProviderHeaders,
  ProviderRequestOptions,
  SimpleStreamOptions,
  StreamOptions,
} from "@earendil-works/pi-ai";
import { lazyStream, ModelsError } from "@earendil-works/pi-ai";
import type { ConfigValueResolver } from "./config-value.js";
import type {
  ModelsJsonConfig,
  ModelsJsonProviderConfig,
} from "./models-json.js";

export interface RequestCompositionAdapters {
  readonly configValues: ConfigValueResolver;
}

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
 * Pinned `composeApiKeyAuth` (LuckyToken has no extension layer): stored
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
 * The runtime Models facade (pinned ModelRuntime getAuth/prepareRequest):
 * the same provider collection the data plane serves, with per-request
 * model-level configured headers composed above the auth result. Every
 * other Models operation delegates to the underlying collection.
 */
export function createRequestCompositionModels(
  models: Models,
  config: ModelsJsonConfig | undefined,
  adapters: RequestCompositionAdapters,
  options: { readonly readConfig?: () => ModelsJsonConfig | undefined } = {},
): Models {
  const providerConfig = (
    providerId: string,
  ): ModelsJsonProviderConfig | undefined =>
    (options.readConfig === undefined ? config : options.readConfig())
      ?.providers[providerId];

  const getAuth = (
    providerOrModel: string | Model<Api>,
    overrides: Parameters<Models["getAuth"]>[1] = {},
  ): Promise<AuthResult | undefined> => {
    if (typeof providerOrModel === "string") {
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

  const prepareRequest = async <
    TOptions extends ProviderRequestOptions & ModelsRequestTransforms,
  >(
    model: Model<Api>,
    options: TOptions | undefined,
  ): Promise<{
    provider: Provider;
    model: Model<Api>;
    options: Omit<TOptions, "transformHeaders"> & ProviderRequestOptions;
  }> => {
    const provider = models.getProvider(model.provider);
    if (!provider)
      throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
    const resolution = await getAuth(model, {
      ...(options?.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options?.env === undefined ? {} : { env: options.env }),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!resolution)
      throw new ModelsError(
        "auth",
        `Provider is not configured: ${model.provider}`,
      );

    const { transformHeaders, ...rawProviderOptions } = options ?? {};
    const providerOptions = rawProviderOptions as Omit<
      TOptions,
      "transformHeaders"
    > &
      ProviderRequestOptions;
    let headers = mergeHeaders(
      resolution.auth.headers,
      providerOptions.headers,
    );
    if (transformHeaders) headers = await transformHeaders(headers ?? {});
    const env =
      resolution.env || providerOptions.env
        ? { ...(resolution.env ?? {}), ...(providerOptions.env ?? {}) }
        : undefined;
    return {
      provider,
      model: resolution.auth.baseUrl
        ? { ...model, baseUrl: resolution.auth.baseUrl }
        : model,
      options: {
        ...providerOptions,
        apiKey: providerOptions.apiKey ?? resolution.auth.apiKey,
        headers,
        env,
      } as Omit<TOptions, "transformHeaders"> & ProviderRequestOptions,
    };
  };

  const stream = <TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: ModelsApiStreamOptions<TApi>,
  ) =>
    lazyStream(model, async () => {
      const prepared = await prepareRequest(
        model,
        options as (StreamOptions & ModelsRequestTransforms) | undefined,
      );
      return prepared.provider.stream(
        prepared.model as Model<TApi>,
        context,
        prepared.options as never,
      );
    });

  const streamSimple = (
    model: Model<Api>,
    context: Context,
    options?: ModelsSimpleStreamOptions,
  ) =>
    lazyStream(model, async () => {
      const prepared = await prepareRequest(model, options);
      return prepared.provider.streamSimple(
        prepared.model,
        context,
        prepared.options as SimpleStreamOptions,
      );
    });

  return Object.freeze({
    getProviders: () => models.getProviders(),
    getProvider: (id: string) => models.getProvider(id),
    getModels: (provider?: string) => models.getModels(provider),
    getModel: (provider: string, id: string) => models.getModel(provider, id),
    refresh: (options?: ModelsRefreshOptions): Promise<ModelsRefreshResult> =>
      models.refresh(options),
    checkAuth: (providerId: string, options?: { signal?: AbortSignal }) =>
      models.checkAuth(providerId, options),
    getAvailable: (providerId?: string, options?: { signal?: AbortSignal }) =>
      models.getAvailable(providerId, options),
    getAuth,
    login: (
      providerId: string,
      type: "api_key" | "oauth",
      interaction: never,
    ) => models.login(providerId, type, interaction),
    logout: (providerId: string, options?: { signal?: AbortSignal }) =>
      models.logout(providerId, options),
    stream,
    complete: (
      model: Model<Api>,
      context: Context,
      options?: ModelsApiStreamOptions<Api>,
    ) => stream(model, context, options).result(),
    streamSimple,
    completeSimple: (
      model: Model<Api>,
      context: Context,
      options?: ModelsSimpleStreamOptions,
    ) => streamSimple(model, context, options).result(),
    fetchDeferred: (
      model: Model<Api>,
      handle: never,
      options?: ModelsDeferredFetchOptions,
    ) =>
      lazyStream(model, async () => {
        const prepared = await prepareRequest(model, options);
        if (!prepared.provider.fetchDeferred) {
          throw new ModelsError(
            "provider",
            `Provider ${model.provider} does not support deferred responses`,
          );
        }
        return prepared.provider.fetchDeferred(
          prepared.model,
          handle,
          prepared.options as never,
        );
      }).result(),
    cancelDeferred: async (
      model: Model<Api>,
      handle: never,
      options?: ModelsDeferredCancelOptions,
    ): Promise<void> => {
      const prepared = await prepareRequest(model, options);
      if (!prepared.provider.cancelDeferred) {
        throw new ModelsError(
          "provider",
          `Provider ${model.provider} does not support deferred responses`,
        );
      }
      await prepared.provider.cancelDeferred(
        prepared.model,
        handle,
        prepared.options as never,
      );
    },
  } as Models);
}
