import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import type { Provider } from "@earendil-works/pi-ai";

import { createConfiguredPiModels } from "../support/configured-data-plane.js";
import { createCatalogCacheStore } from "../../src/providers/catalog-cache.js";

/**
 * Ticket 11 composition seam: the configured Pi models own the validated
 * catalog cache and restore the cached dynamic catalog before the runtime
 * is served; a successful Provider login through the served Models
 * schedules a background refresh for the relevant Provider; and the
 * catalog handle recomposes the runtime from authoritative models.json
 * facts. Driven through a controlled Provider Package and a memory file
 * system — no real network or credentials.
 */

function memoryFileSystem(files: Map<string, string>) {
  return {
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
}

function dynamicPackage(provider: Provider) {
  return {
    providerPackage: {
      contractVersion: 1,
      createProvider: async () => provider,
    },
  };
}

function createPackageProvider(options: {
  readonly id: string;
  readonly fetch: (context: {
    readonly allowNetwork: boolean;
  }) => Promise<readonly unknown[]>;
}): Provider {
  let dynamic: readonly unknown[] = [];
  const base = {
    id: options.id,
    name: options.id,
    baseUrl: "https://pkg.example.com/v1",
    auth: {
      apiKey: {
        name: "Package API key",
        login: async () => ({ type: "api_key", key: "test-key" }),
        check: async () => ({ type: "api_key", source: "configured" }),
        resolve: async () => ({ auth: { apiKey: "test-key" }, source: "configured" }),
      },
    },
    getModels: () => dynamic,
    refreshModels: async (context: {
      stored?: { models: readonly { provider: string }[] };
      allowNetwork: boolean;
      publish(publication: {
        persist?: unknown;
        update?: () => void;
      }): Promise<boolean>;
    }) => {
      // Pinned restore-before-network: cached facts come back first.
      if (context.stored !== undefined) {
        const restored = context.stored.models.filter(
          (model) => model.provider === options.id,
        );
        await context.publish({
          update: () => {
            dynamic = restored;
          },
        });
      }
      if (!context.allowNetwork) return;
      const refreshed = await options.fetch({ allowNetwork: true });
      await context.publish({
        persist: { models: refreshed, checkedAt: 1 },
        update: () => {
          dynamic = refreshed;
        },
      });
    },
    stream: () => {
      throw new Error("no streaming in composition tests");
    },
    streamSimple: () => {
      throw new Error("no streaming in composition tests");
    },
  };
  return base as unknown as Provider;
}

function modelFact(providerId: string, id: string, baseUrl: string) {
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
  };
}

describe("catalog composition runtime", () => {
  it("restores the cached dynamic catalog before the composition is served", async () => {
    const files = new Map<string, string>();
    const cachePath = "C:\\app\\models-catalog-cache.json";
    files.set(
      cachePath,
      JSON.stringify({
        schema: "luckytoken-catalog-cache-v1",
        providers: {
          "dynamic-pkg": {
            models: [modelFact("dynamic-pkg", "cached-model", "https://cached.example/v1")],
            checkedAt: 100,
          },
        },
      }),
    );
    const store = createCatalogCacheStore({
      path: cachePath,
      fileSystem: memoryFileSystem(files),
    });
    const fetch = vi.fn(async () => [
      modelFact("dynamic-pkg", "fresh-model", "https://fresh.example/v1"),
    ]);
    const { models, catalog } = await createConfiguredPiModels({
      piDirectory: ".unused-in-memory-pi",
      modelsStore: store,
      credentialSeedStore: new InMemoryCredentialStore(),
      fetch: async () => new Response(null, { status: 500 }),
      providerPackages: Object.freeze({
        "@fixture/dynamic": {},
      }),
      importModule: async () =>
        dynamicPackage(createPackageProvider({ id: "dynamic-pkg", fetch })),
      now: () => 1,
      createUuid: () => "00000000-0000-4000-8000-000000000001",
    });
    // The cached facts are served without any network fetch.
    expect(fetch).not.toHaveBeenCalled();
    expect(
      models.getModels("dynamic-pkg")?.some((model) => model.id === "cached-model"),
    ).toBe(true);
    // The catalog handle exposes the same served Models.
    expect(catalog.models.getModel("dynamic-pkg", "cached-model")).toBeDefined();
  });

  it("keeps direct Pi login free of hidden Catalog scheduling", async () => {
    const files = new Map<string, string>();
    const store = createCatalogCacheStore({
      path: "C:\\app\\models-catalog-cache.json",
      fileSystem: memoryFileSystem(files),
    });
    const refreshModels = vi.fn(async () => []);
    const { models, providerAuthBindings } = await createConfiguredPiModels({
      piDirectory: ".unused-in-memory-pi",
      modelsStore: store,
      credentialSeedStore: new InMemoryCredentialStore(),
      fetch: async () => new Response(null, { status: 500 }),
      providerPackages: Object.freeze({
        "@fixture/dynamic": {},
      }),
      importModule: async () =>
        dynamicPackage(
          createPackageProvider({
            id: "login-pkg",
            fetch: refreshModels,
          }),
        ),
      now: () => 1,
      createUuid: () => "00000000-0000-4000-8000-000000000003",
    });
    const login = await providerAuthBindings.createLoginBinding({
      providerId: "login-pkg",
      authType: "api_key",
      displayName: "Login fixture",
      useNow: true,
      expectedRevision: "absent",
    });
    await providerAuthBindings.runBound(login, () =>
      models.login("login-pkg", "api_key", {
        prompt: async () => "secret",
        notify: async () => undefined,
        signal: new AbortController().signal,
      }),
    );
    await Promise.resolve();
    expect(refreshModels).not.toHaveBeenCalled();
  });
});
