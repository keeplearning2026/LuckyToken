import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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

afterEach(async () => {
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
    }),
  });
}

async function fixture(options: {
  config?: string;
  nativeEntries?: readonly CodexNativeCatalogEntry[];
  nativeCatalogUnavailable?: boolean;
  routedSlug?: string;
  validateCatalog?: (content: string) => Promise<void>;
  injectedModelCount?: number;
  restoreTarget?: {
    readonly modelProvider: string | null;
    readonly openaiBaseUrl: string | null;
    readonly modelCatalogJson: string | null;
  };
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
  const authority = createCodexIntegrationAuthority({
    codexHome,
    stateDirectory,
    endpoint: () => "http://127.0.0.1:3000/v1",
    nativeCatalog: nativeSource(
      nativeEntries,
      options.nativeCatalogUnavailable ? "unavailable" : "bundled",
    ),
    buildCatalog,
    validateCatalog: options.validateCatalog ?? (async () => undefined),
    restoreTarget: () =>
      options.restoreTarget ?? {
        modelProvider: null,
        openaiBaseUrl: null,
        modelCatalogJson: null,
      },
  });
  return { root, codexHome, stateDirectory, authority, buildScopes };
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
  it("migrates v2 Enable intent while discarding its obsolete preimage", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-codex-invalid-state-"));
    roots.push(root);
    const codexHome = join(root, "codex");
    const stateDirectory = join(root, "state");
    await mkdir(codexHome, { recursive: true });
    await mkdir(stateDirectory, { recursive: true });
    const original = 'openai_base_url = "https://before.example/v1"\n';
    await writeFile(join(codexHome, "config.toml"), original, "utf8");
    await writeFile(
      join(stateDirectory, "integration-state.json"),
      `${JSON.stringify({
        schemaVersion: "Token-codex-integration-v2",
        desiredEnabled: true,
        preimage: {
          modelProvider: 42,
          openaiBaseUrl: null,
          modelCatalogJson: null,
        },
      })}\n`,
      "utf8",
    );
    const authority = createCodexIntegrationAuthority({
      codexHome,
      stateDirectory,
      endpoint: () => "http://127.0.0.1:3000/v1",
      nativeCatalog: nativeSource([{ slug: "gpt-native" }]),
      buildCatalog: async (native) => ({
        content: `${JSON.stringify({ models: native })}\n`,
        modelCount: native.length,
        injectedModelCount: 1,
        warnings: [],
      }),
      validateCatalog: async () => undefined,
    });

    const started = await authority.reconcile("startup");
    expect(started).toMatchObject({ desiredEnabled: true, observedState: "managed" });
    expect(await readFile(join(codexHome, "config.toml"), "utf8")).toContain(
      'openai_base_url = "http://127.0.0.1:3000/v1"',
    );
    expect(authority.nativeModels.has("gpt-native")).toBe(true);

    await authority.reconcile("shutdown");
    expect(await readFile(join(codexHome, "config.toml"), "utf8")).toBe("");
  });

  it("migrates the v2 managed fact but restores only the configured target", async () => {
    const fx = await fixture({
      config: [
        'model_provider = "openai"',
        'openai_base_url = "http://127.0.0.1:3000/v1"',
        `model_catalog_json = "${join("ignored", "old-catalog.json").replaceAll("\\", "\\\\")}"`,
        'model = "keep-me"',
        "",
      ].join("\n"),
    });
    await mkdir(fx.stateDirectory, { recursive: true });
    await writeFile(
      join(fx.stateDirectory, "integration-state.json"),
      `${JSON.stringify({
        schemaVersion: "Token-codex-integration-v2",
        desiredEnabled: false,
        preimage: {
          modelProvider: "obsolete-provider",
          openaiBaseUrl: "https://obsolete.example/v1",
          modelCatalogJson: "C:/obsolete/catalog.json",
        },
      })}\n`,
      "utf8",
    );

    const restored = await fx.authority.reconcile("startup");

    expect(restored).toMatchObject({ desiredEnabled: false, observedState: "native" });
    expect(await readFile(join(fx.codexHome, "config.toml"), "utf8")).toBe(
      'model = "keep-me"\n',
    );
  });

  it("defaults OFF, owns an empty native set, and query never changes Codex files", async () => {
    const fx = await fixture();
    const before = await readFile(join(fx.codexHome, "config.toml"), "utf8");

    const projection = await fx.authority.query();

    expect(projection.desiredEnabled).toBe(false);
    expect(projection.scope).toBe("favorite");
    expect(projection.observedState).toBe("native");
    expect(fx.authority.nativeModels.has("gpt-native")).toBe(false);
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
    expect(fx.authority.nativeModels.has("gpt-native")).toBe(true);
    expect(catalog.models.map((entry) => entry.slug)).toEqual([
      "gpt-native",
      "anthropic/claude-opus",
    ]);
  });

  it("repeated active convergence never duplicates root keys and blank restore targets delete them", async () => {
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
    expect(await readFile(join(fx.codexHome, "config.toml"), "utf8")).toBe('model = "gpt-x"\n');
  });

  it("disable applies the default all-null restore target and clears Direct Mode", async () => {
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

    expect(restored).toBe('model = "old-model"\n');
    expect(result.desiredEnabled).toBe(false);
    expect(result.message).toBeUndefined();
    expect(result.observedState).toBe("native");
    expect(restored).not.toContain("model_provider");
    expect(restored).not.toContain("model_catalog_json");
    expect(restored).not.toContain("openai_base_url");
    expect(restored).toContain('model = "old-model"');
    expect(fx.authority.nativeModels.has("gpt-native")).toBe(false);

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

  it("disable restores the three root keys from the configured target", async () => {
    const fx = await fixture({
      config: [
        'model_provider = "before"',
        'openai_base_url = "https://before.example/v1"',
        'model_catalog_json = "C:/before/catalog.json"',
        'model = "keep-me"',
        "",
      ].join("\n"),
      restoreTarget: {
        modelProvider: null,
        openaiBaseUrl: "https://restore.example/v1",
        modelCatalogJson: "C:/restore/catalog.json",
      },
    });
    await fx.authority.reconcile("enable");

    await fx.authority.reconcile("disable");
    const restored = await readFile(join(fx.codexHome, "config.toml"), "utf8");

    expect(restored).not.toContain("model_provider");
    expect(restored).toContain('openai_base_url = "https://restore.example/v1"');
    expect(restored).toContain('model_catalog_json = "C:/restore/catalog.json"');
    expect(restored).toContain('model = "keep-me"');
  });

  it("active convergence repairs duplicate or malformed managed keys", async () => {
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

    const synced = await fx.authority.reconcile("sync");
    const active = await readFile(join(fx.codexHome, "config.toml"), "utf8");

    expect(synced.observedState).toBe("managed");
    expect(countRootKey(active, "model_provider")).toBe(1);
    expect(countRootKey(active, "openai_base_url")).toBe(1);
    expect(countRootKey(active, "model_catalog_json")).toBe(1);
    expect(active).toContain('model_provider = "openai"');
    expect(active).toContain('openai_base_url = "http://127.0.0.1:3000/v1"');
  });

  it("restore converges to the configured target even when managed keys drifted or duplicated", async () => {
    const original = 'openai_base_url = "https://before.example/v1"\n';
    const fx = await fixture({
      config: original,
      restoreTarget: {
        modelProvider: null,
        openaiBaseUrl: "https://before.example/v1",
        modelCatalogJson: null,
      },
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

    const disabled = await fx.authority.reconcile("disable");
    const restored = await readFile(join(fx.codexHome, "config.toml"), "utf8");

    expect(disabled.observedState).toBe("native");
    expect(restored).toBe(original);
    expect(fx.authority.nativeModels.has("gpt-native")).toBe(false);
  });

  it("shutdown applies the configured restore target without changing durable Enable intent", async () => {
    const original = 'openai_base_url = "https://before.example/v1"\n';
    const fx = await fixture({
      config: original,
      restoreTarget: {
        modelProvider: null,
        openaiBaseUrl: "https://before.example/v1",
        modelCatalogJson: null,
      },
    });
    await fx.authority.reconcile("enable");

    const shutdown = await fx.authority.reconcile("shutdown");

    expect(shutdown.desiredEnabled).toBe(true);
    expect(shutdown.needsSync).toBe(true);
    expect(await readFile(join(fx.codexHome, "config.toml"), "utf8")).toBe(original);
    expect(fx.authority.nativeModels.has("gpt-native")).toBe(false);
  });

  it("shutdown fails instead of claiming success when the configured target cannot be restored", async () => {
    const fx = await fixture({ config: 'openai_base_url = "https://before.example/v1"\n' });
    await fx.authority.reconcile("enable");
    await rm(join(fx.codexHome, "config.toml"), { force: true });

    await expect(fx.authority.reconcile("shutdown")).rejects.toThrow(
      "Codex integration could not be restored before Token shutdown",
    );
    expect(fx.authority.nativeModels.has("gpt-native")).toBe(true);
  });

  it("keeps Enable ON when the configured restore target cannot be applied", async () => {
    const fx = await fixture();
    await fx.authority.reconcile("enable");
    await rm(join(fx.codexHome, "config.toml"), { force: true });

    const result = await fx.authority.reconcile("disable");

    expect(result).toMatchObject({
      desiredEnabled: true,
      observedState: "unavailable",
      message: "Codex config.toml was not found while restoring the integration.",
    });
    expect(fx.authority.nativeModels.has("gpt-native")).toBe(true);
  });

  it("changes made while Token is closed do not replace the configured restore target", async () => {
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
    expect(fx.authority.nativeModels.has("gpt-native")).toBe(true);
    await fx.authority.reconcile("shutdown");

    expect(await readFile(join(fx.codexHome, "config.toml"), "utf8")).toBe("");
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
        }),
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
    expect(authority.nativeModels.has("gpt-a")).toBe(true);

    entries = [{ slug: "gpt-b" }];
    await authority.reconcile("sync");
    const catalog = await readFile(
      join(codexHome, "token-model-catalog.json"),
      "utf8",
    );

    expect(authority.nativeModels.has("gpt-a")).toBe(false);
    expect(authority.nativeModels.has("gpt-b")).toBe(true);
    expect(catalog).toContain("gpt-b");
    expect(catalog).not.toContain("gpt-a");

    source = "unavailable";
    entries = [];
    const configBeforeFailure = await readFile(join(codexHome, "config.toml"), "utf8");
    const failed = await authority.reconcile("sync");

    expect(failed.observedState).toBe("unavailable");
    expect(authority.nativeModels.has("gpt-b")).toBe(true);
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
    expect(fx.authority.nativeModels.has("anything")).toBe(false);
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

  it("preserves hash characters in configured TOML restore values", async () => {
    const original = [
      'openai_base_url = "https://before.example/v1#fragment" # user comment',
      'model_catalog_json = "C:/catalogs/#native.json"',
      "",
    ].join("\n");
    const fx = await fixture({
      config: original,
      restoreTarget: {
        modelProvider: null,
        openaiBaseUrl: "https://before.example/v1#fragment",
        modelCatalogJson: "C:/catalogs/#native.json",
      },
    });

    const enabled = await fx.authority.reconcile("enable");
    expect(enabled.observedState).toBe("managed");

    await fx.authority.reconcile("disable");
    const restored = await readFile(join(fx.codexHome, "config.toml"), "utf8");

    expect(restored).toContain('openai_base_url = "https://before.example/v1#fragment"');
    expect(restored).toContain('model_catalog_json = "C:/catalogs/#native.json"');
  });

  it("recognizes quoted TOML root keys as the same managed fields instead of adding duplicates", async () => {
    const original = [
      '\"model_provider\" = "custom"',
      "'openai_base_url' = 'https://quoted.example/v1'",
      '\"model_catalog_json\" = "C:/quoted/catalog.json"',
      "",
    ].join("\n");
    const fx = await fixture({
      config: original,
      restoreTarget: {
        modelProvider: "custom",
        openaiBaseUrl: "https://quoted.example/v1",
        modelCatalogJson: "C:/quoted/catalog.json",
      },
    });

    const enabled = await fx.authority.reconcile("enable");
    const active = await readFile(join(fx.codexHome, "config.toml"), "utf8");

    expect(enabled.observedState).toBe("managed");
    expect((active.match(/model_provider/gu) ?? []).length).toBe(1);
    expect((active.match(/openai_base_url/gu) ?? []).length).toBe(1);
    expect((active.match(/model_catalog_json/gu) ?? []).length).toBe(1);

    await fx.authority.reconcile("disable");
    const restored = await readFile(join(fx.codexHome, "config.toml"), "utf8");
    expect(restored).toContain('model_provider = "custom"');
    expect(restored).toContain('openai_base_url = "https://quoted.example/v1"');
    expect(restored).toContain('model_catalog_json = "C:/quoted/catalog.json"');
  });

  it("injects one authoritative target when managed root keys were duplicated", async () => {
    const original = [
      'openai_base_url = "https://one.example/v1"',
      'openai_base_url = "https://two.example/v1"',
      "",
    ].join("\n");
    const fx = await fixture({ config: original });

    const result = await fx.authority.reconcile("enable");
    const active = await readFile(join(fx.codexHome, "config.toml"), "utf8");

    expect(result.desiredEnabled).toBe(true);
    expect(result.observedState).toBe("managed");
    expect(countRootKey(active, "model_provider")).toBe(1);
    expect(countRootKey(active, "openai_base_url")).toBe(1);
    expect(countRootKey(active, "model_catalog_json")).toBe(1);
    expect(active).toContain('model_provider = "openai"');
    expect(active).toContain('openai_base_url = "http://127.0.0.1:3000/v1"');
    expect(fx.authority.nativeModels.has("gpt-native")).toBe(true);
  });
});
