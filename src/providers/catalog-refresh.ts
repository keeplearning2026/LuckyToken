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
} from "@luckytoken/application-control-plane/control-plane";

import type { ModelsJsonAuthority } from "../models-config/authority.js";
import type { RuntimeDiagnosticsStore } from "../runtime-diagnostics/index.js";
import type { CatalogCacheStore } from "./catalog-cache.js";
import type { ModelsJsonConfig } from "./models-json.js";

/**
 * Ticket 11 catalog refresh controller — the single owner of the refresh
 * lifecycle and of the one authoritative active catalog snapshot.
 *
 * Pinned semantics (mirror of the repository-pinned Pi `ModelRuntime`:
 * `pi-agent/packages/coding-agent/src/core/model-runtime.ts` and
 * `pi-agent/packages/ai/src/models.ts`):
 *
 * - restore-before-network: every refresh phase restores the cached dynamic
 *   catalog from the validated LuckyToken-owned cache first; the startup
 *   bind restores the cache and only then schedules the background network
 *   refresh;
 * - rebuild-on-refresh: every run re-reads the authoritative models.json
 *   through the authority and recomposes the runtime providers (pinned
 *   `ModelConfig.load` + `rebuildProviders`) — an invalid models.json keeps
 *   compatible built-ins, drops affected custom Providers, is never
 *   silently repaired, and its value-free error is aggregated into the
 *   snapshot;
 * - per-Provider isolation: `Models.refresh` restores/publishes per
 *   Provider, so a failed Provider keeps its cached/built-in facts while
 *   unaffected Providers refresh; failures become value-safe warnings (no
 *   credentials, headers, environment values or raw Provider errors);
 * - one authoritative snapshot: the served catalog is captured and swapped
 *   atomically after each cycle — new requests resolve the new facts while
 *   in-flight invocations keep their already-captured Model objects.
 *
 * Background triggers (startup, successful login, model page open) are
 * non-blocking and deduplicated through the injected scheduler; manual
 * refresh is serialized, forced, and returns bounded per-Provider results.
 */

export interface CatalogRuntimeHandle {
  /** The served Models facade; `getModels`/`getModel` read the captured
   *  active snapshot (one authoritative catalog). */
  readonly models: Models;
  /**
   * Re-apply the built-in + models.json provider composition over the Pi
   * built-in base (pinned rebuildProviders). `undefined` means no user
   * providers; external Provider Packages are never touched.
   */
  readonly recompose: (modelsJson: ModelsJsonConfig | undefined) => void;
  /** Atomically capture the current runtime catalog as the served
   *  snapshot. New requests only — captured Model objects are never
   *  mutated. */
  readonly capture: () => void;
}

export interface CatalogRefreshScheduler {
  schedule(task: () => void): void;
}

export interface CatalogRefreshControllerOptions {
  readonly store: CatalogCacheStore;
  /** Authoritative models.json facts (validity, providers, file errors). */
  readonly authority: Pick<ModelsJsonAuthority, "query">;
  /** Value-safe warning destination (existing Runtime Diagnostics seam). */
  readonly diagnostics: RuntimeDiagnosticsStore;
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
  /** Successful Provider login: schedules a background refresh for the
   *  provider that just logged in. */
  onProviderLogin(providerId: string): void;
  /** Serialized, forced manual refresh; resolves with bounded per-Provider
   *  results. */
  refreshManual(signal?: AbortSignal): Promise<CatalogRefreshReportProjection>;
  dispose(): void;
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
}

