import { describe, expect, it } from "vitest";

import type { Api, Model } from "@earendil-works/pi-ai";

import {
  createCatalogCacheStore,
  type CatalogCacheFileSystem,
} from "../../src/providers/catalog-cache.js";

/**
 * Ticket 11 cache seam: the validated LuckyToken-owned dynamic catalog
 * cache. The store implements the pi-ai `ModelsStore` contract over a
 * transparent JSON file under the configured application directory; only
 * validated dynamic model facts are ever persisted, restore drops invalid
 * entries with a precise value-free report, and the same file restores the
 * catalog across a restart.
 */

function modelFact(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: "dynamic-model",
    name: "Dynamic Model",
    api: "openai-completions",
    provider: "dynamic-provider",
    baseUrl: "https://catalog.example.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
    ...overrides,
  } as Model<Api>;
}

function entry(models: readonly Model<Api>[] = [modelFact()]) {
  return {
    models,
    checkedAt: 1000,
    lastModified: 500,
    etag: '"abc"',
  };
}

function createMemoryFileSystem(): {
  readonly fileSystem: CatalogCacheFileSystem;
  readonly files: Map<string, string>;
} {
  const files = new Map<string, string>();
  const fileSystem: CatalogCacheFileSystem = {
    readFile: async (path) => {
      const content = files.get(path);
      if (content === undefined) {
        throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      }
      return content;
    },
    writeFile: async (path, content) => {
      files.set(path, content);
    },
    rename: async (from, to) => {
      const content = files.get(from);
      if (content === undefined) {
        throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      }
      files.delete(from);
      files.set(to, content);
    },
    mkdir: async () => undefined,
    rm: async (path) => {
      files.delete(path);
    },
  };
  return { fileSystem, files };
}

