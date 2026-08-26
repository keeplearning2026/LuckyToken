import { describe, expect, it, vi } from "vitest";
import type {
  ControlPlaneClient,
  RequestJourneySummary,
  RuntimeEventRecord,
} from "@token/application-control-plane/control-plane";

import {
  registerDesktopIpcHandlers,
  type DesktopIpcHandler,
} from "../src/main/desktop-ipc.js";
import { desktopIpcChannels } from "../src/shared/ipc-channels.js";
import type { DesktopBackendState } from "../src/shared/desktop-api.js";

const JOURNEY: RequestJourneySummary = Object.freeze({
  id: 1,
  runtimeId: "52000000-0000-4000-8000-000000000001",
  requestId: "52000000-0000-4000-8000-000000000002",
  operation: "model_generation",
  outcome: "running",
  completeness: "complete",
  createdAt: 1,
});

const RUNTIME_EVENT: RuntimeEventRecord = Object.freeze({
  kind: "runtime_event",
  id: 2,
  runtimeId: JOURNEY.runtimeId,
  recordId: "52000000-0000-4000-8000-000000000003",
  sequence: 0,
  time: 2,
  level: "warning",
  classification: "catalog_refresh_degraded",
  safeMessage: "Catalog refresh was degraded",
});

function fixture() {
  const handlers = new Map<string, DesktopIpcHandler>();
  const registrar = {
    handle: vi.fn((channel: string, handler: DesktopIpcHandler) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  };
  const journeyStop = vi.fn(async () => undefined);
  const runtimeEventStop = vi.fn(async () => undefined);
  const journeyListeners: Array<(record: RequestJourneySummary) => void> = [];
  const runtimeEventListeners: Array<(record: RuntimeEventRecord) => void> = [];
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
    queryRequestJourneys: vi.fn(async () => ({
      outcome: "ok",
      result: { records: [], hasMore: false },
    })),
    getRequestJourney: vi.fn(async () => ({ outcome: "ok", result: {} })),
    getRequestArtifact: vi.fn(async () => ({ outcome: "ok", result: {} })),
    queryRuntimeEvents: vi.fn(async () => ({
      outcome: "ok",
      result: { records: [], hasMore: false },
    })),
    subscribeRequestJourneys: vi.fn(async (listener) => {
      journeyListeners.push(listener);
      listener(JOURNEY);
      return journeyStop;
    }),
    subscribeRuntimeEvents: vi.fn(async (listener) => {
      runtimeEventListeners.push(listener);
      listener(RUNTIME_EVENT);
      return runtimeEventStop;
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
    openRequestArtifact: vi.fn(async () => ({ outcome: "opened" as const })),
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
    journeyStop,
    runtimeEventStop,
    journeyListeners,
    runtimeEventListeners,
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
    ).rejects.toThrow("Untrusted Token desktop IPC sender");
    expect(client.executeRuntimeCommand).not.toHaveBeenCalled();
  });

  it("forwards trusted typed operations without an Electron DTO layer", async () => {
    const { handlers, client, runtimeResult, event } = fixture();
    await expect(
      handlers.get(desktopIpcChannels.runtime)?.(event(7), "start"),
    ).resolves.toEqual(runtimeResult);
    expect(client.executeRuntimeCommand).toHaveBeenCalledWith("start");
  });

  it("forwards diagnostics reads and the desktop capture-open workflow through named operations", async () => {
    const { handlers, client, platform, event } = fixture();
    const trusted = event(7);
    const journeyQuery = { afterId: 4, limit: 20 } as const;
    const journeyInput = { requestId: JOURNEY.requestId } as const;
    const artifactInput = {
      requestId: JOURNEY.requestId,
      artifactId: "client-request-wire",
      mediaType: "application/json",
    } as const;
    const runtimeQuery = { afterId: 6, limit: 10 } as const;

    await handlers.get(desktopIpcChannels.requestJourneysQuery)?.(
      trusted,
      journeyQuery,
    );
    await handlers.get(desktopIpcChannels.requestJourneyGet)?.(
      trusted,
      journeyInput,
    );
    await handlers.get(desktopIpcChannels.requestArtifactOpen)?.(
      trusted,
      artifactInput,
    );
    await handlers.get(desktopIpcChannels.runtimeEventsQuery)?.(
      trusted,
      runtimeQuery,
    );

    expect(client.queryRequestJourneys).toHaveBeenCalledWith(journeyQuery);
    expect(client.getRequestJourney).toHaveBeenCalledWith(journeyInput);
    expect(platform.openRequestArtifact).toHaveBeenCalledWith(artifactInput);
    expect(client.queryRuntimeEvents).toHaveBeenCalledWith(runtimeQuery);
  });

  it("routes unified diagnostics events only to the requesting renderer and releases both subscriptions", async () => {
    const { handlers, bridge, journeyStop, runtimeEventStop, event } = fixture();
    const trusted = event(7);

    await handlers.get(desktopIpcChannels.requestJourneysSubscribe)?.(trusted);
    expect(trusted.send).toHaveBeenCalledWith(
      desktopIpcChannels.requestJourneysEvent,
      JOURNEY,
    );
    await handlers.get(desktopIpcChannels.runtimeEventsSubscribe)?.(trusted);
    expect(trusted.send).toHaveBeenCalledWith(
      desktopIpcChannels.runtimeEventsEvent,
      RUNTIME_EVENT,
    );
    await bridge.releaseSender(7);
    expect(journeyStop).toHaveBeenCalledTimes(1);
    expect(runtimeEventStop).toHaveBeenCalledTimes(1);
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

  it("rebinds a logical Request Journey subscription and rejects stale-client callbacks", async () => {
    const fixtureState = fixture();
    const trusted = fixtureState.event(7);
    await fixtureState.handlers.get(desktopIpcChannels.requestJourneysSubscribe)?.(trusted);
    expect(fixtureState.client.subscribeRequestJourneys).toHaveBeenCalledTimes(1);

    fixtureState.publishBackendState({ revision: 2, kind: "unavailable" });
    fixtureState.publishBackendState({
      revision: 3,
      kind: "ready",
      status: { ...fixtureState.runtimeResult.snapshot, sequence: 2 },
    });
    await vi.waitFor(() =>
      expect(fixtureState.client.subscribeRequestJourneys).toHaveBeenCalledTimes(2),
    );
    const sendsBeforeStale = trusted.send.mock.calls.length;
    fixtureState.journeyListeners[0]?.({ ...JOURNEY, id: 99 });
    expect(trusted.send).toHaveBeenCalledTimes(sendsBeforeStale);

    fixtureState.journeyListeners[1]?.({ ...JOURNEY, id: 100 });
    expect(trusted.send).toHaveBeenLastCalledWith(
      desktopIpcChannels.requestJourneysEvent,
      expect.objectContaining({ id: 100 }),
    );
    await fixtureState.bridge.dispose();
  });

  it("keeps unified diagnostics bindings across ready status updates", async () => {
    const fixtureState = fixture();
    const trusted = fixtureState.event(7);
    await fixtureState.handlers.get(desktopIpcChannels.requestJourneysSubscribe)?.(trusted);
    await fixtureState.handlers.get(desktopIpcChannels.runtimeEventsSubscribe)?.(trusted);
    expect(fixtureState.client.subscribeRequestJourneys).toHaveBeenCalledTimes(1);
    expect(fixtureState.client.subscribeRuntimeEvents).toHaveBeenCalledTimes(1);

    fixtureState.publishBackendState({
      revision: 2,
      kind: "ready",
      status: { ...fixtureState.runtimeResult.snapshot, sequence: 2 },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const journeySubscribeCount = vi.mocked(
      fixtureState.client.subscribeRequestJourneys,
    ).mock.calls.length;
    const runtimeSubscribeCount = vi.mocked(
      fixtureState.client.subscribeRuntimeEvents,
    ).mock.calls.length;
    const journeyStopCount = fixtureState.journeyStop.mock.calls.length;
    const runtimeStopCount = fixtureState.runtimeEventStop.mock.calls.length;
    await fixtureState.bridge.dispose();

    expect(journeySubscribeCount).toBe(1);
    expect(runtimeSubscribeCount).toBe(1);
    expect(journeyStopCount).toBe(0);
    expect(runtimeStopCount).toBe(0);
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
