import {
  createModels,
  defaultProviderAuthContext,
  type AuthContext,
  type CredentialStore,
  type FetchFunction,
  type Models,
  type ModelsStore,
} from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import { createAuth } from "./auth.js";
import type { AliasRegistryAuthority } from "./aliases/authority.js";
import type { AliasModelSource } from "./alias-model-seam.js";
import {
  certifyCoreServingComposition,
  type CoreServingCertificationManifest,
} from "./core-serving-certification.js";
import { createInvocationDiagnosticsFactory } from "./invocation-diagnostics/index.js";
import {
  createRequestIdentityObserver,
  type RequestIdentityObserver,
} from "./request-observation/index.js";
import {
  bindRuntimeDiagnosticsConfiguration,
  createRuntimeDiagnosticsStoreFactory,
  type RuntimeDiagnosticsStore,
} from "./runtime-diagnostics/index.js";
import { bindAnthropicConfiguration } from "./protocols/anthropic/configuration.js";
import { bindOpenAIResponsesConfiguration } from "./protocols/openai-responses/configuration.js";
import {
  createFileClientTokenStore,
  type ClientTokenAuthority,
} from "./client-auth/file-token-store.js";
import {
  createLiveClientTokenAuthority,
  type LiveClientTokenAuthority,
} from "./client-auth/live-authority.js";
import type { LuckyTokenCliConfig } from "./cli-config.js";
import {
  createLiveCredentialAuthority,
  type LiveCredentialAuthority,
} from "./credentials/authority.js";
import type { ClientProtocolHandler } from "./http.js";
import { createModelsDiscoveryHandler } from "./models-discovery.js";
import { createFileCredentialStore } from "./pi/file-credential-store.js";
import {
  createConfigValueResolver,
  type ConfigValueAdapters,
  type ConfigValueResolver,
  type EnvSource,
} from "./providers/config-value.js";
import {
  loadModelsJson,
  type ModelsJsonConfig,
} from "./providers/models-json.js";
import {
  applyLuckyTokenProviderComposition,
  registerLuckyTokenProviders,
} from "./providers/catalog.js";
import { createCatalogSnapshotModels } from "./providers/catalog-refresh.js";
import {
  createRequestCompositionModels,
  resolveRequestModel,
} from "./providers/request-composition.js";
import {
  loadProviderPackages,
  type ImportProviderModule,
} from "./providers/package-loader.js";
import {
  anthropicMessagesProtocolId,
  createAnthropicMessagesHandler,
} from "./protocols/anthropic/handler.js";
import {
  createOpenAIResponsesHandler,
  openaiResponsesProtocolId,
} from "./protocols/openai-responses/handler.js";
import { createLuckyTokenRuntime, type LuckyTokenRuntime } from "./runtime.js";
import { createProtocolAwareRuntime } from "./settings/runtime.js";
import type { SettingsRegistry } from "./settings/catalog.js";

export interface ConfiguredPiModelsOptions {
  readonly piDirectory: string;
  readonly credentials?: CredentialStore;
  readonly fetch: FetchFunction;
  /** Optional models.json path; absent means no user-registered providers. */
  readonly modelsJsonPath?: string;
  /**
   * Ticket 11: the validated LuckyToken-owned dynamic catalog cache. When
   * provided, the composition restores the cached dynamic facts (before
   * any network refresh) and serves the one authoritative active catalog
   * snapshot.
   */
  readonly modelsStore?: ModelsStore;
  /**
   * Ticket 11: notified after a successful Provider login through the
   * served Models; the refresh controller schedules a background refresh
   * for the provider that just logged in.
   */
  readonly onProviderLogin?: (providerId: string) => void;
  readonly providerPackages?: Readonly<Record<string, unknown>>;
  readonly importModule?: ImportProviderModule;
  readonly createUuid?: () => string;
  readonly now?: () => number;
  /**
   * Called when models.json exists but cannot be parsed or validated
   * (Ticket 08): the gateway keeps running without models.json providers and
   * the Control Plane authority exposes the exact file error instead of
   * bricking the data plane.
   */
  readonly onInvalidModelsJson?: (error: unknown) => void;
  /**
   * Ticket 10 deterministic env/command adapters for per-request config
   * value resolution (apiKey/header values). Tests inject these; production
   * defaults to `process.env` and a bounded shell. No cached resolution.
   */
  readonly configValueAdapters?: ConfigValueAdapters;
  /**
   * Auth context used by the Provider auth resolution (`ctx.env`). Defaults
   * to the same env source as `configValueAdapters.envSource` so injected
   * tests observe one deterministic environment.
   */
  readonly authContext?: AuthContext;
}

