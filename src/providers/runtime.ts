/**
 * Provider Runtime (Provider Activation Specification v1.0 §7) — the one
 * Backend-lifetime Provider execution environment.
 *
 * Owns exactly:
 *
 * - the one Pi `Models` collection for login AND request execution;
 * - Pi built-in Provider registration;
 * - `models.json` Provider composition (overlays/custom Providers);
 * - bundled LuckyToken Provider Package loading (CommandCode Private);
 * - external user Provider Package loading;
 * - the one Pi-compatible credential store and the Live Credential
 *   Authority over it;
 * - the catalog runtime handle (`models`, `recompose`, `capture`);
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
  type CredentialStore,
  type FetchFunction,
  type Models,
  type ModelsStore,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { LiveCredentialAuthority } from "../credentials/authority.js";
import { createLiveCredentialAuthority } from "../credentials/authority.js";
import { createFileCredentialStore } from "../pi/file-credential-store.js";
import {
  bundledProviderIds,
  bundledProviderPackages,
  bundledProviderSpecifiers,
} from "./bundled.js";
import {
  applyLuckyTokenProviderComposition,
  registerLuckyTokenProviders,
} from "./catalog.js";
import {
  createCatalogSnapshotModels,
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
  | "luckytoken_bundled"
  | "user";

/** The narrow Provider Runtime seam (Spec §7.3). */
export interface ProviderRuntime {
  readonly models: Models;
  readonly credentialAuthority: LiveCredentialAuthority;
  readonly catalog: CatalogRuntimeHandle;
  /** Every non-Pi Provider identity introduced by product assembly:
   *  bundled LuckyToken Packages plus external user Packages. Used by the
   *  shared model-discovery surface. This is a fact projection, not a
   *  duplicate Provider registry. */
  readonly externalProviderIds: readonly string[];
  providerSource(providerId: string): ProviderSource;
}

export interface CreateProviderRuntimeOptions {
  readonly piDirectory: string;
  readonly modelsJsonPath: string;
  /** Explicitly configured external/user Provider Packages. Bundled
   *  packages are never configured here; claiming one is rejected. */
  readonly userProviderPackages: Readonly<Record<string, unknown>>;
  readonly fetch: FetchFunction;
  readonly credentials?: CredentialStore;
  readonly modelsStore?: ModelsStore;
  readonly configValueAdapters?: ConfigValueAdapters;
  readonly authContext?: AuthContext;
  readonly importModule?: ImportProviderModule;
  readonly onInvalidModelsJson?: (error: unknown) => void;
  readonly onProviderLogin?: (providerId: string) => void;
  readonly createUuid?: () => string;
  readonly now?: () => number;
}

/** One deterministic config-value context shared by the Pi models and the
 *  Credential Authority (mirror of the composition's helper). */
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

  // The ONE Pi Models collection for the Backend lifetime: login and every
  // later Data Plane serving instance share this object graph (Spec §3.4,
  // §6).
  const mutableModels = createModels({
    credentials:
      options.credentials ??
      createFileCredentialStore(join(options.piDirectory, "auth.json")),
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
  const bundledLoaded = await loadProviderPackages({
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

  const externalProviderIds: readonly string[] = Object.freeze([
    ...bundledLoaded.providerIds,
    ...userLoaded.providerIds,
  ]);
  // The models.json Provider ids the composition currently owns. recompose
  // uses ONLY these as the previous user set: external user Provider
  // Packages are never touched by models.json recomposition (pinned
  // semantics), so they must not be in the delete scope.
  let currentModelsJsonProviderIds: ReadonlySet<string> = new Set(
    modelsJsonProviderIds,
  );
  const userPackageProviderIds: ReadonlySet<string> = Object.freeze(
    new Set(userLoaded.providerIds),
  );
  let currentModelsJson: ModelsJsonConfig | undefined = modelsJson;

  // Ticket 10: the same effective Provider/model/runtime composition serves
  // catalog facts and invocation; the facade adds only the per-request
  // model-level configured header layer above the standard Pi auth path.
  const facade: Models = createRequestCompositionModels(
    mutableModels,
    modelsJson,
    { configValues },
    // Provider Activation (Spec v1.0 §12.1): the request composition
    // facade must observe the CURRENT models.json generation, not the
    // initial one — recompose updates the same variable the facade reads,
    // so per-request auth/header composition and the catalog never diverge.
    { readConfig: () => currentModelsJson },
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

  // The served Models resolve the one authoritative active catalog
  // snapshot; a capture atomically swaps it for new requests while
  // in-flight invocations keep their captured Model objects.
  const served = createCatalogSnapshotModels(loginAware);
  await served.refresh({ allowNetwork: false });
  served.capture();

  // Credential Authority over the same store the Models use (Spec §10.1):
  // one auth.json, one authority, for the whole Backend lifetime.
  const credentialStore =
    options.credentials ??
    createFileCredentialStore(join(options.piDirectory, "auth.json"));
  const credentialAuthority = await createLiveCredentialAuthority({
    store: credentialStore,
    path: join(options.piDirectory, "auth.json"),
    configValues,
    authContext,
    providers: () => served.getProviders(),
    modelsJsonProviders: () =>
      currentModelsJson?.providers ?? Object.freeze({}),
    now,
  });

  const recompose = (next: ModelsJsonConfig | undefined): void => {
    // Provider Activation (Spec v1.0 §12.1/§19.4): one logical operation.
    // The composition is applied FIRST — it can fail (e.g. a reserved
    // bundled Provider ID) — and only a successful composition commits the
    // new generation to the request-config reader and source metadata.
    // A failed recompose never produces a mixed generation where the
    // request config reader already points at N+1 while the composition
    // and catalog are still generation N.
    const nextUserProviderIds = applyLuckyTokenProviderComposition(
      mutableModels,
      {
        ...(next === undefined ? {} : { modelsJson: next }),
        configValues,
        previousUserProviderIds: currentModelsJsonProviderIds,
      },
    );
    currentModelsJson = next;
    currentModelsJsonProviderIds = new Set(nextUserProviderIds);
  };

  // Source classification is deterministic (Spec §9.3): bundled IDs win,
  // then Pi built-in IDs, then current user Providers. The user Provider
  // set is updated by the same recompose operation that changes models.json
  // composition (Spec §12.1).
  const piBuiltinIds: ReadonlySet<string> = Object.freeze(
    new Set(builtinProviders().map((provider) => provider.id)),
  );

  const providerSource = (providerId: string): ProviderSource => {
    if (bundledProviderIds.has(providerId)) return "luckytoken_bundled";
    if (piBuiltinIds.has(providerId)) return "pi_builtin";
    if (
      currentModelsJsonProviderIds.has(providerId) ||
      userPackageProviderIds.has(providerId)
    ) {
      return "user";
    }
    // Defensive: an unknown Provider is a user-derived identity (it cannot
    // be a Pi built-in or bundled one by construction).
    return "user";
  };

  return Object.freeze({
    models: served,
    credentialAuthority,
    externalProviderIds,
    catalog: Object.freeze({
      models: served,
      recompose,
      capture: () => served.capture(),
    }),
    providerSource,
  });
}
