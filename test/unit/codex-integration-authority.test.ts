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

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function nativeSource(entries: readonly CodexNativeCatalogEntry[]): CodexNativeCatalogSource {
  return Object.freeze({
    load: async () => ({ source: "bundled" as const, entries, warnings: [] }),
  });
}

async function fixture(options: {
  config?: string;
  nativeEntries?: readonly CodexNativeCatalogEntry[];
  routedSlug?: string;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "luckytoken-codex-integration-"));
  roots.push(root);
  const codexHome = join(root, "codex");
  const stateDirectory = join(root, "luckytoken", "integrations", "codex");
  await mkdir(codexHome, { recursive: true });
  const config = options.config ?? "model = \"gpt-5.6-sol\"\n[features]\nfoo = true\n";
  await writeFile(join(codexHome, "config.toml"), config, "utf8");
  const nativeEntries = options.nativeEntries ?? [
    { slug: "gpt-native", display_name: "GPT Native", base_instructions: "Codex native" },
  ];
  const routedSlug = options.routedSlug ?? "anthropic/claude-opus";
  const buildCatalog = async (
    native: readonly CodexNativeCatalogEntry[],
  ): Promise<CodexCatalogBuildResult> => ({
    content: `${JSON.stringify({
      models: [...native, { slug: routedSlug, display_name: routedSlug }],
    }, null, 2)}\n`,
    modelCount: native.length + 1,
    warnings: [],
  });
  const authority = createCodexIntegrationAuthority({
    codexHome,
    stateDirectory,
    endpoint: () => "http://127.0.0.1:3000/v1",
    nativeCatalog: nativeSource(nativeEntries),
    buildCatalog,
  });
  return { root, codexHome, stateDirectory, authority };
}