/**
 * One deterministic config-value context (Ticket 10) shared by the Pi
 * models' request composition and the Credential Authority: the same env
 * source, the same resolver, the same auth context. Production defaults to
 * `process.env` and a bounded shell; tests inject both adapters.
 */
function createCompositionConfigValueContext(
  configValueAdapters: ConfigValueAdapters | undefined,
  authContext: AuthContext | undefined,
): {
  readonly envSource: EnvSource;
  readonly configValues: ConfigValueResolver;
  readonly authContext: AuthContext;
} {
  const envSource =
    configValueAdapters?.envSource ?? ((name: string) => process.env[name]);
  const configValues = createConfigValueResolver({
    envSource,
    ...(configValueAdapters?.commandRunner === undefined
      ? {}
      : { commandRunner: configValueAdapters.commandRunner }),
  });
  const context =
    authContext ??
    Object.freeze({
      env: async (name: string) => envSource(name),
      fileExists: defaultProviderAuthContext().fileExists,
    });
  return { envSource, configValues, authContext: context };
}

/**
 * Builds the narrow known-value scrubber (Ticket 07 F4) from every
 * credential owner: Client Protocol token authorities expose their own
 * scrub operation, and the Credential Authority scrubs its owned stored
 * values (raw plus env-resolved references; commands are never executed).
 */
async function createCompositionScrubber(owners: {
  readonly clientAuthority: ClientTokenAuthority;
  readonly responsesAuthority?: ClientTokenAuthority;
  readonly credentialAuthority: LiveCredentialAuthority;
}): Promise<((value: string) => string) | undefined> {
  const scrubbers: Array<(value: string) => string> = [
    owners.clientAuthority.scrub,
    owners.credentialAuthority.scrub,
  ];
  if (owners.responsesAuthority !== undefined) {
    scrubbers.push(owners.responsesAuthority.scrub);
  }
  if (scrubbers.length === 0) return undefined;
  return (value: string) => {
    let redacted = value;
    for (const scrub of scrubbers) redacted = scrub(redacted);
    return redacted;
  };
}

export interface ConfiguredLuckyTokenCompositionOptions {
  readonly config: LuckyTokenCliConfig;
  readonly credentials?: CredentialStore;
  readonly fetch: FetchFunction;
  readonly importModule?: ImportProviderModule;
  readonly createMessageId?: () => string;
  readonly createSessionId?: () => string;
  readonly now?: () => number;
  readonly shutdownSignal?: AbortSignal;
  /**
   * Reuse an already-open Runtime Diagnostics store (Ticket 07), e.g. the
   * one the Control Plane host owns. When absent the composition opens and
   * returns its own store, which the caller must close.
   */
  readonly diagnosticsStore?: RuntimeDiagnosticsStore;
  /** Registered settings authority for protocol enablement; when absent every
   *  configured protocol is served (Ticket 03 behavior). */
  readonly settingsRegistry?: SettingsRegistry;
  /** See `ConfiguredPiModelsOptions.onInvalidModelsJson`. */
  readonly onInvalidModelsJson?: (error: unknown) => void;
  /** See `ConfiguredPiModelsOptions.configValueAdapters` (Ticket 10). */
  readonly configValueAdapters?: ConfigValueAdapters;
  /** See `ConfiguredPiModelsOptions.authContext` (Ticket 10). */
  readonly authContext?: AuthContext;
  /** See `ConfiguredPiModelsOptions.modelsStore` (Ticket 11). */
  readonly modelsStore?: ModelsStore;
  /** See `ConfiguredPiModelsOptions.onProviderLogin` (Ticket 11). */
  readonly onProviderLogin?: (providerId: string) => void;
  /**
   * Ticket 15: the Ticket 14 alias authority created by the run/serve
   * composition root (one registry, never duplicated). When provided, the
   * data plane is alias-only: handlers and model discovery capture one
   * immutable resolver snapshot per request. When absent, the legacy
   * provider/model selector contract applies (test seam).
   */
  readonly aliasAuthority?: AliasRegistryAuthority;
}

