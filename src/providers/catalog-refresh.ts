import type {
  Api,
  AuthCheck,
  Model,
  Models,
  ModelsRefreshOptions,
  ModelsStoreEntry,
} from "@earendil-works/pi-ai";
import { ModelsError } from "@earendil-works/pi-ai";
import type {
  CatalogModelAvailability,
  CatalogProviderProjection,
  CatalogProviderState,
  CatalogRefreshErrorProjection,
  CatalogRefreshReportProjection,
  CatalogRefreshTrigger,
  CatalogSnapshotProjection,
} from "@token/application-control-plane/control-plane";

import type { ModelsJsonAuthority } from "../models-config/authority.js";
import type { RequestJourneyObservationAuthority } from "../diagnostics/contract.js";
import type {
  CatalogCacheStage,
  CatalogCacheStore,
} from "./catalog-cache.js";

/**
 * Ticket 11 catalog refresh controller — the single owner of the refresh
 * lifecycle and of the one authoritative active catalog snapshot.
 *
 * Pinned semantics (mirror of the repository-pinned Pi `ModelRuntime`:
 * `pi-agent/packages/coding-agent/src/core/model-runtime.ts` and
 * `pi-agent/packages/ai/src/models.ts`):
 *
 * - restore-before-network: every refresh phase restores the cached dynamic
 *   catalog from the validated Token-owned cache first; the startup
 *   bind restores the cache and only then schedules the background network
 *   refresh;
 * - startup-only models.json: Provider composition is fixed for the Backend
 *   lifetime. Refresh may re-read models.json only to report current file
 *   validity; it never applies file changes to the running Provider set;
 * - per-Provider isolation: `Models.refresh` restores/publishes per
 *   Provider, so a failed Provider keeps its cached/built-in facts while
 *   unaffected Providers refresh; failures become value-safe warnings (no
 *   credentials, headers, environment values or raw Provider errors);
 * - one authoritative snapshot: the served catalog is captured and swapped
 *   atomically after each cycle — new requests resolve the new facts while
 *   in-flight invocations keep their already-captured Model objects.
 *
 * Background triggers (startup and model page open) are
 * non-blocking and deduplicated through the injected scheduler; manual
 * refresh is serialized, forced, and returns bounded per-Provider results.
 */

export interface CatalogRuntimeHandle {
  /** The served Models facade; `getModels`/`getModel` read the captured
   * active snapshot. Provider composition is fixed for the Backend lifetime. */
  readonly models: Models;
  /** Atomically capture the current runtime catalog as the served snapshot.
   * Dynamic Provider catalog refresh may change model facts; models.json never
   * changes the Provider set after startup. */
  readonly capture: (preserveProviderIds?: ReadonlySet<string>) => void;
  /** Capture an opaque exact auth operation view for one lifecycle Provider
   * before its refresh begins. */
  operationsForProvider(providerId: string): Promise<CatalogProviderOperations>;
  /** Refresh exactly one Provider under its captured Profile binding. */
  refreshProvider(
    providerId: string,
    options: Omit<ModelsRefreshOptions, "providers">,
  ): ReturnType<Models["refresh"]>;
  /** Check exactly one Provider under its captured Profile binding. */
  checkAuth(
    providerId: string,
    options?: { readonly signal?: AbortSignal },
  ): ReturnType<Models["checkAuth"]>;
  /** Default lifecycle runs have no pre-captured binding; exact operation
   * views override these guards. */
  isCurrent(providerId: string): Promise<boolean>;
  publishIfCurrent(
    providerId: string,
    publish: (assertCurrent: () => void) => Promise<void> | void,
  ): Promise<boolean>;
  /** Restore one Provider's live dynamic facts from the current cache with
   * no credential resolution or network use. */
  restoreProvider(providerId: string, entry: ModelsStoreEntry): Promise<void>;
}

/** Exact, request-bound Provider operations used by an explicit recheck.
 * The Catalog Controller owns refresh publication but never sees the
 * credential binding that scopes these calls. */
export type CatalogProviderOperations = Pick<
  CatalogRuntimeHandle,
  "refreshProvider" | "checkAuth" | "isCurrent" | "publishIfCurrent"
>;

export interface CatalogRefreshScheduler {
  schedule(task: () => void): void;
}

export interface CatalogRefreshControllerOptions {
  readonly store: CatalogCacheStore;
  /** Authoritative models.json facts (validity, providers, file errors). */
  readonly authority: Pick<ModelsJsonAuthority, "query">;
  /** Fail-open, value-safe runtime observation destination. */
  readonly diagnostics: Pick<
    RequestJourneyObservationAuthority,
    "observeRuntime"
  >;
  /** Deterministic clock. */
  readonly now: () => number;
  /** Deterministic background scheduling; defaults to microtasks. */
  readonly scheduler?: CatalogRefreshScheduler;
  /** Notified on every snapshot swap (provisional and final). */
  readonly onSnapshot?: (snapshot: CatalogSnapshotProjection) => void;
}

