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
      "diagnostics.deepCapture.enabled",
      "application.quitDrainTimeoutMs",
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
