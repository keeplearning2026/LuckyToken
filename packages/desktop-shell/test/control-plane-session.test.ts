import { describe, expect, it, vi } from "vitest";
import type {
  ControlPlaneClient,
  ControlPlaneEndpoint,
  StatusEvent,
  StatusSnapshot,
} from "@luckytoken/application-control-plane/control-plane";

import { createControlPlaneSession } from "../src/main/control-plane-session.js";

const endpoint: ControlPlaneEndpoint = Object.freeze({
  address: "session-test-address",
  capability: "session-test-capability-012345678901234567890123",
});

function status(
  sequence: number,
  modelDataPlane: StatusSnapshot["modelDataPlane"],
): StatusSnapshot {
  return Object.freeze({
    sequence,
    modelDataPlane,
    provider: "configured",
  });
}

function fakeClient(initial: StatusSnapshot) {
  let statusListener: ((event: StatusEvent) => void) | undefined;
  let disconnect: ((value: { reason: "closed" | "transport_lost" }) => void) | undefined;
  const unsubscribe = vi.fn(async () => undefined);
  const close = vi.fn(async () => {
    disconnect?.({ reason: "closed" });
  });
  const client = {
    disconnected: new Promise<{ reason: "closed" | "transport_lost" }>((resolve) => {
      disconnect = resolve;
    }),
    hello: vi.fn(async () => ({
      type: "compatible" as const,
      contractVersion: 1,
      application: { id: "luckytoken", version: "test" },
    })),
    getStatus: vi.fn(async () => initial),
    subscribe: vi.fn(async (listener: (event: StatusEvent) => void) => {
      statusListener = listener;
      return unsubscribe;
    }),
    close,
  } as unknown as ControlPlaneClient;
  return {
    client,
    unsubscribe,
    close,
    emit(next: StatusSnapshot) {
      statusListener?.({ type: "status_changed", sequence: next.sequence, snapshot: next });
    },
    lose() {
      disconnect?.({ reason: "transport_lost" });
    },
  };
}

describe("Main ControlPlaneSession", () => {
  it("connects with the existing typed client and projects only safe session/tray state", async () => {
    const first = fakeClient(status(1, "stopped"));
    const session = createControlPlaneSession({ connect: async () => first.client });

    await session.connect(endpoint);
    expect(session.state()).toEqual({ kind: "ready", status: status(1, "stopped") });
    expect(session.trayHealth()).toBe("stopped");
    expect(session.client()).toBe(first.client);
    expect(session.application()).toEqual({ id: "luckytoken", version: "test" });

    first.emit(status(2, "running"));
    expect(session.state()).toEqual({ kind: "ready", status: status(2, "running") });
    expect(session.trayHealth()).toBe("ready");
    expect(JSON.stringify(session.state())).not.toContain(endpoint.address);
    expect(JSON.stringify(session.state())).not.toContain(endpoint.capability);
  });

  it("moves to unavailable on transport loss and reconnects from a fresh snapshot", async () => {
    const first = fakeClient(status(4, "running"));
    const second = fakeClient(status(9, "stopped"));
    const connect = vi
      .fn<() => Promise<ControlPlaneClient>>()
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client);
    const session = createControlPlaneSession({ connect: async () => connect() });
    const seen: string[] = [];
    session.subscribeState((state) => seen.push(state.kind));

    await session.connect(endpoint);
    first.lose();
    await vi.waitFor(() => expect(session.state().kind).toBe("unavailable"));
    expect(() => session.application()).toThrow("LuckyToken Control Plane is unavailable");

    const reconnect = session.reconnect(endpoint);
    expect(session.state().kind).toBe("reconnecting");
    await reconnect;
    expect(session.state()).toEqual({ kind: "ready", status: status(9, "stopped") });
    expect(seen).toContain("unavailable");
    expect(seen).toContain("reconnecting");
  });

  it("releases subscriptions and clients on replacement and disposal", async () => {
    const first = fakeClient(status(1, "running"));
    const second = fakeClient(status(2, "running"));
    const connect = vi
      .fn<() => Promise<ControlPlaneClient>>()
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client);
    const session = createControlPlaneSession({ connect: async () => connect() });

    await session.connect(endpoint);
    await session.reconnect(endpoint);
    expect(first.unsubscribe).toHaveBeenCalledTimes(1);
    expect(first.close).toHaveBeenCalledTimes(1);

    await session.dispose();
    expect(second.unsubscribe).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);
  });
});
