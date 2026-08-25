import type {
  AuthContext,
  Credential,
  CredentialStore,
  FetchFunction,
  ModelsStore,
} from "@earendil-works/pi-ai";

import type { TokenCliConfig } from "../../src/cli-config.js";
import {
  createConfiguredTokenDataPlane as createProductionDataPlane,
  type ConfiguredTokenDataPlane as ProductionDataPlane,
} from "../../src/composition.js";
import type { CodexNativeModelSource } from "../../src/codex-native-seam.js";
import type {
  CredentialProfileManagement,
  ProviderAuthBindingAuthority,
} from "../../src/credentials/profile-contract.js";
import {
  createInMemoryProviderCredentialRecordStore,
  NO_PROVIDER_RECORD_REVISION,
  PROVIDER_CREDENTIAL_RECORD_SCHEMA_VERSION,
  type ProviderCredentialRecordStore,
} from "../../src/credentials/profile-record-store.js";
import type {
  RequestJourneyBeginInput,
  RequestJourneyObservationAuthority,
  RequestJourneyObserver,
} from "../../src/diagnostics/contract.js";
import type { PublicModelSource } from "../../src/public-model-seam.js";
import type { PublicModelAuthority } from "../../src/public-models/authority.js";
import { resolveModel } from "../../src/model-resolution.js";
import type { ConfigValueAdapters } from "../../src/providers/config-value.js";
import { loadModelsJson } from "../../src/providers/models-json.js";
import type { ImportProviderModule } from "../../src/providers/package-loader.js";
import {
  createProviderRuntime,
  type ProviderRuntime,
} from "../../src/providers/runtime.js";
import type { SettingsRegistry } from "../../src/settings/catalog.js";

export interface TestConfiguredDataPlaneOptions {
  readonly config: TokenCliConfig;
  readonly credentialRecordStore?: ProviderCredentialRecordStore;
  /** Test fixture source converted into one current Profile per Provider. */
  readonly credentialSeedStore?: CredentialStore;
  readonly fetch: FetchFunction;
  readonly importModule?: ImportProviderModule;
  readonly createMessageId?: () => string;
  readonly createSessionId?: () => string;
  readonly now?: () => number;
  readonly shutdownSignal?: AbortSignal;
  readonly diagnostics?: RequestJourneyObservationAuthority;
  readonly settingsRegistry?: SettingsRegistry;
  readonly onInvalidModelsJson?: (error: unknown) => void;
  readonly configValueAdapters?: ConfigValueAdapters;
  readonly authContext?: AuthContext;
  readonly modelsStore?: ModelsStore;
  readonly codexNativeModels?: CodexNativeModelSource;
  readonly publicModelAuthority?: PublicModelAuthority;
  readonly providerRuntime?: ProviderRuntime;
}

export interface TestConfiguredDataPlane extends ProductionDataPlane {
  readonly userConfiguredProviderIds: readonly string[];
  readonly diagnostics: RequestJourneyObservationAuthority;
  readonly credentialManagement: CredentialProfileManagement;
  readonly providerAuthBindings: ProviderAuthBindingAuthority;
  readonly catalog: ProviderRuntime["catalog"];
}

export type ConfiguredTokenDataPlane = TestConfiguredDataPlane;

export interface TestConfiguredPiModelsOptions {
  readonly piDirectory: string;
  readonly credentialRecordStore?: ProviderCredentialRecordStore;
  readonly credentialSeedStore?: CredentialStore;
  readonly fetch: FetchFunction;
  readonly modelsJsonPath?: string;
  readonly modelsStore?: ModelsStore;
  readonly providerPackages?: Readonly<Record<string, unknown>>;
  readonly importModule?: ImportProviderModule;
  readonly createUuid?: () => string;
  readonly now?: () => number;
  readonly onInvalidModelsJson?: (error: unknown) => void;
  readonly configValueAdapters?: ConfigValueAdapters;
  readonly authContext?: AuthContext;
}