export interface CatalogRefreshController {
  /** Attach the runtime: restores the cached catalog (before any network
   *  refresh), swaps the first snapshot, then schedules the non-blocking
   *  startup background refresh. */
  bind(handle: CatalogRuntimeHandle, signal?: AbortSignal): Promise<void>;
  /** The current authoritative active catalog snapshot. */
  snapshot(): CatalogSnapshotProjection;
  /** True once a runtime is bound. Refresh commands before binding are
   *  unavailable — a no-op schedule must never claim "scheduled". */
  isBound(): boolean;
  /** Non-blocking, deduplicated background trigger. */
  scheduleBackground(
    trigger: Exclude<CatalogRefreshTrigger, "manual">,
    providerIds?: readonly string[],
  ): void;
  /** Exact-profile, non-blocking post-login refresh. */
  scheduleProviderBackground(
    trigger: "login",
    providerId: string,
    operations: CatalogProviderOperations,
  ): void;
  /** Serialized, forced manual refresh; resolves with bounded per-Provider
   *  results. */
  refreshManual(signal?: AbortSignal): Promise<CatalogRefreshReportProjection>;
  refreshProviderManual(
    providerId: string,
    signal?: AbortSignal,
    operations?: CatalogProviderOperations,
  ): Promise<CatalogRefreshReportProjection>;
  dispose(): Promise<void>;
}

const VALUE_SAFE_FAILURE_TEMPLATE =
  'Model catalog refresh failed for provider "%s"';

interface ProviderRuntimeState {
  readonly state: CatalogProviderState;
  readonly error?: string;
  readonly errorCode?: string;
  readonly refreshedAt?: number;
  readonly cachedAt?: number;
  readonly availability?: CatalogModelAvailability;
  readonly dynamicModelIds: ReadonlySet<string>;
}

/** One Provider's observed outcome for the CURRENT refresh run only. */
type RunOutcome =
  | { readonly outcome: "succeeded" }
  | { readonly outcome: "skipped" }
  | {
      readonly outcome: "failed";
      readonly error: string;
      readonly errorCode: string;
    };

/** Deterministic persisted-entry comparison for publish observation. */
function serializeEntry(
  entry: ModelsStoreEntry | undefined,
): string | undefined {
  return entry === undefined ? undefined : JSON.stringify(entry);
}

interface PendingBackground {
  readonly trigger: Exclude<CatalogRefreshTrigger, "manual">;
  readonly providerIds?: readonly string[];
  readonly providerOperations?: CatalogProviderOperations;
}

interface RefreshRun {
  readonly trigger: CatalogRefreshTrigger;
  readonly network: boolean;
  readonly force: boolean;
  readonly providerIds?: readonly string[];
  readonly signal?: AbortSignal;
  readonly providerOperations?: CatalogProviderOperations;
}

/** Safe failure category: ModelsError codes are fixed pi-ai enum values;
 *  anything else is "unknown". Raw messages never cross this boundary. */
function safeFailureCode(error: unknown): string {
  return error instanceof ModelsError && typeof error.code === "string"
    ? error.code
    : "unknown";
}

function valueSafeFailureMessage(providerId: string): string {
  return VALUE_SAFE_FAILURE_TEMPLATE.replace("%s", providerId);
}

type CatalogRuntimeClassification =
  | "catalog_cache_unproven"
  | "catalog_stale_publish_rollback_failed"
  | "catalog_restored_capture_failed"
  | "catalog_failed_refresh_restore_failed"
  | "catalog_exact_publish_failed"
  | "catalog_provider_refresh_failed"
  | "catalog_models_json_unavailable"
  | "catalog_cached_model_facts_discarded";

function observeCatalogWarning(
  diagnostics: CatalogRefreshControllerOptions["diagnostics"],
  classification: CatalogRuntimeClassification,
  safeMessage: string,
): void {
  try {
    diagnostics.observeRuntime({
      level: "warning",
      classification,
      safeMessage,
    });
  } catch {
    // Catalog serving and refresh remain authoritative over observation.
  }
}

