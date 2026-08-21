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

import type { PublicModelSource } from "./public-model-seam.js";
import type { PublicModelAuthority } from "./public-models/authority.js";
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
import {
  bindRequestLedgerConfiguration,
  createRequestLedgerStoreFactory,
  type RequestLedgerStore,
} from "./request-ledger/index.js";
import {
  bindDeepDiagnosticsConfiguration,
  createDeepCaptureAuthority,
  createDeepCaptureStoreFactory,
  type CaptureWriteFailure,
  type DeepCaptureAuthority,
  type DeepCaptureStore,
} from "./deep-diagnostics/index.js";
import { bindAnthropicConfiguration } from "./protocols/anthropic/configuration.js";
import { bindOpenAIResponsesConfiguration } from "./protocols/openai-responses/configuration.js";
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
import { registerLuckyTokenProviders } from "./providers/catalog.js";
import { createCatalogSnapshotModels } from "./providers/catalog-refresh.js";
import {
  createRequestCompositionModels,
  resolveRequestModel,
} from "./providers/request-composition.js";
import type { ProviderRuntime } from "./providers/runtime.js";
import { resolveUsageSemantics } from "./providers/usage-declarations.js";
import { createExecutionOperation } from "./execution.js";
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
import type {
  CodexLocalCredentialAuthority,
  CodexNativeModelSource,
} from "./codex-native-seam.js";
import { createCodexLocalCredentialAuthority } from "./integrations/codex/local-auth.js";
import { createCodexLocalResponsesLane } from "./integrations/codex/local-responses.js";
import { createCodexLocalCompactLane } from "./integrations/codex/local-compact.js";
import { createProviderNativeResponses } from "./provider-native-responses/index.js";
import { createOpenAIResponsesCompactHandler } from "./protocols/openai-responses/compact.js";
import { createResponseSessionState } from "./protocols/openai-responses/session-state.js";

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
  readonly credentialAuthority: LiveCredentialAuthority;
  readonly codexLocalAuth?: CodexLocalCredentialAuthority;
}): Promise<((value: string) => string) | undefined> {
  const scrubbers: Array<(value: string) => string> = [
    owners.credentialAuthority.scrub,
  ];
  if (owners.codexLocalAuth !== undefined) {
    scrubbers.push(owners.codexLocalAuth.scrub);
  }
  if (scrubbers.length === 0) return undefined;
  return (value: string) => {
    let redacted = value;
    for (const scrub of scrubbers) redacted = scrub(redacted);
    return redacted;
  };
}

export interface ConfiguredLuckyTokenDataPlaneOptions {
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
  /**
   * Reuse an already-open Request Ledger store (Ticket 18), e.g. the one
   * the Control Plane host owns. When absent the composition opens and
   * returns its own store, which the caller must close.
   */
  readonly requestLedgerStore?: RequestLedgerStore;
  /**
   * Reuse an already-open Deep Diagnostics capture store (Ticket 22), e.g.
   * the one the Control Plane host owns. When absent the composition opens
   * and returns its own store, which the caller must close. The store
   * fails closed until the credential-owner scrubber is attached.
   */
  readonly deepCaptureStore?: DeepCaptureStore;
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
  /** Native Codex request seams. The Backend-owned Codex integration authority
   *  supplies model identity; tests may inject deterministic implementations. */
  readonly codexLocalAuth?: CodexLocalCredentialAuthority;
  readonly codexNativeModels?: CodexNativeModelSource;
  /** Backend-lifetime Public Model authority. Discovery captures its current
   * immutable snapshot; no request path reads the persistence file. */
  readonly publicModelAuthority?: PublicModelAuthority;
  /**
   * Ticket 23: narrow sanitized capture persistence hooks wired by the
   * owner to the persistence degradation authority. When the failure hook
   * is provided, the composition's legacy diagnostics append is replaced by
   * it (the authority owns the full fallback chain); without it the legacy
   * sanitized diagnostics Critical is appended (unchanged behavior).
   */
  readonly onCapturePersistenceFailure?: (fact: CaptureWriteFailure) => void;
  readonly onCapturePersistenceRecovery?: (fact: {
    readonly requestId: string;
  }) => void;
  /**
   * Provider Activation (Spec v1.0): the Backend-lifetime Provider Runtime
   * created before the Data Plane. When provided, the Data Plane consumes
   * its one Pi Models, credential authority, catalog handle and external
   * Provider ids instead of creating a second Provider composition. When
   * absent (legacy test seam), the composition creates its own Provider
   * composition as before.
   */
  readonly providerRuntime?: ProviderRuntime;
}