interface RefreshRun {
  readonly trigger: CatalogRefreshTrigger;
  readonly network: boolean;
  readonly force: boolean;
  readonly providerIds?: readonly string[];
  readonly signal?: AbortSignal;
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
  ): Promise<CatalogModelAvailability> => {
    try {
      const check: AuthCheck | undefined =
        signal === undefined
          ? await runtime?.models.checkAuth(providerId)
          : await runtime?.models.checkAuth(providerId, { signal });
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
    // Pinned rebuild-on-refresh: compose the CURRENT authoritative
    // models.json facts over the built-in base (an invalid file keeps
    // compatible built-ins and drops affected custom Providers).
    runtime.recompose(
      modelsState.present && modelsState.valid
        ? ({ providers: modelsState.providers } as ModelsJsonConfig)
        : undefined,
    );
    const inScopeProviders = (runtime.models.getProviders() ?? []).filter(
      (provider) =>
        provider.refreshModels !== undefined &&
        (run.providerIds === undefined ||
          run.providerIds.includes(provider.id)),
    );
    // The persisted entry each in-scope Provider starts from: a publish
    // during this run is the observable evidence that a refresh actually
    // happened (a no-credential Pi run skips the network phase without
    // recording anything).
    const preRunEntries = new Map<string, string | undefined>();
    for (const provider of inScopeProviders) {
      const entry = await options.store
        .read(provider.id)
        .catch(() => undefined);
      preRunEntries.set(provider.id, serializeEntry(entry));
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
    const result = await runtime.models.refresh(refreshOptions);
    const aborted = run.signal !== undefined && run.signal.aborted;
    // Per-Provider isolation: failed Providers keep their cached/built-in
    // facts; every failure becomes a precise value-safe warning. Outcomes
    // are observed for THIS run only — an aborted or no-credential run
    // never reuses stale states.
    const failures: CatalogRefreshErrorProjection[] = [];
    const outcomes = new Map<string, RunOutcome>();
    const next: Record<string, ProviderRuntimeState> = { ...preRunStates };
    for (const provider of inScopeProviders) {
      const previous = next[provider.id];
      const error = result.errors.get(provider.id);
      const stored = await options.store
        .read(provider.id)
        .catch(() => undefined);
      const dynamicIds = Object.freeze(
        new Set((stored?.models ?? []).map((model) => model.id)),
      );
      const published =
        serializeEntry(stored) !== preRunEntries.get(provider.id);
      if (error !== undefined) {
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
            availability: await checkAvailability(provider.id, run.signal),
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
          availability: await checkAvailability(provider.id, run.signal),
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
      for (const provider of runtime.models.getProviders()) {
        if (provider.refreshModels !== undefined) continue;
        const previous = next[provider.id];
        next[provider.id] = Object.freeze({
          state: "known",
          ...(previous?.cachedAt === undefined ? {} : { cachedAt: previous.cachedAt }),
          availability: await checkAvailability(provider.id, run.signal),
          dynamicModelIds: Object.freeze(new Set<string>()),
        });
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
      providerStates = Object.freeze(next);
      refreshErrors = Object.freeze(failures);
      if (run.network) refreshedAt = now();
      // One authoritative swap: new requests see the fresh catalog;
      // captured Model objects stay untouched.
      runtime.capture();
      swap();
    }
    // Precise value-safe warnings: fixed templates and safe codes only.
    for (const failure of failures) {
      options.diagnostics.append({
        level: "warning",
        text: failure.message,
        details: Object.freeze({
          providerId: failure.providerId,
          code: failure.code,
        }),
      });
    }
    if (modelsJsonError !== undefined) {
      options.diagnostics.append({
        level: "warning",
        text: "models.json is not loadable; the effective catalog keeps only compatible built-in Providers until the file is fixed.",
        details: Object.freeze({
          kind: modelsJsonError.kind,
        }),
      });
    }
    for (const dropped of options.store.takeDroppedReport()) {
      options.diagnostics.append({
        level: "warning",
        text: `Cached dynamic model facts were discarded for provider "${dropped.providerId}" and will be refetched on the next refresh.`,
        details: Object.freeze({
          providerId: dropped.providerId,
          reason: dropped.reason,
        }),
      });
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
    onProviderLogin(providerId: string): void {
      scheduleBackground("login", [providerId]);
    },
    refreshManual(signal?: AbortSignal): Promise<CatalogRefreshReportProjection> {
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
          ...(runSignal === undefined ? {} : { signal: runSignal }),
        });
        const finishedAt = now();
        const providers = (runtime?.models.getProviders() ?? [])
          .filter((provider) => provider.refreshModels !== undefined)
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
    },
    dispose(): void {
      disposed = true;
      activeController?.abort();
      runtime = undefined;
    },
  });
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
): Models & { readonly capture: () => void } {
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
    capture: () => {
      captured = Object.freeze([...models.getModels()]);
    },
  } as Models & { readonly capture: () => void });
}
