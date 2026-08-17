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

  it("applies pending restart-required settings once their action is confirmed", async () => {
    const registry = createSettingsRegistry(emptyStore());
    await registry.set("server.port", 3200, undefined);
    const attempted = await registry.set("server.bindHost", "0.0.0.0", undefined);
    const actionId =
      attempted.outcome === "confirmation_required"
        ? attempted.confirmation?.actionId
        : undefined;
    expect(actionId).toBeDefined();

    const confirmed = await registry.confirm({
      actionId: actionId as string,
      token: undefined,
    });
    const snapshot = registry.snapshot();

    expect(confirmed).toMatchObject({ outcome: "applied" });
    expect(snapshot.settings).toMatchObject({
      "server.port": { value: 3200, effective: 3200 },
      "server.bindHost": { value: "0.0.0.0", effective: "0.0.0.0" },
    });
    // Effective bindHost is non-loopback, so the confirmed action must also
    // have been recorded as a completed LAN enable.
    expect(snapshot.confirmation).toBeUndefined();
  });
});
