import { describe, expect, it } from "vitest";

import { isLoopbackHost, resolveEffectiveSettings } from "../../../src/settings/data-plane.js";
import type { RegisteredSetting } from "../../../src/settings/catalog.js";

function setting(
  key: string,
  type: RegisteredSetting["type"],
  value: boolean | number | string,
  applyMode: RegisteredSetting["applyMode"],
  effective?: boolean | number | string,
): RegisteredSetting {
  return {
    key,
    type,
    default: type === "boolean" ? true : type === "number" ? 3000 : "127.0.0.1",
    validation: type === "boolean" ? { type: "boolean" } : type === "number"
      ? { type: "integer", minimum: 1, maximum: 65_535 }
      : { type: "host", label: "bind host" },
    sensitivity: "public",
    applyMode,
    value,
    ...(effective === undefined ? {} : { effective }),
  };
}

describe("settings to Data Plane resolution", () => {
  it("resolves effective bind and port from the registry", () => {
    expect(
      resolveEffectiveSettings({
        "server.port": setting("server.port", "number", 3200, "restart-required", 3200),
        "server.bindHost": setting(
          "server.bindHost",
          "string",
          "0.0.0.0",
          "restart-required",
          "0.0.0.0",
        ),
      }),
    ).toEqual({ host: "0.0.0.0", port: 3200 });
  });

  it("never falls back to a random or default port when a fixed effective port is set", () => {
    expect(
      resolveEffectiveSettings({
        "server.port": setting("server.port", "number", 3200, "restart-required", 3200),
        "server.bindHost": setting(
          "server.bindHost",
          "string",
          "127.0.0.1",
          "restart-required",
          "127.0.0.1",
        ),
      }),
    ).toEqual({ host: "127.0.0.1", port: 3200 });
  });

  it("falls back to declared defaults when the registry is empty", () => {
    expect(resolveEffectiveSettings({})).toEqual({ host: "127.0.0.1", port: 3000 });
  });

  it("classifies loopback hosts as never requiring a warning", () => {
    for (const host of ["127.0.0.1", "localhost", "::1", "[::1]"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of ["0.0.0.0", "192.168.1.5", "10.0.0.2"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});
