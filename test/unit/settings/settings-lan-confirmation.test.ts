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

describe("non-loopback bind confirmation gate", () => {
  it("requires explicit one-time confirmation to enable a non-loopback bind", async () => {
    const registry = createSettingsRegistry(emptyStore());
    const attempted = await registry.set(
      "server.bindHost",
      "0.0.0.0",
      undefined,
    );
    const snapshot = registry.snapshot();

    expect(attempted).toMatchObject({
      outcome: "confirmation_required",
      confirmation: {
        actionId: expect.any(String),
        settingKey: "server.bindHost",
        value: "0.0.0.0",
        message: expect.stringContaining("0.0.0.0") as string,
      },
    });
    expect(snapshot.confirmation).toBeDefined();
    // The pending value is visible but the effective bind must still be
    // loopback; a restart without confirmation must not listen on LAN.
    expect(snapshot.settings["server.bindHost"]).toMatchObject({
      value: "0.0.0.0",
      effective: "127.0.0.1",
    });
  });

  it("never asks for confirmation on the loopback default", async () => {
    const registry = createSettingsRegistry(emptyStore());
    const applied = await registry.set("server.bindHost", "127.0.0.1", undefined);

    expect(applied).toMatchObject({ outcome: "pending" });
    expect(applied).not.toHaveProperty("confirmation");
    expect(registry.snapshot().confirmation).toBeUndefined();
  });

  it("confirms the exact pending action once and clears the confirmation", async () => {
    const registry = createSettingsRegistry(emptyStore());
    const attempted = await registry.set(
      "server.bindHost",
      "0.0.0.0",
      undefined,
    );
    const actionId =
      attempted.outcome === "confirmation_required"
        ? attempted.confirmation?.actionId
        : undefined;
    expect(actionId).toBeDefined();

    const confirmed = await registry.confirm({
      actionId: actionId as string,
      token: undefined,
    });
    expect(confirmed).toMatchObject({ outcome: "applied" });

    const snapshot = registry.snapshot();
    expect(snapshot.confirmation).toBeUndefined();
    // A different host change is a new action and needs a new confirmation.
    const second = await registry.set("server.bindHost", "192.168.1.5", undefined);
    expect(second).toMatchObject({ outcome: "confirmation_required" });
  });

  it("rejects a confirm without a matching pending action", async () => {
    const registry = createSettingsRegistry(emptyStore());

    await expect(
      registry.confirm({ actionId: "no-such-action", token: undefined }),
    ).rejects.toThrow("confirmation");
  });
});