export function createCatalogRefreshController(
  options: CatalogRefreshControllerOptions,
): CatalogRefreshController {
  const scheduler = options.scheduler ?? {
    schedule: (task: () => void) => {
      queueMicrotask(task);
    },
  };
  const now = options.now;
  let runtime: CatalogRuntimeHandle | undefined;
  let activeController: AbortController | undefined;
  let disposed = false;
  let version = 0;
  let refreshErrors: readonly CatalogRefreshErrorProjection[] =
    Object.freeze([]);
  let modelsJsonValid = true;
  let modelsJsonError: CatalogSnapshotProjection["modelsJsonError"];
  let refreshedAt: number | undefined;
  let providerStates: Readonly<Record<string, ProviderRuntimeState>> =
    Object.freeze({});
  let snapshot: CatalogSnapshotProjection = Object.freeze({
    version: 0,
    modelsJsonValid: true,
    providers: Object.freeze([]),
    refreshErrors,
  });
  let pendingBackground: PendingBackground | undefined;
  let scheduled = false;
  // A failed exact-run restore means mutable Pi Provider facts cannot be
  // proven safe. Keep serving the previous captured snapshot until an exact
  // successful publication repairs that Provider.
  const restorationQuarantine = new Set<string>();
  // Serializes refresh runs; manual refresh awaits the current tail.
  let runQueue: Promise<unknown> = Promise.resolve();

  const swap = (): void => {
    version += 1;
    snapshot = buildSnapshot();
    options.onSnapshot?.(snapshot);
  };

  const dynamicIdsFor = (providerId: string): ReadonlySet<string> =>
    providerStates[providerId]?.dynamicModelIds ??
    Object.freeze(new Set<string>());

  const buildSnapshot = (): CatalogSnapshotProjection => {
    const providers = (runtime?.models.getProviders() ?? []).map(
      (provider): CatalogProviderProjection => {
        const state = providerStates[provider.id];
        const dynamicIds = dynamicIdsFor(provider.id);
        const models = runtime?.models.getModels(provider.id) ?? [];
        return Object.freeze({
          providerId: provider.id,
          name: provider.name,
          dynamic: provider.refreshModels !== undefined,
          state: state?.state ?? "known",
          ...(state?.error === undefined ? {} : { error: state.error }),
          ...(state?.errorCode === undefined ? {} : { errorCode: state.errorCode }),
          ...(state?.refreshedAt === undefined
            ? {}
            : { refreshedAt: state.refreshedAt }),
          ...(state?.cachedAt === undefined ? {} : { cachedAt: state.cachedAt }),
          models: Object.freeze(
            models.map((model) =>
              Object.freeze({
                id: model.id,
                dynamic: dynamicIds.has(model.id),
                availability:
                  state?.availability ?? ("unknown" as CatalogModelAvailability),
              }),
            ),
          ),
        });
      },
    );
    return Object.freeze({
      version,
      modelsJsonValid,
      ...(modelsJsonError === undefined ? {} : { modelsJsonError }),
      ...(refreshedAt === undefined ? {} : { refreshedAt }),
      providers: Object.freeze(providers),
      refreshErrors,
    });
  };

  const checkAvailability = async (
    providerId: string,
    signal: AbortSignal | undefined,
    operations: CatalogProviderOperations = runtime!,
  ): Promise<CatalogModelAvailability> => {
    try {
      const check: AuthCheck | undefined =
        signal === undefined
          ? await operations.checkAuth(providerId)
          : await operations.checkAuth(providerId, { signal });
      return check === undefined ? "unavailable" : "available";
    } catch {
      return "unknown";
    }
  };

  const runRefresh = async (
    run: RefreshRun,
  ): Promise<ReadonlyMap<string, RunOutcome> | undefined> => {
    if (disposed || runtime === undefined) return undefined;
    const startedAt = now();
    const modelsState = await options.authority.query();
    if (run.signal !== undefined && run.signal.aborted) return undefined;
    const valid = !modelsState.present || modelsState.valid;
    modelsJsonValid = valid;
    modelsJsonError =
      modelsState.present && !modelsState.valid
        ? modelsState.error
        : undefined;
    // models.json is startup-only. Refresh may report the current file's
    // validity for management UI, but it never mutates this Backend's fixed
    // Provider composition.
    const targetProviders = (runtime.models.getProviders() ?? []).filter(
      (provider) =>
        (run.providerIds === undefined ||
          run.providerIds.includes(provider.id)),
    );
    const inScopeProviders = targetProviders.filter(
      (provider) => provider.refreshModels !== undefined,
    );
    if (run.providerOperations === undefined && targetProviders.length > 0) {
      const combined = new Map<string, RunOutcome>();
      for (const provider of targetProviders) {
        if (run.signal?.aborted === true) break;
        let providerOperations: CatalogProviderOperations;
        try {
          providerOperations = await runtime.operationsForProvider(provider.id);
        } catch (error) {
          // Preserve the ordinary per-Provider failure projection without
          // granting a credential binding that could mutate model facts.
          providerOperations = Object.freeze({
            refreshProvider: async () => {
              throw error;
            },
            checkAuth: async () => {
              throw error;
            },
            isCurrent: async () => true,
            publishIfCurrent: async (_providerId, publish) => {
              await publish(() => undefined);
              return true;
            },
          });
        }
        const outcome = await runRefresh({
          ...run,
          providerIds: Object.freeze([provider.id]),
          providerOperations,
        });
        const providerOutcome = outcome?.get(provider.id);
        if (providerOutcome !== undefined) combined.set(provider.id, providerOutcome);
      }
      refreshErrors = Object.freeze(
        [...combined.entries()].flatMap(([providerId, outcome]) =>
          outcome.outcome === "failed"
            ? [Object.freeze({
                providerId,
                code: outcome.errorCode,
                message: outcome.error,
              })]
            : [],
        ),
      );
      swap();
      return combined;
    }
    if (
      run.providerOperations !== undefined &&
      run.providerIds?.length === 1 &&
      !(await run.providerOperations.isCurrent(run.providerIds[0]!))
    ) {
      return new Map([[run.providerIds[0]!, { outcome: "skipped" as const }]]);
    }
    const operationsFor = (providerId: string): CatalogProviderOperations =>
      run.providerOperations !== undefined &&
      run.providerIds?.length === 1 &&
      run.providerIds[0] === providerId
        ? run.providerOperations
        : runtime!;
    // The persisted entry each in-scope Provider starts from: a publish
    // during this run is the observable evidence that a refresh actually
    // happened (a no-credential Pi run skips the network phase without
    // recording anything).
    const preRunEntries = new Map<string, ModelsStoreEntry | undefined>();
    for (const provider of inScopeProviders) {
      const entry = await options.store
        .read(provider.id)
        .catch(() => undefined);
      preRunEntries.set(provider.id, entry);
    }
    if (run.signal !== undefined && run.signal.aborted) return undefined;
    const preRunStates = providerStates;
    const preRunSnapshot = snapshot;
    if (run.network) {
      // Provisional snapshot: refreshable Providers are observably
      // "refreshing" while the network phase runs.
      const refreshing: Record<string, ProviderRuntimeState> = {
        ...providerStates,
      };
      for (const provider of inScopeProviders) {
        const previous = refreshing[provider.id];
        refreshing[provider.id] = Object.freeze({
          state: "refreshing",
          ...(previous?.error === undefined ? {} : { error: previous.error }),
          ...(previous?.errorCode === undefined
            ? {}
            : { errorCode: previous.errorCode }),
          ...(previous?.refreshedAt === undefined
            ? {}
            : { refreshedAt: previous.refreshedAt }),
          ...(previous?.cachedAt === undefined ? {} : { cachedAt: previous.cachedAt }),
          availability: previous?.availability ?? "unknown",
          dynamicModelIds:
            previous?.dynamicModelIds ?? Object.freeze(new Set<string>()),
        });
      }
      providerStates = Object.freeze(refreshing);
      swap();
    }
    const refreshOptions: ModelsRefreshOptions = {
      allowNetwork: run.network,
      force: run.network && run.force,
      ...(run.providerIds === undefined
        ? {}
        : { providers: run.providerIds }),
      ...(run.signal === undefined ? {} : { signal: run.signal }),
    };
    const runErrors = new Map<string, unknown>();
    const stagedRefreshes = new Map<
      string,
      CatalogCacheStage<Awaited<ReturnType<CatalogProviderOperations["refreshProvider"]>>>
    >();
    for (const provider of inScopeProviders) {
      try {
        const refresh = () => operationsFor(provider.id).refreshProvider(provider.id, {
            ...(refreshOptions.allowNetwork === undefined
              ? {}
              : { allowNetwork: refreshOptions.allowNetwork }),
            ...(refreshOptions.force === undefined
              ? {}
              : { force: refreshOptions.force }),
            ...(refreshOptions.signal === undefined
              ? {}
              : { signal: refreshOptions.signal }),
          });
        const exactStage = run.providerOperations !== undefined && run.network
          ? await options.store.runStaged(provider.id, refresh)
          : undefined;
        if (exactStage !== undefined) stagedRefreshes.set(provider.id, exactStage);
        const result = exactStage?.result ?? await refresh();
        const error = result.errors.get(provider.id);
        if (error !== undefined) runErrors.set(provider.id, error);
      } catch (error) {
        runErrors.set(provider.id, error);
      }
    }
    const discardExactRun = async (
      unprovenCacheProviderIds: ReadonlySet<string> = new Set<string>(),
    ): Promise<ReadonlyMap<string, RunOutcome>> => {
      const restoreFailures: string[] = [];
      for (const provider of inScopeProviders) {
        if (
          unprovenCacheProviderIds.has(provider.id) ||
          restorationQuarantine.has(provider.id)
        ) {
          restorationQuarantine.add(provider.id);
          restoreFailures.push(provider.id);
          observeCatalogWarning(
            options.diagnostics,
            "catalog_cache_unproven",
            valueSafeFailureMessage(provider.id),
          );
          continue;
        }
        try {
          // Restore the Provider's live model facts through another isolated
          // view. A stale exact run never rewrites the authoritative cache.
          const entry = await options.store.read(provider.id);
          await runtime!.restoreProvider(
            provider.id,
            entry ?? Object.freeze({ models: Object.freeze([]) }),
          );
        } catch {
          restorationQuarantine.add(provider.id);
          restoreFailures.push(provider.id);
          observeCatalogWarning(
            options.diagnostics,
            "catalog_stale_publish_rollback_failed",
            valueSafeFailureMessage(provider.id),
          );
        }
      }
      if (restoreFailures.length === 0) {
        try {
          // An exact publish can fail after the mutable Provider was updated
          // (or even after a served capture began). Re-capture only the
          // authoritative restored facts before returning to the old
          // controller snapshot.
          runtime!.capture(restorationQuarantine);
        } catch {
          for (const provider of inScopeProviders) {
            restorationQuarantine.add(provider.id);
            restoreFailures.push(provider.id);
            observeCatalogWarning(
              options.diagnostics,
              "catalog_restored_capture_failed",
              valueSafeFailureMessage(provider.id),
            );
          }
        }
      }
      if (restoreFailures.length === 0) {
        providerStates = preRunStates;
        snapshot = preRunSnapshot;
        options.onSnapshot?.(snapshot);
      } else {
        const quarantined: Record<string, ProviderRuntimeState> = {
          ...preRunStates,
        };
        for (const providerId of restoreFailures) {
          const previous = preRunStates[providerId];
          quarantined[providerId] = Object.freeze({
            state: "failed",
            error: valueSafeFailureMessage(providerId),
            errorCode: "restore_unproven",
            ...(previous?.refreshedAt === undefined
              ? {}
              : { refreshedAt: previous.refreshedAt }),
            ...(previous?.cachedAt === undefined
              ? {}
              : { cachedAt: previous.cachedAt }),
            availability: "unknown",
            dynamicModelIds:
              previous?.dynamicModelIds ?? Object.freeze(new Set<string>()),
          });
        }
        providerStates = Object.freeze(quarantined);
        swap();
      }
      return new Map(
        inScopeProviders.map((provider) => [
          provider.id,
          { outcome: "skipped" as const },
        ]),
      );
    };
    if (
      run.providerOperations !== undefined &&
      run.providerIds?.length === 1 &&
      !(await run.providerOperations.isCurrent(run.providerIds[0]!))
    ) {
      return discardExactRun();
    }
    const aborted = run.signal !== undefined && run.signal.aborted;
    if (aborted && run.providerOperations !== undefined) {
      return discardExactRun();
    }
    // Per-Provider isolation: failed Providers keep their cached/built-in
    // facts; every failure becomes a precise value-safe warning. Outcomes
    // are observed for THIS run only — an aborted or no-credential run
    // never reuses stale states.
    const failures: CatalogRefreshErrorProjection[] = [];
    const outcomes = new Map<string, RunOutcome>();
    const next: Record<string, ProviderRuntimeState> = { ...preRunStates };
    for (const provider of inScopeProviders) {
      const previous = next[provider.id];
      const error = runErrors.get(provider.id);
      const exactStage = stagedRefreshes.get(provider.id);
      const stored = error !== undefined && exactStage !== undefined
        ? preRunEntries.get(provider.id)
        : exactStage?.entry ?? await options.store
            .read(provider.id)
            .catch(() => undefined);
      const dynamicIds = Object.freeze(
        new Set((stored?.models ?? []).map((model) => model.id)),
      );
      const published = exactStage?.changed ??
        serializeEntry(stored) !== serializeEntry(preRunEntries.get(provider.id));
      if (error !== undefined) {
        if (exactStage !== undefined) {
          try {
            const entry = await options.store.read(provider.id);
            await runtime!.restoreProvider(
              provider.id,
              entry ?? Object.freeze({ models: Object.freeze([]) }),
            );
          } catch {
            restorationQuarantine.add(provider.id);
            observeCatalogWarning(
              options.diagnostics,
              "catalog_failed_refresh_restore_failed",
              valueSafeFailureMessage(provider.id),
            );
          }
        }
        failures.push(
          Object.freeze({
            providerId: provider.id,
            code: safeFailureCode(error),
            message: valueSafeFailureMessage(provider.id),
          }),
        );
        outcomes.set(provider.id, {
          outcome: "failed",
          error: valueSafeFailureMessage(provider.id),
          errorCode: safeFailureCode(error),
        });
        if (run.network && !aborted) {
          next[provider.id] = Object.freeze({
            state: "failed",
            error: valueSafeFailureMessage(provider.id),
            errorCode: safeFailureCode(error),
            ...(previous?.refreshedAt === undefined
              ? {}
              : { refreshedAt: previous.refreshedAt }),
            ...(previous?.cachedAt === undefined
              ? {}
              : { cachedAt: previous.cachedAt }),
            availability: await checkAvailability(
              provider.id,
              run.signal,
              operationsFor(provider.id),
            ),
            dynamicModelIds: dynamicIds,
          });
        }
        continue;
      }
      if (!run.network) continue;
      if (!published) {
        // No publish happened in this run (no credential resolved, or the
        // run aborted before this Provider): report skipped and keep the
        // previous usable state.
        outcomes.set(provider.id, { outcome: "skipped" });
        continue;
      }
      outcomes.set(provider.id, { outcome: "succeeded" });
      if (!aborted) {
        next[provider.id] = Object.freeze({
          state: "succeeded",
          refreshedAt: now(),
          ...(previous?.cachedAt === undefined ? {} : { cachedAt: previous.cachedAt }),
          availability: await checkAvailability(
            provider.id,
            run.signal,
            operationsFor(provider.id),
          ),
          dynamicModelIds: dynamicIds,
        });
      }
    }
    if (aborted) {
      // The cycle did not complete: the served snapshot reverts to the
      // last complete one (the provisional refreshing state never sticks)
      // and nothing is captured for new requests.
      providerStates = preRunStates;
      snapshot = preRunSnapshot;
      options.onSnapshot?.(snapshot);
    } else {
      // Static Providers have no refresh lifecycle but still expose their
      // auth availability (pinned availability refresh covers every
      // Provider).
      for (const provider of targetProviders) {
        if (provider.refreshModels !== undefined) continue;
        const previous = next[provider.id];
        const availability = await checkAvailability(
          provider.id,
          run.signal,
          operationsFor(provider.id),
        );
        next[provider.id] = Object.freeze({
          state: "known",
          ...(previous?.cachedAt === undefined ? {} : { cachedAt: previous.cachedAt }),
          availability,
          dynamicModelIds: Object.freeze(new Set<string>()),
        });
        if (run.network) {
          if (availability === "available") {
            outcomes.set(provider.id, { outcome: "succeeded" });
          } else if (availability === "unavailable") {
            outcomes.set(provider.id, { outcome: "skipped" });
          } else {
            const errorCode = "auth_check_failed";
            const message = valueSafeFailureMessage(provider.id);
            failures.push(Object.freeze({
              providerId: provider.id,
              code: errorCode,
              message,
            }));
            outcomes.set(provider.id, {
              outcome: "failed",
              error: message,
              errorCode,
            });
          }
        }
      }
      if (!run.network) {
        // Restore phase: cached facts are served, no network result yet.
        for (const provider of runtime.models.getProviders()) {
          if (provider.refreshModels === undefined) continue;
          const stored = await options.store
            .read(provider.id)
            .catch(() => undefined);
          if (stored === undefined) continue;
          const previous = next[provider.id];
          next[provider.id] = Object.freeze({
            state: "cached",
            cachedAt: startedAt,
            ...(previous?.availability === undefined
              ? {}
              : { availability: previous.availability }),
            dynamicModelIds: Object.freeze(
              new Set(stored.models.map((model) => model.id)),
            ),
          });
        }
      }
      const publish = async (
        assertCurrent: () => void = () => undefined,
      ): Promise<void> => {
        for (const [providerId, stage] of stagedRefreshes) {
          if (!runErrors.has(providerId)) await stage.commit(assertCurrent);
        }
        assertCurrent();
        for (const [providerId, stage] of stagedRefreshes) {
          if (!runErrors.has(providerId) && stage.changed) {
            restorationQuarantine.delete(providerId);
          }
        }
        for (const providerId of restorationQuarantine) {
          const previous = next[providerId];
          next[providerId] = Object.freeze({
            state: "failed",
            error: valueSafeFailureMessage(providerId),
            errorCode: "restore_unproven",
            ...(previous?.refreshedAt === undefined
              ? {}
              : { refreshedAt: previous.refreshedAt }),
            ...(previous?.cachedAt === undefined
              ? {}
              : { cachedAt: previous.cachedAt }),
            availability: "unknown",
            dynamicModelIds:
              previous?.dynamicModelIds ?? Object.freeze(new Set<string>()),
          });
        }
        providerStates = Object.freeze(next);
        refreshErrors = Object.freeze(failures);
        if (run.network) refreshedAt = now();
        // One authoritative swap: new requests see the fresh catalog;
        // captured Model objects stay untouched.
        runtime!.capture(restorationQuarantine);
        swap();
      };
      if (
        run.providerOperations !== undefined &&
        run.providerIds?.length === 1
      ) {
        let committed: boolean;
        try {
          committed = await run.providerOperations.publishIfCurrent(
            run.providerIds[0]!,
            publish,
          );
        } catch {
          const unprovenCacheProviderIds = new Set<string>();
          for (const [providerId, stage] of stagedRefreshes) {
            try {
              await stage.rollback();
            } catch {
              unprovenCacheProviderIds.add(providerId);
            }
          }
          const discarded = await discardExactRun(unprovenCacheProviderIds);
          const providerId = run.providerIds[0]!;
          observeCatalogWarning(
            options.diagnostics,
            "catalog_exact_publish_failed",
            valueSafeFailureMessage(providerId),
          );
          return new Map(discarded).set(providerId, {
            outcome: "failed",
            error: valueSafeFailureMessage(providerId),
            errorCode: "exact_publish_failed",
          });
        }
        if (!committed) return discardExactRun();
      } else {
        await publish();
      }
    }
    // Precise value-safe warnings: fixed templates and safe codes only.
    for (const failure of failures) {
      observeCatalogWarning(
        options.diagnostics,
        "catalog_provider_refresh_failed",
        failure.message,
      );
    }
    if (modelsJsonError !== undefined) {
      observeCatalogWarning(
        options.diagnostics,
        "catalog_models_json_unavailable",
        "models.json is not loadable; the effective catalog keeps only compatible built-in Providers until the file is fixed.",
      );
    }
    for (const dropped of options.store.takeDroppedReport()) {
      observeCatalogWarning(
        options.diagnostics,
        "catalog_cached_model_facts_discarded",
        `Cached dynamic model facts were discarded for provider "${dropped.providerId}" and will be refetched on the next refresh.`,
      );
    }
    return outcomes;
  };

  const enqueueBackground = (): void => {
    const pending = pendingBackground;
    if (pending === undefined) return;
    pendingBackground = undefined;
    runQueue = runQueue
      .then(() =>
        runRefresh({
          trigger: pending.trigger,
          network: true,
          force: false,
          ...(pending.providerIds === undefined
            ? {}
            : { providerIds: pending.providerIds }),
          ...(pending.providerOperations === undefined
            ? {}
            : { providerOperations: pending.providerOperations }),
          ...(activeController === undefined
            ? {}
            : { signal: activeController.signal }),
        }),
      )
      .catch(() => undefined);
  };

  const scheduleBackground = (
    trigger: Exclude<CatalogRefreshTrigger, "manual">,
    providerIds?: readonly string[],
  ): void => {
    if (disposed || runtime === undefined) return;
    pendingBackground = {
      trigger,
      ...(providerIds === undefined ? {} : { providerIds }),
    };
    if (scheduled) return;
    scheduled = true;
    scheduler.schedule(() => {
      scheduled = false;
      enqueueBackground();
    });
  };

  const scheduleProviderBackground = (
    trigger: "login",
    providerId: string,
    providerOperations: CatalogProviderOperations,
  ): void => {
    if (disposed || runtime === undefined) return;
    scheduler.schedule(() => {
      if (disposed || runtime === undefined) return;
      runQueue = runQueue
        .then(() =>
          runRefresh({
            trigger,
            network: true,
            force: false,
            providerIds: Object.freeze([providerId]),
            providerOperations,
            ...(activeController === undefined
              ? {}
              : { signal: activeController.signal }),
          }),
        )
        .catch(() => undefined);
    });
  };

  return Object.freeze({
    async bind(handle: CatalogRuntimeHandle, signal?: AbortSignal): Promise<void> {
      if (disposed) return;
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      runtime = handle;
      const runSignal =
        signal === undefined
          ? controller.signal
          : AbortSignal.any([signal, controller.signal]);
      // Startup restore: the last valid cached dynamic catalog is served
      // before any network refresh is scheduled.
      await runRefresh({
        trigger: "startup",
        network: false,
        force: false,
        signal: runSignal,
      });
      if (disposed) return;
      scheduleBackground("startup");
    },
    snapshot(): CatalogSnapshotProjection {
      return snapshot;
    },
    isBound(): boolean {
      return runtime !== undefined;
    },
    scheduleBackground,
    scheduleProviderBackground,
    refreshManual(signal?: AbortSignal): Promise<CatalogRefreshReportProjection> {
      return refreshManualFor(undefined, signal);
    },
    refreshProviderManual(
      providerId: string,
      signal?: AbortSignal,
      operations?: CatalogProviderOperations,
    ): Promise<CatalogRefreshReportProjection> {
      return refreshManualFor([providerId], signal, operations);
    },
    async dispose(): Promise<void> {
      disposed = true;
      pendingBackground = undefined;
      activeController?.abort();
      await runQueue.catch(() => undefined);
      runtime = undefined;
    },
  });

  function refreshManualFor(
    providerIds: readonly string[] | undefined,
    signal?: AbortSignal,
    providerOperations?: CatalogProviderOperations,
  ): Promise<CatalogRefreshReportProjection> {
      if (runtime === undefined) {
        return Promise.reject(
          new Error("Catalog refresh is not available before the runtime starts"),
        );
      }
      const startedAt = now();
      const runSignal =
        signal ?? (activeController === undefined ? undefined : activeController.signal);
      const run = runQueue.then(async () => {
        const outcomes = await runRefresh({
          trigger: "manual",
          network: true,
          force: true,
          ...(providerIds === undefined ? {} : { providerIds }),
          ...(runSignal === undefined ? {} : { signal: runSignal }),
          ...(providerOperations === undefined ? {} : { providerOperations }),
        });
        const finishedAt = now();
        const providers = (runtime?.models.getProviders() ?? [])
          .filter((provider) =>
            providerIds === undefined || providerIds.includes(provider.id),
          )
          .map((provider) => {
            const outcome = outcomes?.get(provider.id);
            if (outcome === undefined) {
              // Nothing was observed for this Provider (the run never
              // started or was aborted before it could be reached): report
              // skipped, never a stale outcome.
              return Object.freeze({
                providerId: provider.id,
                outcome: "skipped" as const,
              });
            }
            return Object.freeze({
              providerId: provider.id,
              outcome: outcome.outcome,
              ...("error" in outcome ? { error: outcome.error } : {}),
              ...("errorCode" in outcome ? { errorCode: outcome.errorCode } : {}),
            });
          });
        return Object.freeze({
          trigger: "manual" as const,
          startedAt,
          finishedAt,
          providers: Object.freeze(providers),
        });
      });
      runQueue = run.catch(() => undefined);
      return run;
  }
}

