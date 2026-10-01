/**
 * Provider Runtime (Provider Activation Specification v1.0 §7) — the one
 * Backend-lifetime Provider execution environment.
 *
 * Owns exactly:
 *
 * - the one Pi `Models` collection for login AND request execution;
 * - Pi built-in Provider registration;
 * - `models.json` Provider composition (overlays/custom Providers);
 * - bundled Token Provider Package loading;
 * - external user Provider Package loading;
 * - the one Provider Profile state owner, its narrow management/binding
 *   views, and the composition-private Pi CredentialStore adapter;
 * - the catalog runtime handle (`models`, `capture`);
 * - Provider source classification (`pi_builtin` / `token_bundled` /
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
import { createCodexAppServerRefresher } from "../credentials/codex-app-server-refresh.js";
import { codexExternalAuthPath } from "../credentials/external-auth.js";
import {
  createExternalCredentialSource,
  type ExternalCredentialSource,
} from "../credentials/external-credential-source.js";
import {
  createFileProviderCredentialRecordStore,
  type ProviderCredentialRecordStore,
} from "../credentials/profile-record-store.js";
import { resolveCodexHome } from "../integrations/codex/home.js";
import {
  buildCodexModelCandidates,
  type CodexModelCandidateGeneration,
} from "../integrations/codex/codex-model-candidates.js";
import type { CodexNativeCatalogSource, CodexNativeCatalogSnapshot } from "../integrations/codex/native-catalog-source.js";
import { applyAutomaticModelOverlay } from "./automatic-model-overlay.js";
import {
  bundledProviderIds,
  bundledProviderPackages,
  bundledProviderSpecifiers,
} from "./bundled.js";
import { registerTokenProviders } from "./catalog.js";
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
import { loadModelsJson, type ModelsJsonConfig } from "./models-json.js";
import {
  loadProviderPackages,
  type ImportProviderModule,
} from "./package-loader.js";
import { createRequestCompositionModels } from "./request-composition.js";

export type ProviderSource =
  | "pi_builtin"
  | "token_bundled"
  | "user";

/** One Codex native-model overlay generation (plan sections 4.6–4.8). */
export interface AutomaticModelOverlayHandle {
  /** The candidate set currently published to the served catalog. */
  generation(): CodexModelCandidateGeneration | undefined;
  /** Acquire one fresh native snapshot, rebuild the candidate set, and
   * publish it as one unit. A failure keeps the previous generation. */
  refresh(snapshot?: CodexNativeCatalogSnapshot): Promise<{
    readonly generation?: string;
    readonly warnings: readonly string[];
  }>;
}

/** The narrow Provider Runtime seam (Spec §7.3). */
export interface ProviderRuntime {
  readonly models: Models;
  readonly credentialManagement: CredentialProfileManagement;
  readonly providerAuthBindings: ProviderAuthBindingAuthority;
  readonly automaticModelOverlay: AutomaticModelOverlayHandle;
  scrubCredentialText(value: string): string;
  readonly catalog: CatalogRuntimeHandle;
  catalogOperationsFor(capture: ProviderAuthBindingCapture): CatalogProviderOperations;
  providerSource(providerId: string): ProviderSource;
}