export async function createConfiguredPiModels(
  options: TestConfiguredPiModelsOptions,
): Promise<{
  readonly models: ProviderRuntime["models"];
  readonly externalProviderIds: readonly string[];
  readonly userConfiguredProviderIds: readonly string[];
  readonly modelsJson?: Awaited<ReturnType<typeof loadModelsJson>>;
  readonly catalog: ProviderRuntime["catalog"];
  readonly providerAuthBindings: ProviderRuntime["providerAuthBindings"];
  readonly credentialManagement: ProviderRuntime["credentialManagement"];
}> {
  const modelsJsonPath =
    options.modelsJsonPath ?? `${options.piDirectory}/models.json`;
  const credentialRecordStore = options.credentialRecordStore ??
    (options.credentialSeedStore === undefined
      ? undefined
      : await createSeededCredentialRecordStoreFromStore(
          options.credentialSeedStore,
        ));
  const runtime = await createProviderRuntime({
    piDirectory: options.piDirectory,
    modelsJsonPath,
    userProviderPackages: options.providerPackages ?? {},
    fetch: options.fetch,
    ...(credentialRecordStore === undefined
      ? {}
      : { credentialRecordStore }),
    ...(options.modelsStore === undefined
      ? {}
      : { modelsStore: options.modelsStore }),
    ...(options.importModule === undefined
      ? {}
      : {
          importModule: (specifier: string) =>
            specifier === "@token/provider-commandcode-private"
              ? import("@token/provider-commandcode-private")
              : specifier === "@token/provider-commandcode-goat"
                ? import("@token/provider-commandcode-goat")
              : options.importModule!(specifier),
        }),
    ...(options.createUuid === undefined
      ? {}
      : { createUuid: options.createUuid }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.onInvalidModelsJson === undefined
      ? {}
      : { onInvalidModelsJson: options.onInvalidModelsJson }),
    ...(options.configValueAdapters === undefined
      ? {}
      : { configValueAdapters: options.configValueAdapters }),
    ...(options.authContext === undefined
      ? {}
      : { authContext: options.authContext }),
  });
  let modelsJson: Awaited<ReturnType<typeof loadModelsJson>>;
  try {
    modelsJson = await loadModelsJson(modelsJsonPath);
  } catch {
    modelsJson = undefined;
  }
  const modelsJsonIds = Object.freeze(Object.keys(modelsJson?.providers ?? {}));
  const configured = new Set(modelsJsonIds);
  const externalProviderIds = Object.freeze(
    runtime.models
      .getProviders()
      .map((provider) => provider.id)
      .filter(
        (providerId) =>
          !configured.has(providerId) &&
          runtime.providerSource(providerId) !== "pi_builtin",
      ),
  );
  const userPackageIds = externalProviderIds.filter(
    (providerId) => runtime.providerSource(providerId) === "user",
  );
  return Object.freeze({
    models: runtime.models,
    externalProviderIds,
    userConfiguredProviderIds: Object.freeze([
      ...modelsJsonIds,
      ...userPackageIds,
    ]),
    ...(modelsJson === undefined ? {} : { modelsJson }),
    catalog: runtime.catalog,
    providerAuthBindings: runtime.providerAuthBindings,
    credentialManagement: runtime.credentialManagement,
  });
}