export interface ConfiguredLuckyTokenDataPlane {
  readonly runtime: LuckyTokenRuntime;
  readonly certification: CoreServingCertificationManifest;
  /** Finalize protocol-owned resources after serving has become quiescent. */
  close(): Promise<void>;
  /** User-configured models.json and external Provider Package registrations. */
  readonly userConfiguredProviderIds: readonly string[];
  /** Permanent Runtime Diagnostics store (Ticket 07). */
  readonly diagnosticsStore: RuntimeDiagnosticsStore;
  /** Live Credential Authority (Ticket 12): the running Data Plane's single
   *  serialized auth.json authority for UI/CLI credential commands. */
  readonly credentialAuthority: LiveCredentialAuthority;
  /** Ticket 11 catalog runtime handle: served snapshot Models plus atomic
   * capture. Provider composition is fixed for the Backend lifetime. */
  readonly catalog: {
    readonly models: Models;
    readonly capture: () => void;
  };
  /** Request identity observer (Ticket 17 identity seam): the bounded
   *  public ledger of authorized request identities that the Requests
   *  surface and Ticket 18's permanent ledger build on. */
  readonly requestIdentities: RequestIdentityObserver;
  /** Permanent Request Lifecycle Ledger store (Ticket 18): the one SQLite/
   *  WAL authority for request lifecycle facts. */
  readonly requestLedger: RequestLedgerStore;
  /** Bounded Deep Diagnostics capture store (Ticket 22): the one SQLite/
   *  WAL authority for deliberately captured raw request/response
   *  artifacts under age + capacity retention. */
  readonly deepCaptureStore: DeepCaptureStore;
  /** The one global capture authority (Ticket 22): reads the registered
   *  hot-apply enable setting once per accepted request. */
  readonly deepCapture: DeepCaptureAuthority;
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
  /** Ticket 11 catalog runtime handle: served snapshot Models plus atomic
   * capture. models.json is read only during this composition. */
  catalog: {
    readonly models: Models;
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
      capture: () => served.capture(),
    }),
  });
}