/**
 * The served Models facade with one authoritative active catalog snapshot
 * (Ticket 11): `capture()` atomically records the current runtime catalog;
 * `getModels`/`getModel` resolve from the same captured snapshot (falling
 * back to the live collection before the first capture, e.g. CLI
 * login/logout consumers). After a capture, live collection changes never
 * leak into either lookup. In-flight invocations keep the Model objects
 * they already captured: a capture never mutates previously returned
 * objects.
 */
export function createCatalogSnapshotModels(
  models: Models,
): Models & {
  readonly capture: (preserveProviderIds?: ReadonlySet<string>) => void;
} {
  let captured: readonly Model<Api>[] | undefined;
  const snapshotModels = (providerId?: string): readonly Model<Api>[] => {
    const all = captured ?? models.getModels();
    if (providerId === undefined) return all;
    return all.filter((model) => model.provider === providerId);
  };
  return Object.freeze({
    getProviders: () => models.getProviders(),
    getProvider: (id: string) => models.getProvider(id),
    getModels: (providerId?: string) => snapshotModels(providerId),
    getModel: (providerId: string, id: string) =>
      (captured ?? models.getModels()).find(
        (model) => model.provider === providerId && model.id === id,
      ),
    refresh: (options) => models.refresh(options),
    checkAuth: (providerId: string, options?: { signal?: AbortSignal }) =>
      models.checkAuth(providerId, options),
    getAvailable: (providerId?: string, options?: { signal?: AbortSignal }) =>
      models.getAvailable(providerId, options),
    getAuth: (providerOrModel: string | Model<Api>, overrides: unknown) =>
      models.getAuth(
        providerOrModel as Parameters<Models["getAuth"]>[0],
        overrides as Parameters<Models["getAuth"]>[1],
      ),
    login: (providerId: string, type: "api_key" | "oauth", interaction: never) =>
      models.login(providerId, type, interaction),
    logout: (providerId: string, options?: { signal?: AbortSignal }) =>
      models.logout(providerId, options),
    stream: (model, context, options) => models.stream(model, context, options),
    complete: (model, context, options) => models.complete(model, context, options),
    streamSimple: (model, context, options) =>
      models.streamSimple(model, context, options),
    completeSimple: (model, context, options) =>
      models.completeSimple(model, context, options),
    fetchDeferred: (model, handle, options) =>
      models.fetchDeferred(model, handle, options),
    cancelDeferred: (model, handle, options) =>
      models.cancelDeferred(model, handle, options),
    capture: (preserveProviderIds?: ReadonlySet<string>) => {
      const live = models.getModels();
      if (
        captured === undefined ||
        preserveProviderIds === undefined ||
        preserveProviderIds.size === 0
      ) {
        captured = Object.freeze([...live]);
        return;
      }
      const previous = captured;
      const next: Model<Api>[] = [];
      const providerIds = new Set(
        [...previous, ...live].map((model) => model.provider),
      );
      for (const providerId of providerIds) {
        const source = preserveProviderIds.has(providerId) ? previous : live;
        next.push(...source.filter((model) => model.provider === providerId));
      }
      captured = Object.freeze(next);
    },
  } as Models & {
    readonly capture: (preserveProviderIds?: ReadonlySet<string>) => void;
  });
}
