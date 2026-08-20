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
  it("does not admit the Public Model endpoint port into the Settings authority", async () => {
    const registry = createSettingsRegistry(emptyStore());
    const applied = await registry.set("server.port", 3100, undefined);

    expect(applied).toMatchObject({ outcome: "unknown_key" });
    expect(registry.snapshot().settings).not.toHaveProperty("server.port");
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

  it("restores persisted hot-apply settings when a new registry loads", async () => {
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
    await first.set("protocols.openai-responses.enabled", false, undefined);
    expect(first.snapshot().settings["protocols.openai-responses.enabled"]).toMatchObject({
      value: false,
      applyMode: "hot-apply",
    });

    const restarted = createSettingsRegistry(store);
    await restarted.load();
    expect(restarted.snapshot().settings["protocols.openai-responses.enabled"]).toMatchObject({
      value: false,
      applyMode: "hot-apply",
    });
  });
});