async function configuredProviderIds(
  config: TokenCliConfig,
  runtime: ProviderRuntime,
): Promise<{
  readonly userConfiguredProviderIds: readonly string[];
  readonly discoveryProviderIds: readonly string[];
}> {
  let modelsJsonIds: readonly string[] = [];
  try {
    const modelsJson = await loadModelsJson(config.pi.modelsJson);
    modelsJsonIds = Object.freeze(Object.keys(modelsJson?.providers ?? {}));
  } catch {
    modelsJsonIds = Object.freeze([]);
  }
  const configured = new Set(modelsJsonIds);
  const providerIds = runtime.models
    .getProviders()
    .map((provider) => provider.id);
  const userPackageIds = providerIds.filter(
    (providerId) =>
      !configured.has(providerId) &&
      runtime.providerSource(providerId) === "user",
  );
  const discoveryProviderIds = providerIds.filter(
    (providerId) =>
      !configured.has(providerId) &&
      runtime.providerSource(providerId) !== "pi_builtin",
  );
  return Object.freeze({
    userConfiguredProviderIds: Object.freeze([
      ...modelsJsonIds,
      ...userPackageIds,
    ]),
    discoveryProviderIds: Object.freeze(discoveryProviderIds),
  });
}

function directPublicModels(
  runtime: ProviderRuntime,
  providerIds: readonly string[],
): PublicModelSource {
  const published = Object.freeze(
    runtime.models
      .getModels()
      .filter((model) => providerIds.includes(model.provider))
      .map((model) =>
        Object.freeze({
          alias: `${model.provider}/${model.id}`,
          providerId: model.provider,
          modelId: model.id,
        }),
      ),
  );
  const snapshot = Object.freeze({
    version: 0,
    endpoint: Object.freeze({ host: "127.0.0.1", port: 0 }),
    providers: Object.freeze([]),
    resolve: (selector: string) => {
      try {
        const model = resolveModel(runtime.models, selector);
        return Object.freeze({ providerId: model.provider, modelId: model.id });
      } catch {
        return undefined;
      }
    },
    publishedModels: () => published,
    favoriteModels: () => [],
  });
  return Object.freeze({ requestSnapshot: async () => snapshot });
}

const NOOP_DIAGNOSTICS: RequestJourneyObservationAuthority = Object.freeze({
  begin(input: RequestJourneyBeginInput): RequestJourneyObserver {
    return Object.freeze({
      requestId: input.requestId,
      observe(): void {},
      close(): void {},
    });
  },
  observeRuntime(): void {},
});

/** Test-only convenience composition. It deliberately owns the broad setup
 * production removed, while the Data Plane itself receives only narrow facts.
 * Generic serving tests use a no-I/O Diagnostics observer unless they inject
 * a real unified authority explicitly. */
