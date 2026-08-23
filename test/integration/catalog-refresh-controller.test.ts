import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createModels,
  createProvider,
  type Api,
  type AuthCheck,
  type Model,
  type Models,
  type Provider,
  type ProviderAuth,
  type RefreshModelsContext,
} from "@earendil-works/pi-ai";

import type { ModelsStoreEntry } from "@earendil-works/pi-ai";

type ModelApi = Model<Api>;
import { createCatalogCacheStore } from "../../src/providers/catalog-cache.js";
import {
  createCatalogRefreshController,
  createCatalogSnapshotModels,
  type CatalogProviderOperations,
  type CatalogRefreshControllerOptions,
  type CatalogRuntimeHandle,
} from "../../src/providers/catalog-refresh.js";
import { createModelsJsonAuthority } from "../../src/models-config/authority.js";
import { composeEffectiveCatalog } from "../../src/providers/effective-composition.js";
import { applyLuckyTokenProviderComposition } from "../../src/providers/catalog.js";
import { createConfigValueResolver } from "../../src/providers/config-value.js";
import type {
  RequestJourneyObservationAuthority,
  RuntimeEventObservationInput,
} from "../../src/diagnostics/contract.js";

/**
 * Ticket 11 controller seam: the authoritative active catalog snapshot.
 *
 * The refresh controller restores the validated cache before any network
 * refresh, recomposes the runtime from the authoritative models.json on
 * every run, isolates per-Provider failures with value-safe warnings, and
 * atomically swaps the served catalog snapshot (new requests only; captured
 * Model objects are never mutated). Every case drives the real cache store,
 * the real models.json authority and the real provider composition through
 * a controlled Provider and a deterministic clock/scheduler.
 */

interface ControlledProviderOptions {
  readonly baseline?: readonly ModelApi[];
  readonly available?: boolean;
  readonly fetch?: (context: RefreshModelsContext) => Promise<readonly Model<Api>[]>;
  /** When set, fetch throws this error; the raw message must never leak. */
  readonly fetchError?: Error;
}

function createControlledProvider(
  providerId: string,
  options: ControlledProviderOptions,
): { readonly provider: Provider; readonly fetches: number[] } {
  const fetches: number[] = [];
  const base = createProvider({
    id: providerId,
    name: providerId,
    baseUrl: "https://controlled.example.com/v1",
    models: [...(options.baseline ?? [])],
    auth: {
      apiKey: {
        name: "Controlled API key",
        login: async () => ({ type: "api_key", key: "test-key" }),
        check: async (): Promise<AuthCheck | undefined> =>
          options.available === false
            ? undefined
            : { type: "api_key", source: "configured" },
        resolve: async () =>
          options.available === false
            ? undefined
            : { auth: { apiKey: "test-key" }, source: "configured" },
      },
    } satisfies ProviderAuth,
    api: {
      stream: () => {
        throw new Error("no streaming in catalog tests");
      },
      streamSimple: () => {
        throw new Error("no streaming in catalog tests");
      },
    },
  });
  const refreshModels: NonNullable<Provider["refreshModels"]> = async (
    context,
  ) => {
    if (context.stored !== undefined) {
      const restored = context.stored.models.filter(
        (model) => model.provider === providerId,
      );
      await context.publish({
        update: () => {
          dynamic = restored;
        },
      });
    }
    if (!context.allowNetwork || context.signal.aborted) return;
    fetches.push(fetches.length);
    if (options.fetch !== undefined) {
      const refreshed = await options.fetch(context);
      await context.publish({
        persist: {
          models: refreshed,
          checkedAt: Date.now(),
        },
        update: () => {
          dynamic = refreshed;
        },
      });
      return;
    }
    if (options.fetchError !== undefined) throw options.fetchError;
    throw new Error(`No fetch implementation for ${providerId}`);
  };
  let dynamic: readonly ModelApi[] = [];
  const provider: Provider =
    options.fetch === undefined && options.fetchError === undefined
      ? { ...base, getModels: () => [...(options.baseline ?? [])] }
      : {
          ...base,
          refreshModels,
          getModels: () => {
            const merged = [...(options.baseline ?? [])];
            for (const model of dynamic) {
              const index = merged.findIndex((entry) => entry.id === model.id);
              if (index >= 0) merged[index] = model;
              else merged.push(model);
            }
            return merged;
          },
        };
  return { provider, fetches };
}

function dynamicModelFact(
  providerId: string,
  id: string,
  baseUrl: string,
): ModelApi {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: providerId,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  } as ModelApi;
}

interface Fixture {
  readonly authority: ReturnType<typeof createModelsJsonAuthority>;
  readonly store: ReturnType<typeof createCatalogCacheStore>;
  readonly diagnostics: Pick<
    RequestJourneyObservationAuthority,
    "observeRuntime"
  >;
  readonly files: Map<string, string>;
  readonly fileSystem: {
    readFile(path: string): Promise<string>;
    writeFile(path: string, content: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    mkdir(path: string): Promise<void>;
    rm(path: string): Promise<void>;
  };
  readonly modelsJsonPath: string;
  readonly cachePath: string;
  readonly now: () => number;
  readonly advance: (ms: number) => void;
  readonly scheduler: { schedule(fn: () => void): void; flush(): Promise<void> };
  readonly warnings: RuntimeEventObservationInput[];
  readonly close: () => Promise<void>;
}

const fixtures: Fixture[] = [];

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "luckytoken-catalog-refresh-"));
  const modelsJsonPath = join(root, "models.json");
  const cachePath = join(root, "models-catalog-cache.json");
  const files = new Map<string, string>();
  const memoryFileSystem = {
    readFile: async (path: string) => {
      const content = files.get(path);
      if (content === undefined) {
        throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      }
      return content;
    },
    writeFile: async (path: string, content: string) => {
      files.set(path, content);
    },
    rename: async (from: string, to: string) => {
      const content = files.get(from);
      if (content === undefined) {
        throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      }
      files.delete(from);
      files.set(to, content);
    },
    mkdir: async () => undefined,
    rm: async (path: string) => {
      files.delete(path);
    },
  };
  const authority = createModelsJsonAuthority({
    path: modelsJsonPath,
    fileSystem: memoryFileSystem,
    lock: { acquire: async () => async () => undefined },
    compose: (providers) => composeEffectiveCatalog(providers),
  });
  const store = createCatalogCacheStore({
    path: cachePath,
    fileSystem: memoryFileSystem,
  });
  let nowValue = 1_700_000_000_000;
  const now = () => nowValue;
  const advance = (ms: number) => {
    nowValue += ms;
  };
  const tasks: Array<() => void | Promise<void>> = [];
  const scheduler = {
    schedule(fn: () => void): void {
      tasks.push(fn);
    },
    async flush(): Promise<void> {
      while (tasks.length > 0) {
        const task = tasks.shift() as () => void | Promise<void>;
        await task();
      }
    },
  };
  const warnings: Fixture["warnings"] = [];
  const diagnostics = Object.freeze({
    observeRuntime(input: RuntimeEventObservationInput): void {
      warnings.push(structuredClone(input));
    },
  });
  const fixture: Fixture = {
    authority,
    store,
    diagnostics,
    files,
    fileSystem: memoryFileSystem,
    modelsJsonPath,
    cachePath,
    now,
    advance,
    scheduler,
    warnings,
    close: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
  fixtures.push(fixture);
  return fixture;
}

