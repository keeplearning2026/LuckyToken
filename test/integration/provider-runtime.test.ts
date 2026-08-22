import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bundledProviderIds,
  bundledProviderPackages,
} from "../../src/providers/bundled.js";
import {
  assertUserProviderPackages,
  createProviderRuntime,
} from "../../src/providers/runtime.js";
import {
  COMMANDCODE_GOAT_PROVIDER_PACKAGE,
  COMMANDCODE_PROVIDER_PACKAGE,
  commandCodeProviderImportModule,
} from "../support/commandcode-provider-package.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{ modelsJsonPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "luckytoken-provider-runtime-"));
  roots.push(root);
  return { modelsJsonPath: join(root, "models.json") };
}

/**
 * Provider Activation Spec §23.1: Provider Runtime contract tests.
 * P1 — Pi built-in discovery; P2 — bundled CommandCode discovery; P3 —
 * source classification; P4 — reserved bundled identities.
 */
describe("Provider Runtime composition", () => {
  it("P1: exposes the exact pinned Pi built-in Provider set with no user configuration", async () => {
    const { modelsJsonPath } = await fixture();
    const runtime = await createProviderRuntime({
      piDirectory: join(await mkdtemp(join(tmpdir(), "pi-")), "pi"),
      modelsJsonPath,
      userProviderPackages: {},
      fetch: vi.fn(async () => new Response()),
      credentials: new InMemoryCredentialStore(),
      importModule: commandCodeProviderImportModule(),
      now: () => 1,
      createUuid: () => "00000000-0000-4000-8000-000000000001",
    });
    const actualIds = new Set(
      runtime.models.getProviders().map((provider) => provider.id),
    );
    const expectedIds = new Set(builtinProviders().map((provider) => provider.id));
    for (const id of expectedIds) expect(actualIds.has(id)).toBe(true);
    for (const id of actualIds) {
      if (!bundledProviderIds.has(id)) {
        expect(expectedIds.has(id)).toBe(true);
      }
    }
  });

  it("P2: discovers both bundled CommandCode Providers without user configuration", async () => {
    const { modelsJsonPath } = await fixture();
    const runtime = await createProviderRuntime({
      piDirectory: join(await mkdtemp(join(tmpdir(), "pi-")), "pi"),
      modelsJsonPath,
      userProviderPackages: {},
      fetch: vi.fn(async () => new Response()),
      credentials: new InMemoryCredentialStore(),
      importModule: commandCodeProviderImportModule(),
      now: () => 1,
      createUuid: () => "00000000-0000-4000-8000-000000000002",
    });
    const commandCode = runtime.models.getProvider("commandcode-private");
    expect(commandCode).toBeDefined();
    expect(commandCode?.name).toBe("CommandCode Private");
    expect(runtime.providerSource("commandcode-private")).toBe(
      "luckytoken_bundled",
    );
    expect(runtime.models.getModels("commandcode-private").length).toBeGreaterThan(0);
    const goat = runtime.models.getProvider("commandcode-goat");
    expect(goat).toBeDefined();
    expect(goat?.name).toBe("CommandCode Goat");
    expect(runtime.providerSource("commandcode-goat")).toBe(
      "luckytoken_bundled",
    );
    expect(runtime.models.getModels("commandcode-goat")).toHaveLength(33);
  });

  it("P3: classifies Pi builtin, bundled, custom models.json, external package and builtin overlay sources", async () => {
    const { modelsJsonPath } = await fixture();
    // A custom models.json Provider plus an overlay of a Pi built-in.
    await writeFile(
      modelsJsonPath,
      JSON.stringify({
        providers: {
          "my-custom": {
            baseUrl: "https://gateway.example.com",
            api: "anthropic-messages",
            models: [{ id: "claude-sonnet" }],
          },
          anthropic: {
            api: "anthropic-messages",
            models: [{ id: "claude-sonnet" }],
          },
        },
      }),
      "utf8",
    );
    const runtime = await createProviderRuntime({
      piDirectory: join(await mkdtemp(join(tmpdir(), "pi-")), "pi"),
      modelsJsonPath,
      userProviderPackages: {},
      fetch: vi.fn(async () => new Response()),
      credentials: new InMemoryCredentialStore(),
      importModule: commandCodeProviderImportModule(),
      now: () => 1,
      createUuid: () => "00000000-0000-4000-8000-000000000003",
    });
    expect(runtime.providerSource("commandcode-private")).toBe(
      "luckytoken_bundled",
    );
    // The first Pi builtin (e.g. openai or anthropic) is pi_builtin.
    const piId = builtinProviders()[0]?.id;
    expect(piId).toBeDefined();
    expect(runtime.providerSource(piId!)).toBe("pi_builtin");
    // The models.json overlay of a Pi built-in stays pi_builtin.
    expect(runtime.providerSource("anthropic")).toBe("pi_builtin");
    // A custom models.json Provider is user.
    expect(runtime.providerSource("my-custom")).toBe("user");
  });

  it("P3b: an external user Provider Package is classified user", async () => {
    const { modelsJsonPath } = await fixture();
    const importBundledProvider = commandCodeProviderImportModule();
    const runtime = await createProviderRuntime({
      piDirectory: join(await mkdtemp(join(tmpdir(), "pi-")), "pi"),
      modelsJsonPath,
      userProviderPackages: {
        "@user/test-provider": { token: "abc" },
      },
      fetch: vi.fn(async () => new Response()),
      credentials: new InMemoryCredentialStore(),
      importModule: async (specifier) => {
        if (
          specifier === COMMANDCODE_PROVIDER_PACKAGE ||
          specifier === COMMANDCODE_GOAT_PROVIDER_PACKAGE
        ) {
          return (await importBundledProvider(specifier)) as object;
        }
        if (specifier === "@user/test-provider") {
          return {
            providerPackage: {
              contractVersion: 1,
              createProvider() {
                return {
                  id: "user-package-provider",
                  name: "User Package Provider",
                  models: [],
                  auth: {},
                  getModels: () => [],
                  stream: async function* stream() {},
                  streamSimple: async function* streamSimple() {},
                };
              },
            },
          };
        }
        throw new Error(`Unexpected specifier: ${specifier}`);
      },
      now: () => 1,
      createUuid: () => "00000000-0000-4000-8000-000000000004",
    });
    expect(runtime.providerSource("user-package-provider")).toBe("user");
    expect(runtime.models.getProvider("user-package-provider")).toBeDefined();
  });

  it.each([
    COMMANDCODE_PROVIDER_PACKAGE,
    COMMANDCODE_GOAT_PROVIDER_PACKAGE,
  ])("P4: rejects user configuration claiming bundled package %s", (specifier) => {
    expect(() =>
      assertUserProviderPackages({
        [specifier]: {},
      }),
    ).toThrow(/bundled product Provider/);
    expect(bundledProviderPackages.length).toBeGreaterThan(0);
    expect(bundledProviderIds.has("commandcode-private")).toBe(true);
    expect(bundledProviderIds.has("commandcode-goat")).toBe(true);
  });

  it("keeps Private and Goat credentials in independent Pi Provider slots", async () => {
    const { modelsJsonPath } = await fixture();
    const credentials = new InMemoryCredentialStore();
    const runtime = await createProviderRuntime({
      piDirectory: join(await mkdtemp(join(tmpdir(), "pi-")), "pi"),
      modelsJsonPath,
      userProviderPackages: {},
      fetch: vi.fn(async () => new Response()),
      credentials,
      importModule: commandCodeProviderImportModule(),
      now: () => 1,
      createUuid: () => "00000000-0000-4000-8000-000000000010",
    });
    await credentials.modify("commandcode-private", async () => ({
      type: "api_key",
      key: "private-key",
    }));

    expect(
      (await runtime.models.getAuth("commandcode-private"))?.auth.apiKey,
    ).toBe("private-key");
    await expect(runtime.models.getAuth("commandcode-goat")).resolves.toBeUndefined();

    await credentials.modify("commandcode-goat", async () => ({
      type: "api_key",
      key: "goat-key",
    }));
    expect((await runtime.models.getAuth("commandcode-goat"))?.auth.apiKey).toBe(
      "goat-key",
    );
    expect(
      (await runtime.models.getAuth("commandcode-private"))?.auth.apiKey,
    ).toBe("private-key");
  });

  it("P4b: rejects a user models.json Provider claiming the reserved bundled Provider ID", async () => {
    const { modelsJsonPath } = await fixture();
    await writeFile(
      modelsJsonPath,
      JSON.stringify({
        providers: {
          "commandcode-private": {
            baseUrl: "https://gateway.example.com",
            api: "anthropic-messages",
            models: [{ id: "shadowed-model" }],
          },
        },
      }),
      "utf8",
    );
    await expect(
      createProviderRuntime({
        piDirectory: join(await mkdtemp(join(tmpdir(), "pi-")), "pi"),
        modelsJsonPath,
        userProviderPackages: {},
        fetch: vi.fn(async () => new Response()),
        credentials: new InMemoryCredentialStore(),
        importModule: commandCodeProviderImportModule(),
        now: () => 1,
        createUuid: () => "00000000-0000-4000-8000-000000000006",
      }),
    ).rejects.toThrow(/bundled product Provider/);
  });

  it("models.json edits do not change the Provider Runtime until a new Backend startup", async () => {
    const { modelsJsonPath } = await fixture();
    await writeFile(
      modelsJsonPath,
      JSON.stringify({
        providers: {
          "first-custom": {
            baseUrl: "https://gateway.example.com",
            api: "anthropic-messages",
            models: [{ id: "model-1" }],
          },
        },
      }),
      "utf8",
    );
    const runtime = await createProviderRuntime({
      piDirectory: join(await mkdtemp(join(tmpdir(), "pi-")), "pi"),
      modelsJsonPath,
      userProviderPackages: {},
      fetch: vi.fn(async () => new Response()),
      credentials: new InMemoryCredentialStore(),
      importModule: commandCodeProviderImportModule(),
      now: () => 1,
      createUuid: () => "00000000-0000-4000-8000-000000000005",
    });
    expect(runtime.providerSource("first-custom")).toBe("user");
    expect(runtime.models.getProvider("first-custom")).toBeDefined();

    // The file can change while this Backend is running, but Provider
    // composition is startup-only.
    await writeFile(
      modelsJsonPath,
      JSON.stringify({
        providers: {
          "second-custom": {
            baseUrl: "https://gateway.example.com",
            api: "anthropic-messages",
            models: [{ id: "model-2" }],
          },
        },
      }),
      "utf8",
    );
    runtime.catalog.capture();

    expect(runtime.models.getProvider("second-custom")).toBeUndefined();
    expect(runtime.models.getProvider("first-custom")).toBeDefined();
    expect(runtime.providerSource("first-custom")).toBe("user");
    expect(runtime.catalog.models.getModels("second-custom").length).toBe(0);
  });

  it("models.json API-key edits do not hot-apply to later requests in the same Backend", async () => {
    const { modelsJsonPath } = await fixture();
    await writeFile(
      modelsJsonPath,
      JSON.stringify({
        providers: {
          "keyed-custom": {
            baseUrl: "https://gateway.example.com",
            api: "anthropic-messages",
            apiKey: "initial-key",
            models: [{ id: "model-1" }],
          },
        },
      }),
      "utf8",
    );
    const runtime = await createProviderRuntime({
      piDirectory: join(await mkdtemp(join(tmpdir(), "pi-")), "pi"),
      modelsJsonPath,
      userProviderPackages: {},
      fetch: vi.fn(async () => new Response()),
      credentials: new InMemoryCredentialStore(),
      importModule: commandCodeProviderImportModule(),
      now: () => 1,
      createUuid: () => "00000000-0000-4000-8000-000000000007",
    });
    const model = runtime.models.getModel("keyed-custom", "model-1");
    expect(model).toBeDefined();

    // Request A resolves its auth at generation N (the pinned per-request
    // auth resolution reads models.json facts at resolve time).
    const requestA = await runtime.models.getAuth(model!);
    expect(requestA?.auth.apiKey).toBe("initial-key");

    // Changing the file does not mutate the fixed request-composition facts.
    await writeFile(
      modelsJsonPath,
      JSON.stringify({
        providers: {
          "keyed-custom": {
            baseUrl: "https://gateway.example.com",
            api: "anthropic-messages",
            apiKey: "rotated-key",
            models: [{ id: "model-1" }],
          },
        },
      }),
      "utf8",
    );
    runtime.catalog.capture();

    expect(requestA?.auth.apiKey).toBe("initial-key");
    const requestB = await runtime.models.getAuth(model!);
    expect(requestB?.auth.apiKey).toBe("initial-key");
  });

  it("removing models.json does not remove startup auth facts from the running Backend", async () => {
    const { modelsJsonPath } = await fixture();
    await writeFile(
      modelsJsonPath,
      JSON.stringify({
        providers: {
          "keyed-custom": {
            baseUrl: "https://gateway.example.com",
            api: "anthropic-messages",
            apiKey: "initial-key",
            models: [{ id: "model-1" }],
          },
        },
      }),
      "utf8",
    );
    const runtime = await createProviderRuntime({
      piDirectory: join(await mkdtemp(join(tmpdir(), "pi-")), "pi"),
      modelsJsonPath,
      userProviderPackages: {},
      fetch: vi.fn(async () => new Response()),
      credentials: new InMemoryCredentialStore(),
      importModule: commandCodeProviderImportModule(),
      now: () => 1,
      createUuid: () => "00000000-0000-4000-8000-000000000008",
    });
    const model = runtime.models.getModel("keyed-custom", "model-1");
    expect(model).toBeDefined();
    expect((await runtime.models.getAuth(model!))?.auth.apiKey).toBe(
      "initial-key",
    );

    await rm(modelsJsonPath, { force: true });
    runtime.catalog.capture();

    const authAfter = await runtime.models.getAuth(model!);
    expect(authAfter?.auth.apiKey).toBe("initial-key");
  });

  it("an invalid replacement models.json cannot disturb the already composed runtime", async () => {
    const { modelsJsonPath } = await fixture();
    await writeFile(
      modelsJsonPath,
      JSON.stringify({
        providers: {
          "keyed-custom": {
            baseUrl: "https://gateway.example.com",
            api: "anthropic-messages",
            apiKey: "generation-n-key",
            models: [{ id: "model-1" }],
          },
        },
      }),
      "utf8",
    );
    const runtime = await createProviderRuntime({
      piDirectory: join(await mkdtemp(join(tmpdir(), "pi-")), "pi"),
      modelsJsonPath,
      userProviderPackages: {},
      fetch: vi.fn(async () => new Response()),
      credentials: new InMemoryCredentialStore(),
      importModule: commandCodeProviderImportModule(),
      now: () => 1,
      createUuid: () => "00000000-0000-4000-8000-000000000009",
    });
    const model = runtime.models.getModel("keyed-custom", "model-1");
    expect(model).toBeDefined();
    expect((await runtime.models.getAuth(model!))?.auth.apiKey).toBe(
      "generation-n-key",
    );

    // A replacement file may even be invalid for a future startup; it is
    // not interpreted by this already-running Provider Runtime.
    await writeFile(
      modelsJsonPath,
      JSON.stringify({
        providers: {
          "commandcode-private": {
            baseUrl: "https://gateway.example.com",
            api: "anthropic-messages",
            apiKey: "shadow-key",
            models: [{ id: "shadowed" }],
          },
        },
      }),
      "utf8",
    );
    runtime.catalog.capture();

    // Startup generation remains fully authoritative.
    expect(runtime.models.getProvider("keyed-custom")).toBeDefined();
    expect(runtime.providerSource("keyed-custom")).toBe("user");
    expect((await runtime.models.getAuth(model!))?.auth.apiKey).toBe(
      "generation-n-key",
    );
  });
});
