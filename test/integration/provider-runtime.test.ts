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

  it("P2: discovers bundled CommandCode without user providerPackages configuration", async () => {
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
    const runtime = await createProviderRuntime({
      piDirectory: join(await mkdtemp(join(tmpdir(), "pi-")), "pi"),
      modelsJsonPath,
      userProviderPackages: {
        "@user/test-provider": { token: "abc" },
      },
      fetch: vi.fn(async () => new Response()),
      credentials: new InMemoryCredentialStore(),
      importModule: async (specifier) => {
        if (specifier === COMMANDCODE_PROVIDER_PACKAGE) {
          return (await commandCodeProviderImportModule()(specifier)) as object;
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

  it("P4: rejects user configuration claiming the bundled package specifier", () => {
    expect(() =>
      assertUserProviderPackages({
        [COMMANDCODE_PROVIDER_PACKAGE]: {},
      }),
    ).toThrow(/bundled product Provider/);
    // The bundled metadata itself is never empty.
    expect(bundledProviderPackages.length).toBeGreaterThan(0);
    expect(bundledProviderIds.has("commandcode-private")).toBe(true);
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

  it("Ticket 13: models.json recompose updates source metadata coherently before the next capture", async () => {
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

    // A models.json swap removes the old custom Provider and adds a new one:
    // one recompose operation updates the composition AND the user Provider
    // id set before the next capture (Spec §12.1).
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
    const next = await import("../../src/providers/models-json.js").then(
      (module) => module.loadModelsJson(modelsJsonPath),
    );
    runtime.catalog.recompose(next);
    runtime.catalog.capture();

    expect(runtime.models.getProvider("second-custom")).toBeDefined();
    expect(runtime.models.getProvider("first-custom")).toBeUndefined();
    expect(runtime.providerSource("second-custom")).toBe("user");
    // The captured snapshot serves the new composition.
    expect(runtime.catalog.models.getModels("second-custom").length).toBe(1);
  });

  it("Ticket 13b: recompose keeps an in-flight auth resolution at generation N while later resolutions use generation N+1", async () => {
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

    // A models.json swap changes the configured key; recompose is one
    // logical operation that also updates the request-composition reader.
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
    const next = await import("../../src/providers/models-json.js").then(
      (module) => module.loadModelsJson(modelsJsonPath),
    );
    runtime.catalog.recompose(next);
    runtime.catalog.capture();

    // Request A keeps the generation-N facts it already resolved — an
    // in-flight invocation is never remapped by a later recompose.
    expect(requestA?.auth.apiKey).toBe("initial-key");

    // A later resolution (Request B) uses generation N+1 facts.
    const requestB = await runtime.models.getAuth(model!);
    expect(requestB?.auth.apiKey).toBe("rotated-key");
  });

  it("Ticket 13c: removing models.json clears the configured auth instead of resurrecting the initial config (Spec §12.1)", async () => {
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

    // The file is removed: the current generation has no models.json.
    await rm(modelsJsonPath, { force: true });
    const next = await import("../../src/providers/models-json.js").then(
      (module) => module.loadModelsJson(modelsJsonPath),
    );
    expect(next).toBeUndefined();
    runtime.catalog.recompose(next);
    runtime.catalog.capture();

    // The configured key must NOT resurrect: the reader distinguishes
    // "no reader" from "reader says no config".
    const authAfter = await runtime.models.getAuth(model!);
    expect(authAfter?.auth.apiKey).toBeUndefined();
  });

  it("Ticket 13d: a failed recompose never commits a mixed generation (Spec §19.4)", async () => {
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

    // The next generation claims the reserved bundled Provider ID: the
    // composition must fail WITHOUT committing the new config to the
    // request reader.
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
    const next = await import("../../src/providers/models-json.js").then(
      (module) => module.loadModelsJson(modelsJsonPath),
    );
    expect(() => runtime.catalog.recompose(next)).toThrow(
      /bundled product Provider/,
    );

    // Generation N remains fully authoritative: composition, source
    // metadata and the request reader are all still N.
    expect(runtime.models.getProvider("keyed-custom")).toBeDefined();
    expect(runtime.providerSource("keyed-custom")).toBe("user");
    expect((await runtime.models.getAuth(model!))?.auth.apiKey).toBe(
      "generation-n-key",
    );
  });
});