describe("catalog cache store", () => {
  it("persists a validated dynamic catalog entry as transparent JSON", async () => {
    const { fileSystem, files } = createMemoryFileSystem();
    const path = "C:\\app\\models-catalog-cache.json";
    const store = createCatalogCacheStore({ path, fileSystem });
    await store.write("dynamic-provider", entry());
    const raw = files.get(path);
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw ?? "") as {
      schema: string;
      providers: Record<string, unknown>;
    };
    // Transparent LuckyToken-owned file: schema identity plus the entry.
    expect(parsed.schema).toBe("luckytoken-catalog-cache-v1");
    expect(parsed.providers["dynamic-provider"]).toBeDefined();
    const restored = await store.read("dynamic-provider");
    expect(restored?.models[0]?.id).toBe("dynamic-model");
    expect(restored?.checkedAt).toBe(1000);
  });

  it("restores the cached catalog across a restart (new store, same file)", async () => {
    const { fileSystem, files } = createMemoryFileSystem();
    const path = "C:\\app\\models-catalog-cache.json";
    await createCatalogCacheStore({ path, fileSystem }).write(
      "dynamic-provider",
      entry(),
    );
    expect(files.size).toBeGreaterThan(0);
    const second = createCatalogCacheStore({ path, fileSystem });
    const restored = await second.read("dynamic-provider");
    expect(restored?.models[0]?.id).toBe("dynamic-model");
    expect(restored?.etag).toBe('"abc"');
  });

  it("drops a shape-invalid cached entry and reports it precisely", async () => {
    const { fileSystem, files } = createMemoryFileSystem();
    const path = "C:\\app\\models-catalog-cache.json";
    files.set(
      path,
      JSON.stringify({
        schema: "luckytoken-catalog-cache-v1",
        providers: {
          "good-provider": entry([modelFact({ provider: "good-provider" })]),
          "broken-provider": {
            models: [{ id: "no-facts" }],
            checkedAt: 1,
          },
        },
      }),
    );
    const store = createCatalogCacheStore({ path, fileSystem });
    expect(await store.read("broken-provider")).toBeUndefined();
    expect((await store.read("good-provider"))?.models[0]?.id).toBe(
      "dynamic-model",
    );
    expect(store.takeDroppedReport()).toEqual([
      { providerId: "broken-provider", reason: "invalid_entry" },
    ]);
  });

  it("drops every entry when the cache file is unparseable", async () => {
    const { fileSystem, files } = createMemoryFileSystem();
    const path = "C:\\app\\models-catalog-cache.json";
    files.set(path, "{ not json");
    const store = createCatalogCacheStore({ path, fileSystem });
    expect(await store.read("dynamic-provider")).toBeUndefined();
    expect(store.takeDroppedReport()).toEqual([
      { providerId: "dynamic-provider", reason: "unparseable_file" },
    ]);
  });

  it("rejects a write whose model facts are not validated", async () => {
    const { fileSystem } = createMemoryFileSystem();
    const store = createCatalogCacheStore({
      path: "C:\\app\\models-catalog-cache.json",
      fileSystem,
    });
    await expect(
      store.write("dynamic-provider", {
        models: [{ id: "missing-facts" }] as unknown as readonly Model<Api>[],
        checkedAt: 1,
      }),
    ).rejects.toThrow(/not valid dynamic model facts/u);
  });

  it("rejects a write whose models belong to another provider", async () => {
    const { fileSystem } = createMemoryFileSystem();
    const store = createCatalogCacheStore({
      path: "C:\\app\\models-catalog-cache.json",
      fileSystem,
    });
    await expect(
      store.write("dynamic-provider", entry([modelFact({ provider: "other" })])),
    ).rejects.toThrow(/does not match the cached provider/u);
  });

  it("keeps a failed write from touching the file", async () => {
    const { fileSystem, files } = createMemoryFileSystem();
    const path = "C:\\app\\models-catalog-cache.json";
    const store = createCatalogCacheStore({ path, fileSystem });
    await expect(
      store.write("broken", {
        models: [{ id: "bad" }] as unknown as readonly Model<Api>[],
      }),
    ).rejects.toThrow();
    expect(files.has(path)).toBe(false);
  });

  it("deletes a provider entry", async () => {
    const { fileSystem } = createMemoryFileSystem();
    const path = "C:\\app\\models-catalog-cache.json";
    const store = createCatalogCacheStore({ path, fileSystem });
    await store.write("dynamic-provider", entry());
    await store.delete("dynamic-provider");
    expect(await store.read("dynamic-provider")).toBeUndefined();
    // Other providers survive.
    await store.write("other-provider", entry([modelFact({ provider: "other-provider" })]));
    await store.delete("dynamic-provider");
    expect((await store.read("other-provider"))?.models[0]?.id).toBe(
      "dynamic-model",
    );
  });

  it("returns undefined for an absent cache file without a report", async () => {
    const { fileSystem } = createMemoryFileSystem();
    const store = createCatalogCacheStore({
      path: "C:\\app\\models-catalog-cache.json",
      fileSystem,
    });
    expect(await store.read("dynamic-provider")).toBeUndefined();
    expect(store.takeDroppedReport()).toEqual([]);
  });

  it("reloads the file when it changed on disk", async () => {
    const { fileSystem, files } = createMemoryFileSystem();
    const path = "C:\\app\\models-catalog-cache.json";
    const store = createCatalogCacheStore({ path, fileSystem });
    await store.write("dynamic-provider", entry([modelFact({ id: "v1" })]));
    expect((await store.read("dynamic-provider"))?.models[0]?.id).toBe("v1");
    // Simulate an external edit of the transparent file.
    files.set(
      path,
      JSON.stringify({
        schema: "luckytoken-catalog-cache-v1",
        providers: {
          "dynamic-provider": entry([modelFact({ id: "v2" })]),
        },
      }),
    );
    expect((await store.read("dynamic-provider"))?.models[0]?.id).toBe("v2");
  });

  it("serializes concurrent mutations so no Provider publish is lost", async () => {
    const { fileSystem } = createMemoryFileSystem();
    const path = "C:\\app\\models-catalog-cache.json";
    const store = createCatalogCacheStore({ path, fileSystem });
    // Pi refreshes Providers concurrently: two publishes must not clobber
    // each other's whole-file write.
    const publishA = store.write(
      "dynamic-a",
      entry([modelFact({ provider: "dynamic-a", id: "ma" })]),
    );
    const publishB = store.write(
      "dynamic-b",
      entry([modelFact({ provider: "dynamic-b", id: "mb" })]),
    );
    await Promise.all([publishA, publishB]);
    // Both entries survive a simulated restart (fresh store over the file).
    const restarted = createCatalogCacheStore({ path, fileSystem });
    expect((await restarted.read("dynamic-a"))?.models[0]?.id).toBe("ma");
    expect((await restarted.read("dynamic-b"))?.models[0]?.id).toBe("mb");
  });

  it("serializes concurrent write and delete mutations coherently", async () => {
    const { fileSystem } = createMemoryFileSystem();
    const path = "C:\\app\\models-catalog-cache.json";
    const store = createCatalogCacheStore({ path, fileSystem });
    await store.write(
      "dynamic-a",
      entry([modelFact({ provider: "dynamic-a", id: "ma" })]),
    );
    await Promise.all([
      store.write(
        "dynamic-b",
        entry([modelFact({ provider: "dynamic-b", id: "mb" })]),
      ),
      store.delete("dynamic-a"),
    ]);
    const restarted = createCatalogCacheStore({ path, fileSystem });
    expect(await restarted.read("dynamic-a")).toBeUndefined();
    expect((await restarted.read("dynamic-b"))?.models[0]?.id).toBe("mb");
  });

  it("does not re-report the same dropped entries for an unchanged file", async () => {
    const { fileSystem, files } = createMemoryFileSystem();
    const path = "C:\\app\\models-catalog-cache.json";
    files.set(
      path,
      JSON.stringify({
        schema: "luckytoken-catalog-cache-v1",
        providers: {
          "broken-provider": {
            models: [{ id: "no-facts" }],
            checkedAt: 1,
          },
        },
      }),
    );
    const store = createCatalogCacheStore({ path, fileSystem });
    expect(await store.read("broken-provider")).toBeUndefined();
    expect(store.takeDroppedReport()).toEqual([
      { providerId: "broken-provider", reason: "invalid_entry" },
    ]);
    // Repeated restore reads over the unchanged file never re-report.
    expect(await store.read("broken-provider")).toBeUndefined();
    expect(store.takeDroppedReport()).toEqual([]);
    expect(store.takeDroppedReport()).toEqual([]);
  });
});
