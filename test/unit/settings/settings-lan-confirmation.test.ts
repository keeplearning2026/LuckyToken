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

describe("removed LAN bind settings surface", () => {
  it("has no bind-host setting, confirmation state, or confirm operation", async () => {
    const registry = createSettingsRegistry(emptyStore());

    await expect(
      registry.set("server.bindHost", "0.0.0.0", undefined),
    ).resolves.toMatchObject({ outcome: "unknown_key" });
    expect(registry.snapshot()).toEqual({ settings: registry.query([]) });
    expect("confirm" in registry).toBe(false);
    expect("confirmation" in registry.snapshot()).toBe(false);
  });
});
