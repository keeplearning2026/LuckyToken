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
      "diagnostics.fullJourneyCapture.enabled",
      "diagnostics.failedJourneyCapture.enabled",
      "integrations.codex.preimage.modelProvider",
      "integrations.codex.preimage.openaiBaseUrl",
      "integrations.codex.preimage.modelCatalogJson",
    ]);

    const anthropic = byKey.get("protocols.anthropic-messages.enabled");
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

    for (const key of [
      "integrations.codex.preimage.modelProvider",
      "integrations.codex.preimage.openaiBaseUrl",
      "integrations.codex.preimage.modelCatalogJson",
    ]) {
      expect(byKey.get(key)).toMatchObject({
        key,
        type: "nullable-string",
        default: null,
        validation: { type: "nullable-string" },
        sensitivity: "public",
        applyMode: "hot-apply",
        value: null,
      });
      expect(registry.validate(key, null)).toMatchObject({ valid: true });
      expect(registry.validate(key, "configured-value")).toMatchObject({ valid: true });
      expect(registry.validate(key, "")).toMatchObject({ valid: false });
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
});