function countRootKey(content: string, key: string): number {
  const root = content.split(/^\s*\[/mu, 1)[0] ?? "";
  return root.split(/\r?\n/u).filter((line) => new RegExp(`^\\s*${key}\\s*=`).test(line)).length;
}

describe("Codex integration authority", () => {
  it("fails closed on a malformed v2 preimage instead of writing an invalid restore target", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-codex-invalid-state-"));
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
        schemaVersion: "luckytoken-codex-integration-v2",
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
        warnings: [],
      }),
    });

    await expect(authority.reconcile("startup")).rejects.toThrow(
      "Codex integration state is invalid",
    );
    expect(await readFile(join(codexHome, "config.toml"), "utf8")).toBe(original);
    expect(authority.nativeModels.has("gpt-native")).toBe(false);
  });

  it("defaults OFF, owns an empty native set, and query never changes Codex files", async () => {
    const fx = await fixture();
    const before = await readFile(join(fx.codexHome, "config.toml"), "utf8");

    const projection = await fx.authority.query();

    expect(projection.desiredEnabled).toBe(false);
    expect(projection.observedState).toBe("native");
    expect(fx.authority.nativeModels.has("gpt-native")).toBe(false);
    expect(await readFile(join(fx.codexHome, "config.toml"), "utf8")).toBe(before);
  });

  it("enable captures the three-key preimage, unconditionally converges them to LuckyToken, and publishes the same native snapshot", async () => {
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

  it("repeated active convergence never recaptures the LuckyToken projection or duplicates root keys", async () => {
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
    expect(await readFile(join(fx.codexHome, "config.toml"), "utf8")).toBe(
      'openai_base_url = "https://before.example/v1"\nmodel = "gpt-x"\n',
    );
  });

  it("disable restores each first-observed key to present/absent state and clears Local Native", async () => {
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

    expect(restored).toBe(original);
    expect(result.desiredEnabled).toBe(false);
    expect(result.message).toBeUndefined();
    expect(result.observedState).toBe("native");
    expect(restored).toContain('model_provider = "custom"');
    expect(restored).toContain('model_catalog_json = "C:/user/catalog.json"');
    expect(restored).not.toContain("openai_base_url");
    expect(restored).toContain('model = "old-model"');
    expect(fx.authority.nativeModels.has("gpt-native")).toBe(false);

    await expect(fx.authority.reconcile("disable")).resolves.toMatchObject({
      desiredEnabled: false,
      observedState: "native",
    });
  });

  it("active convergence repairs duplicate or malformed managed keys after the preimage is already known", async () => {
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

  it("restore converges back to the captured target even when managed keys drifted or duplicated", async () => {
    const original = 'openai_base_url = "https://before.example/v1"\n';
    const fx = await fixture({ config: original });
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

  it("shutdown restores the current preimage without changing the durable Enable intent", async () => {
    const original = 'openai_base_url = "https://before.example/v1"\n';
    const fx = await fixture({ config: original });
    await fx.authority.reconcile("enable");

    const shutdown = await fx.authority.reconcile("shutdown");

    expect(shutdown.desiredEnabled).toBe(true);
    expect(await readFile(join(fx.codexHome, "config.toml"), "utf8")).toBe(original);
    expect(fx.authority.nativeModels.has("gpt-native")).toBe(false);
  });

  it("shutdown fails instead of claiming success when an active preimage cannot be restored", async () => {
    const fx = await fixture({ config: 'openai_base_url = "https://before.example/v1"\n' });
    await fx.authority.reconcile("enable");
    await rm(join(fx.codexHome, "config.toml"), { force: true });

    await expect(fx.authority.reconcile("shutdown")).rejects.toThrow(
      "Codex integration could not be restored before LuckyToken shutdown",
    );
    expect(fx.authority.nativeModels.has("gpt-native")).toBe(false);
  });

  it("a later startup with Enable still ON captures changes made while LuckyToken was closed as the new restore target", async () => {
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

    expect(await readFile(join(fx.codexHome, "config.toml"), "utf8")).toBe(changedWhileClosed);
  });

  it("sync republishes native identity and catalog from one new snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-codex-integration-sync-"));
    roots.push(root);
    const codexHome = join(root, "codex");
    const stateDirectory = join(root, "state");
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, "config.toml"), "model = \"x\"\n", "utf8");
    let entries: readonly CodexNativeCatalogEntry[] = [{ slug: "gpt-a" }];
    const authority = createCodexIntegrationAuthority({
      codexHome,
      stateDirectory,
      endpoint: () => "http://127.0.0.1:3000/v1",
      nativeCatalog: { load: async () => ({ source: "bundled", entries, warnings: [] }) },
      buildCatalog: async (native) => ({
        content: `${JSON.stringify({ models: native })}\n`,
        modelCount: native.length,
        warnings: [],
      }),
    });
    await authority.reconcile("enable");
    expect(authority.nativeModels.has("gpt-a")).toBe(true);

    entries = [{ slug: "gpt-b" }];
    await authority.reconcile("sync");
    const catalog = await readFile(join(stateDirectory, "model-catalog.json"), "utf8");

    expect(authority.nativeModels.has("gpt-a")).toBe(false);
    expect(authority.nativeModels.has("gpt-b")).toBe(true);
    expect(catalog).toContain("gpt-b");
    expect(catalog).not.toContain("gpt-a");
  });

  it("native metadata absence leaves Local Native empty but still permits a routed catalog and injection", async () => {
    const fx = await fixture({ nativeEntries: [] });

    const result = await fx.authority.reconcile("enable");
    const catalog = await readFile(result.catalogPath, "utf8");

    expect(result.observedState).toBe("managed");
    expect(fx.authority.nativeModels.has("anything")).toBe(false);
    expect(catalog).toContain("anthropic/claude-opus");
  });

  it("preserves hash characters inside managed TOML string values instead of treating them as comments", async () => {
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
    const fx = await fixture({ config: original });

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

  it("fails closed on duplicate managed root keys instead of guessing which value to restore", async () => {
    const original = [
      'openai_base_url = "https://one.example/v1"',
      'openai_base_url = "https://two.example/v1"',
      "",
    ].join("\n");
    const fx = await fixture({ config: original });

    const result = await fx.authority.reconcile("enable");

    expect(result.desiredEnabled).toBe(true);
    expect(result.observedState).toBe("conflict");
    expect(result.message).toContain("duplicate");
    expect(await readFile(join(fx.codexHome, "config.toml"), "utf8")).toBe(original);
    expect(fx.authority.nativeModels.has("gpt-native")).toBe(false);
  });
});
