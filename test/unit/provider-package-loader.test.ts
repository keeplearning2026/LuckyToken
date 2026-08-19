import { createModels } from "@earendil-works/pi-ai";
import { providerPackage as commandCodeProviderPackage } from "@luckytoken/provider-commandcode-private";
import { describe, expect, it, vi } from "vitest";

import { loadProviderPackages } from "../../src/providers/package-loader.js";

describe("Provider Package loader", () => {
  it("loads and registers a configured package through one seam", async () => {
    const models = createModels();

    const result = await loadProviderPackages({
      models,
      providerPackages: Object.freeze({ "@fixture/commandcode": {} }),
      host: {
        fetch: async () => new Response(null, { status: 500 }),
        now: () => 1,
        createUuid: () => "00000000-0000-4000-8000-000000000002",
      },
      importModule: async () => ({
        providerPackage: commandCodeProviderPackage,
      }),
    });

    expect(result.providerIds).toEqual(["commandcode-private"]);
    expect(models.getProvider("commandcode-private")?.id).toBe(
      "commandcode-private",
    );
  });

  it("rejects a Provider Package whose Provider ID exceeds the external namespace limit", async () => {
    const models = createModels();
    const longProviderId = "p".repeat(65);

    await expect(
      loadProviderPackages({
        models,
        providerPackages: Object.freeze({ "@fixture/long-provider-id": {} }),
        host: {
          fetch: async () => new Response(null, { status: 500 }),
          now: () => 1,
          createUuid: () => "00000000-0000-4000-8000-000000000009",
        },
        importModule: async () => ({
          providerPackage: {
            contractVersion: 1 as const,
            createProvider: async (
              input: Parameters<typeof commandCodeProviderPackage.createProvider>[0],
            ) => ({
              ...commandCodeProviderPackage.createProvider(input),
              id: longProviderId,
            }),
          },
        }),
      }),
    ).rejects.toThrow("safe Provider ID");
    expect(models.getProvider(longProviderId)).toBeUndefined();
  });

  it("does not partially register when a staged Provider ID conflicts", async () => {
    const models = createModels();

    await expect(
      loadProviderPackages({
        models,
        providerPackages: Object.freeze({
          "@fixture/first": {},
          "@fixture/second": {},
        }),
        host: {
          fetch: async () => new Response(null, { status: 500 }),
          now: () => 1,
          createUuid: () => "00000000-0000-4000-8000-000000000003",
        },
        importModule: async () => ({
          providerPackage: commandCodeProviderPackage,
        }),
      }),
    ).rejects.toThrow("Provider ID conflicts");
    expect(models.getProvider("commandcode-private")).toBeUndefined();
  });

  it.each([
    "../fixture",
    "./fixture",
    "C:/fixture",
    "file:///fixture",
    "node:fs",
    "fs",
    "@fixture/package/subpath",
  ])("rejects a non-package-root specifier before import: %s", async (specifier) => {
    const importModule = vi.fn();

    await expect(
      loadProviderPackages({
        models: createModels(),
        providerPackages: { [specifier]: {} },
        host: {
          fetch: async () => new Response(),
          now: () => 1,
          createUuid: () => "00000000-0000-4000-8000-000000000004",
        },
        importModule,
      }),
    ).rejects.toThrow("npm root package name");
    expect(importModule).not.toHaveBeenCalled();
  });

  it("reports a missing fixed providerPackage export", async () => {
    await expect(
      loadProviderPackages({
        models: createModels(),
        providerPackages: { "@fixture/missing-export": {} },
        host: {
          fetch: async () => new Response(),
          now: () => 1,
          createUuid: () => "00000000-0000-4000-8000-000000000005",
        },
        importModule: async () => ({}),
      }),
    ).rejects.toThrow("must export providerPackage");
  });

  it("rejects a mismatched package contract version", async () => {
    await expect(
      loadProviderPackages({
        models: createModels(),
        providerPackages: { "@fixture/version-mismatch": {} },
        host: {
          fetch: async () => new Response(),
          now: () => 1,
          createUuid: () => "00000000-0000-4000-8000-000000000006",
        },
        importModule: async () => ({
          providerPackage: {
            contractVersion: 2,
            createProvider: () => commandCodeProviderPackage.createProvider,
          },
        }),
      }),
    ).rejects.toThrow("contractVersion must be 1");
  });

  it.each([
    [
      "synchronous",
      () => {
        throw new Error("sync factory failure");
      },
    ],
    [
      "asynchronous",
      async () => {
        await Promise.resolve();
        throw new Error("async factory failure");
      },
    ],
  ])(
    "keeps registration atomic when a %s factory fails",
    async (_failureKind, failingFactory) => {
      const models = createModels();

      await expect(
        loadProviderPackages({
          models,
          providerPackages: {
            "@fixture/valid": {},
            "@fixture/failing": {},
          },
          host: {
            fetch: async () => new Response(),
            now: () => 1,
            createUuid: () => "00000000-0000-4000-8000-000000000007",
          },
          importModule: async (specifier) => ({
            providerPackage:
              specifier === "@fixture/valid"
                ? commandCodeProviderPackage
                : { contractVersion: 1, createProvider: failingFactory },
          }),
        }),
      ).rejects.toThrow("factory failure");
      expect(models.getProvider("commandcode-private")).toBeUndefined();
    },
  );
});