function writeModelsJson(
  fixture: Fixture,
  providers: Record<string, unknown>,
): void {
  fixture.files.set(
    fixture.modelsJsonPath,
    `${JSON.stringify({ providers }, null, 2)}\n`,
  );
}

function writeCacheEntry(
  fixture: Fixture,
  providerId: string,
  entry: ModelsStoreEntry,
): void {
  const raw = fixture.files.get(fixture.cachePath);
  const parsed =
    raw === undefined
      ? { schema: "luckytoken-catalog-cache-v1", providers: {} }
      : (JSON.parse(raw) as {
          schema: string;
          providers: Record<string, unknown>;
        });
  parsed.providers[providerId] = entry;
  fixture.files.set(fixture.cachePath, JSON.stringify(parsed, null, 2));
}

function createRuntimeHandle(options: {
  readonly providers: readonly Provider[];
  readonly modelsJson?: Record<string, unknown>;
  readonly configValues?: ReturnType<typeof createConfigValueResolver>;
  readonly modelsStore?: ReturnType<typeof createCatalogCacheStore>;
  readonly builtins?: readonly Provider[];
}): CatalogRuntimeHandle & { readonly models: Models } {
  const configValues =
    options.configValues ??
    createConfigValueResolver({ envSource: () => undefined });
  const mutable = createModels({
    authContext: {
      env: async () => undefined,
      fileExists: async () => false,
    },
    ...(options.modelsStore === undefined
      ? {}
      : { modelsStore: options.modelsStore }),
  });
  for (const provider of options.providers) mutable.setProvider(provider);
  let userProviderIds: ReadonlySet<string> = new Set();
  const apply = (modelsJson: Record<string, unknown> | undefined) => {
    userProviderIds = new Set(
      applyLuckyTokenProviderComposition(mutable, {
        ...(modelsJson === undefined
          ? {}
          : { modelsJson: { providers: modelsJson as never } }),
        configValues,
        previousUserProviderIds: userProviderIds,
        ...(options.builtins === undefined ? {} : { builtins: options.builtins }),
      }),
    );
  };
  apply(options.modelsJson);
  const wrapped = createCatalogSnapshotModels(mutable);
  return {
    models: wrapped,
    capture: (preserveProviderIds) => wrapped.capture(preserveProviderIds),
    operationsForProvider: async () => ({
      refreshProvider: (providerId, refreshOptions) =>
        wrapped.refresh({ ...refreshOptions, providers: [providerId] }),
      checkAuth: (providerId, checkOptions) =>
        wrapped.checkAuth(providerId, checkOptions),
      isCurrent: async () => true,
      publishIfCurrent: async (_providerId, publish) => {
        await publish(() => undefined);
        return true;
      },
    }),
    refreshProvider: (providerId, refreshOptions) =>
      wrapped.refresh({ ...refreshOptions, providers: [providerId] }),
    checkAuth: (providerId, checkOptions) =>
      wrapped.checkAuth(providerId, checkOptions),
    isCurrent: async () => true,
    publishIfCurrent: async (_providerId, publish) => {
      await publish(() => undefined);
      return true;
    },
    restoreProvider: async (providerId, entry) => {
      const provider = wrapped.getProvider(providerId);
      await provider?.refreshModels?.({
        stored: structuredClone(entry),
        publish: async (publication) => {
          publication.update?.();
          return true;
        },
        allowNetwork: false,
        signal: new AbortController().signal,
      });
    },
  };
}

function createController(
  fixture: Fixture,
  options: Partial<CatalogRefreshControllerOptions> = {},
) {
  return createCatalogRefreshController({
    store: fixture.store,
    authority: fixture.authority,
    diagnostics: fixture.diagnostics,
    now: fixture.now,
    scheduler: fixture.scheduler,
    ...options,
  });
}

