import { describe, expect, it } from "vitest";

import {
  DATA_PLANE_LOOPBACK_HOST,
  resolveEffectiveSettings,
} from "../../../src/settings/data-plane.js";
import type { RegisteredSetting } from "../../../src/settings/catalog.js";

function portSetting(value: number, effective: number): RegisteredSetting {
  return {
    key: "server.port",
    type: "number",
    default: 3000,
    validation: { type: "integer", minimum: 1, maximum: 65_535 },
    sensitivity: "public",
    applyMode: "restart-required",
    value,
    effective,
  };
}

describe("settings to Data Plane resolution", () => {
  it("always resolves the fixed loopback host with the effective port", () => {
    expect(
      resolveEffectiveSettings({
        "server.port": portSetting(3280, 3200),
      }),
    ).toEqual({ host: DATA_PLANE_LOOPBACK_HOST, port: 3200 });
  });

  it("uses the fixed loopback host and declared default port when the registry is empty", () => {
    expect(resolveEffectiveSettings({})).toEqual({
      host: DATA_PLANE_LOOPBACK_HOST,
      port: 3000,
    });
  });
});
