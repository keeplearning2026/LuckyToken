import { describe, expect, it, vi } from "vitest";
import type { ControlPlaneClient } from "@luckytoken/application-control-plane/control-plane";

import {
  registerDesktopIpcHandlers,
  type DesktopIpcHandler,
} from "../src/main/desktop-ipc.js";
import { desktopIpcChannels } from "../src/shared/ipc-channels.js";
import type { DesktopBackendState } from "../src/shared/desktop-api.js";

function fixture() {
  const handlers = new Map<string, DesktopIpcHandler>();
  const registrar = {
    handle: vi.fn((channel: string, handler: DesktopIpcHandler) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  };
  const ledgerStop = vi.fn(async () => undefined);
  const ledgerListeners: Array<(event: never) => void> = [];
  const runtimeResult = {
    command: "start" as const,
    outcome: "started" as const,
    snapshot: { sequence: 1, modelDataPlane: "running" as const, provider: "configured" as const },
  };
  const client = {
    getStatus: vi.fn(async () => runtimeResult.snapshot),
    executeRuntimeCommand: vi.fn(async () => runtimeResult),
    executeCredentialProfilesCommand: vi.fn(async () => ({
      outcome: "ok",
      state: { providers: [] },
    })),
    executeProviderProfileAuthCommand: vi.fn(async (_command, onInteraction) => {
      onInteraction?.({ type: "progress", message: "Adding Profile" });
      return { outcome: "ok", state: { providers: [] } };
    }),
    subscribeRequestLedger: vi.fn(async (listener) => {
      ledgerListeners.push(listener);
      listener({ type: "request_ledger", record: { id: 1 } } as never);
      return ledgerStop;
    }),
  } as unknown as ControlPlaneClient;
  let backendState: DesktopBackendState = {
    revision: 1,
    kind: "ready" as const,
    status: runtimeResult.snapshot,
  };
  const stateListeners = new Set<(state: DesktopBackendState) => void>();
  const session = {
    client: () => client,
    state: () => backendState,
    subscribeState(listener: (state: DesktopBackendState) => void) {
      stateListeners.add(listener);
      listener(backendState);
      return () => stateListeners.delete(listener);
    },
  } as never;
  const platform = {
    getAutoStart: vi.fn(async () => false),
    setAutoStart: vi.fn(async (enabled: boolean) => enabled),
    pickDirectory: vi.fn(async () => "C:/project"),
    pickSaveFile: vi.fn(async () => "C:/export.zip"),
    openExternal: vi.fn(async () => undefined),
    writeClipboardText: vi.fn(async () => undefined),
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
  return {
    handlers,
    registrar,
    client,
    platform,
    bridge,
    ledgerStop,
    ledgerListeners,
    runtimeResult,
    event,
    publishBackendState(state: DesktopBackendState) {
      backendState = state;
      for (const listener of stateListeners) listener(state);
    },
  };
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

  it("routes ledger events only to the requesting renderer and releases live subscriptions", async () => {
    const { handlers, bridge, ledgerStop, event } = fixture();
    const trusted = event(7);

    await handlers.get(desktopIpcChannels.ledgerSubscribe)?.(trusted);
    expect(trusted.send).toHaveBeenCalledWith(
      desktopIpcChannels.ledgerEvent,
      expect.objectContaining({ type: "request_ledger" }),
    );
    await bridge.releaseSender(7);
    expect(ledgerStop).toHaveBeenCalledTimes(1);
  });

  it("routes Profile management and Profile auth through their typed channels", async () => {
    const { handlers, client, event } = fixture();
    const trusted = event(7);
    const command = { command: "query" as const };
    await handlers.get(desktopIpcChannels.credentialProfiles)?.(trusted, command);
    expect(client.executeCredentialProfilesCommand).toHaveBeenCalledWith(command);

    await handlers.get(desktopIpcChannels.providerProfileAuth)?.(
      trusted,
      { command: "query" },
    );
    expect(trusted.send).toHaveBeenCalledWith(
      desktopIpcChannels.providerProfileAuthEvent,
      { type: "progress", message: "Adding Profile" },
    );
  });

  it("rebinds a logical ledger subscription and rejects stale-client callbacks", async () => {
    const fixtureState = fixture();
    const trusted = fixtureState.event(7);
    await fixtureState.handlers.get(desktopIpcChannels.ledgerSubscribe)?.(trusted);
    expect(fixtureState.client.subscribeRequestLedger).toHaveBeenCalledTimes(1);

    fixtureState.publishBackendState({ revision: 2, kind: "unavailable" });
    fixtureState.publishBackendState({
      revision: 3,
      kind: "ready",
      status: { ...fixtureState.runtimeResult.snapshot, sequence: 2 },
    });
    await vi.waitFor(() =>
      expect(fixtureState.client.subscribeRequestLedger).toHaveBeenCalledTimes(2),
    );
    const sendsBeforeStale = trusted.send.mock.calls.length;
    fixtureState.ledgerListeners[0]?.({
      type: "request_ledger",
      record: { id: 99 },
    } as never);
    expect(trusted.send).toHaveBeenCalledTimes(sendsBeforeStale);

    fixtureState.ledgerListeners[1]?.({
      type: "request_ledger",
      record: { id: 100 },
    } as never);
    expect(trusted.send).toHaveBeenLastCalledWith(
      desktopIpcChannels.ledgerEvent,
      expect.objectContaining({ record: { id: 100 } }),
    );
    await fixtureState.bridge.dispose();
  });

  it("keeps the Ledger binding across ready status updates", async () => {
    const fixtureState = fixture();
    const trusted = fixtureState.event(7);
    await fixtureState.handlers.get(desktopIpcChannels.ledgerSubscribe)?.(trusted);
    expect(fixtureState.client.subscribeRequestLedger).toHaveBeenCalledTimes(1);

    fixtureState.publishBackendState({
      revision: 2,
      kind: "ready",
      status: { ...fixtureState.runtimeResult.snapshot, sequence: 2 },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const subscribeCount = vi.mocked(
      fixtureState.client.subscribeRequestLedger,
    ).mock.calls.length;
    const stopCount = fixtureState.ledgerStop.mock.calls.length;
    await fixtureState.bridge.dispose();

    expect(subscribeCount).toBe(1);
    expect(stopCount).toBe(0);
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

    await expect(
      handlers.get(desktopIpcChannels.clipboardWrite)?.(event(7), "lt_token"),
    ).resolves.toBeUndefined();
    expect(platform.writeClipboardText).toHaveBeenCalledWith("lt_token");
  });
});
