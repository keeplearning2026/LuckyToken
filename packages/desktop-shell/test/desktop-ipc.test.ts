import { describe, expect, it, vi } from "vitest";
import type { ControlPlaneClient } from "@luckytoken/application-control-plane/control-plane";

import {
  registerDesktopIpcHandlers,
  type DesktopIpcHandler,
} from "../src/main/desktop-ipc.js";
import { desktopIpcChannels } from "../src/shared/ipc-channels.js";

function fixture() {
  const handlers = new Map<string, DesktopIpcHandler>();
  const registrar = {
    handle: vi.fn((channel: string, handler: DesktopIpcHandler) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  };
  const ledgerStop = vi.fn(async () => undefined);
  const runtimeResult = {
    command: "start" as const,
    outcome: "started" as const,
    snapshot: { sequence: 1, modelDataPlane: "running" as const, provider: "configured" as const },
  };
  const client = {
    getStatus: vi.fn(async () => runtimeResult.snapshot),
    executeRuntimeCommand: vi.fn(async () => runtimeResult),
    executeAuthCommand: vi.fn(async (_command, onInteraction) => {
      onInteraction?.({ type: "progress", message: "Signing in" });
      return { outcome: "ok", state: { revision: 1, path: "auth.json", present: true, valid: true, providers: [] } };
    }),
    subscribeRequestLedger: vi.fn(async (listener) => {
      listener({ type: "request_ledger", record: { id: 1 } } as never);
      return ledgerStop;
    }),
  } as unknown as ControlPlaneClient;
  const session = {
    client: () => client,
  } as never;
  const platform = {
    getAutoStart: vi.fn(async () => false),
    setAutoStart: vi.fn(async (enabled: boolean) => enabled),
    pickDirectory: vi.fn(async () => "C:/project"),
    pickSaveFile: vi.fn(async () => "C:/export.zip"),
    openExternal: vi.fn(async () => undefined),
    getDesktopVersion: vi.fn(async () => "1.0.0"),
  };
  const bridge = registerDesktopIpcHandlers({
    registrar,
    session,
    platform,
    isTrustedSender: (senderId) => senderId === 7,
  });
  const event = (senderId: number) => ({
    senderId,
    send: vi.fn(),
  });
  return { handlers, registrar, client, platform, bridge, ledgerStop, runtimeResult, event };
}

describe("typed Electron desktop IPC", () => {
  it("rejects an untrusted sender before any privileged operation", async () => {
    const { handlers, client, event } = fixture();
    await expect(
      handlers.get(desktopIpcChannels.runtime)?.(event(99), "start"),
    ).rejects.toThrow("Untrusted LuckyToken desktop IPC sender");
    expect(client.executeRuntimeCommand).not.toHaveBeenCalled();
  });

  it("forwards trusted typed operations without an Electron DTO layer", async () => {
    const { handlers, client, runtimeResult, event } = fixture();
    await expect(
      handlers.get(desktopIpcChannels.runtime)?.(event(7), "start"),
    ).resolves.toEqual(runtimeResult);
    expect(client.executeRuntimeCommand).toHaveBeenCalledWith("start");
  });

  it("routes auth and ledger events only to the requesting renderer and releases live subscriptions", async () => {
    const { handlers, bridge, ledgerStop, event } = fixture();
    const trusted = event(7);

    await handlers.get(desktopIpcChannels.auth)?.(
      trusted,
      { command: "login", providerId: "example", authType: "oauth" },
    );
    expect(trusted.send).toHaveBeenCalledWith(
      desktopIpcChannels.authEvent,
      { type: "progress", message: "Signing in" },
    );

    await handlers.get(desktopIpcChannels.ledgerSubscribe)?.(trusted);
    expect(trusted.send).toHaveBeenCalledWith(
      desktopIpcChannels.ledgerEvent,
      expect.objectContaining({ type: "request_ledger" }),
    );
    await bridge.releaseSender(7);
    expect(ledgerStop).toHaveBeenCalledTimes(1);
  });

  it("keeps platform capabilities separate and validates external URLs", async () => {
    const { handlers, platform, event } = fixture();
    await expect(
      handlers.get(desktopIpcChannels.autoStartSet)?.(event(7), true),
    ).resolves.toBe(true);
    expect(platform.setAutoStart).toHaveBeenCalledWith(true);

    await expect(
      handlers.get(desktopIpcChannels.openExternal)?.(event(7), "file:///C:/secret"),
    ).rejects.toThrow("Refusing to open a non-http(s) URL");
    expect(platform.openExternal).not.toHaveBeenCalled();
  });
});
