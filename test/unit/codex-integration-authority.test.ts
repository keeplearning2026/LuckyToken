import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { inspectCodexManagedConfig } from "../../src/integrations/codex/config-toml.js";
import {
  createCodexIntegrationAuthority,
  type CodexCatalogBuildResult,
} from "../../src/integrations/codex/integration.js";
import type {
  CodexNativeCatalogEntry,
  CodexNativeCatalogSource,
} from "../../src/integrations/codex/native-catalog-source.js";
import type { AgentInjectionSnapshot } from "../../src/integrations/agents/snapshot.js";

const roots: string[] = [];
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, readFile: vi.fn(actual.readFile), rename: vi.fn(actual.rename) };
});
const actualFs = await vi.importActual<typeof FsPromises>("node:fs/promises");

afterEach(async () => {
  vi.mocked(readFile).mockReset();
  vi.mocked(rename).mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function nativeSource(
  entries: readonly CodexNativeCatalogEntry[],
  source: "bundled" | "unavailable" = "bundled",
): CodexNativeCatalogSource {
  return Object.freeze({
    load: async () => ({
      source,
      entries,
      warnings:
        source === "unavailable"
          ? ["Codex native model metadata is unavailable."]
          : [],
      generation: `${source}:${entries.map((entry) => entry.slug).join(",")}`,
    }),
    invalidate: () => undefined,
  });
}

async function fixture(options: {
  config?: string;
  nativeEntries?: readonly CodexNativeCatalogEntry[];
  nativeCatalogUnavailable?: boolean;
  routedSlug?: string;
  validateCatalog?: (content: string) => Promise<void>;
  injectedModelCount?: number;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "Token-codex-integration-"));
  roots.push(root);
  const codexHome = join(root, "codex");
  const stateDirectory = join(root, "Token", "integrations", "codex");
  await mkdir(codexHome, { recursive: true });
  const config = options.config ?? "model = \"gpt-5.6-sol\"\n[features]\nfoo = true\n";
  await writeFile(join(codexHome, "config.toml"), config, "utf8");
  const nativeEntries = options.nativeEntries ?? [
    { slug: "gpt-native", display_name: "GPT Native", base_instructions: "Codex native" },
  ];
  const routedSlug = options.routedSlug ?? "anthropic/claude-opus";
  const buildScopes: Array<"favorite" | "full" | undefined> = [];
  const buildCatalog = async (
    native: readonly CodexNativeCatalogEntry[],
    scope?: "favorite" | "full",
  ): Promise<CodexCatalogBuildResult> => ({
    ...(buildScopes.push(scope), {}),
    content: `${JSON.stringify({
      models: [...native, { slug: routedSlug, display_name: routedSlug }],
    }, null, 2)}\n`,
    modelCount: native.length + 1,
    injectedModelCount: options.injectedModelCount ?? 1,
    warnings: [],
  });
  const createAuthority = () => createCodexIntegrationAuthority({
    codexHome,
    stateDirectory,
    endpoint: () => "http://127.0.0.1:3000/v1",
    nativeCatalog: nativeSource(
      nativeEntries,
      options.nativeCatalogUnavailable ? "unavailable" : "bundled",
    ),
    buildCatalog,
    validateCatalog: options.validateCatalog ?? (async () => undefined),
  });
  return { root, codexHome, stateDirectory, authority: createAuthority(), createAuthority, buildScopes };
}

function countRootKey(content: string, key: string): number {
  const root = content.split(/^\s*\[/mu, 1)[0] ?? "";
  return root.split(/\r?\n/u).filter((line) => new RegExp(`^\\s*${key}\\s*=`).test(line)).length;
}

function injectionSnapshot(): AgentInjectionSnapshot {
  return Object.freeze({
    endpoint: Object.freeze({
      origin: "http://127.0.0.1:3000",
      openaiBaseUrl: "http://127.0.0.1:3000/v1",
    }),
    full: Object.freeze([]),
    favorite: Object.freeze([]),
    warnings: Object.freeze([]),
  });
}

describe("Codex integration authority", () => {
  it("retains recovery ownership if verification fails after writing config.toml", async () => {
    const fx = await fixture();
    const configPath = join(fx.codexHome, "config.toml");
    let configCommitted = false;
    vi.mocked(rename).mockImplementation(async (...args) => {
      await actualFs.rename(...args);
      if (args[1] === configPath) configCommitted = true;
    });
    vi.mocked(readFile).mockImplementation(async (...args) => {
      if (configCommitted && args[0] === configPath) {
        configCommitted = false;
        throw new Error("probe verification read failed");
      }
      return actualFs.readFile(...args);
    });
    await expect(fx.authority.reconcile("enable")).rejects.toThrow("probe verification read failed");
    expect(await readFile(configPath, "utf8")).toContain("openai_base_url");
    vi.mocked(readFile).mockReset();
    vi.mocked(rename).mockReset();
    await expect(fx.createAuthority().restore()).resolves.toMatchObject({ observedState: "native" });
    expect(await readFile(configPath, "utf8")).not.toContain("openai_base_url");
  });

  it("leaves config.toml unchanged when recovery ownership cannot be persisted", async () => {
    const fx = await fixture();
    const configPath = join(fx.codexHome, "config.toml");
    const before = await readFile(configPath, "utf8");
    const statePath = join(fx.stateDirectory, "integration-state.json");
    vi.mocked(rename).mockImplementation(async (...args) => {
      if (args[1] === statePath) {
        const state = JSON.parse(await actualFs.readFile(args[0], "utf8")) as { managed: boolean };
        if (state.managed) throw new Error("probe ownership write failed");
      }
      await actualFs.rename(...args);
    });
    await expect(fx.authority.reconcile("enable")).rejects.toThrow("probe ownership write failed");
    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  it("releases newly recorded ownership when config replacement fails before commit", async () => {
    const fx = await fixture();
    const configPath = join(fx.codexHome, "config.toml");
    vi.mocked(rename).mockImplementation(async (...args) => {
      if (args[1] === configPath) throw new Error("probe config rename failed");
      await actualFs.rename(...args);
    });
    await expect(fx.authority.reconcile("enable")).rejects.toThrow("probe config rename failed");
    vi.mocked(rename).mockReset();
    const external = 'model = "user-model"\nopenai_base_url = "https://user.example/v1"\n';
    await writeFile(configPath, external, "utf8");
    await fx.createAuthority().restore();
    expect(await readFile(configPath, "utf8")).toBe(external);
  });
  it("rejects obsolete integration-state schemas instead of migrating them", async () => {
    const fx = await fixture();
    await mkdir(fx.stateDirectory, { recursive: true });
    await writeFile(
      join(fx.stateDirectory, "integration-state.json"),
      `${JSON.stringify({
        schemaVersion: "Token-codex-integration-v2",
        desiredEnabled: true,
      })}\n`,
      "utf8",
    );

    await expect(fx.authority.query()).rejects.toThrow(
      "Codex integration state is invalid",
    );
  });

  it("defaults OFF, owns an empty native set, and query never changes Codex files", async () => {
    const fx = await fixture();
    const before = await readFile(join(fx.codexHome, "config.toml"), "utf8");

    const projection = await fx.authority.query();

    expect(projection.desiredEnabled).toBe(false);
    expect(projection.scope).toBe("favorite");
    expect(projection.observedState).toBe("native");
    expect(fx.authority.directModels.has("gpt-native")).toBe(false);
    expect(await readFile(join(fx.codexHome, "config.toml"), "utf8")).toBe(before);
  });

  it("persists Full scope without changing Codex files", async () => {
    const fx = await fixture();
    const before = await readFile(join(fx.codexHome, "config.toml"), "utf8");

    const changed = await fx.authority.setScope("full");

    expect(changed.scope).toBe("full");
    expect(changed.desiredEnabled).toBe(false);
    expect(await readFile(join(fx.codexHome, "config.toml"), "utf8")).toBe(before);
    await expect(fx.authority.query()).resolves.toMatchObject({ scope: "full" });
  });

  it("builds the Codex catalog with the persisted injection scope", async () => {
    const fx = await fixture();
    await fx.authority.setScope("full");

    await fx.authority.reconcile("enable");

    expect(fx.buildScopes).toEqual(["full"]);
  });

  it("exposes Codex file handling through common inject and restore operations", async () => {
    const fx = await fixture();

    const injected = await fx.authority.inject(injectionSnapshot(), "full");
    const restored = await fx.authority.restore();

    expect(fx.authority.id).toBe("codex");
    expect(fx.buildScopes).toEqual(["full"]);
    expect(injected).toMatchObject({
      observedState: "managed",
      modelCount: 1,
      changed: true,
      message: "Codex synced. Restart Codex to load the updated model catalog.",
    });
    expect(restored).toMatchObject({
      observedState: "native",
      modelCount: 0,
      message: "Codex configuration restored. Restart Codex to apply the change.",
    });
  });

  it("treats restore as successful when Codex has no Token injection", async () => {
    const fx = await fixture();
    await rm(join(fx.codexHome, "config.toml"), { force: true });

    await expect(fx.authority.restore()).resolves.toMatchObject({
      observedState: "native",
      modelCount: 0,
      changed: false,
    });
  });

  it("enables Favorite scope without changing Codex files when no model is injectable", async () => {
    const fx = await fixture({ injectedModelCount: 0 });
    const before = await readFile(join(fx.codexHome, "config.toml"), "utf8");

    const enabled = await fx.authority.reconcile("enable");

    expect(enabled).toMatchObject({
      desiredEnabled: true,
      scope: "favorite",
      observedState: "native",
      modelCount: 0,
      needsSync: false,
      message: "Codex is enabled in Favorite scope, but no model can be injected.",
    });
    expect(await readFile(join(fx.codexHome, "config.toml"), "utf8")).toBe(before);
    await expect(readFile(enabled.catalogPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps Enable OFF when Codex injection cannot start", async () => {
    const fx = await fixture();
    await rm(join(fx.codexHome, "config.toml"), { force: true });

    const result = await fx.authority.reconcile("enable");

    expect(result).toMatchObject({
      desiredEnabled: false,
      observedState: "unavailable",
      message: "Codex config.toml was not found.",
    });
  });

  it("enable converges the three root keys to Token and publishes the same native snapshot", async () => {
    const original = [
      'model_provider = "ccswitch"',
      'openai_base_url = "https://old.example/v1"',
      'model = "old-model"',
      "[features]",
      "foo = true",
      "",
    ].join("\n");
    const fx = await fixture({ config: original });

    const result = await fx.authority.reconcile("enable");
    const content = await readFile(join(fx.codexHome, "config.toml"), "utf8");
    const catalog = JSON.parse(await readFile(result.catalogPath, "utf8")) as {
      models: Array<Record<string, unknown>>;
    };

    expect(result.desiredEnabled).toBe(true);
    expect(result.observedState).toBe("managed");
    expect(content).toContain('model_provider = "openai"');
    expect(content).toContain('openai_base_url = "http://127.0.0.1:3000/v1"');
    expect(content).toContain("model_catalog_json = ");
    expect(content).toContain('model = "old-model"');
    expect(content).toContain("foo = true");
    expect(content).toContain("standalone_web_search = true");
    expect(fx.authority.directModels.has("gpt-native")).toBe(true);
    expect(catalog.models.map((entry) => entry.slug)).toEqual([
      "gpt-native",
      "anthropic/claude-opus",
    ]);
  });

  it("manages standalone search without changing other feature entries", async () => {
    const fx = await fixture({
      config: 'model = "m"\r\n[features]\r\nfoo = true\r\nstandalone_web_search = false\r\n',
    });
    await fx.authority.reconcile("enable");
    await fx.authority.reconcile("sync");
    const active = await readFile(join(fx.codexHome, "config.toml"), "utf8");
    expect(active).toContain("foo = true\r\nstandalone_web_search = true\r\n");
    expect((active.match(/standalone_web_search\s*=/gu) ?? [])).toHaveLength(1);
    await fx.authority.reconcile("disable");
    const restored = await readFile(join(fx.codexHome, "config.toml"), "utf8");
    expect(restored).toContain("foo = true\r\n");
    expect(restored).not.toContain("standalone_web_search");
  });

  it("reports conflicting standalone search assignments without changing config", async () => {
    const config = '[features]\nstandalone_web_search = true\nstandalone_web_search = false\n';
    const fx = await fixture({ config });
    const result = await fx.authority.reconcile("enable");
    expect(result.observedState).toBe("conflict");
    expect(await readFile(join(fx.codexHome, "config.toml"), "utf8")).toBe(config);
  });

  it.each([
    'features = { standalone_web_search = false }\n',
    '"features"."standalone_web_search" = false\n',
    '[features.extra]\nvalue = true\n',
  ])("converges valid alternate TOML features forms: %s", async (config) => {
    const fx = await fixture({ config });
    const result = await fx.authority.reconcile("enable");
    const active = await readFile(join(fx.codexHome, "config.toml"), "utf8");

    expect(result.observedState).toBe("managed");
    expect(inspectCodexManagedConfig(active)).toMatchObject({
      ok: true,
      values: { standaloneWebSearch: true },
    });
  });

  it("rejects a malformed quoted standalone feature key", async () => {
    const config = '[features]\n"standalone_web_search" : false\n';
    const fx = await fixture({ config });
    expect((await fx.authority.reconcile("enable")).observedState).toBe("conflict");
    expect(await readFile(join(fx.codexHome, "config.toml"), "utf8")).toBe(config);
  });

  it("repeated active convergence never duplicates root keys and native restore deletes them", async () => {
    const original = 'openai_base_url = "https://before.example/v1"\nmodel = "gpt-x"\n';
    const fx = await fixture({ config: original });
    await fx.authority.reconcile("enable");

    await fx.authority.reconcile("startup");
    await fx.authority.reconcile("sync");
    const active = await readFile(join(fx.codexHome, "config.toml"), "utf8");

    expect(countRootKey(active, "model_provider")).toBe(1);
    expect(countRootKey(active, "openai_base_url")).toBe(1);
    expect(countRootKey(active, "model_catalog_json")).toBe(1);

    await fx.authority.reconcile("disable");
    const restored = await readFile(join(fx.codexHome, "config.toml"), "utf8");
    expect(restored).toContain('model = "gpt-x"');
    expect(restored).not.toContain("model_provider");
    expect(restored).not.toContain("openai_base_url");
    expect(restored).not.toContain("model_catalog_json");
    expect(restored).not.toContain("standalone_web_search");
  });

  it("disable restores native defaults and clears Direct Mode", async () => {
    const original = [
      'model_provider = "custom"',
      'model_catalog_json = "C:/user/catalog.json"',
      'model = "old-model"',
      "",
    ].join("\n");
    const fx = await fixture({ config: original });
    await fx.authority.reconcile("enable");

    const result = await fx.authority.reconcile("disable");
    const restored = await readFile(join(fx.codexHome, "config.toml"), "utf8");

    expect(result.desiredEnabled).toBe(false);
    expect(result.message).toBeUndefined();
    expect(result.observedState).toBe("native");
    expect(restored).not.toContain("model_provider");
    expect(restored).not.toContain("model_catalog_json");
    expect(restored).not.toContain("openai_base_url");
    expect(restored).toContain('model = "old-model"');
    expect(fx.authority.directModels.has("gpt-native")).toBe(false);

    await expect(fx.authority.reconcile("disable")).resolves.toMatchObject({
      desiredEnabled: false,
      observedState: "native",
    });
  });

  it("disable leaves the unreferenced Token catalog for the next full rewrite", async () => {
    const fx = await fixture();
    const enabled = await fx.authority.reconcile("enable");
    const published = await readFile(enabled.catalogPath, "utf8");

    await fx.authority.reconcile("disable");

    expect(await readFile(enabled.catalogPath, "utf8")).toBe(published);
  });

  it("disable removes the managed root keys and preserves unrelated config", async () => {
    const fx = await fixture({
      config: [
        'model_provider = "before"',
        'openai_base_url = "https://before.example/v1"',
        'model_catalog_json = "C:/before/catalog.json"',
        'model = "keep-me"',
        "",
      ].join("\n"),
    });
    await fx.authority.reconcile("enable");

    await fx.authority.reconcile("disable");
    const restored = await readFile(join(fx.codexHome, "config.toml"), "utf8");

    expect(restored).not.toContain("model_provider");
    expect(restored).not.toContain("openai_base_url");
    expect(restored).not.toContain("model_catalog_json");
    expect(restored).toContain('model = "keep-me"');
  });

  it("refuses invalid TOML during active convergence without rewriting it", async () => {
    const fx = await fixture({ config: 'openai_base_url = "https://before.example/v1"\n' });
    await fx.authority.reconcile("enable");
    await writeFile(
      join(fx.codexHome, "config.toml"),
      [
        'model_provider = "wrong"',
        'openai_base_url = ["broken"]',
        'openai_base_url = "https://other.example/v1"',
        'model_catalog_json = "C:/other/catalog.json"',
        "",
      ].join("\n"),
      "utf8",
    );

    const invalid = await readFile(join(fx.codexHome, "config.toml"), "utf8");
    const synced = await fx.authority.reconcile("sync");

    expect(synced.observedState).toBe("conflict");
    expect(await readFile(join(fx.codexHome, "config.toml"), "utf8")).toBe(invalid);
  });

  it("refuses restore when config.toml became invalid", async () => {
    const fx = await fixture({
      config: 'openai_base_url = "https://before.example/v1"\n',
    });
    await fx.authority.reconcile("enable");
    await writeFile(
      join(fx.codexHome, "config.toml"),
      [
        'model_provider = "other"',
        'model_provider = "another"',
        'openai_base_url = ["broken"]',
        'model_catalog_json = "C:/other/catalog.json"',
        "",
      ].join("\n"),
      "utf8",
    );

    const invalid = await readFile(join(fx.codexHome, "config.toml"), "utf8");
    const disabled = await fx.authority.reconcile("disable");

    expect(disabled.observedState).toBe("conflict");
    expect(disabled.desiredEnabled).toBe(true);
    expect(await readFile(join(fx.codexHome, "config.toml"), "utf8")).toBe(invalid);
    expect(fx.authority.directModels.has("gpt-native")).toBe(true);
  });

  it("shutdown restores native defaults without changing durable Enable intent", async () => {
    const fx = await fixture({
      config: 'openai_base_url = "https://before.example/v1"\n',
    });
    await fx.authority.reconcile("enable");

    const shutdown = await fx.authority.reconcile("shutdown");

    expect(shutdown.desiredEnabled).toBe(true);
    expect(shutdown.needsSync).toBe(true);
    const restored = await readFile(join(fx.codexHome, "config.toml"), "utf8");
    expect(restored).not.toContain("model_provider");
    expect(restored).not.toContain("openai_base_url");
    expect(restored).not.toContain("model_catalog_json");
    expect(restored).not.toContain("standalone_web_search");
    expect(fx.authority.directModels.has("gpt-native")).toBe(false);
  });

  it("shutdown fails instead of claiming success when native defaults cannot be restored", async () => {
    const fx = await fixture({ config: 'openai_base_url = "https://before.example/v1"\n' });
    await fx.authority.reconcile("enable");
    await rm(join(fx.codexHome, "config.toml"), { force: true });

    await expect(fx.authority.reconcile("shutdown")).rejects.toThrow(
      "Codex integration could not be restored before Token shutdown",
    );
    expect(fx.authority.directModels.has("gpt-native")).toBe(true);
  });

  it("keeps Enable ON when native defaults cannot be restored", async () => {
    const fx = await fixture();
    await fx.authority.reconcile("enable");
    await rm(join(fx.codexHome, "config.toml"), { force: true });

    const result = await fx.authority.reconcile("disable");

    expect(result).toMatchObject({
      desiredEnabled: true,
      observedState: "unavailable",
      message: "Codex config.toml was not found while restoring the integration.",
    });
    expect(fx.authority.directModels.has("gpt-native")).toBe(true);
  });

  it("discards managed-key changes made while Token is closed after the next managed lifecycle", async () => {
    const fx = await fixture({ config: 'openai_base_url = "https://before.example/v1"\n' });
    await fx.authority.reconcile("enable");
    await fx.authority.reconcile("shutdown");
    const changedWhileClosed = [
      'model_provider = "other"',
      'openai_base_url = "https://while-closed.example/v1"',
      "",
    ].join("\n");
    await writeFile(join(fx.codexHome, "config.toml"), changedWhileClosed, "utf8");

    await fx.authority.reconcile("startup");
    expect(fx.authority.directModels.has("gpt-native")).toBe(true);
    await fx.authority.reconcile("shutdown");

    const restored = await readFile(join(fx.codexHome, "config.toml"), "utf8");
    expect(restored).not.toContain("model_provider");
    expect(restored).not.toContain("openai_base_url");
    expect(restored).not.toContain("model_catalog_json");
    expect(restored).not.toContain("standalone_web_search");
  });

  it("sync republishes native identity into the Token catalog under CODEX_HOME", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-codex-integration-sync-"));
    roots.push(root);
    const codexHome = join(root, "codex");
    const stateDirectory = join(root, "state");
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, "config.toml"), "model = \"x\"\n", "utf8");
    let entries: readonly CodexNativeCatalogEntry[] = [{ slug: "gpt-a" }];
    let source: "bundled" | "unavailable" = "bundled";
    const authority = createCodexIntegrationAuthority({
      codexHome,
      stateDirectory,
      endpoint: () => "http://127.0.0.1:3000/v1",
      nativeCatalog: {
        load: async () => ({
          source,
          entries,
          warnings: source === "unavailable" ? ["native catalog unavailable"] : [],
          generation: `${source}:${entries.map((entry) => entry.slug).join(",")}`,
        }),
        invalidate: () => undefined,
      },
      buildCatalog: async (native) => ({
        content: `${JSON.stringify({ models: native })}\n`,
        modelCount: native.length,
        injectedModelCount: 1,
        warnings: [],
      }),
      validateCatalog: async () => undefined,
    });
    await authority.reconcile("enable");
    expect(authority.directModels.has("gpt-a")).toBe(true);

    entries = [{ slug: "gpt-b" }];
    await authority.reconcile("sync");
    const catalog = await readFile(
      join(codexHome, "token-model-catalog.json"),
      "utf8",
    );

    expect(authority.directModels.has("gpt-a")).toBe(false);
    expect(authority.directModels.has("gpt-b")).toBe(true);
    expect(catalog).toContain("gpt-b");
    expect(catalog).not.toContain("gpt-a");

    source = "unavailable";
    entries = [];
    const configBeforeFailure = await readFile(join(codexHome, "config.toml"), "utf8");
    const failed = await authority.reconcile("sync");

    expect(failed.observedState).toBe("unavailable");
    expect(authority.directModels.has("gpt-b")).toBe(true);
    expect(await readFile(join(codexHome, "config.toml"), "utf8")).toBe(
      configBeforeFailure,
    );
    expect(await readFile(join(codexHome, "token-model-catalog.json"), "utf8")).toBe(
      catalog,
    );
  });

  it("native metadata unavailability leaves Codex files unchanged", async () => {
    const fx = await fixture({
      nativeEntries: [],
      nativeCatalogUnavailable: true,
    });
    const original = await readFile(join(fx.codexHome, "config.toml"), "utf8");

    const result = await fx.authority.reconcile("enable");

    expect(result).toMatchObject({
      desiredEnabled: false,
      observedState: "unavailable",
      message: "The Codex model catalog could not be read. No Codex files were changed.",
    });
    expect(fx.authority.directModels.has("anything")).toBe(false);
    expect(await readFile(join(fx.codexHome, "config.toml"), "utf8")).toBe(original);
    await expect(readFile(result.catalogPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves the published catalog and config unchanged when installed CLI validation fails", async () => {
    const fx = await fixture({
      validateCatalog: async () => {
        throw new Error("parser rejected candidate");
      },
    });
    const configPath = join(fx.codexHome, "config.toml");
    const catalogPath = join(
      fx.codexHome,
      "token-model-catalog.json",
    );
    const originalConfig = await readFile(configPath, "utf8");
    const originalCatalog = '{"models":[{"slug":"previous"}]}\n';
    await writeFile(catalogPath, originalCatalog, "utf8");

    const result = await fx.authority.reconcile("enable");

    expect(result).toMatchObject({
      desiredEnabled: false,
      observedState: "unavailable",
      message:
        "The Token model catalog failed installed Codex validation. No Codex files were changed. parser rejected candidate",
    });
    expect(await readFile(configPath, "utf8")).toBe(originalConfig);
    expect(await readFile(catalogPath, "utf8")).toBe(originalCatalog);
  });

  it("handles hash characters in managed TOML values before restoring defaults", async () => {
    const original = [
      'openai_base_url = "https://before.example/v1#fragment" # user comment',
      'model_catalog_json = "C:/catalogs/#native.json"',
      "",
    ].join("\n");
    const fx = await fixture({ config: original });

    const enabled = await fx.authority.reconcile("enable");
    expect(enabled.observedState).toBe("managed");

    await fx.authority.reconcile("disable");
    const restored = await readFile(join(fx.codexHome, "config.toml"), "utf8");

    expect(restored).not.toContain("openai_base_url");
    expect(restored).not.toContain("model_catalog_json");
  });

  it("recognizes quoted TOML root keys as the same managed fields instead of adding duplicates", async () => {
    const original = [
      '\"model_provider\" = "custom"',
      "'openai_base_url' = 'https://quoted.example/v1'",
      '\"model_catalog_json\" = "C:/quoted/catalog.json"',
      "",
    ].join("\n");
    const fx = await fixture({ config: original });

    const enabled = await fx.authority.reconcile("enable");
    const active = await readFile(join(fx.codexHome, "config.toml"), "utf8");

    expect(enabled.observedState).toBe("managed");
    expect((active.match(/model_provider/gu) ?? []).length).toBe(1);
    expect((active.match(/openai_base_url/gu) ?? []).length).toBe(1);
    expect((active.match(/model_catalog_json/gu) ?? []).length).toBe(1);

    await fx.authority.reconcile("disable");
    const restored = await readFile(join(fx.codexHome, "config.toml"), "utf8");
    expect(restored).not.toContain("model_provider");
    expect(restored).not.toContain("openai_base_url");
    expect(restored).not.toContain("model_catalog_json");
  });

  it("refuses an initially invalid config with duplicate managed root keys", async () => {
    const original = [
      'openai_base_url = "https://one.example/v1"',
      'openai_base_url = "https://two.example/v1"',
      "",
    ].join("\n");
    const fx = await fixture({ config: original });

    const result = await fx.authority.reconcile("enable");

    expect(result.desiredEnabled).toBe(false);
    expect(result.observedState).toBe("conflict");
    expect(await readFile(join(fx.codexHome, "config.toml"), "utf8")).toBe(original);
    expect(fx.authority.directModels.has("gpt-native")).toBe(false);
  });
});
