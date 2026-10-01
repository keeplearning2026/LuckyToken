import type { Model } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
  COMMANDCODE_MODEL_CATALOG_SCHEMA,
  DEFAULT_COMMANDCODE_MODEL_CATALOG,
  loadCommandCodeModelCatalog,
} from "@token/commandcode-model-catalog";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexNativeCatalogSource } from "../../src/integrations/codex/native-catalog-source.js";
import { createCodexIntegrationAuthority } from "../../src/integrations/codex/integration.js";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createBundledProviderConfigurations } from "../../src/providers/bundled-configuration.js";
import {
  bundledProviderIds,
  bundledProviderPackages,
  bundledProviderSpecifiers,
} from "../../src/providers/bundled.js";
import {
  assertUserProviderPackages,
  createProviderRuntime as createRawProviderRuntime,
  type CreateProviderRuntimeOptions,
} from "../../src/providers/runtime.js";
import {
  COMMANDCODE_GOAT_PROVIDER_PACKAGE,
  COMMANDCODE_PROVIDER_PACKAGE,
} from "../support/commandcode-provider-package.js";
import { bundledProviderImportModule } from "../support/bundled-provider-packages.js";
import { DEEPSEEK_RESPONSE_PROVIDER_PACKAGE } from "../support/deepseek-response-provider-package.js";

const roots: string[] = [];

function createProviderRuntime(
  options: Omit<CreateProviderRuntimeOptions, "bundledProviderConfigurations"> & {
    readonly bundledProviderConfigurations?: Readonly<Record<string, unknown>>;
  },
): ReturnType<typeof createRawProviderRuntime> {
  return createRawProviderRuntime({
    ...options,
    bundledProviderConfigurations:
      options.bundledProviderConfigurations ??
      createBundledProviderConfigurations(DEFAULT_COMMANDCODE_MODEL_CATALOG),
  });
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{ modelsJsonPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "Token-provider-runtime-"));
  roots.push(root);
  return { modelsJsonPath: join(root, "models.json") };
}

async function getBoundModelAuth(runtime: Awaited<ReturnType<typeof createProviderRuntime>>, model: Model<string>) {
  const capture = await runtime.providerAuthBindings.capture(model.provider);
  return runtime.providerAuthBindings.runBound(capture, () =>
    runtime.models.getAuth(model),
  );
}

/**
 * Provider Activation Spec §23.1: Provider Runtime contract tests.
 * P1 — Pi built-in discovery; P2 — bundled CommandCode discovery; P3 —
 * source classification; P4 — reserved bundled identities.
 */
