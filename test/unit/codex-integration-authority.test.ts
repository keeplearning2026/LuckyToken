import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createCodexIntegrationAuthority } from "../../src/integrations/codex/integration.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(
  config = "model = \"gpt-5.6-sol\"\n[features]\nfoo = true\n",
  localAuthAvailable = true,
) {
  const root = await mkdtemp(join(tmpdir(), "luckytoken-codex-integration-"));
  roots.push(root);
  const codexHome = join(root, "codex");
  const stateDirectory = join(root, "luckytoken", "integrations", "codex");
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(codexHome, "config.toml"), config, "utf8");
  const authority = createCodexIntegrationAuthority({
    codexHome,
    stateDirectory,
    endpoint: () => "http://127.0.0.1:3000/v1",
    localAuthAvailable: async () => localAuthAvailable,
    buildCatalog: async () => ({
      content: `${JSON.stringify({ models: [{ slug: "gpt-native" }] }, null, 2)}\n`,
      modelCount: 1,
      warnings: [],
    }),
  });
  return { root, codexHome, stateDirectory, authority };
}

describe("Codex managed integration authority", () => {
  it("defaults OFF and a query never changes Codex files", async () => {
    const fx = await fixture();
    const before = await readFile(join(fx.codexHome, "config.toml"), "utf8");

    const projection = await fx.authority.query();

    expect(projection.desiredEnabled).toBe(false);
    expect(projection.observedState).toBe("native");
    expect(await readFile(join(fx.codexHome, "config.toml"), "utf8")).toBe(before);
  });

  it("refuses enable when the local Codex OAuth credential is unavailable", async () => {
    const original = "model = \"gpt-5.6-sol\"\n[features]\nfoo = true\n";
    const fx = await fixture(original, false);

    const result = await fx.authority.setEnabled(true);

    expect(result.desiredEnabled).toBe(false);
    expect(result.message).toContain("authentication");
    expect(await readFile(join(fx.codexHome, "config.toml"), "utf8")).toBe(original);
  });

  it("enables by patching only LuckyToken-owned root keys and preserves the rest of config.toml", async () => {
    const fx = await fixture();

    const result = await fx.authority.setEnabled(true);
    const content = await readFile(join(fx.codexHome, "config.toml"), "utf8");

    expect(result.desiredEnabled).toBe(true);
    expect(result.observedState).toBe("managed");
    expect(content).toContain('model = "gpt-5.6-sol"');
    expect(content).toContain("[features]");
    expect(content).toContain("foo = true");
    expect(content).toContain('openai_base_url = "http://127.0.0.1:3000/v1"');
    expect(content).toContain("model_catalog_json = ");
    expect(content).not.toContain('model_provider = "luckytoken"');
    expect(await readFile(result.catalogPath, "utf8")).toContain('"slug": "gpt-native"');
  });

  it("disable persists OFF then restores the exact original config when the managed bytes are unchanged", async () => {
    const original = "model = \"gpt-5.6-sol\"\n[features]\nfoo = true\n";
    const fx = await fixture(original);
    await fx.authority.setEnabled(true);

    const result = await fx.authority.setEnabled(false);

    expect(result.desiredEnabled).toBe(false);
    expect(result.observedState).toBe("native");
    expect(await readFile(join(fx.codexHome, "config.toml"), "utf8")).toBe(original);
  });

  it("keeps an externally owned Codex route as conflict when the already-off switch is set off again", async () => {
    const original = 'openai_base_url = "https://user-proxy.example/v1"\nmodel = "gpt-5.6-sol"\n';
    const fx = await fixture(original);

    const before = await fx.authority.query();
    const disabled = await fx.authority.setEnabled(false);

    expect(before.observedState).toBe("conflict");
    expect(disabled.desiredEnabled).toBe(false);
    expect(disabled.observedState).toBe("conflict");
    expect(await readFile(join(fx.codexHome, "config.toml"), "utf8")).toBe(original);
  });

  it("refuses enable without changing desired state when the user owns openai_base_url", async () => {
    const original = 'openai_base_url = "https://user-proxy.example/v1"\nmodel = "gpt-5.6-sol"\n';
    const fx = await fixture(original);

    const result = await fx.authority.setEnabled(true);

    expect(result.desiredEnabled).toBe(false);
    expect(result.observedState).toBe("conflict");
    expect(result.message).toContain("openai_base_url");
    expect(await readFile(join(fx.codexHome, "config.toml"), "utf8")).toBe(original);
  });

  it("refuses an external root model_provider and never retags Codex history/provider identity", async () => {
    const original = 'model_provider = "other"\nmodel = "their-model"\n';
    const fx = await fixture(original);

    const result = await fx.authority.setEnabled(true);

    expect(result.desiredEnabled).toBe(false);
    expect(result.observedState).toBe("conflict");
    expect(result.message).toContain("model_provider");
    expect(await readFile(join(fx.codexHome, "config.toml"), "utf8")).toBe(original);
  });

  it("does not overwrite user edits made after enable; it removes only unchanged LuckyToken-owned keys", async () => {
    const fx = await fixture();
    await fx.authority.setEnabled(true);
    const configPath = join(fx.codexHome, "config.toml");
    const injected = await readFile(configPath, "utf8");
    await writeFile(configPath, `${injected}\n# user edit\n`, "utf8");

    const result = await fx.authority.setEnabled(false);
    const restored = await readFile(configPath, "utf8");

    expect(result.desiredEnabled).toBe(false);
    expect(result.observedState).toBe("native");
    expect(restored).toContain("# user edit");
    expect(restored).not.toContain("openai_base_url");
    expect(restored).not.toContain("model_catalog_json");
  });

  it("keeps a failed disable classified as drifted on later queries", async () => {
    const fx = await fixture();
    await fx.authority.setEnabled(true);
    const configPath = join(fx.codexHome, "config.toml");
    const injected = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      injected.replace(
        'openai_base_url = "http://127.0.0.1:3000/v1"',
        'openai_base_url = "https://user-changed.example/v1"',
      ),
      "utf8",
    );

    const disabled = await fx.authority.setEnabled(false);
    const queried = await fx.authority.query();

    expect(disabled.observedState).toBe("drifted");
    expect(queried.desiredEnabled).toBe(false);
    expect(queried.observedState).toBe("drifted");
    expect(await readFile(configPath, "utf8")).toContain(
      'openai_base_url = "https://user-changed.example/v1"',
    );
  });

  it("does not claim restore success when a managed marker was removed but its routing value remains", async () => {
    const fx = await fixture();
    await fx.authority.setEnabled(true);
    const configPath = join(fx.codexHome, "config.toml");
    const injected = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      injected.replace("# LuckyToken managed: openai_base_url\n", ""),
      "utf8",
    );

    const disabled = await fx.authority.setEnabled(false);
    const queried = await fx.authority.query();
    const current = await readFile(configPath, "utf8");

    expect(disabled.desiredEnabled).toBe(false);
    expect(disabled.observedState).toBe("drifted");
    expect(queried.observedState).toBe("drifted");
    expect(current).toContain('openai_base_url = "http://127.0.0.1:3000/v1"');
  });

  it("reports drift and preserves a managed key that the user changed after enable", async () => {
    const fx = await fixture();
    await fx.authority.setEnabled(true);
    const configPath = join(fx.codexHome, "config.toml");
    const injected = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      injected.replace(
        'openai_base_url = "http://127.0.0.1:3000/v1"',
        'openai_base_url = "https://user-changed.example/v1"',
      ),
      "utf8",
    );

    const result = await fx.authority.setEnabled(false);
    const current = await readFile(configPath, "utf8");

    expect(result.desiredEnabled).toBe(false);
    expect(result.observedState).toBe("drifted");
    expect(current).toContain('openai_base_url = "https://user-changed.example/v1"');
  });
});