describe("catalog refresh controller", () => {
  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  });

  it("keeps catalog failure behavior identical when unified runtime observation is enabled or throws", async () => {
    type RuntimeObserver = Pick<
      RequestJourneyObservationAuthority,
      "observeRuntime"
    >;
    const run = async (diagnostics: RuntimeObserver) => {
      const fixture = await createFixture();
      writeModelsJson(fixture, {});
      const controlled = createControlledProvider("dynamic-observed", {
        fetchError: new Error("raw provider failure must stay private"),
      });
      const controller = createController(fixture, {
        diagnostics,
      });
      await controller.bind(
        createRuntimeHandle({
          modelsStore: fixture.store,
          providers: [controlled.provider],
        }),
      );
      return {
        report: await controller.refreshManual(),
        snapshot: controller.snapshot(),
      };
    };

    const observations: RuntimeEventObservationInput[] = [];
    const disabled = await run({ observeRuntime: () => undefined });
    const enabled = await run({
      observeRuntime: (input) => {
        observations.push(structuredClone(input));
      },
    });
    const throwing = await run({
      observeRuntime: () => {
        throw new Error("diagnostics unavailable");
      },
    });

    expect(enabled).toEqual(disabled);
    expect(throwing).toEqual(disabled);
    expect(observations).toEqual([
      {
        level: "warning",
        classification: "catalog_provider_refresh_failed",
        safeMessage:
          'Model catalog refresh failed for provider "dynamic-observed"',
      },
    ]);
    expect(JSON.stringify(observations)).not.toContain("raw provider failure");
  });

  it("restores the cached dynamic catalog at startup before any network refresh", async () => {
    const fixture = await createFixture();
    writeCacheEntry(fixture, "dynamic-a", {
      models: [dynamicModelFact("dynamic-a", "cached-model", "https://cached.example/v1")],
      checkedAt: 100,
    });
    writeModelsJson(fixture, {});
    const controlled = createControlledProvider("dynamic-a", {
      fetch: async () => [dynamicModelFact("dynamic-a", "fresh-model", "https://fresh.example/v1")],
    });
    const controller = createController(fixture);
    const handle = createRuntimeHandle({ modelsStore: fixture.store, providers: [controlled.provider] });
    await controller.bind(handle);
    // The cached facts are served before the network refresh ran.
    expect(controlled.fetches).toEqual([]);
    const snapshot = controller.snapshot();
    expect(snapshot.modelsJsonValid).toBe(true);
    const dynamicA = snapshot.providers.find(
      (provider) => provider.providerId === "dynamic-a",
    );
    expect(dynamicA?.state).toBe("cached");
    expect(
      handle.models.getModels("dynamic-a")?.some((model) => model.id === "cached-model"),
    ).toBe(true);
    // The non-blocking startup background refresh then fetches.
    await fixture.scheduler.flush();
    await vi.waitFor(() => {
      expect(controlled.fetches.length).toBe(1);
      expect(
        controller
          .snapshot()
          .providers.find((provider) => provider.providerId === "dynamic-a")
          ?.state,
      ).toBe("succeeded");
    });
    expect(
      handle.models.getModels("dynamic-a")?.some((model) => model.id === "fresh-model"),
    ).toBe(true);
  });

  it("deduplicates background triggers into one refresh run", async () => {
    const fixture = await createFixture();
    writeModelsJson(fixture, {});
    const controlled = createControlledProvider("dynamic-a", {
      fetch: async () => [dynamicModelFact("dynamic-a", "m1", "https://a.example/v1")],
    });
    const controller = createController(fixture);
    await controller.bind(createRuntimeHandle({ modelsStore: fixture.store, providers: [controlled.provider] }));
    // Startup and page-open triggers arrive before the scheduler ran.
    controller.scheduleBackground("startup");
    controller.scheduleBackground("page_open");
    await fixture.scheduler.flush();
    await vi.waitFor(() => {
      expect(controlled.fetches.length).toBe(1);
    });
    // No second run is triggered by the coalesced triggers.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(controlled.fetches.length).toBe(1);
  });

  it("atomically swaps the served catalog; captured Model snapshots are untouched", async () => {
    const fixture = await createFixture();
    writeModelsJson(fixture, {});
    const controlled = createControlledProvider("dynamic-a", {
      baseline: [dynamicModelFact("dynamic-a", "baseline-model", "https://base.example/v1")],
      fetch: async () => [
        dynamicModelFact("dynamic-a", "baseline-model", "https://fresh.example/v1"),
      ],
    });
    const controller = createController(fixture);
    const handle = createRuntimeHandle({ modelsStore: fixture.store, providers: [controlled.provider] });
    await controller.bind(handle);
    // A request captures its Model object from the served snapshot.
    const captured = handle.models.getModel("dynamic-a", "baseline-model");
    expect(captured?.baseUrl).toBe("https://base.example/v1");
    const report = await controller.refreshManual();
    // Bounded per-Provider results: every refreshable Provider reports its
    // outcome (the pinned Radius baseline is refreshable too).
    expect(
      report.providers.find((entry) => entry.providerId === "dynamic-a")
        ?.outcome,
    ).toBe("succeeded");
    // New requests see the fresh facts…
    const next = handle.models.getModel("dynamic-a", "baseline-model");
    expect(next?.baseUrl).toBe("https://fresh.example/v1");
    // …while the in-flight captured Model object keeps its own facts.
    expect(captured?.baseUrl).toBe("https://base.example/v1");
    expect(controller.snapshot().version).toBeGreaterThanOrEqual(2);
  });

  it("isolates a failed Provider: cached facts survive and a value-safe warning is recorded", async () => {
    const fixture = await createFixture();
    writeCacheEntry(fixture, "dynamic-a", {
      models: [dynamicModelFact("dynamic-a", "cached-model", "https://cached.example/v1")],
      checkedAt: 100,
    });
    writeModelsJson(fixture, {});
    const rawSecret = "sk-raw-network-secret-9f4b2c71";
    const failing = createControlledProvider("dynamic-a", {
      fetchError: new Error(`upstream 500 with ${rawSecret}`),
    });
    const healthy = createControlledProvider("dynamic-b", {
      fetch: async () => [dynamicModelFact("dynamic-b", "fresh-model", "https://b.example/v1")],
    });
    const controller = createController(fixture);
    const handle = createRuntimeHandle({
      modelsStore: fixture.store,
      providers: [failing.provider, healthy.provider],
    });
    await controller.bind(handle);
    await controller.refreshManual();
    const snapshot = controller.snapshot();
    const failedProvider = snapshot.providers.find(
      (provider) => provider.providerId === "dynamic-a",
    );
    expect(failedProvider?.state).toBe("failed");
    expect(failedProvider?.error).toBeDefined();
    // The raw Provider error never leaks into the snapshot.
    expect(JSON.stringify(snapshot)).not.toContain(rawSecret);
    // The unaffected Provider refreshed; the failed one keeps cached facts.
    expect(
      snapshot.providers.find((provider) => provider.providerId === "dynamic-b")
        ?.state,
    ).toBe("succeeded");
    expect(snapshot.refreshErrors).toEqual([
      expect.objectContaining({ providerId: "dynamic-a" }),
    ]);
    expect(
      handle.models.getModels("dynamic-a")?.some((model) => model.id === "cached-model"),
    ).toBe(true);
    // A precise value-safe warning was recorded.
    const warning = fixture.warnings.find((entry) =>
      entry.safeMessage.includes("dynamic-a"),
    );
    expect(warning).toBeDefined();
    expect(warning?.classification).toBe("catalog_provider_refresh_failed");
    expect(
      fixture.warnings.some((entry) => entry.safeMessage.includes(rawSecret)),
    ).toBe(false);
    expect(JSON.stringify(fixture.warnings)).not.toContain(rawSecret);
  });

  it("keeps compatible built-ins when models.json is invalid and never repairs it", async () => {
    const fixture = await createFixture();
    fixture.files.set(fixture.modelsJsonPath, "{ not json");
    const custom = createControlledProvider("custom-gateway", {
      baseline: [dynamicModelFact("custom-gateway", "custom-model", "https://c.example/v1")],
    });
    const controller = createController(fixture);
    const handle = createRuntimeHandle({
      modelsStore: fixture.store,
      providers: [custom.provider],
      modelsJson: {
        "custom-gateway": {
          baseUrl: "https://c.example/v1",
          api: "openai-completions",
          models: [{ id: "custom-model" }],
        },
      },
    });
    await controller.bind(handle);
    const before = controller.snapshot();
    // The current file error is surfaced, but the startup-composed Provider
    // remains part of this Backend lifetime.
    expect(before.modelsJsonValid).toBe(false);
    expect(before.modelsJsonError?.kind).toBe("parse");
    expect(before.providers.find((p) => p.providerId === "custom-gateway")).toBeDefined();
    expect(handle.models.getModels("custom-gateway").length).toBe(1);
    // The invalid file was not repaired.
    expect(fixture.files.get(fixture.modelsJsonPath)).toBe("{ not json");
    // Refresh never recomposes Provider identity.
    await controller.refreshManual();
    const after = controller.snapshot();
    expect(after.providers.find((p) => p.providerId === "custom-gateway")).toBeDefined();
    expect(fixture.files.get(fixture.modelsJsonPath)).toBe("{ not json");
    // A later valid file updates only management validity; Provider identity
    // was already fixed at startup.
    writeModelsJson(fixture, {
      "custom-gateway": {
        baseUrl: "https://c.example/v1",
        api: "openai-completions",
        models: [{ id: "custom-model" }],
      },
    });
    await controller.refreshManual();
    expect(
      controller
        .snapshot()
        .providers.find((p) => p.providerId === "custom-gateway"),
    ).toBeDefined();
    expect(handle.models.getModels("custom-gateway")?.length).toBe(1);
  });

  it("distinguishes known, unavailable, cached, refreshing, failed and succeeded states", async () => {
    const fixture = await createFixture();
    writeModelsJson(fixture, {});
    const staticProvider = createControlledProvider("static-b", {
      baseline: [dynamicModelFact("static-b", "static-model", "https://s.example/v1")],
      available: false,
    });
    const cached = createControlledProvider("dynamic-c", {
      fetch: async () => [dynamicModelFact("dynamic-c", "m", "https://c.example/v1")],
    });
    writeCacheEntry(fixture, "dynamic-c", {
      models: [dynamicModelFact("dynamic-c", "cached-m", "https://cache.example/v1")],
      checkedAt: 1,
    });
    const controller = createController(fixture);
    const handle = createRuntimeHandle({
      modelsStore: fixture.store,
      providers: [staticProvider.provider, cached.provider],
    });
    await controller.bind(handle);
    // Known static provider with unavailable models.
    const staticView = controller
      .snapshot()
      .providers.find((p) => p.providerId === "static-b");
    expect(staticView?.state).toBe("known");
    expect(staticView?.dynamic).toBe(false);
    expect(staticView?.models[0]?.availability).toBe("unavailable");
    // Cached dynamic provider.
    const cachedView = controller
      .snapshot()
      .providers.find((p) => p.providerId === "dynamic-c");
    expect(cachedView?.state).toBe("cached");
    expect(cachedView?.models[0]?.dynamic).toBe(true);
    // Refreshing is observable while a manual refresh is in flight.
    let releaseFetch: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const gated = createControlledProvider("dynamic-g", {
      fetch: async () => {
        await gate;
        return [dynamicModelFact("dynamic-g", "g", "https://g.example/v1")];
      },
    });
    let secondHandle: CatalogRuntimeHandle & { readonly models: Models };
    await controller.bind(
      (secondHandle = createRuntimeHandle({
        modelsStore: fixture.store,
        providers: [
          staticProvider.provider,
          cached.provider,
          gated.provider,
        ],
      })),
    );
    const pending = controller.refreshManual();
    await vi.waitFor(() => {
      expect(
        controller
          .snapshot()
          .providers.find((p) => p.providerId === "dynamic-g")?.state,
      ).toBe("refreshing");
    });
    releaseFetch?.();
    await pending;
    // Failed and succeeded states.
    const gatedView = controller
      .snapshot()
      .providers.find((p) => p.providerId === "dynamic-g");
    expect(gatedView?.state).toBe("succeeded");
    expect(
      secondHandle.models
        .getModels("dynamic-g")
        ?.some((model) => model.id === "g"),
    ).toBe(true);
  });

  it("emits a value-safe warning when cached entries are dropped", async () => {
    const fixture = await createFixture();
    writeModelsJson(fixture, {});
    fixture.files.set(
      fixture.cachePath,
      JSON.stringify({
        schema: "luckytoken-catalog-cache-v1",
        providers: {
          "dynamic-a": { models: [{ id: "broken" }], checkedAt: 1 },
        },
      }),
    );
    const controlled = createControlledProvider("dynamic-a", {
      fetch: async () => [dynamicModelFact("dynamic-a", "m1", "https://a.example/v1")],
    });
    const controller = createController(fixture);
    await controller.bind(createRuntimeHandle({ modelsStore: fixture.store, providers: [controlled.provider] }));
    expect(controller.snapshot().providers[0]?.state).toBe("known");
    expect(
      fixture.warnings.some((entry) =>
        entry.safeMessage.includes("dynamic-a") &&
        entry.safeMessage.includes("discard"),
      ),
    ).toBe(true);
    // An unchanged broken cache file never re-emits the same warning.
    await controller.refreshManual();
    expect(
      fixture.warnings.filter((entry) =>
        entry.safeMessage.includes("discard"),
      ),
    ).toHaveLength(1);
  });

  it("keeps concurrent Provider publishes coherent through the cache", async () => {
    const fixture = await createFixture();
    writeModelsJson(fixture, {});
    const a = createControlledProvider("dynamic-a", {
      fetch: async () => [dynamicModelFact("dynamic-a", "ma", "https://a.example/v1")],
    });
    const b = createControlledProvider("dynamic-b", {
      fetch: async () => [dynamicModelFact("dynamic-b", "mb", "https://b.example/v1")],
    });
    const controller = createController(fixture);
    const handle = createRuntimeHandle({
      modelsStore: fixture.store,
      providers: [a.provider, b.provider],
    });
    await controller.bind(handle);
    // Pi refreshes both Providers concurrently; both persisted publishes
    // must survive a simulated restart.
    await controller.refreshManual();
    const restarted = createCatalogCacheStore({
      path: fixture.cachePath,
      fileSystem: fixture.fileSystem,
    });
    expect((await restarted.read("dynamic-a"))?.models[0]?.id).toBe("ma");
    expect((await restarted.read("dynamic-b"))?.models[0]?.id).toBe("mb");
  });

  it("does not overlay a newly edited models.json during dynamic catalog refresh", async () => {
    const fixture = await createFixture();
    // A refreshModels-bearing base registered like a built-in…
    const base = createControlledProvider("dynamic-a", {
      baseline: [dynamicModelFact("dynamic-a", "base-model", "https://base.example/v1")],
      fetch: async () => [dynamicModelFact("dynamic-a", "fresh-model", "https://fresh.example/v1")],
    });
    // …with cached dynamic facts from a previous run…
    writeCacheEntry(fixture, "dynamic-a", {
      models: [dynamicModelFact("dynamic-a", "cached-model", "https://cached.example/v1")],
      checkedAt: 100,
    });
    // …while models.json is edited after the runtime composition exists.
    writeModelsJson(fixture, {
      "dynamic-a": {
        baseUrl: "https://gateway.example.com/v1",
        api: "openai-completions",
        models: [{ id: "configured-model" }],
      },
    });
    const controller = createController(fixture);
    const handle = createRuntimeHandle({
      modelsStore: fixture.store,
      providers: [],
      builtins: [base.provider],
    });
    await controller.bind(handle);
    // Cached runtime facts are served, but the newly edited models.json is
    // not hot-applied.
    let served = handle.models.getModels("dynamic-a");
    expect(
      served?.some((model) => model.id === "cached-model"),
    ).toBe(true);
    expect(
      served?.some((model) => model.id === "configured-model"),
    ).toBe(false);
    // A request captured its Model object from the served snapshot.
    const captured = handle.models.getModel("dynamic-a", "cached-model");
    const capturedBaseUrl = captured?.baseUrl;
    // A successful refresh swaps the overlay's dynamic facts: new requests
    // see the fresh catalog while the captured object stays stable.
    await controller.refreshManual();
    served = handle.models.getModels("dynamic-a");
    expect(
      served?.some((model) => model.id === "fresh-model"),
    ).toBe(true);
    // The old dynamic fact is gone from the served snapshot for new
    // requests, while the in-flight captured Model object is untouched.
    expect(handle.models.getModel("dynamic-a", "cached-model")).toBeUndefined();
    expect(captured?.baseUrl).toBe(capturedBaseUrl);
  });

  it("reports skipped Providers that never refreshed (no credential)", async () => {
    const fixture = await createFixture();
    writeModelsJson(fixture, {});
    const noCredential = createControlledProvider("dynamic-a", {
      fetch: async () => [
        dynamicModelFact("dynamic-a", "m", "https://a.example/v1"),
      ],
      available: false,
    });
    const controller = createController(fixture);
    await controller.bind(
      createRuntimeHandle({
        modelsStore: fixture.store,
        providers: [noCredential.provider],
      }),
    );
    const report = await controller.refreshManual();
    const entry = report.providers.find(
      (provider) => provider.providerId === "dynamic-a",
    );
    // Pi skips the network phase without a credential: the run must not
    // claim a refresh that never happened.
    expect(entry?.outcome).toBe("skipped");
  });

  it("reports the aborted run truthfully and restores the served snapshot", async () => {
    const fixture = await createFixture();
    writeModelsJson(fixture, {});
    let releaseFetch: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const gated = createControlledProvider("dynamic-a", {
      fetch: async () => {
        await gate;
        return [dynamicModelFact("dynamic-a", "m", "https://a.example/v1")];
      },
    });
    const controller = createController(fixture);
    await controller.bind(
      createRuntimeHandle({
        modelsStore: fixture.store,
        providers: [gated.provider],
      }),
    );
    const abort = new AbortController();
    const pending = controller.refreshManual(abort.signal);
    await vi.waitFor(() => {
      expect(
        controller
          .snapshot()
          .providers.find((p) => p.providerId === "dynamic-a")?.state,
      ).toBe("refreshing");
    });
    abort.abort();
    releaseFetch?.();
    const report = await pending;
    const entry = report.providers.find(
      (provider) => provider.providerId === "dynamic-a",
    );
    // The interrupted Provider is reported skipped — never a stale
    // succeeded from a previous run.
    expect(entry?.outcome).toBe("skipped");
    // The served snapshot reverts to the last complete cycle (no stuck
    // refreshing, no claimed refresh).
    const state = controller
      .snapshot()
      .providers.find((p) => p.providerId === "dynamic-a")?.state;
    expect(state).not.toBe("refreshing");
  });

  it("resolves getModel and getModels from the captured snapshot only", async () => {
    const fixture = await createFixture();
    writeModelsJson(fixture, {});
    const providerA = createControlledProvider("dynamic-a", {
      baseline: [dynamicModelFact("dynamic-a", "m1", "https://a.example/v1")],
    });
    const mutable = createModels({
      authContext: { env: async () => undefined, fileExists: async () => false },
      modelsStore: fixture.store,
    });
    mutable.setProvider(providerA.provider);
    const wrapped = createCatalogSnapshotModels(mutable);
    // The first capture freezes the served snapshot.
    wrapped.capture();
    expect(wrapped.getModel("dynamic-a", "m1")).toBeDefined();
    // A later live refresh (new Provider object with an extra model) must
    // never leak into the captured snapshot.
    const providerB = createControlledProvider("dynamic-a", {
      baseline: [
        dynamicModelFact("dynamic-a", "m1", "https://a.example/v1"),
        dynamicModelFact("dynamic-a", "m2", "https://a.example/v1"),
      ],
    });
    mutable.setProvider(providerB.provider);
    expect(wrapped.getModels("dynamic-a")?.some((model) => model.id === "m2")).toBe(false);
    expect(wrapped.getModel("dynamic-a", "m2")).toBeUndefined();
    // An explicit capture swaps the served snapshot for new requests.
    wrapped.capture();
    expect(wrapped.getModel("dynamic-a", "m2")).toBeDefined();
  });

  it("Ticket 13: a login-triggered refresh publishes generation N+1 without mutating facts a request already captured at generation N", async () => {
    const fixture = await createFixture();
    writeModelsJson(fixture, {});
    let releaseFetch: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const dynamic = createControlledProvider("dynamic-a", {
      baseline: [dynamicModelFact("dynamic-a", "gen-n-model", "https://n.example/v1")],
      fetch: async () => {
        if (dynamic.fetches.length === 1) {
          return [dynamicModelFact("dynamic-a", "gen-n-model", "https://n.example/v1")];
        }
        await gate;
        return [dynamicModelFact("dynamic-a", "gen-n1-model", "https://n1.example/v1")];
      },
    });
    const controller = createController(fixture);
    const handle = createRuntimeHandle({
      modelsStore: fixture.store,
      providers: [dynamic.provider],
    });
    await controller.bind(handle);
    await fixture.scheduler.flush();
    await vi.waitFor(() => {
      expect(
        controller.snapshot().providers.find(
          (provider) => provider.providerId === "dynamic-a",
        )?.state,
      ).toBe("succeeded");
    });

    // Request A captures its Model object from generation N.
    const capturedA = handle.models.getModel("dynamic-a", "gen-n-model");
    expect(capturedA?.baseUrl).toBe("https://n.example/v1");

    const exactOperations: CatalogProviderOperations = {
      refreshProvider: handle.refreshProvider,
      checkAuth: handle.checkAuth,
      isCurrent: async () => true,
      publishIfCurrent: async (_providerId: string, publish) => {
        await publish(() => undefined);
        return true;
      },
    };
    // The successful login child phase carries exact Profile operations.
    // The fetch is gated so publication is explicitly controlled.
    controller.scheduleProviderBackground("login", "dynamic-a", exactOperations);
    await fixture.scheduler.flush();
    await vi.waitFor(() => {
      expect(dynamic.fetches.length).toBe(2);
    });
    // The provisional snapshot is published while the refresh is in flight.
    expect(
      controller
        .snapshot()
        .providers.find((p) => p.providerId === "dynamic-a")?.state,
    ).toBe("refreshing");
    // Request A's captured object is not mutated by the provisional swap.
    expect(handle.models.getModel("dynamic-a", "gen-n-model")?.baseUrl).toBe(
      "https://n.example/v1",
    );

    // Release the network phase: generation N+1 is published atomically.
    releaseFetch?.();
    await vi.waitFor(() => {
      expect(
        controller
          .snapshot()
          .providers.find((p) => p.providerId === "dynamic-a")?.state,
      ).toBe("succeeded");
    });
    // Request B accepted after publication uses generation N+1 facts.
    expect(handle.models.getModel("dynamic-a", "gen-n1-model")).toBeDefined();
    // Request A keeps its captured generation-N facts.
    expect(capturedA?.baseUrl).toBe("https://n.example/v1");
  });

  it("discards an exact post-login Catalog result when its Profile selection becomes stale", async () => {
    const fixture = await createFixture();
    writeModelsJson(fixture, {});
    let releaseFetch: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const dynamic = createControlledProvider("dynamic-a", {
      baseline: [dynamicModelFact("dynamic-a", "stable-model", "https://stable.example/v1")],
      fetch: async () => {
        if (dynamic.fetches.length === 1) {
          return [dynamicModelFact("dynamic-a", "stable-model", "https://stable.example/v1")];
        }
        await gate;
        return [dynamicModelFact("dynamic-a", "stale-model", "https://stale.example/v1")];
      },
    });
    const controller = createController(fixture);
    const handle = createRuntimeHandle({
      modelsStore: fixture.store,
      providers: [dynamic.provider],
    });
    await controller.bind(handle);
    await fixture.scheduler.flush();
    await vi.waitFor(() => {
      expect(
        controller.snapshot().providers.find(
          (provider) => provider.providerId === "dynamic-a",
        )?.state,
      ).toBe("succeeded");
    });
    let current = true;
    controller.scheduleProviderBackground("login", "dynamic-a", {
      refreshProvider: handle.refreshProvider,
      checkAuth: handle.checkAuth,
      isCurrent: async () => current,
      publishIfCurrent: async (_providerId, publish) => {
        if (!current) return false;
        await publish(() => undefined);
        return true;
      },
    });
    await fixture.scheduler.flush();
    await vi.waitFor(() => expect(dynamic.fetches).toHaveLength(2));

    current = false;
    releaseFetch?.();
    await vi.waitFor(() => {
      expect(
        controller.snapshot().providers.find(
          (provider) => provider.providerId === "dynamic-a",
        )?.state,
      ).not.toBe("refreshing");
    });

    expect(handle.models.getModel("dynamic-a", "stale-model")).toBeUndefined();
    expect((await fixture.store.read("dynamic-a"))?.models).toEqual([
      expect.objectContaining({ id: "stable-model" }),
    ]);
    // Even a later raw capture cannot leak the discarded live Provider state.
    handle.capture();
    expect(handle.models.getModel("dynamic-a", "stale-model")).toBeUndefined();
    expect(handle.models.getModel("dynamic-a", "stable-model")).toBeDefined();
  });

  it("rolls back an exact Catalog publication failure and never leaves refreshing state", async () => {
    const fixture = await createFixture();
    writeModelsJson(fixture, {});
    const dynamic = createControlledProvider("dynamic-a", {
      baseline: [],
      fetch: async () => [
        dynamicModelFact(
          "dynamic-a",
          dynamic.fetches.length === 1 ? "stable-model" : "uncommitted-model",
          "https://dynamic.example/v1",
        ),
      ],
    });
    const controller = createController(fixture);
    const handle = createRuntimeHandle({
      modelsStore: fixture.store,
      providers: [dynamic.provider],
    });
    await controller.bind(handle);
    await fixture.scheduler.flush();
    await vi.waitFor(() => {
      expect(handle.models.getModel("dynamic-a", "stable-model")).toBeDefined();
    });

    const report = await controller.refreshProviderManual(
      "dynamic-a",
      undefined,
      {
        refreshProvider: handle.refreshProvider,
        checkAuth: handle.checkAuth,
        isCurrent: async () => true,
        publishIfCurrent: async (_providerId, publish) => {
          await publish(() => {
            throw new Error("selection lease compromised");
          });
          return true;
        },
      },
    );

    expect(report.providers).toEqual([
      expect.objectContaining({
        providerId: "dynamic-a",
        outcome: "failed",
        errorCode: "exact_publish_failed",
      }),
    ]);
    expect(
      controller.snapshot().providers.find(
        (provider) => provider.providerId === "dynamic-a",
      )?.state,
    ).not.toBe("refreshing");
    expect(handle.models.getModel("dynamic-a", "uncommitted-model")).toBeUndefined();
    expect((await fixture.store.read("dynamic-a"))?.models).toEqual([
      expect.objectContaining({ id: "stable-model" }),
    ]);
  });

  it("quarantines only the Provider whose post-commit rollback is unproven", async () => {
    const fixture = await createFixture();
    writeModelsJson(fixture, {});
    const dynamicA = createControlledProvider("dynamic-a", {
      baseline: [],
      fetch: async () => [
        dynamicModelFact(
          "dynamic-a",
          dynamicA.fetches.length === 1 ? "a-stable" : "a-unsafe",
          "https://a.example/v1",
        ),
      ],
    });
    const dynamicB = createControlledProvider("dynamic-b", {
      baseline: [],
      fetch: async () => [
        dynamicModelFact(
          "dynamic-b",
          dynamicB.fetches.length === 1 ? "b-stable" : "b-new",
          "https://b.example/v1",
        ),
      ],
    });
    const controller = createController(fixture);
    const handle = createRuntimeHandle({
      modelsStore: fixture.store,
      providers: [dynamicA.provider, dynamicB.provider],
    });
    await controller.bind(handle);
    await fixture.scheduler.flush();
    await vi.waitFor(() => {
      expect(handle.models.getModel("dynamic-a", "a-stable")).toBeDefined();
      expect(handle.models.getModel("dynamic-b", "b-stable")).toBeDefined();
    });

    const originalRename = fixture.fileSystem.rename.bind(fixture.fileSystem);
    let exactRenames = 0;
    fixture.fileSystem.rename = async (from, to) => {
      exactRenames += 1;
      if (exactRenames === 2) throw new Error("rollback storage unavailable");
      await originalRename(from, to);
    };
    let ownershipAssertions = 0;
    await controller.refreshProviderManual("dynamic-a", undefined, {
      refreshProvider: handle.refreshProvider,
      checkAuth: handle.checkAuth,
      isCurrent: async () => true,
      publishIfCurrent: async (_providerId, publish) => {
        await publish(() => {
          ownershipAssertions += 1;
          if (ownershipAssertions === 2) {
            throw new Error("selection lease compromised after cache commit");
          }
        });
        return true;
      },
    });

    expect((await fixture.store.read("dynamic-a"))?.models).toEqual([
      expect.objectContaining({ id: "a-unsafe" }),
    ]);
    expect(handle.models.getModel("dynamic-a", "a-stable")).toBeDefined();
    expect(handle.models.getModel("dynamic-a", "a-unsafe")).toBeUndefined();
    expect(
      controller.snapshot().providers.find(
        (provider) => provider.providerId === "dynamic-a",
      ),
    ).toMatchObject({ state: "failed", errorCode: "restore_unproven" });

    await controller.refreshProviderManual("dynamic-b", undefined, {
      refreshProvider: handle.refreshProvider,
      checkAuth: handle.checkAuth,
      isCurrent: async () => true,
      publishIfCurrent: async (_providerId, publish) => {
        await publish(() => undefined);
        return true;
      },
    });
    expect(handle.models.getModel("dynamic-b", "b-new")).toBeDefined();
    expect(handle.models.getModel("dynamic-a", "a-stable")).toBeDefined();
    expect(handle.models.getModel("dynamic-a", "a-unsafe")).toBeUndefined();
  });

  it("generation-guards an ordinary lifecycle refresh captured before a Profile switch", async () => {
    const fixture = await createFixture();
    writeModelsJson(fixture, {});
    let releaseFetch: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const dynamic = createControlledProvider("dynamic-a", {
      baseline: [],
      fetch: async () => {
        if (dynamic.fetches.length === 1) {
          return [dynamicModelFact("dynamic-a", "stable", "https://stable.example/v1")];
        }
        await gate;
        return [dynamicModelFact("dynamic-a", "stale", "https://stale.example/v1")];
      },
    });
    const baseHandle = createRuntimeHandle({
      modelsStore: fixture.store,
      providers: [dynamic.provider],
    });
    let current = true;
    const guardedHandle: CatalogRuntimeHandle = {
      ...baseHandle,
      operationsForProvider: async () => ({
        refreshProvider: baseHandle.refreshProvider,
        checkAuth: baseHandle.checkAuth,
        isCurrent: async () => current,
        publishIfCurrent: async (_providerId, publish) => {
          if (!current) return false;
          await publish(() => undefined);
          return true;
        },
      }),
    };
    const controller = createController(fixture);
    await controller.bind(guardedHandle);
    await fixture.scheduler.flush();
    await vi.waitFor(() => {
      expect(baseHandle.models.getModel("dynamic-a", "stable")).toBeDefined();
    });

    controller.scheduleBackground("page_open", ["dynamic-a"]);
    await fixture.scheduler.flush();
    await vi.waitFor(() => expect(dynamic.fetches).toHaveLength(2));
    current = false;
    releaseFetch?.();
    await vi.waitFor(() => {
      expect(
        controller.snapshot().providers.find(
          (provider) => provider.providerId === "dynamic-a",
        )?.state,
      ).not.toBe("refreshing");
    });

    expect(baseHandle.models.getModel("dynamic-a", "stale")).toBeUndefined();
    expect((await fixture.store.read("dynamic-a"))?.models).toEqual([
      expect.objectContaining({ id: "stable" }),
    ]);
  });

  it("queues every exact post-login Provider refresh without overwriting an earlier login", async () => {
    const fixture = await createFixture();
    writeModelsJson(fixture, {});
    const dynamicA = createControlledProvider("dynamic-a", {
      baseline: [],
      fetch: async () => [
        dynamicModelFact(
          "dynamic-a",
          `a-${dynamicA.fetches.length}`,
          "https://a.example/v1",
        ),
      ],
    });
    const dynamicB = createControlledProvider("dynamic-b", {
      baseline: [],
      fetch: async () => [
        dynamicModelFact(
          "dynamic-b",
          `b-${dynamicB.fetches.length}`,
          "https://b.example/v1",
        ),
      ],
    });
    const controller = createController(fixture);
    const handle = createRuntimeHandle({
      modelsStore: fixture.store,
      providers: [dynamicA.provider, dynamicB.provider],
    });
    await controller.bind(handle);
    await fixture.scheduler.flush();
    await vi.waitFor(() => {
      expect(dynamicA.fetches).toHaveLength(1);
      expect(dynamicB.fetches).toHaveLength(1);
    });

    const exactFor = (providerId: string): CatalogProviderOperations => ({
      refreshProvider: handle.refreshProvider,
      checkAuth: handle.checkAuth,
      isCurrent: async (candidate) => candidate === providerId,
      publishIfCurrent: async (candidate, publish) => {
        if (candidate !== providerId) return false;
        await publish(() => undefined);
        return true;
      },
    });
    controller.scheduleProviderBackground("login", "dynamic-a", exactFor("dynamic-a"));
    controller.scheduleProviderBackground("login", "dynamic-b", exactFor("dynamic-b"));
    await fixture.scheduler.flush();

    await vi.waitFor(() => {
      expect(dynamicA.fetches).toHaveLength(2);
      expect(dynamicB.fetches).toHaveLength(2);
    });
    await vi.waitFor(() => {
      expect(handle.models.getModel("dynamic-a", "a-2")).toBeDefined();
      expect(handle.models.getModel("dynamic-b", "b-2")).toBeDefined();
    });
  });

  it("checks and publishes a static Provider only under that Provider's exact binding", async () => {
    const fixture = await createFixture();
    writeModelsJson(fixture, {});
    const staticA = createControlledProvider("static-a", {
      baseline: [dynamicModelFact("static-a", "a", "https://a.example/v1")],
    });
    const staticB = createControlledProvider("static-b", {
      baseline: [dynamicModelFact("static-b", "b", "https://b.example/v1")],
    });
    const controller = createController(fixture);
    const handle = createRuntimeHandle({
      providers: [staticA.provider, staticB.provider],
      modelsStore: fixture.store,
    });
    await controller.bind(handle);
    await fixture.scheduler.flush();

    const checked: string[] = [];
    const published: string[] = [];
    controller.scheduleProviderBackground("login", "static-a", {
      refreshProvider: handle.refreshProvider,
      checkAuth: async (providerId, options) => {
        checked.push(providerId);
        return handle.checkAuth(providerId, options);
      },
      isCurrent: async (providerId) => providerId === "static-a",
      publishIfCurrent: async (providerId, publish) => {
        published.push(providerId);
        if (providerId !== "static-a") return false;
        await publish(() => undefined);
        return true;
      },
    });
    await fixture.scheduler.flush();
    await vi.waitFor(() => expect(published).toEqual(["static-a"]));

    expect(checked).toEqual(["static-a"]);
  });

  it("treats an unconfigured static Provider as skipped availability without warnings", async () => {
    const fixture = await createFixture();
    writeModelsJson(fixture, {});
    const staticProvider = createControlledProvider("static-unconfigured", {
      baseline: [
        dynamicModelFact(
          "static-unconfigured",
          "static-model",
          "https://static.example/v1",
        ),
      ],
      available: false,
    });
    const controller = createController(fixture);
    const handle = createRuntimeHandle({
      providers: [staticProvider.provider],
      modelsStore: fixture.store,
    });
    await controller.bind(handle);
    await fixture.scheduler.flush();
    const report = await controller.refreshProviderManual("static-unconfigured");

    expect(report.providers).toEqual([
      { providerId: "static-unconfigured", outcome: "skipped" },
    ]);
    expect(controller.snapshot().refreshErrors).toEqual([]);
    expect(
      controller.snapshot().providers.find(
        (provider) => provider.providerId === "static-unconfigured",
      )?.models[0]?.availability,
    ).toBe("unavailable");
    expect(
      fixture.warnings.some((warning) =>
        warning.safeMessage.includes("static-unconfigured"),
      ),
    ).toBe(false);
  });
});
