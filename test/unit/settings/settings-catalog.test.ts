import { describe, expect, it } from "vitest";

import {
  createSettingsRegistry,
  type SettingsStore,
} from "../../../src/settings/catalog.js";

function emptyStore(): SettingsStore {
  return {
    async load() {
      return {};
    },
    async save() {},
  };
}

describe("authoritative registered settings catalog", () => {
  it("declares type, default, validation, sensitivity, and apply mode for every stable setting", () => {
    const registry = createSettingsRegistry(emptyStore());
    const catalog = registry.catalog();
    const byKey = new Map(catalog.map((setting) => [setting.key, setting]));

    expect(catalog.map((setting) => setting.key)).toEqual([
      "protocols.anthropic-messages.enabled",
      "protocols.openai-responses.enabled",
      "application.quitDrainTimeoutMs",
      "credentials.autoLocalOAuth.enabled",
      "providerUsage.refreshIntervalMinutes",
      "providerUsage.refreshTimeoutSeconds",
      "diagnostics.fullJourneyCapture.enabled",
      "diagnostics.failedJourneyCapture.enabled",
      "integrations.codex.searchModel",
      "integrations.claude.model",
      "integrations.claude.opusModel",
      "integrations.claude.sonnetModel",
      "integrations.claude.haikuModel",
      "integrations.claude.subagentModel",
      "protocols.openai-responses.responseRepair.functionCallNamespace.providerNative",
    ]);

    const anthropic = byKey.get("protocols.anthropic-messages.enabled");
    expect(byKey.get("credentials.autoLocalOAuth.enabled")).toMatchObject({
      type: "boolean", default: false, value: false, applyMode: "hot-apply",
    });
    expect(registry.validate("credentials.autoLocalOAuth.enabled", true)).toEqual({ valid: true });
    expect(registry.validate("credentials.autoLocalOAuth.enabled", "true")).toMatchObject({ valid: false });
    expect(anthropic).toMatchObject({
      key: "protocols.anthropic-messages.enabled",
      type: "boolean",
      default: true,
      sensitivity: "public",
      applyMode: "hot-apply",
      value: true,
    });
    expect(anthropic?.validation).toBeDefined();

    const drainTimeout = byKey.get("application.quitDrainTimeoutMs");
    expect(drainTimeout).toMatchObject({
      key: "application.quitDrainTimeoutMs",
      type: "number",
      default: 5000,
      sensitivity: "public",
      applyMode: "hot-apply",
      value: 5000,
    });
    expect(registry.validate("application.quitDrainTimeoutMs", -1)).toMatchObject({
      valid: false,
    });
    expect(registry.validate("application.quitDrainTimeoutMs", 301_000)).toMatchObject({
      valid: false,
    });
    expect(registry.validate("application.quitDrainTimeoutMs", 750)).toMatchObject({
      valid: true,
    });

    expect(byKey.get("providerUsage.refreshIntervalMinutes")).toMatchObject({
      type: "number",
      default: 15,
      validation: { type: "integer", minimum: 1, maximum: 1440 },
      applyMode: "hot-apply",
      value: 15,
    });
    expect(registry.validate("providerUsage.refreshIntervalMinutes", 1)).toEqual({ valid: true });
    expect(registry.validate("providerUsage.refreshIntervalMinutes", 0)).toMatchObject({ valid: false });
    expect(registry.validate("providerUsage.refreshIntervalMinutes", 1441)).toMatchObject({ valid: false });

    expect(byKey.get("providerUsage.refreshTimeoutSeconds")).toMatchObject({
      type: "number",
      default: 45,
      validation: { type: "integer", minimum: 5, maximum: 600 },
      applyMode: "hot-apply",
      value: 45,
    });
    expect(registry.validate("providerUsage.refreshTimeoutSeconds", 5)).toEqual({ valid: true });
    expect(registry.validate("providerUsage.refreshTimeoutSeconds", 4)).toMatchObject({ valid: false });
    expect(registry.validate("providerUsage.refreshTimeoutSeconds", 601)).toMatchObject({ valid: false });

    const fullJourneyCapture = byKey.get(
      "diagnostics.fullJourneyCapture.enabled",
    );
    expect(fullJourneyCapture).toMatchObject({
      key: "diagnostics.fullJourneyCapture.enabled",
      type: "boolean",
      default: false,
      validation: { type: "boolean" },
      sensitivity: "public",
      applyMode: "hot-apply",
      value: false,
    });
    expect(
      registry.validate("diagnostics.fullJourneyCapture.enabled", true),
    ).toEqual({ valid: true });
    expect(
      registry.validate("diagnostics.fullJourneyCapture.enabled", "true"),
    ).toMatchObject({ valid: false });

    expect(byKey.get("diagnostics.failedJourneyCapture.enabled")).toMatchObject({
      key: "diagnostics.failedJourneyCapture.enabled",
      type: "boolean",
      default: true,
      validation: { type: "boolean" },
      sensitivity: "public",
      applyMode: "hot-apply",
      value: true,
    });

    expect(byKey.get("integrations.codex.searchModel")).toMatchObject({
      type: "string",
      default: "gpt-6-luna",
      validation: { type: "model-name" },
      applyMode: "hot-apply",
      value: "gpt-6-luna",
    });
    expect(registry.validate("integrations.codex.searchModel", "gpt-5.6-sol")).toEqual({ valid: true });
    expect(registry.validate("integrations.codex.searchModel", "")).toMatchObject({ valid: false });

    for (const key of [
      "integrations.claude.model",
      "integrations.claude.opusModel",
      "integrations.claude.sonnetModel",
      "integrations.claude.haikuModel",
      "integrations.claude.subagentModel",
    ]) {
      expect(byKey.get(key)).toMatchObject({
        type: "nullable-string",
        default: null,
        validation: { type: "nullable-string" },
        applyMode: "hot-apply",
        value: null,
      });
      expect(registry.validate(key, "provider/model with spaces")).toEqual({ valid: true });
      expect(registry.validate(key, null)).toEqual({ valid: true });
      expect(registry.validate(key, "")).toMatchObject({ valid: false });
    }

    for (const key of [
      "integrations.codex.preimage.modelProvider",
      "integrations.codex.preimage.openaiBaseUrl",
      "integrations.codex.preimage.modelCatalogJson",
      "integrations.codex.preimage.standaloneWebSearch",
    ]) {
      expect(byKey.has(key)).toBe(false);
      expect(registry.validate(key, null)).toMatchObject({
        valid: false,
        error: `${key} is not a registered setting`,
      });
    }
  });

  it("never exposes unregistered fields or ambient internal variables", () => {
    const registry = createSettingsRegistry(emptyStore());
    const catalog = registry.catalog();

    expect(catalog.some((setting) => setting.key.includes("internal"))).toBe(false);
    expect(catalog.some((setting) => setting.key.includes("env"))).toBe(false);
    expect(registry.query(["server.port", "unknown.internal.flag"])).toMatchObject(
      {},
    );
    expect(registry.query(["unknown.internal.flag"])).toEqual({});
  });

  it("does not expose a configurable bind host", () => {
    const registry = createSettingsRegistry(emptyStore());

    expect(registry.catalog().some((setting) => setting.key === "server.bindHost")).toBe(false);
    expect(registry.query(["server.bindHost"])).toEqual({});
    expect(registry.validate("server.bindHost", "0.0.0.0")).toMatchObject({
      valid: false,
      error: "server.bindHost is not a registered setting",
    });
  });

  it("validates values and rejects values outside the declared validation", () => {
    const registry = createSettingsRegistry(emptyStore());
    expect(registry.validate("server.port", 3000)).toMatchObject({
      valid: false,
      error: "server.port is not a registered setting",
    });
    expect(registry.validate("application.quitDrainTimeoutMs", 99_999)).toMatchObject({
      valid: true,
    });
    expect(registry.validate("protocols.anthropic-messages.enabled", true)).toMatchObject({
      valid: true,
    });
  });

  it("keeps the Provider Usage refresh timeout below the automatic refresh interval", async () => {
    const registry = createSettingsRegistry(emptyStore());
    await registry.load();

    expect(
      await registry.set(
        "providerUsage.refreshTimeoutSeconds",
        120,
        undefined,
      ),
    ).toMatchObject({ outcome: "applied" });
    expect(
      await registry.set(
        "providerUsage.refreshIntervalMinutes",
        3,
        undefined,
      ),
    ).toMatchObject({ outcome: "applied" });
    expect(
      registry.validate("providerUsage.refreshTimeoutSeconds", 180),
    ).toMatchObject({ valid: false });
    expect(
      await registry.set(
        "providerUsage.refreshIntervalMinutes",
        2,
        undefined,
      ),
    ).toMatchObject({ outcome: "invalid_value" });
  });

  it("drops an invalid persisted Provider Usage timeout to its default", async () => {
    const registry = createSettingsRegistry({
      async load() {
        return {
          "providerUsage.refreshIntervalMinutes": 1,
          "providerUsage.refreshTimeoutSeconds": 60,
        };
      },
      async save() {},
    });
    await registry.load();

    expect(
      registry.query(["providerUsage.refreshTimeoutSeconds"])[
        "providerUsage.refreshTimeoutSeconds"
      ]?.value,
    ).toBe(45);
  });
});