export async function createConfiguredLuckyTokenDataPlane(
  options: ConfiguredLuckyTokenDataPlaneOptions,
): Promise<ConfiguredLuckyTokenDataPlane> {
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
  const now = options.now ?? Date.now;
  const createSessionId = options.createSessionId ?? randomUUID;
  const openaiResponsesConfig = Object.hasOwn(
    config.clientProtocols,
    openaiResponsesProtocolId,
  )
    ? config.clientProtocols[openaiResponsesProtocolId]
    : undefined;
  const codexLocalAuth =
    openaiResponsesConfig === undefined
      ? undefined
      : options.codexLocalAuth ?? createCodexLocalCredentialAuthority();
  const codexNativeModels =
    openaiResponsesConfig === undefined ? undefined : options.codexNativeModels;
  const registry = options.settingsRegistry;
  if (registry !== undefined) await registry.load();
  // Provider Activation (Spec v1.0 §13): the Data Plane consumes the
  // Backend-lifetime Provider Runtime's one Pi Models / credential
  // authority / catalog handle when injected. The legacy internal
  // composition path remains only for direct CLI/test composition.
  const providerRuntime = options.providerRuntime;
  let models: Models;
  let externalProviderIds: readonly string[];
  let userConfiguredProviderIds: readonly string[];
  let modelsJson: Awaited<ReturnType<typeof createConfiguredPiModels>>["modelsJson"];
  let catalog: ConfiguredLuckyTokenDataPlane["catalog"];
  let credentialAuthority: LiveCredentialAuthority;
  let composedModelsJson: ModelsJsonConfig | undefined;

  if (providerRuntime !== undefined) {
    models = providerRuntime.models;
    externalProviderIds = providerRuntime.externalProviderIds;
    userConfiguredProviderIds = providerRuntime.externalProviderIds;
    modelsJson = undefined;
    catalog = providerRuntime.catalog;
    credentialAuthority = providerRuntime.credentialAuthority;
    composedModelsJson = undefined;
  } else {
    const composed = await createConfiguredPiModels({
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
    models = composed.models;
    externalProviderIds = composed.externalProviderIds;
    userConfiguredProviderIds = composed.userConfiguredProviderIds;
    modelsJson = composed.modelsJson;
    catalog = composed.catalog;
    // Ticket 12: the running Data Plane's Credential Authority owns the
    // one Pi-compatible auth.json. models.json facts are fixed at composition
    // time; runtime file edits take effect only after a new Backend startup.
    const { configValues, authContext } = createCompositionConfigValueContext(
      options.configValueAdapters,
      options.authContext,
    );
    const credentialStore =
      options.credentials ??
      createFileCredentialStore(join(config.pi.directory, "auth.json"));
    composedModelsJson = modelsJson;
    credentialAuthority = await createLiveCredentialAuthority({
      store: credentialStore,
      path: join(config.pi.directory, "auth.json"),
      configValues,
      authContext,
      providers: () => models.getProviders(),
      modelsJsonProviders: () =>
        composedModelsJson?.providers ?? Object.freeze({}),
      now,
    });
  }
  // F4: build the narrow known-value scrubber from every credential owner.
  // Each authority exposes only a scrub operation; no raw-secret arrays flow
  // through unrelated modules. The Credential Authority scrubs its owned
  // stored values (raw plus env-resolved references, never commands).
  const scrub = await createCompositionScrubber({
    credentialAuthority,
    ...(codexLocalAuth === undefined ? {} : { codexLocalAuth }),
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
  // Ticket 18: the Request Ledger is its own audit surface. Pattern
  // redaction is its baseline; the same credential-owner scrubber is
  // attached (replacing on Data Plane restarts). A ledger persistence fault
  // never changes a model response — it is reported through the narrow
  // sanitized diagnostics seam (request id + message hash only).
  const requestLedger: RequestLedgerStore =
    options.requestLedgerStore ??
    (await createRequestLedgerStoreFactory({
      configuration: bindRequestLedgerConfiguration(config.requestLedger),
      now,
      ...(scrub === undefined ? {} : { scrub }),
      onPersistenceFailure: (failure) => {
        try {
          diagnosticsStore.append({
            level: "critical",
            text: "Request Ledger persistence failure",
            ...(failure.requestId.length === 0
              ? {}
              : { requestId: failure.requestId }),
            details: { messageHash: failure.messageHash },
          });
        } catch {
          // The diagnostics seam must never affect the request path.
        }
      },
    }).open());
  if (
    options.requestLedgerStore !== undefined &&
    scrub !== undefined
  ) {
    requestLedger.attachScrub(scrub);
  }
  // Ticket 22: the bounded capture store is its own audit surface with the
  // same one universal redaction choke point and the same credential-owner
  // scrubber as the diagnostics store and the ledger. It fails closed until
  // the scrubber is attached (raw bodies must never reach disk under a
  // pattern-only downgrade); a capture write fault never changes a model
  // response — it is reported through the narrow sanitized diagnostics
  // seam (request id + message hash only).
  const deepCaptureStore: DeepCaptureStore =
    options.deepCaptureStore ??
    (await createDeepCaptureStoreFactory({
      configuration: bindDeepDiagnosticsConfiguration(config.deepDiagnostics),
      now,
      ...(scrub === undefined ? {} : { scrub }),
    }).open());
  if (options.deepCaptureStore !== undefined && scrub !== undefined) {
    deepCaptureStore.attachScrub(scrub);
  }
  // The one global capture authority: the registered hot-apply setting is
  // the live enable state; each request reads one immutable snapshot at
  // acceptance (in-flight requests keep it after a toggle).
  const deepCapture = createDeepCaptureAuthority({
    store: deepCaptureStore,
    now,
    readEnabled: () => {
      if (registry === undefined) return config.deepDiagnostics.enabled;
      const setting = registry.query(["diagnostics.deepCapture.enabled"])[
        "diagnostics.deepCapture.enabled"
      ];
      if (setting === undefined) return config.deepDiagnostics.enabled;
      return setting.value === true;
    },
    onWriteFailure: (failure) => {
      if (options.onCapturePersistenceFailure !== undefined) {
        // Ticket 23: the owner's degradation authority owns the full
        // fallback chain (fixed Critical to stderr + bounded memory + the
        // persistent diagnostics copy); the legacy append below would
        // duplicate the Critical.
        try {
          options.onCapturePersistenceFailure(failure);
        } catch {
          // The degradation seam must never affect the request path.
        }
        return;
      }
      try {
        diagnosticsStore.append({
          level: "critical",
          text: "Deep Diagnostics capture failure",
          ...(failure.requestId.length === 0
            ? {}
            : { requestId: failure.requestId }),
          details: { code: failure.code },
        });
      } catch {
        // The diagnostics seam must never affect the request path.
      }
    },
    onWriteRecovery: (fact) => {
      if (options.onCapturePersistenceRecovery === undefined) return;
      try {
        options.onCapturePersistenceRecovery(fact);
      } catch {
        // The degradation seam must never affect the request path.
      }
    },
  });
  // Request identity is session-only. Client access authentication and
  // project-scoped identity no longer exist on the Data Plane.
  const requestIdentities = createRequestIdentityObserver({ now });
  const publicModelAuthority = options.publicModelAuthority;
  const publicModels: PublicModelSource | undefined =
    publicModelAuthority === undefined
      ? undefined
      : Object.freeze({
          requestSnapshot: async () => publicModelAuthority.snapshot(),
        });
  const anthropic = createAnthropicMessagesHandler({
    models,
    createSessionId,
    onRequestIdentity: (identity) =>
      requestIdentities.observe(anthropicMessagesProtocolId, {
        ...(identity.clientSessionId === undefined
          ? {}
          : { clientSessionId: identity.clientSessionId }),
      }),
    configuration: bindAnthropicConfiguration(
      anthropicConfig.adapterConfiguration,
    ),
    invocationDiagnostics,
    requestLedger,
    deepCapture,
    passthroughFetch: options.fetch,
    ...(options.createMessageId === undefined
      ? {}
      : { createMessageId: options.createMessageId }),
    ...(publicModels === undefined ? {} : { publicModels }),
    maxRequestBytes: config.limits.maxRequestBytes,
    now,
    // Ticket 10: the Provider/request-composition seam owns request-local
    // baseUrl derivation; the handler receives it as a narrow Pi-typed op.
    resolveRequestModel,
    // Ticket 20: the Provider integration side owns the usage-semantics
    // declaration table; the composition binds it into the neutral
    // execution operation the handler already knows.
    executeOperation: createExecutionOperation(resolveUsageSemantics),
  });
  const clientProtocols: ClientProtocolHandler[] = [anthropic];
  let finalizeResponsesState: (() => Promise<void>) | undefined;
  // Shared model discovery is unauthenticated like the rest of the local
  // Data Plane.
  clientProtocols.push(
    createModelsDiscoveryHandler({
      models,
      providerIds: externalProviderIds,
      ...(publicModels === undefined ? {} : { publicModels }),
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
  );
  if (openaiResponsesConfig !== undefined) {
    const stateFile =
      openaiResponsesConfig.stateFile ??
      join(dirname(config.configPath), "state", "openai-responses.json");
    const providerNativeLane = createProviderNativeResponses({
      models,
      fetch: options.fetch,
    });
    const localNativeLane =
      codexLocalAuth === undefined || codexNativeModels === undefined
        ? undefined
        : createCodexLocalResponsesLane({
            credentials: codexLocalAuth,
            models: codexNativeModels,
            fetch: options.fetch,
          });
    const localCompactLane =
      codexLocalAuth === undefined || codexNativeModels === undefined
        ? undefined
        : createCodexLocalCompactLane({
            credentials: codexLocalAuth,
            models: codexNativeModels,
            fetch: options.fetch,
          });
    const responsesConfiguration = bindOpenAIResponsesConfiguration(
      openaiResponsesConfig.adapterConfiguration,
    );
    const sessionState = createResponseSessionState({
      stateFile,
      storeFalsePolicy: responsesConfiguration.conversion.response.storeFalse,
    });
    finalizeResponsesState = () => sessionState.flush();
    const responses = createOpenAIResponsesHandler({
      models,
      createSessionId,
      onRequestIdentity: (identity) =>
        requestIdentities.observe(openaiResponsesProtocolId, {
          ...(identity.clientSessionId === undefined
            ? {}
            : { clientSessionId: identity.clientSessionId }),
        }),
      configuration: responsesConfiguration,
      invocationDiagnostics,
      requestLedger,
      deepCapture,
      stateFile,
      sessionState,
      providerNativeLane,
      ...(publicModels === undefined ? {} : { publicModels }),
      maxRequestBytes: config.limits.maxRequestBytes,
      now,
      // Ticket 20: the Provider integration side owns the usage-semantics
      // declaration table; the composition binds it into the neutral
      // execution operation the handler already knows.
      executeOperation: createExecutionOperation(resolveUsageSemantics),
      ...(localNativeLane === undefined ? {} : { localNativeLane }),
    });
    clientProtocols.push(responses);
    clientProtocols.push(
      createOpenAIResponsesCompactHandler({
        models,
        ...(publicModels === undefined ? {} : { publicModels }),
        ...(localCompactLane === undefined ? {} : { localNativeLane: localCompactLane }),
        providerNativeLane,
        configuration: responsesConfiguration,
        stateFile,
        sessionState,
        createSessionId,
        executeOperation: createExecutionOperation(resolveUsageSemantics),
        maxRequestBytes: config.limits.maxRequestBytes,
        now,
      }),
    );
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
            {
              id: openaiResponsesProtocolId,
              method: "POST",
              pathname: "/v1/responses/compact",
            },
          ],
        });
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    runtime,
    certification,
    close(): Promise<void> {
      closePromise ??= finalizeResponsesState?.() ?? Promise.resolve();
      return closePromise;
    },
    userConfiguredProviderIds,
    diagnosticsStore,
    credentialAuthority,
    catalog: Object.freeze({
      models: catalog.models,
      capture: catalog.capture,
    }),
    requestIdentities,
    requestLedger,
    deepCaptureStore,
    deepCapture,
  });
}