export interface CreateProviderRuntimeOptions {
  readonly piDirectory: string;
  readonly modelsJsonPath: string;
  /** Product-owned configurations for the Token bundled Provider Packages.
   * Provider Runtime treats these as opaque package inputs. */
  readonly bundledProviderConfigurations: Readonly<Record<string, unknown>>;
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
  readonly onAutomaticModelOverlayWarnings?: (warnings: readonly string[]) => void;
  readonly createUuid?: () => string;
  readonly now?: () => number;
  /** Codex-owned home observed by the external credential source and the
   * Codex-native refresh delegation. Defaults to `resolveCodexHome()`. */
  readonly codexHome?: string;
  /** Shared Codex native acquisition. When present, one snapshot generation
   * feeds the automatic `openai-codex` model overlay. */
  readonly nativeCatalogSource?: CodexNativeCatalogSource;
  /** Test/composition seam for the external credential boundary. */
  readonly externalCredentialSource?: ExternalCredentialSource;
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
        `Provider Package ${specifier} is a Token bundled product Provider and cannot be configured in providerPackages. Remove it from the configuration.`,
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
  const codexHome = options.codexHome ?? resolveCodexHome();
  const externalSource =
    options.externalCredentialSource ??
    createExternalCredentialSource({
      authPath: codexExternalAuthPath(codexHome),
      refresher: createCodexAppServerRefresher({ codexHome }),
      now,
    });
  const recordStore =
    options.credentialRecordStore ??
    createFileProviderCredentialRecordStore({
      piDirectory: options.piDirectory,
      createRevision: createUuid,
      ...(options.onCredentialStoreDegraded === undefined
        ? {}
        : { onLockDegraded: options.onCredentialStoreDegraded }),
    });
  let currentProviders: () => readonly Provider[] = () => Object.freeze([]);
  const profileState = createProviderCredentialProfiles({
    recordStore,
    providers: () => currentProviders(),
    createId: createUuid,
    now,
    externalSource,
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

  // Automatic `openai-codex` model overlay (plan section 4): one native
  // acquisition generation, shared by every view. The candidate set is
  // unfiltered by user configuration; each view applies the same per-id
  // exclusion rule against its own configuration.
  const automaticOverlayProviderId = "openai-codex" as const;
  const builtins = builtinProviders();
  const piCodexModels =
    builtins.find((provider) => provider.id === automaticOverlayProviderId)
      ?.getModels() ?? Object.freeze([]);
  const userProvidersView: Readonly<Record<string, unknown>> =
    modelsJson?.providers ?? Object.freeze({});
  let automaticOverlay: CodexModelCandidateGeneration | undefined;
  let lastOverlayWarningKey: string | undefined;
  const reportOverlayWarnings = (generation: string | undefined, warnings: readonly string[]): void => {
    const bounded = Object.freeze(warnings.slice(0, 32).map((warning) => warning.slice(0, 512)));
    const key = JSON.stringify([generation, bounded]);
    if (bounded.length === 0 || key === lastOverlayWarningKey) return;
    lastOverlayWarningKey = key;
    try { options.onAutomaticModelOverlayWarnings?.(bounded); } catch { /* Observation cannot change publication. */ }
  };
  if (options.nativeCatalogSource !== undefined) {
    try {
      automaticOverlay = buildCodexModelCandidates({
        snapshot: await options.nativeCatalogSource.load(),
        piModels: piCodexModels,
      });
      reportOverlayWarnings(automaticOverlay.generation, automaticOverlay.warnings);
    } catch {
      automaticOverlay = undefined;
    }
  }
  const overlayForView = (
    providers: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>> =>
    applyAutomaticModelOverlay({
      providers,
      overlay: automaticOverlay,
      providerId: automaticOverlayProviderId,
    });
  // The candidate set is validated before it is appended, and every entry the
  // overlay does not append to comes from the already-validated user
  // configuration; the composed record is a models.json provider view by
  // construction.
  const servedModelsJson: ModelsJsonConfig = Object.freeze({
    providers: overlayForView(userProvidersView) as unknown as ModelsJsonConfig["providers"],
  });

  // Step 1+2: Pi built-ins + models.json overlays/custom Providers.
  const registeredProviderIds = registerTokenProviders(mutableModels, {
    modelsJson: servedModelsJson,
    configValues,
  });
  const modelsJsonProviderIds = Object.freeze(
    registeredProviderIds.filter(
      (providerId) =>
        providerId !== automaticOverlayProviderId ||
        Object.hasOwn(userProvidersView, providerId),
    ),
  );

  // Step 3: Token bundled Provider Packages. They load through the
  // same Token Provider Package contract as user packages (Spec
  // §8.3); a missing/broken bundled Provider is a product integrity
  // failure (Spec §18.1).
  const bundled = options.bundledProviderConfigurations;
  for (const entry of bundledProviderPackages) {
    if (!Object.hasOwn(bundled, entry.specifier)) {
      throw new Error(
        `Missing bundled Provider Package configuration: ${entry.specifier}`,
      );
    }
  }
  for (const specifier of Object.keys(bundled)) {
    if (!bundledProviderSpecifiers.has(specifier)) {
      throw new Error(
        `Unknown bundled Provider Package configuration: ${specifier}`,
      );
    }
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
    servedModelsJson,
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

  // Startup orphan maintenance: the record is authoritative, so an
  // unreferenced incarnation is collected only after the store's grace period
  // and only while holding the per-credential lock. Failures are bounded
  // maintenance noise and never block startup.
  void (async () => {
    try {
      for (const providerId of await recordStore.listProviderIds()) {
        await recordStore.collectOrphans(providerId);
      }
    } catch {
      // Best-effort maintenance.
    }
  })();

  // Source classification is deterministic (Spec §9.3): bundled IDs win,
  // then Pi built-in IDs, then the startup models.json/user-package Provider
  // set. That source classification stays fixed for the Backend lifetime.
  const piBuiltinIds: ReadonlySet<string> = Object.freeze(
    new Set(builtinProviders().map((provider) => provider.id)),
  );

  const providerSource = (providerId: string): ProviderSource => {
    if (bundledProviderIds.has(providerId)) return "token_bundled";
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

  const automaticModelOverlayHandle: AutomaticModelOverlayHandle = Object.freeze({
    generation: () => automaticOverlay,
    async refresh(snapshot?: CodexNativeCatalogSnapshot) {
      if (options.nativeCatalogSource === undefined) {
        return Object.freeze({ warnings: Object.freeze([]) });
      }
      // Explicit invalidation: a manual refresh re-acquires rather than
      // reusing a TTL-optimized snapshot.
      if (snapshot === undefined) options.nativeCatalogSource.invalidate();
      let next: CodexModelCandidateGeneration;
      try {
        next = buildCodexModelCandidates({
          snapshot: snapshot ?? await options.nativeCatalogSource.load(),
          piModels: piCodexModels,
        });
      } catch {
        // Publication is staged: a failed refresh keeps the previous
        // generation authoritative.
        const warnings = Object.freeze(["Codex native model overlay refresh failed; the previous generation stays published."]);
        reportOverlayWarnings(automaticOverlay?.generation, warnings);
        return Object.freeze({ warnings });
      }
      registerTokenProviders(mutableModels, {
        builtins: builtins.filter((provider) => provider.id === automaticOverlayProviderId),
        modelsJson: Object.freeze({
          providers: applyAutomaticModelOverlay({
            providers: Object.hasOwn(userProvidersView, automaticOverlayProviderId)
              ? { [automaticOverlayProviderId]: userProvidersView[automaticOverlayProviderId] }
              : {},
            overlay: next,
            providerId: automaticOverlayProviderId,
          }) as unknown as ModelsJsonConfig["providers"],
        }),
        configValues,
      });
      automaticOverlay = next;
      served.capture();
      reportOverlayWarnings(next.generation, next.warnings);
      return Object.freeze({
        generation: next.generation,
        warnings: next.warnings,
      });
    },
  });

  return Object.freeze({
    models: served,
    credentialManagement: profileState.management,
    providerAuthBindings: profileState.binding,
    automaticModelOverlay: automaticModelOverlayHandle,
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