export async function createConfiguredTokenDataPlane(
  options: TestConfiguredDataPlaneOptions,
): Promise<TestConfiguredDataPlane> {
  const now = options.now ?? Date.now;
  const credentialRecordStore = options.credentialRecordStore ??
    (options.credentialSeedStore === undefined
      ? undefined
      : await createSeededCredentialRecordStoreFromStore(
          options.credentialSeedStore,
        ));
  const runtime =
    options.providerRuntime ??
    (await createProviderRuntime({
      piDirectory: options.config.pi.directory,
      modelsJsonPath: options.config.pi.modelsJson,
      userProviderPackages: options.config.providerPackages,
      fetch: options.fetch,
      ...(credentialRecordStore === undefined
        ? {}
        : { credentialRecordStore }),
      ...(options.modelsStore === undefined
        ? {}
        : { modelsStore: options.modelsStore }),
      ...(options.configValueAdapters === undefined
        ? {}
        : { configValueAdapters: options.configValueAdapters }),
      ...(options.authContext === undefined
        ? {}
        : { authContext: options.authContext }),
      ...(options.importModule === undefined
        ? {}
        : {
            importModule: (specifier: string) =>
              specifier === "@token/provider-commandcode-private"
                ? import("@token/provider-commandcode-private")
                : specifier === "@token/provider-commandcode-goat"
                  ? import("@token/provider-commandcode-goat")
                : options.importModule!(specifier),
          }),
      ...(options.onInvalidModelsJson === undefined
        ? {}
        : { onInvalidModelsJson: options.onInvalidModelsJson }),
      ...(options.createSessionId === undefined
        ? {}
        : { createUuid: options.createSessionId }),
      now,
    }));
  const providerIds = await configuredProviderIds(
    options.config,
    runtime,
  );
  const { userConfiguredProviderIds } = providerIds;
  const diagnostics = options.diagnostics ?? NOOP_DIAGNOSTICS;

  if (options.settingsRegistry !== undefined) {
    await options.settingsRegistry.load();
  }
  const publicModels =
    options.publicModelAuthority === undefined
      ? directPublicModels(runtime, providerIds.discoveryProviderIds)
      : Object.freeze({
          requestSnapshot: async () => options.publicModelAuthority!.snapshot(),
        });
  const dataPlane = await createProductionDataPlane({
    configuration: options.config,
    models: runtime.models,
    providerAuthBindings: runtime.providerAuthBindings,
    publicModels,
    diagnostics,
    isProtocolEnabled: (protocolId) => {
      const setting = options.settingsRegistry?.query([
        `protocols.${protocolId}.enabled`,
      ])[`protocols.${protocolId}.enabled`];
      return setting?.value !== false;
    },
    fetch: options.fetch,
    ...(options.codexNativeModels === undefined
      ? {}
      : { codexNativeModels: options.codexNativeModels }),
    ...(options.createMessageId === undefined
      ? {}
      : { createMessageId: options.createMessageId }),
    ...(options.createSessionId === undefined
      ? {}
      : { createSessionId: options.createSessionId }),
    ...(options.shutdownSignal === undefined
      ? {}
      : { shutdownSignal: options.shutdownSignal }),
    now,
  });

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= dataPlane.close();
    return closePromise;
  };
  return Object.freeze({
    ...dataPlane,
    close,
    userConfiguredProviderIds,
    diagnostics,
    credentialManagement: runtime.credentialManagement,
    providerAuthBindings: runtime.providerAuthBindings,
    catalog: runtime.catalog,
  });
}

export async function createSeededCredentialRecordStore(
  entries: readonly {
    readonly providerId: string;
    readonly credential: Credential;
    readonly displayName?: string;
    readonly authMethodLabel?: string;
  }[],
): Promise<ProviderCredentialRecordStore> {
  let revision = 0;
  const store = createInMemoryProviderCredentialRecordStore({
    createRevision: () => `test-revision-${++revision}`,
  });
  for (const entry of entries) {
    await store.modifyManagement(
      entry.providerId,
      NO_PROVIDER_RECORD_REVISION,
      () => ({
        kind: "commit",
        record: {
          schemaVersion: PROVIDER_CREDENTIAL_RECORD_SCHEMA_VERSION,
          providerId: entry.providerId,
          revision: NO_PROVIDER_RECORD_REVISION,
          selectionGeneration: `test-selection-${entry.providerId}`,
          activeCredentialId: `test-credential-${entry.providerId}`,
          switchPolicy: { apiKeyOn429: false, oauthOn429: false },
          profiles: [{
            credentialId: `test-credential-${entry.providerId}`,
            credentialGeneration: `test-generation-${entry.providerId}`,
            authType: entry.credential.type,
            authMethodLabel: entry.authMethodLabel ?? "Test credentials",
            displayName: entry.displayName ?? "Test",
            enabled: true,
            priority: 0,
            createdAt: 1,
            updatedAt: 1,
            credential: structuredClone(entry.credential),
          }],
        },
        value: undefined,
      }),
    );
  }
  return store;
}

async function createSeededCredentialRecordStoreFromStore(
  seedStore: CredentialStore,
): Promise<ProviderCredentialRecordStore> {
  const entries = await Promise.all(
    (await seedStore.list()).map(async (info) => {
      const credential = await seedStore.read(info.providerId);
      return credential === undefined
        ? undefined
        : { providerId: info.providerId, credential };
    }),
  );
  return createSeededCredentialRecordStore(
    entries.filter((entry) => entry !== undefined),
  );
}
