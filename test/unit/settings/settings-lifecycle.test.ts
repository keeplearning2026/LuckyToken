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
  it("keeps the old authoritative value when persistence fails", async () => {
    const registry = createSettingsRegistry({
      async load() {
        return { "protocols.anthropic-messages.enabled": true };
      },
      async save() {
        throw new Error("disk full: must not cross the settings contract");
      },
    });
    await registry.load();

    const result = await registry.set(
      "protocols.anthropic-messages.enabled",
      false,
      undefined,
    );

    expect(result).toMatchObject({
      outcome: "storage_failure",
      error: "Settings could not be saved",
      settings: {
        "protocols.anthropic-messages.enabled": { value: true },
      },
    });
    expect(registry.snapshot().settings["protocols.anthropic-messages.enabled"]?.value).toBe(true);
  });

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

  it("serializes concurrent mutations and publishes only after each save", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstSave = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const saved: Array<Readonly<Record<string, unknown>>> = [];
    let saves = 0;
    const registry = createSettingsRegistry({
      async load() {
        return {};
      },
      async save(document) {
        saves += 1;
        if (saves === 1) await firstSave;
        saved.push({ ...document });
      },
    });

    const first = registry.set("protocols.openai-responses.enabled", false, undefined);
    const second = registry.set("protocols.openai-responses.enabled", true, undefined);
    await expect.poll(() => saves).toBe(1);
    expect(registry.snapshot().settings["protocols.openai-responses.enabled"]?.value).toBe(true);
    releaseFirst?.();

    await expect(first).resolves.toMatchObject({ outcome: "applied" });
    await expect(second).resolves.toMatchObject({ outcome: "applied" });
    expect(saved).toHaveLength(2);
    expect(saved[0]?.["protocols.openai-responses.enabled"]).toBe(false);
    expect(saved[1]?.["protocols.openai-responses.enabled"]).toBe(true);
    expect(registry.snapshot().settings["protocols.openai-responses.enabled"]?.value).toBe(true);
  });

  it("recovers the mutation queue after one save failure", async () => {
    let attempts = 0;
    let durable: Readonly<Record<string, unknown>> = {};
    const registry = createSettingsRegistry({
      async load() {
        return {};
      },
      async save(document) {
        attempts += 1;
        if (attempts === 1) throw new Error("first save failed");
        durable = { ...document };
      },
    });

    const first = registry.set("protocols.openai-responses.enabled", false, undefined);
    const second = registry.set("protocols.openai-responses.enabled", false, undefined);

    await expect(first).resolves.toMatchObject({ outcome: "storage_failure" });
    await expect(second).resolves.toMatchObject({ outcome: "applied" });
    expect(durable["protocols.openai-responses.enabled"]).toBe(false);
  });

  it("shares a concurrent load and retries after a failed load", async () => {
    let reads = 0;
    const registry = createSettingsRegistry({
      async load() {
        reads += 1;
        if (reads === 1) throw new Error("temporary read failure");
        return { "protocols.openai-responses.enabled": false };
      },
      async save() {},
    });

    await expect(Promise.all([registry.load(), registry.load()])).rejects.toThrow(
      "temporary read failure",
    );
    expect(reads).toBe(1);
    await registry.load();
    expect(reads).toBe(2);
    expect(registry.snapshot().settings["protocols.openai-responses.enabled"]?.value).toBe(false);
  });
});
