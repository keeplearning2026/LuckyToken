import { describe, expect, it } from "vitest";

import {
  CODEX_NATIVE_CONFIG_TARGET,
  inspectCodexManagedConfig,
  patchCodexManagedConfig,
} from "../../src/integrations/codex/config-toml.js";

const ACTIVE_TARGET = Object.freeze({
  modelProvider: "openai",
  openaiBaseUrl: "http://127.0.0.1:3000/v1",
  modelCatalogJson: "C:/Token/token-model-catalog.json",
  standaloneWebSearch: true,
});

describe("Codex config.toml managed editor", () => {
  it("overwrites existing managed values while preserving unrelated config", () => {
    const original = [
      '# user config',
      'model_provider = "custom"',
      'openai_base_url = "https://old.example/v1"',
      'model_catalog_json = "C:/user/catalog.json"',
      'model = "keep-me"',
      "",
      "[features]",
      "foo = true",
      "standalone_web_search = false",
      "",
    ].join("\n");

    const patched = patchCodexManagedConfig(original, ACTIVE_TARGET);
    const inspected = inspectCodexManagedConfig(patched);

    expect(inspected).toEqual({
      ok: true,
      values: ACTIVE_TARGET,
    });
    expect(patched).toContain('model = "keep-me"');
    expect(patched).toContain("foo = true");
    expect(patched).not.toContain("https://old.example/v1");
    expect(patched).not.toContain("C:/user/catalog.json");
  });

  it("adds missing managed values without disturbing nested feature tables", () => {
    const original = [
      'model = "keep-me"',
      "[features.other]",
      "enabled = true",
      "",
    ].join("\n");

    const patched = patchCodexManagedConfig(original, ACTIVE_TARGET);

    expect(inspectCodexManagedConfig(patched)).toEqual({
      ok: true,
      values: ACTIVE_TARGET,
    });
    expect(patched).toContain("[features.other]");
    expect(patched).toContain("enabled = true");
  });

  it.each([
    'features.other.enabled = true\n',
    '[features.other]\nsettings.value = "keep"\n',
    'features = { other = { enabled = true }, standalone_web_search = false }\n',
    '["features"]\nfoo = true\n',
  ])("patches complex valid features shapes without producing invalid TOML: %s", (original) => {
    const patched = patchCodexManagedConfig(original, ACTIVE_TARGET);
    const restored = patchCodexManagedConfig(
      patched,
      CODEX_NATIVE_CONFIG_TARGET,
    );

    expect(inspectCodexManagedConfig(patched)).toEqual({
      ok: true,
      values: ACTIVE_TARGET,
    });
    expect(inspectCodexManagedConfig(restored)).toEqual({
      ok: true,
      values: CODEX_NATIVE_CONFIG_TARGET,
    });
    expect(restored).not.toContain("standalone_web_search");
  });

  it("handles quoted keys, multiline strings, inline features, comments, and CRLF", () => {
    const original = [
      '# provider note',
      '"model_provider" = "custom"',
      "'openai_base_url' = \"\"\"",
      "https://old.example/v1",
      "\"\"\"",
      'features = { foo = true, standalone_web_search = false }',
      "",
    ].join("\r\n");

    const patched = patchCodexManagedConfig(original, ACTIVE_TARGET);
    const restored = patchCodexManagedConfig(patched, CODEX_NATIVE_CONFIG_TARGET);

    expect(inspectCodexManagedConfig(patched)).toEqual({
      ok: true,
      values: ACTIVE_TARGET,
    });
    expect(inspectCodexManagedConfig(restored)).toEqual({
      ok: true,
      values: CODEX_NATIVE_CONFIG_TARGET,
    });
    expect(restored).toContain("features = { foo = true }");
    expect(restored.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("removes only the four managed values when restoring native defaults", () => {
    const active = [
      'model_provider = "openai"',
      'openai_base_url = "http://127.0.0.1:3000/v1"',
      'model_catalog_json = "C:/Token/token-model-catalog.json"',
      'model = "keep-me"',
      "",
      "[features]",
      "foo = true",
      "standalone_web_search = true",
      "",
    ].join("\n");

    const restored = patchCodexManagedConfig(active, CODEX_NATIVE_CONFIG_TARGET);

    expect(inspectCodexManagedConfig(restored)).toEqual({
      ok: true,
      values: CODEX_NATIVE_CONFIG_TARGET,
    });
    expect(restored).toContain('model = "keep-me"');
    expect(restored).toContain("foo = true");
    expect(restored).not.toContain("model_provider");
    expect(restored).not.toContain("openai_base_url");
    expect(restored).not.toContain("model_catalog_json");
    expect(restored).not.toContain("standalone_web_search");
  });

  it("leaves an empty features table rather than claiming ownership of the table itself", () => {
    const patched = patchCodexManagedConfig('model = "keep-me"\n', ACTIVE_TARGET);
    const restored = patchCodexManagedConfig(patched, CODEX_NATIVE_CONFIG_TARGET);

    expect(restored).toContain("[features]");
    expect(restored).not.toContain("standalone_web_search");
  });

  it("rejects invalid TOML and incompatible managed containers instead of guessing", () => {
    expect(() =>
      patchCodexManagedConfig(
        'openai_base_url = "one"\nopenai_base_url = "two"\n',
        ACTIVE_TARGET,
      ),
    ).toThrow("Codex config.toml is not valid TOML");

    expect(() =>
      patchCodexManagedConfig(
        'features = "not-a-table"\n',
        ACTIVE_TARGET,
      ),
    ).toThrow("Codex config.toml features must be a table");

    expect(() =>
      patchCodexManagedConfig(
        "[model_provider]\nvalue = 1\n",
        ACTIVE_TARGET,
      ),
    ).toThrow("Codex config.toml model_provider must be a string");
  });
});
