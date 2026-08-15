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
      "server.port",
      "server.bindHost",
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

    const port = byKey.get("server.port");
    expect(port).toMatchObject({
      key: "server.port",
      type: "number",
      default: 3000,
      sensitivity: "public",
      applyMode: "restart-required",
      value: 3000,
      effective: 3000,
    });
    expect(port?.validation).toBeDefined();

    const bindHost = byKey.get("server.bindHost");
    expect(bindHost).toMatchObject({
      key: "server.bindHost",
      type: "string",
      default: "127.0.0.1",
      sensitivity: "public",
      applyMode: "restart-required",
      value: "127.0.0.1",
      effective: "127.0.0.1",
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

  it("validates values and rejects values outside the declared validation", () => {
    const registry = createSettingsRegistry(emptyStore());
    const port = registry.catalog().find((setting) => setting.key === "server.port");
    const portValidation = port?.validation as {
      readonly minimum: number;
      readonly maximum: number;
      readonly type: string;
    };
    expect(portValidation).toEqual({ type: "integer", minimum: 1, maximum: 65_535 });

    expect(registry.validate("server.port", 0)).toMatchObject({
      valid: false,
    });
    expect(registry.validate("server.port", 65_536)).toMatchObject({
      valid: false,
    });
    expect(registry.validate("server.port", 3000)).toMatchObject({ valid: true });
    expect(registry.validate("server.bindHost", "0.0.0.0")).toMatchObject({
      valid: true,
    });
    expect(registry.validate("server.bindHost", "not a host")).toMatchObject({
      valid: false,
    });
    expect(registry.validate("protocols.anthropic-messages.enabled", true)).toMatchObject({
      valid: true,
    });
  });
});
