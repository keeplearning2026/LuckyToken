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

describe("settings registry pending and effective lifecycle", () => {
  it("reports pending versus effective only for restart-required settings", async () => {
    const registry = createSettingsRegistry(emptyStore());
    const applied = await registry.set(
      "server.port",
      3100,
      undefined,
    );
    const snapshot = registry.snapshot();

    expect(applied).toMatchObject({
      outcome: "pending",
    });
    expect(snapshot.settings).toMatchObject({
      "server.port": {
        key: "server.port",
        type: "number",
        default: 3000,
        sensitivity: "public",
        applyMode: "restart-required",
        value: 3100,
        effective: 3000,
      },
    });
  });

  it("applies hot-apply settings immediately without pending state", async () => {
    const registry = createSettingsRegistry(emptyStore());
    const applied = await registry.set(
      "protocols.anthropic-messages.enabled",
      false,
      undefined,
    );
    const snapshot = registry.snapshot();

    expect(applied).toMatchObject({ outcome: "applied" });
    expect(snapshot.settings).toMatchObject({
      "protocols.anthropic-messages.enabled": {
        value: false,
        applyMode: "hot-apply",
      },
    });
    // Hot-apply settings carry no effective value.
    expect(snapshot.settings["protocols.anthropic-messages.enabled"]).not.toHaveProperty(
      "effective",
    );
  });

  it("makes a persisted restart-required port effective after a new registry loads", async () => {
    let persisted: Record<string, unknown> = {};
    const store: SettingsStore = {
      async load() {
        return { ...persisted };
      },
      async save(settings) {
        persisted = { ...settings };
      },
    };
    const first = createSettingsRegistry(store);
    await first.set("server.port", 3200, undefined);
    expect(first.snapshot().settings["server.port"]).toMatchObject({
      value: 3200,
      effective: 3000,
    });

    const restarted = createSettingsRegistry(store);
    await restarted.load();
    expect(restarted.snapshot().settings["server.port"]).toMatchObject({
      value: 3200,
      effective: 3200,
    });
  });
});
