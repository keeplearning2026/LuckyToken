/**
 * Provider Runtime (Provider Activation Specification v1.0 §7) — the one
 * Backend-lifetime Provider execution environment.
 *
 * Owns exactly:
 *
 * - the one Pi `Models` collection for login AND request execution;
 * - Pi built-in Provider registration;
 * - `models.json` Provider composition (overlays/custom Providers);
 * - bundled LuckyToken Provider Package loading;
 * - external user Provider Package loading;
 * - the one Provider Profile state owner, its narrow management/binding
 *   views, and the composition-private Pi CredentialStore adapter;
 * - the catalog runtime handle (`models`, `capture`);
 * - Provider source classification (`pi_builtin` / `luckytoken_bundled` /
 *   `user`).
 *
 * Does NOT own: the Control Plane host, Data Plane listener lifecycle,
 * HTTP server, Client Protocol handlers, Alias Authority, Settings
 * Registry, Request Ledger, History/Backup, Tray/Electron state.
 *
 * The seam is intentionally small and stable (Spec §7.3). No start/stop,
 * event bus, command dispatcher, state store or service locator is added.
 */

import {
  createModels,
  defaultProviderAuthContext,
  type AuthContext,
  type FetchFunction,
  type Models,
  type ModelsStore,
  type Provider,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { randomUUID } from "node:crypto";
import type {
  CredentialProfileManagement,
  ProviderAuthBindingAuthority,
  ProviderAuthBindingCapture,
} from "../credentials/profile-contract.js";
import { createProviderCredentialProfiles } from "../credentials/profile-authority.js";
import {
  createFileProviderCredentialRecordStore,
  type ProviderCredentialRecordStore,
} from "../credentials/profile-record-store.js";
import {
  bundledProviderIds,
  bundledProviderPackages,
  bundledProviderSpecifiers,
} from "./bundled.js";
import { registerLuckyTokenProviders } from "./catalog.js";
import {
  createCatalogSnapshotModels,
  type CatalogProviderOperations,
  type CatalogRuntimeHandle,
} from "./catalog-refresh.js";
import {
  createConfigValueResolver,
  type ConfigValueAdapters,
  type ConfigValueResolver,
  type EnvSource,
} from "./config-value.js";
import { loadModelsJson } from "./models-json.js";
import {
  loadProviderPackages,
  type ImportProviderModule,
} from "./package-loader.js";
import { createRequestCompositionModels } from "./request-composition.js";

export type ProviderSource =
  | "pi_builtin"
  | "luckytoken_bundled"
  | "user";

/** The narrow Provider Runtime seam (Spec §7.3). */
export interface ProviderRuntime {
  readonly models: Models;
  readonly credentialManagement: CredentialProfileManagement;
  readonly providerAuthBindings: ProviderAuthBindingAuthority;
  scrubCredentialText(value: string): string;
  readonly catalog: CatalogRuntimeHandle;
  catalogOperationsFor(capture: ProviderAuthBindingCapture): CatalogProviderOperations;
  providerSource(providerId: string): ProviderSource;
}

export interface CreateProviderRuntimeOptions {
  readonly piDirectory: string;
  readonly modelsJsonPath: string;
  /** Explicitly configured external/user Provider Packages. Bundled
   *  packages are never configured here; claiming one is rejected. */
  readonly userProviderPackages: Readonly<Record<string, unknown>>;
  readonly fetch: FetchFunction;
  /** Test/composition Adapter. Production uses the per-Provider file store. */
  readonly credentialRecordStore?: ProviderCredentialRecordStore;
  readonly modelsStore?: ModelsStore;
  readonly configValueAdapters?: ConfigValueAdapters;
  readonly authContext?: AuthContext;
  readonly importModule?: ImportProviderModule;
  readonly onInvalidModelsJson?: (error: unknown) => void;
  readonly onCredentialStoreDegraded?: (error: unknown) => void;
  readonly createUuid?: () => string;
  readonly now?: () => number;
  readonly credentialUsage?: (
    credentialIds: readonly string[],
  ) => readonly {
    readonly credentialId: string;
    readonly lastUsedAt: number;
    readonly lastSucceededAt?: number;
  }[];
}

/** One deterministic config-value context shared by Pi Models and the
 *  Provider Profile state owner. */
function createRuntimeConfigValueContext(
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
 * Validate the explicitly configured external/user Provider Package record
 * against the bundled product identities (Spec §5.5, §8.4): a bundled
 * package specifier is a reserved product identity and cannot be claimed by
 * user configuration. Fails with a clear current-contract error; no
 * migration, duplicate load, silent ignore or compatibility branch.
 */
export function assertUserProviderPackages(
  userProviderPackages: Readonly<Record<string, unknown>>,
): void {
  for (const specifier of Object.keys(userProviderPackages)) {
    if (bundledProviderSpecifiers.has(specifier)) {
      throw new Error(
        `Provider Package ${specifier} is a LuckyToken bundled product Provider and cannot be configured in providerPackages. Remove it from the configuration.`,
      );
    }
  }
}

export async function createProviderRuntime(
  options: CreateProviderRuntimeOptions,
): Promise<ProviderRuntime> {
  assertUserProviderPackages(options.userProviderPackages);

  // A broken models.json must never brick the Backend: the runtime starts
  // without models.json providers and the Control Plane authority exposes
  // the exact file error for inspection instead.
  let modelsJson: Awaited<ReturnType<typeof loadModelsJson>>;
  try {
    modelsJson = await loadModelsJson(options.modelsJsonPath);
  } catch (error) {
    modelsJson = undefined;
    options.onInvalidModelsJson?.(error);
  }

  const { configValues, authContext } = createRuntimeConfigValueContext(
    options.configValueAdapters,
    options.authContext,
  );
  const now = options.now ?? Date.now;
  const createUuid = options.createUuid ?? randomUUID;
  let currentProviders: () => readonly Provider[] = () => Object.freeze([]);
  const profileState = createProviderCredentialProfiles({
    recordStore: options.credentialRecordStore ??
      createFileProviderCredentialRecordStore({
        piDirectory: options.piDirectory,
        createRevision: createUuid,
        ...(options.onCredentialStoreDegraded === undefined
          ? {}
          : { onLockDegraded: options.onCredentialStoreDegraded }),
      }),
    providers: () => currentProviders(),
    createId: createUuid,
    now,
    ambientStatus: (providerId) =>
      modelsJson?.providers[providerId]?.apiKey === undefined
        ? "unknown"
        : "configured",
    ...(options.credentialUsage === undefined
      ? {}
      : { credentialUsage: options.credentialUsage }),
  });

  // The ONE Pi Models collection for the Backend lifetime: login and every
  // later Data Plane serving instance share this object graph (Spec §3.4,
  // §6).
  const mutableModels = createModels({
    credentials: profileState.credentialStore,
    authContext,
    ...(options.modelsStore === undefined
      ? {}
      : { modelsStore: options.modelsStore }),
  });

  // Step 1+2: Pi built-ins + models.json overlays/custom Providers.
  const modelsJsonProviderIds = registerLuckyTokenProviders(mutableModels, {
    ...(modelsJson === undefined ? {} : { modelsJson }),
    configValues,
  });

  // Step 3: LuckyToken bundled Provider Packages. They load through the
  // same LuckyToken Provider Package contract as user packages (Spec
  // §8.3); a missing/broken bundled Provider is a product integrity
  // failure (Spec §18.1).
  const bundled: Record<string, unknown> = {};
  for (const entry of bundledProviderPackages) {
    bundled[entry.specifier] = entry.configuration;
  }
  await loadProviderPackages({
    models: mutableModels,
    providerPackages: bundled,
    host: Object.freeze({
      fetch: options.fetch,
      now,
      createUuid,
    }),
    ...(options.importModule === undefined
      ? {}
      : { importModule: options.importModule }),
  });

  // Step 4: external user Provider Packages (explicit configuration only).
  const userLoaded = await loadProviderPackages({
    models: mutableModels,
    providerPackages: options.userProviderPackages,
    host: Object.freeze({
      fetch: options.fetch,
      now,
      createUuid,
    }),
    ...(options.importModule === undefined
      ? {}
      : { importModule: options.importModule }),
  });

  const modelsJsonProviderIdSet: ReadonlySet<string> = Object.freeze(
    new Set(modelsJsonProviderIds),
  );
  const userPackageProviderIds: ReadonlySet<string> = Object.freeze(
    new Set(userLoaded.providerIds),
  );
  // Ticket 10: the same effective Provider/model/runtime composition serves
  // catalog facts and invocation; the facade adds only the per-request
  // model-level configured header layer above the standard Pi auth path.
  const facade: Models = createRequestCompositionModels(
    mutableModels,
    modelsJson,
    { configValues },
  );

  // The served Models resolve the one authoritative active catalog
  // snapshot; a capture atomically swaps it for new requests while
  // in-flight invocations keep their captured Model objects.
  const served = createCatalogSnapshotModels(facade);
  currentProviders = () => served.getProviders();
  await served.refresh({ allowNetwork: false });
  served.capture();
  await profileState.management.query();

  // Source classification is deterministic (Spec §9.3): bundled IDs win,
  // then Pi built-in IDs, then the startup models.json/user-package Provider
  // set. That source classification stays fixed for the Backend lifetime.
  const piBuiltinIds: ReadonlySet<string> = Object.freeze(
    new Set(builtinProviders().map((provider) => provider.id)),
  );

  const providerSource = (providerId: string): ProviderSource => {
    if (bundledProviderIds.has(providerId)) return "luckytoken_bundled";
    if (piBuiltinIds.has(providerId)) return "pi_builtin";
    if (
      modelsJsonProviderIdSet.has(providerId) ||
      userPackageProviderIds.has(providerId)
    ) {
      return "user";
    }
    // Defensive: an unknown Provider is a user-derived identity (it cannot
    // be a Pi built-in or bundled one by construction).
    return "user";
  };

  const createCatalogOperationsFor = (
    capture: ProviderAuthBindingCapture,
  ): CatalogProviderOperations => {
    const assertProvider = (providerId: string): void => {
      if (capture.facts.providerId !== providerId) {
        throw new Error("Catalog operation does not match its captured Provider binding");
      }
    };
    return Object.freeze({
      async isCurrent(providerId: string): Promise<boolean> {
        assertProvider(providerId);
        return profileState.binding.publishIfCurrent(capture, () => undefined);
      },
      async publishIfCurrent(
        providerId: string,
        publish: (assertCurrent: () => void) => Promise<void> | void,
      ): Promise<boolean> {
        assertProvider(providerId);
        return profileState.binding.publishIfCurrent(capture, publish);
      },
      async refreshProvider(
        providerId: string,
        refreshOptions: Parameters<CatalogRuntimeHandle["refreshProvider"]>[1],
      ) {
        assertProvider(providerId);
        return profileState.binding.runBound(capture, () =>
          served.refresh({ ...refreshOptions, providers: [providerId] }),
        );
      },
      async checkAuth(
        providerId: string,
        checkOptions?: Parameters<CatalogRuntimeHandle["checkAuth"]>[1],
      ) {
        assertProvider(providerId);
        return profileState.binding.runBound(capture, () =>
          served.checkAuth(providerId, checkOptions),
        );
      },
    });
  };

  return Object.freeze({
    models: served,
    credentialManagement: profileState.management,
    providerAuthBindings: profileState.binding,
    scrubCredentialText: (value: string) => profileState.scrub(value),
    catalog: Object.freeze({
      models: served,
      capture: (preserveProviderIds?: ReadonlySet<string>) =>
        served.capture(preserveProviderIds),
      async operationsForProvider(providerId: string) {
        return createCatalogOperationsFor(
          await profileState.binding.capture(providerId),
        );
      },
      async refreshProvider(
        providerId: string,
        refreshOptions: Parameters<CatalogRuntimeHandle["refreshProvider"]>[1],
      ) {
        const capture = await profileState.binding.capture(providerId);
        return profileState.binding.runBound(capture, () =>
          served.refresh({ ...refreshOptions, providers: [providerId] }),
        );
      },
      async checkAuth(
        providerId: string,
        checkOptions?: Parameters<CatalogRuntimeHandle["checkAuth"]>[1],
      ) {
        const capture = await profileState.binding.capture(providerId);
        return profileState.binding.runBound(capture, () =>
          served.checkAuth(providerId, checkOptions),
        );
      },
      async isCurrent(): Promise<boolean> {
        return true;
      },
      async publishIfCurrent(
        _providerId: string,
        publish: (assertCurrent: () => void) => Promise<void> | void,
      ): Promise<boolean> {
        await publish(() => undefined);
        return true;
      },
      async restoreProvider(
        providerId: string,
        entry: Parameters<CatalogRuntimeHandle["restoreProvider"]>[1],
      ): Promise<void> {
        const provider = served.getProvider(providerId);
        if (provider?.refreshModels === undefined) return;
        await provider.refreshModels({
          stored: structuredClone(entry),
          publish: async (publication) => {
            publication.update?.();
            return true;
          },
          allowNetwork: false,
          signal: new AbortController().signal,
        });
      },
    }),
    catalogOperationsFor(capture: ProviderAuthBindingCapture): CatalogProviderOperations {
      return createCatalogOperationsFor(capture);
    },
    providerSource,
  });
}