export interface ConfiguredLuckyTokenComposition {
  readonly runtime: LuckyTokenRuntime;
  readonly certification: CoreServingCertificationManifest;
  /** User-configured models.json and external Provider Package registrations. */
  readonly userConfiguredProviderIds: readonly string[];
  /** Permanent Runtime Diagnostics store (Ticket 07). */
  readonly diagnosticsStore: RuntimeDiagnosticsStore;
  /** Live per-protocol Client Token authorities (Ticket 16): the running
   *  Data Plane's one active global token per protocol. */
  readonly clientTokenAuthorities: Readonly<
    Record<string, LiveClientTokenAuthority>
  >;
  /** Live Credential Authority (Ticket 12): the running Data Plane's single
   *  serialized auth.json authority for UI/CLI credential commands. */
  readonly credentialAuthority: LiveCredentialAuthority;
  /** Ticket 11 catalog runtime handle: served snapshot Models, recompose
   *  and atomic capture for the refresh controller. */
  readonly catalog: {
    readonly models: Models;
    readonly recompose: (modelsJson: ModelsJsonConfig | undefined) => void;
    readonly capture: () => void;
  };
  /** Request identity observer (Ticket 17 identity seam): the bounded
   *  public ledger of authorized request identities that the Requests
   *  surface and Ticket 18's permanent ledger build on. */
  readonly requestIdentities: RequestIdentityObserver;
}

export async function createConfiguredPiModels(
  options: ConfiguredPiModelsOptions,
): Promise<{
  models: Models;
  externalProviderIds: readonly string[];
  userConfiguredProviderIds: readonly string[];
  /** The parsed valid models.json used for this composition (absent when
   *  the file is absent or invalid); the Credential Authority shares these
   *  provider facts for its status classification. */
  modelsJson?: ModelsJsonConfig;
  /** Ticket 11 catalog runtime handle: the served snapshot Models, the
   *  recompose capability and the atomic capture (one authoritative active
   *  catalog). */
  catalog: {
    readonly models: Models;
    readonly recompose: (modelsJson: ModelsJsonConfig | undefined) => void;
    readonly capture: () => void;
  };
}> {
  // A broken models.json must never brick the data plane (Ticket 08): the
  // gateway starts without models.json providers and the Control Plane
  // authority exposes the exact file error for inspection instead.
  let modelsJson: Awaited<ReturnType<typeof loadModelsJson>>;
  try {
    modelsJson = await loadModelsJson(options.modelsJsonPath);
  } catch (error) {
    modelsJson = undefined;
    options.onInvalidModelsJson?.(error);
  }
  // Ticket 10: one per-request config value resolver (literal / $ENV /
  // !command, uncached) and one deterministic env source for both the
  // resolver and the Provider auth context.
  const { configValues, authContext } = createCompositionConfigValueContext(
    options.configValueAdapters,
    options.authContext,
  );
  const mutableModels = createModels({
    credentials:
      options.credentials ??
      createFileCredentialStore(join(options.piDirectory, "auth.json")),
    authContext,
    ...(options.modelsStore === undefined
      ? {}
      : { modelsStore: options.modelsStore }),
  });
  const modelsJsonProviderIds = registerLuckyTokenProviders(mutableModels, {
    ...(modelsJson === undefined ? {} : { modelsJson }),
    configValues,
  });
  const loaded = await loadProviderPackages({
    models: mutableModels,
    providerPackages: options.providerPackages ?? {},
    host: Object.freeze({
      fetch: options.fetch,
      now: options.now ?? Date.now,
      createUuid: options.createUuid ?? randomUUID,
    }),
    ...(options.importModule === undefined
      ? {}
      : { importModule: options.importModule }),
  });
  // Ticket 10: the same effective Provider/model/runtime composition serves
  // catalog facts and invocation; the facade adds only the per-request
  // model-level configured header layer above the standard Pi auth path.
  const facade: Models = createRequestCompositionModels(
    mutableModels,
    modelsJson,
    { configValues },
  );
  // Ticket 11 login seam: a successful Provider login through the served
  // Models schedules a background refresh for the relevant Provider.
  const loginAware: Models =
    options.onProviderLogin === undefined
      ? facade
      : Object.freeze({
          ...facade,
          login: (
            providerId: string,
            type: "api_key" | "oauth",
            interaction: never,
          ) =>
            facade.login(providerId, type, interaction).then((credential) => {
              options.onProviderLogin?.(providerId);
              return credential;
            }),
        } as Models);
  // Ticket 11: the served Models resolve the one authoritative active
  // catalog snapshot; a capture atomically swaps it for new requests while
  // in-flight invocations keep their captured Model objects. The cached
  // dynamic catalog is restored before the composition returns (before any
  // network refresh), then the initial snapshot is captured.
  const served = createCatalogSnapshotModels(loginAware);
  await served.refresh({ allowNetwork: false });
  served.capture();
  let currentModelsJsonProviderIds: ReadonlySet<string> = new Set(
    modelsJsonProviderIds,
  );
  const recompose = (next: ModelsJsonConfig | undefined): void => {
    currentModelsJsonProviderIds = new Set(
      applyLuckyTokenProviderComposition(mutableModels, {
        ...(next === undefined ? {} : { modelsJson: next }),
        configValues,
        previousUserProviderIds: currentModelsJsonProviderIds,
      }),
    );
  };
  return Object.freeze({
    models: served,
    externalProviderIds: loaded.providerIds,
    userConfiguredProviderIds: Object.freeze([
      ...modelsJsonProviderIds,
      ...loaded.providerIds,
    ]),
    ...(modelsJson === undefined ? {} : { modelsJson }),
    catalog: Object.freeze({
      models: served,
      recompose,
      capture: () => served.capture(),
    }),
  });
}