describe("Provider Runtime composition", () => {
  it("commits injection and served overlay from one zero-TTL acquisition", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-shared-acquisition-"));
    roots.push(root);
    await writeFile(join(root, "config.toml"), 'model = "gpt-native"\n');
    let acquisitions = 0;
    const source = createCodexNativeCatalogSource({ codexHome: root, ttlMs: 0, discoverCommands: async () => ["fixture"],
      runVersion: async () => "codex-cli 0.159.2", runBundledCatalog: async () => JSON.stringify({ models: [
        { slug: `gpt-99-${++acquisitions}-fixture`, display_name: "Listable", visibility: "list", supported_in_api: true },
        { slug: `hidden-${acquisitions}`, display_name: "Hidden", visibility: "hide", supported_in_api: false },
      ] }) });
    const snapshot = await source.load();
    const integration = createCodexIntegrationAuthority({ codexHome: root, stateDirectory: join(root, "integration"),
      endpoint: () => "http://127.0.0.1:3000/v1", nativeCatalog: source,
      buildCatalog: async (native) => ({ content: JSON.stringify({ models: [...native, { slug: "token/fixture" }] }),
        modelCount: native.length + 1, injectedModelCount: 1, warnings: [] }),
      validateCatalog: async (_content, selected) => { expect(selected?.command).toBe(snapshot.runtimeIdentity?.command); } });
    await source.withSnapshot(snapshot, async () => {
      const runtime = await createProviderRuntime({ piDirectory: root, codexHome: root, modelsJsonPath: join(root, "models.json"),
        nativeCatalogSource: source, userProviderPackages: {}, fetch: async () => { throw new Error("No network"); }, importModule: bundledProviderImportModule() });
      expect((await integration.reconcile("enable")).observedState).toBe("managed");
      source.invalidate();
      await runtime.automaticModelOverlay.refresh(snapshot);
      const projection = await integration.query();
      const injected = JSON.parse(await readFile(projection.catalogPath, "utf8")) as { models: { slug: string }[] };
      expect(injected.models.map((model) => model.slug)).toEqual([...snapshot.entries.map((model) => model.slug), "token/fixture"]);
      expect(runtime.models.getModels("openai-codex").filter((model) => model.id.endsWith("-fixture")).map((model) => model.id)).toEqual([snapshot.entries[0]!.slug]);
      expect(integration.directModels.has(snapshot.entries[1]!.slug)).toBe(true);
      expect(acquisitions).toBe(1);
    });
  });
  it("publishes bounded conservative-overlay warnings once per generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-overlay-warning-"));
    roots.push(root);
    const source = createCodexNativeCatalogSource({ codexHome: root, discoverCommands: async () => ["fixture"],
      runVersion: async () => "codex-cli 0.159.2", runBundledCatalog: async () => JSON.stringify({ models: [
        { slug: "gpt-99-fixture", display_name: "Future", visibility: "list", supported_in_api: true },
      ] }) });
    const warnings: string[][] = [];
    const runtime = await createProviderRuntime({ piDirectory: root, codexHome: root, modelsJsonPath: join(root, "models.json"),
      nativeCatalogSource: source, userProviderPackages: {}, fetch: async () => { throw new Error("No network"); }, importModule: bundledProviderImportModule(),
      onAutomaticModelOverlayWarnings: (batch) => { warnings.push([...batch]); } });
    expect(warnings.flat().some((warning) => warning.includes("conservative"))).toBe(true);
    await runtime.automaticModelOverlay.refresh();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.every((warning) => warning.length <= 512)).toBe(true);
  });
  it("publishes the supplied native snapshot without reacquiring it", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-overlay-acquisition-"));
    roots.push(root);
    let acquisition = 0;
    const source = createCodexNativeCatalogSource({ codexHome: root, discoverCommands: async () => ["fixture"],
      runVersion: async () => "codex-cli 0.159.2", runBundledCatalog: async () => JSON.stringify({ models: [
        { slug: `gpt-6.${++acquisition}-fixture`, display_name: "Native fixture", visibility: "list", supported_in_api: true },
      ] }) });
    const runtime = await createProviderRuntime({ piDirectory: root, codexHome: root, modelsJsonPath: join(root, "models.json"),
      nativeCatalogSource: source, userProviderPackages: {}, fetch: async () => { throw new Error("No network"); }, importModule: bundledProviderImportModule() });
    const snapshot = await source.load();
    await runtime.automaticModelOverlay.refresh(snapshot);
    expect(runtime.models.getModels("openai-codex").filter((model) => model.id.endsWith("-fixture")).map((model) => model.id)).toEqual([snapshot.entries[0]!.slug]);
    expect(acquisition).toBe(2);
  });
  it("keeps Radius dynamic models after a Codex overlay refresh", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-overlay-radius-"));
    roots.push(root);
    const modelsJsonPath = join(root, "models.json");
    await writeFile(modelsJsonPath, JSON.stringify({ providers: { radius: { oauth: "radius", baseUrl: "https://radius.invalid/v1" } } }));
    const source = createCodexNativeCatalogSource({ codexHome: root, discoverCommands: async () => ["fixture"],
      runVersion: async () => "codex-cli 0.159.2", runBundledCatalog: async () => JSON.stringify({ models: [] }) });
    const runtime = await createProviderRuntime({ piDirectory: root, codexHome: root, modelsJsonPath,
      nativeCatalogSource: source, userProviderPackages: {}, fetch: async () => { throw new Error("No network"); }, importModule: bundledProviderImportModule() });
    const dynamic: Model<"pi-messages"> = { id: "dynamic", provider: "radius", api: "pi-messages", name: "Dynamic", baseUrl: "https://radius.invalid/v1",
      reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 1024 };
    await runtime.catalog.restoreProvider("radius", { models: [dynamic], checkedAt: 1 });
    runtime.catalog.capture();
    expect(runtime.models.getModels("radius").map((model) => model.id)).toEqual(["dynamic"]);
    await runtime.automaticModelOverlay.refresh();
    expect(runtime.models.getModels("radius").map((model) => model.id)).toEqual(["dynamic"]);
  });
  it("injects only the Profile Store into the one Backend-lifetime Models collection", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-profile-runtime-"));
    roots.push(root);
    const piDirectory = join(root, "pi");
    const legacyAuthPath = join(piDirectory, "auth.json");
    await mkdir(piDirectory, { recursive: true });
    await writeFile(legacyAuthPath, JSON.stringify({
      anthropic: { type: "api_key", key: "legacy-secret-must-stay-ignored" },
    }), "utf8");
    let nextId = 0;
    const runtime = await createProviderRuntime({
      piDirectory,
      modelsJsonPath: join(root, "models.json"),
      userProviderPackages: {},
      fetch: vi.fn(async () => new Response()),
      authContext: { env: async () => undefined, fileExists: async () => false },
      importModule: bundledProviderImportModule(),
      now: () => 1,
      createUuid: () => `runtime-id-${++nextId}`,
    });
    const modelsIdentity = runtime.models;
    const modelIdentity = runtime.models.getModels("anthropic")[0];
    const login = await runtime.providerAuthBindings.createLoginBinding({
      providerId: "anthropic",
      authType: "api_key",
      displayName: "Production",
      useNow: false,
      expectedRevision: "absent",
    });
    await runtime.providerAuthBindings.runBound(login, () =>
      runtime.models.login("anthropic", "api_key", {
        prompt: async () => "managed-runtime-secret",
        notify: () => {},
      }),
    );
    await runtime.credentialManagement.query();
    const capture = await runtime.providerAuthBindings.capture("anthropic");
    const resolved = await runtime.providerAuthBindings.runBound(capture, () =>
      runtime.models.getAuth("anthropic"),
    );

    expect(resolved?.auth.apiKey).toBe("managed-runtime-secret");
    expect(runtime.models).toBe(modelsIdentity);
    expect(runtime.models.getModels("anthropic")[0]).toBe(modelIdentity);
    expect(runtime.credentialManagement.snapshot().providers.find(
      (provider) => provider.providerId === "anthropic",
    )?.profiles[0])
      .toMatchObject({ displayName: "Production" });
    expect(await readFile(legacyAuthPath, "utf8")).toContain(
      "legacy-secret-must-stay-ignored",
    );
    expect("credentialAuthority" in runtime).toBe(false);
    expect("credentialStore" in runtime.credentialManagement).toBe(false);
    expect("credentialStore" in runtime.providerAuthBindings).toBe(false);
  });

  it("P1: exposes the exact pinned Pi built-in Provider set with no user configuration", async () => {
    const { modelsJsonPath } = await fixture();
    const runtime = await createProviderRuntime({
      piDirectory: join(await mkdtemp(join(tmpdir(), "pi-")), "pi"),
      modelsJsonPath,
      userProviderPackages: {},
      fetch: vi.fn(async () => new Response()),
      importModule: bundledProviderImportModule(),
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

  it("loads one startup CommandCode catalog snapshot into both bundled Providers", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-commandcode-runtime-"));
    roots.push(root);
    const modelsJsonPath = join(root, "models.json");
    const commandCodeModelsPath = join(root, "commandcode-models.json");
    await writeFile(
      commandCodeModelsPath,
      JSON.stringify({
        schema: COMMANDCODE_MODEL_CATALOG_SCHEMA,
        models: [
          {
            id: "runtime-responses",
            name: "Runtime Responses",
            description: "runtime catalog responses fixture",
            supportedEndpoints: ["/chat/completions", "/responses"],
            endpoint: "/responses",
            input: ["text"],
            reasoning: false,
            contextWindow: 100000,
            minimumPlan: "go",
          },
          {
            id: "runtime-messages",
            name: "Runtime Messages",
            description: "runtime catalog messages fixture",
            supportedEndpoints: ["/messages"],
            endpoint: "/messages",
            input: ["text"],
            reasoning: false,
            contextWindow: 100000,
            minimumPlan: "pro",
          },
        ],
      }),
      "utf8",
    );

    const commandCodeCatalog = await loadCommandCodeModelCatalog(
      commandCodeModelsPath,
    );
    const runtime = await createProviderRuntime({
      piDirectory: join(root, "pi"),
      modelsJsonPath,
      bundledProviderConfigurations: createBundledProviderConfigurations(
        commandCodeCatalog.catalog,
      ),
      userProviderPackages: {},
      fetch: vi.fn(async () => new Response()),
      importModule: bundledProviderImportModule(),
      now: () => 1,
      createUuid: () => "00000000-0000-4000-8000-000000000099",
    });

    expect(
      runtime.models
        .getModels("commandcode-private")
        .map(({ id, api }) => ({ id, api })),
    ).toEqual([
      { id: "runtime-responses", api: "commandcode-private" },
      { id: "runtime-messages", api: "commandcode-private" },
    ]);
    expect(
      runtime.models
        .getModels("commandcode-goat")
        .map(({ id, api }) => ({ id, api })),
    ).toEqual([
      { id: "runtime-responses", api: "openai-responses" },
    ]);
  });

  it("uses the bundled CommandCode snapshot without filesystem I/O when no catalog path is supplied", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-commandcode-default-"));
    roots.push(root);
    const modelsJsonPath = join(root, "models.json");

    const runtime = await createProviderRuntime({
      piDirectory: join(root, "pi"),
      modelsJsonPath,
      userProviderPackages: {},
      fetch: vi.fn(async () => new Response()),
      importModule: bundledProviderImportModule(),
      now: () => 1,
      createUuid: () => "00000000-0000-4000-8000-000000000098",
    });

    expect(runtime.models.getModels("commandcode-private").length).toBeGreaterThan(0);
    await expect(readFile(join(root, "commandcode-models.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("P2: discovers both bundled CommandCode Providers without user configuration", async () => {
    const { modelsJsonPath } = await fixture();
    const runtime = await createProviderRuntime({
      piDirectory: join(await mkdtemp(join(tmpdir(), "pi-")), "pi"),
      modelsJsonPath,
      userProviderPackages: {},
      fetch: vi.fn(async () => new Response()),
      importModule: bundledProviderImportModule(),
      now: () => 1,
      createUuid: () => "00000000-0000-4000-8000-000000000002",
    });
    const commandCode = runtime.models.getProvider("commandcode-private");
    expect(commandCode).toBeDefined();
    expect(commandCode?.name).toBe("CommandCode Private");
    expect(runtime.providerSource("commandcode-private")).toBe(
      "token_bundled",
    );
    expect(runtime.models.getModels("commandcode-private").length).toBeGreaterThan(0);
    const goat = runtime.models.getProvider("commandcode-goat");
    expect(goat).toBeDefined();
    expect(goat?.name).toBe("CommandCode Goat");
    expect(runtime.providerSource("commandcode-goat")).toBe(
      "token_bundled",
    );
    expect(runtime.models.getModels("commandcode-goat")).toHaveLength(39);
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
      importModule: bundledProviderImportModule(),
      now: () => 1,
      createUuid: () => "00000000-0000-4000-8000-000000000003",
    });
    expect(runtime.providerSource("commandcode-private")).toBe(
      "token_bundled",
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
    const importBundledProvider = bundledProviderImportModule();
    const runtime = await createProviderRuntime({
      piDirectory: join(await mkdtemp(join(tmpdir(), "pi-")), "pi"),
      modelsJsonPath,
      userProviderPackages: {
        "@user/test-provider": { token: "abc" },
      },
      fetch: vi.fn(async () => new Response()),
      importModule: async (specifier) => {
        if (bundledProviderSpecifiers.has(specifier)) {
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
    DEEPSEEK_RESPONSE_PROVIDER_PACKAGE,
  ])("P4: rejects user configuration claiming bundled package %s", (specifier) => {
    expect(() =>
      assertUserProviderPackages({
        [specifier]: {},
      }),
    ).toThrow(/bundled product Provider/);
    expect(bundledProviderPackages.length).toBeGreaterThan(0);
    expect(bundledProviderIds.has("commandcode-private")).toBe(true);
    expect(bundledProviderIds.has("commandcode-goat")).toBe(true);
    expect(bundledProviderIds.has("deepseek-response")).toBe(true);
  });

  it("keeps Private and Goat credentials in independent Pi Provider slots", async () => {
    const { modelsJsonPath } = await fixture();
    const runtime = await createProviderRuntime({
      piDirectory: join(await mkdtemp(join(tmpdir(), "pi-")), "pi"),
      modelsJsonPath,
      userProviderPackages: {},
      fetch: vi.fn(async () => new Response()),
      importModule: bundledProviderImportModule(),
      now: () => 1,
      createUuid: () => "00000000-0000-4000-8000-000000000010",
    });
    const add = async (providerId: string, displayName: string, key: string) => {
      const binding = await runtime.providerAuthBindings.createLoginBinding({
        providerId,
        authType: "api_key",
        displayName,
        useNow: false,
        expectedRevision: "absent",
      });
      await runtime.providerAuthBindings.runBound(binding, () =>
        runtime.models.login(providerId, "api_key", {
          prompt: async () => key,
          notify: () => {},
        }),
      );
    };
    const auth = async (providerId: string) => {
      const capture = await runtime.providerAuthBindings.capture(providerId);
      return runtime.providerAuthBindings.runBound(capture, () =>
        runtime.models.getAuth(providerId),
      );
    };

    await add("commandcode-private", "Private", "private-key");
    expect((await auth("commandcode-private"))?.auth.apiKey).toBe("private-key");
    await expect(runtime.providerAuthBindings.capture("commandcode-goat").then(
      (capture) => runtime.providerAuthBindings.runBound(capture, () =>
        runtime.models.getAuth("commandcode-goat"),
      ),
    )).resolves.toBeUndefined();

    await add("commandcode-goat", "Goat", "goat-key");
    expect((await auth("commandcode-goat"))?.auth.apiKey).toBe("goat-key");
    expect((await auth("commandcode-private"))?.auth.apiKey).toBe("private-key");
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
        importModule: bundledProviderImportModule(),
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
      importModule: bundledProviderImportModule(),
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
      importModule: bundledProviderImportModule(),
      now: () => 1,
      createUuid: () => "00000000-0000-4000-8000-000000000007",
    });
    const model = runtime.models.getModel("keyed-custom", "model-1");
    expect(model).toBeDefined();

    // Request A resolves its auth at generation N (the pinned per-request
    // auth resolution reads models.json facts at resolve time).
    const requestA = await getBoundModelAuth(runtime, model!);
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
    const requestB = await getBoundModelAuth(runtime, model!);
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
      importModule: bundledProviderImportModule(),
      now: () => 1,
      createUuid: () => "00000000-0000-4000-8000-000000000008",
    });
    const model = runtime.models.getModel("keyed-custom", "model-1");
    expect(model).toBeDefined();
    expect((await getBoundModelAuth(runtime, model!))?.auth.apiKey).toBe(
      "initial-key",
    );

    await rm(modelsJsonPath, { force: true });
    runtime.catalog.capture();

    const authAfter = await getBoundModelAuth(runtime, model!);
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
      importModule: bundledProviderImportModule(),
      now: () => 1,
      createUuid: () => "00000000-0000-4000-8000-000000000009",
    });
    const model = runtime.models.getModel("keyed-custom", "model-1");
    expect(model).toBeDefined();
    expect((await getBoundModelAuth(runtime, model!))?.auth.apiKey).toBe(
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
    expect((await getBoundModelAuth(runtime, model!))?.auth.apiKey).toBe(
      "generation-n-key",
    );
  });
});