export async function createConfiguredLuckyTokenComposition(
  options: ConfiguredLuckyTokenCompositionOptions,
): Promise<ConfiguredLuckyTokenComposition> {
  const config = options.config;
  const uninstalledProtocol = Object.keys(config.clientProtocols).find(
    (protocolId) =>
      protocolId !== anthropicMessagesProtocolId &&
      protocolId !== openaiResponsesProtocolId,
  );
  if (uninstalledProtocol !== undefined) {
    throw new Error(
      `Client Protocol is configured but not installed: ${uninstalledProtocol}`,
    );
  }
  const anthropicConfig = Object.hasOwn(
    config.clientProtocols,
    anthropicMessagesProtocolId,
  )
    ? config.clientProtocols[anthropicMessagesProtocolId]
    : undefined;
  if (anthropicConfig === undefined) {
    throw new Error(
      `clientProtocols must configure ${anthropicMessagesProtocolId}`,
    );
  }
  // Ticket 16: live per-protocol authorities own the one active global
  // token. They replace the restart-only static authority: every mutation
  // hot-applies to authorization, list results stay masked, and the narrow
  // known-value scrub follows the live token state.
  const clientAuthorities: Record<string, LiveClientTokenAuthority> = {};
  const clientAuthority = await createLiveClientTokenAuthority({
    store: createFileClientTokenStore({ path: anthropicConfig.authFile }),
  });
  clientAuthorities[anthropicMessagesProtocolId] = clientAuthority;
  const now = options.now ?? Date.now;
  const createSessionId = options.createSessionId ?? randomUUID;
  const openaiResponsesConfig = Object.hasOwn(
    config.clientProtocols,
    openaiResponsesProtocolId,
  )
    ? config.clientProtocols[openaiResponsesProtocolId]
    : undefined;
  const responsesAuthority =
    openaiResponsesConfig === undefined
      ? undefined
      : await createLiveClientTokenAuthority({
          store: createFileClientTokenStore({
            path: openaiResponsesConfig.authFile,
          }),
        });
  if (responsesAuthority !== undefined) {
    clientAuthorities[openaiResponsesProtocolId] = responsesAuthority;
  }
  // First enabling creates exactly one protocol-global token when the scope
  // has none — but only for a never-initialized scope: a deliberately
  // deleted token must survive an ordinary restart, so boot-time enabling
  // never resurrects one. The disabled→enabled transition is ensured by the
  // Settings adapter (which may create in any state).
  const registry = options.settingsRegistry;
  if (registry !== undefined) await registry.load();
  for (const [protocolId, authority] of Object.entries(clientAuthorities)) {
    const enabledSetting =
      registry === undefined
        ? undefined
        : registry.query([`protocols.${protocolId}.enabled`])[
            `protocols.${protocolId}.enabled`
          ];
    const enabled =
      enabledSetting === undefined ? true : enabledSetting.value !== false;
    if (enabled) await authority.ensureGlobal({ freshOnly: true });
  }
  const {
    models,
    externalProviderIds,
    userConfiguredProviderIds,
    modelsJson,
    catalog,
  } = await createConfiguredPiModels({
    piDirectory: config.pi.directory,
    modelsJsonPath: config.pi.modelsJson,
    ...(options.credentials === undefined
      ? {}
      : { credentials: options.credentials }),
    fetch: options.fetch,
    providerPackages: config.providerPackages,
    ...(options.importModule === undefined
      ? {}
      : { importModule: options.importModule }),
    ...(options.onInvalidModelsJson === undefined
      ? {}
      : { onInvalidModelsJson: options.onInvalidModelsJson }),
    ...(options.configValueAdapters === undefined
      ? {}
      : { configValueAdapters: options.configValueAdapters }),
    ...(options.authContext === undefined
      ? {}
      : { authContext: options.authContext }),
    ...(options.modelsStore === undefined
      ? {}
      : { modelsStore: options.modelsStore }),
    ...(options.onProviderLogin === undefined
      ? {}
      : { onProviderLogin: options.onProviderLogin }),
    createUuid: createSessionId,
    now,
  });
  // Ticket 12: the running Data Plane's Credential Authority owns the one
  // Pi-compatible auth.json. It shares the composition's resolver and auth
  // context, so its status facts and the request path can never diverge.
  // The models.json facts follow the live composed config: Ticket 11
  // catalog refresh recomposes with a new config, so the authority reads
  // through a slot the wrapped recompose keeps current.
  const { configValues, authContext } = createCompositionConfigValueContext(
    options.configValueAdapters,
    options.authContext,
  );
  const credentialStore =
    options.credentials ??
    createFileCredentialStore(join(config.pi.directory, "auth.json"));
  let composedModelsJson: ModelsJsonConfig | undefined = modelsJson;
  const credentialAuthority = await createLiveCredentialAuthority({
    store: credentialStore,
    path: join(config.pi.directory, "auth.json"),
    configValues,
    authContext,
    providers: () => models.getProviders(),
    modelsJsonProviders: () =>
      composedModelsJson?.providers ?? Object.freeze({}),
    now,
  });
  // F4: build the narrow known-value scrubber from every credential owner.
  // Each authority exposes only a scrub operation; no raw-secret arrays flow
  // through unrelated modules. The Credential Authority scrubs its owned
  // stored values (raw plus env-resolved references, never commands).
  const scrub = await createCompositionScrubber({
    clientAuthority,
    ...(responsesAuthority === undefined ? {} : { responsesAuthority }),
    credentialAuthority,
  });
  const invocationDiagnostics = createInvocationDiagnosticsFactory({
    configuration: config.failureLogging,
    now,
    ...(scrub === undefined ? {} : { scrub }),
  });
  const diagnosticsStore: RuntimeDiagnosticsStore =
    options.diagnosticsStore ??
    (await createRuntimeDiagnosticsStoreFactory({
      configuration: bindRuntimeDiagnosticsConfiguration(
        config.runtimeDiagnostics,
      ),
      now,
      ...(scrub === undefined ? {} : { scrub }),
    }).open());
  // Attach the known-value scrubber to a caller-provided store (F4): the
  // store opened before credential authorities resolved in `serve`.
  if (options.diagnosticsStore !== undefined && scrub !== undefined) {
    diagnosticsStore.attachScrub(scrub);
  }
  // Ticket 17 identity seam: the internal effective session identity is
  // created per request by the auth boundary; only the optional client
  // identity and canonical project context may reach the public observer.
  const requestIdentities = createRequestIdentityObserver({ now });
  const auth = createAuth({
    authorizeToken: (token) => clientAuthority.authorize(token),
    createEffectiveSessionId: createSessionId,
    onAuthorized: (identity) =>
      requestIdentities.observe(anthropicMessagesProtocolId, identity),
  });
  // Ticket 15: the composition adapts the one alias authority into the
  // narrow data-plane source. Every request refreshes first so hot
  // alias/catalog replacement applies to new requests only, then captures
  // the frozen resolver snapshot for its own resolution and response
  // projection (in-flight requests keep the snapshot they captured).
  const aliasAuthority = options.aliasAuthority;
  const aliasSource: AliasModelSource | undefined =
    aliasAuthority === undefined
      ? undefined
      : Object.freeze({
          requestSnapshot: async () => {
            await aliasAuthority.query();
            return aliasAuthority.resolver();
          },
        });
  const anthropic = createAnthropicMessagesHandler({
    models,
    auth,
    configuration: bindAnthropicConfiguration(
      anthropicConfig.adapterConfiguration,
    ),
    invocationDiagnostics,
    passthroughFetch: options.fetch,
    ...(options.createMessageId === undefined
      ? {}
      : { createMessageId: options.createMessageId }),
    ...(aliasSource === undefined ? {} : { aliasSource }),
    maxRequestBytes: config.limits.maxRequestBytes,
    now,
    // Ticket 10: the Provider/request-composition seam owns request-local
    // baseUrl derivation; the handler receives it as a narrow Pi-typed op.
    resolveRequestModel,
  });
  const clientProtocols: ClientProtocolHandler[] = [anthropic];
  // Shared, unauthenticated model discovery: any client may learn the
  // selectors this endpoint serves, independent of Client Protocol Auth.
  clientProtocols.push(
    createModelsDiscoveryHandler({
      models,
      providerIds: externalProviderIds,
      ...(aliasSource === undefined ? {} : { aliasSource }),
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
  );
  if (openaiResponsesConfig !== undefined && responsesAuthority !== undefined) {
    const responsesAuth = createAuth({
      authorizeToken: (token) => responsesAuthority.authorize(token),
      createEffectiveSessionId: createSessionId,
      onAuthorized: (identity) =>
        requestIdentities.observe(openaiResponsesProtocolId, identity),
    });
    const stateFile =
      openaiResponsesConfig.stateFile ??
      join(dirname(config.configPath), "state", "openai-responses.json");
    const responses = createOpenAIResponsesHandler({
      models,
      auth: responsesAuth,
      configuration: bindOpenAIResponsesConfiguration(
        openaiResponsesConfig.adapterConfiguration,
      ),
      invocationDiagnostics,
      stateFile,
      passthroughFetch: options.fetch,
      ...(aliasSource === undefined ? {} : { aliasSource }),
      maxRequestBytes: config.limits.maxRequestBytes,
      ...(options.shutdownSignal === undefined
        ? {}
        : { shutdownSignal: options.shutdownSignal }),
      now,
      // Ticket 10: the Provider/request-composition seam owns request-local
      // baseUrl derivation; the handler receives it as a narrow Pi-typed op.
      resolveRequestModel,
    });
    clientProtocols.push(responses);
  }
  const certification = certifyCoreServingComposition({
    clientProtocolIds: Object.keys(config.clientProtocols),
    providerIds: models.getProviders().map((provider) => provider.id),
    maxRequestBytes: config.limits.maxRequestBytes,
    requestTimeoutMs: config.limits.requestTimeoutMs,
  });
  const baseRuntime = createLuckyTokenRuntime({
    clientProtocols,
    requestTimeoutMs: config.limits.requestTimeoutMs,
    ...(options.shutdownSignal === undefined
      ? {}
      : { shutdownSignal: options.shutdownSignal }),
  });
  const runtime =
    registry === undefined
      ? baseRuntime
      : createProtocolAwareRuntime({
          runtime: baseRuntime,
          registry,
          protocolRoutes: [
            {
              id: anthropicMessagesProtocolId,
              method: "POST",
              pathname: "/v1/messages",
            },
            {
              id: openaiResponsesProtocolId,
              method: "POST",
              pathname: "/v1/responses",
            },
          ],
        });
  return Object.freeze({
    runtime,
    certification,
    userConfiguredProviderIds,
    diagnosticsStore,
    clientTokenAuthorities: Object.freeze(clientAuthorities),
    credentialAuthority,
    // Ticket 11 handle with the credential authority's live models.json
    // facts kept current: a refresh recompose updates both the served
    // catalog and the status classification source.
    catalog: Object.freeze({
      models: catalog.models,
      recompose: (next: ModelsJsonConfig | undefined) => {
        composedModelsJson = next;
        catalog.recompose(next);
      },
      capture: catalog.capture,
    }),
    requestIdentities,
  });
}
