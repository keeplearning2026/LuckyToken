import { describe, expect, it, vi } from "vitest";
import type {
  ApplicationIdentity,
  ApplicationOwnership,
  ControlPlaneClient,
  ControlPlaneEndpoint,
  StatusSnapshot,
} from "@token/application-control-plane/control-plane";

import { createDesktopBackendConnection } from "../src/main/desktop-backend-connection.js";
import type { SpawnedBackend } from "../src/main/backend-launcher.js";
import type {
  ControlPlaneSession,
} from "../src/main/control-plane-session.js";
import type { DesktopBackendState } from "../src/shared/desktop-api.js";
import type { DesktopOwnerLeaseClient } from "../src/main/desktop-owner-lease.js";

const endpointA: ControlPlaneEndpoint = Object.freeze({
  address: "endpoint-a",
  capability: "capability-a-012345678901234567890123456789",
});
const endpointB: ControlPlaneEndpoint = Object.freeze({
  address: "endpoint-b",
  capability: "capability-b-012345678901234567890123456789",
});

function ownership(kind: "cli" | "desktop", pid = 100): ApplicationOwnership {
  return Object.freeze({
    owner: { kind, pid, startedAt: "2026-08-21T00:00:00.000Z" },
  });
}

function snapshot(owner?: ApplicationOwnership): StatusSnapshot {
  return Object.freeze({
    sequence: 1,
    modelDataPlane: "running",
    provider: "configured",
    ...(owner === undefined ? {} : { ownership: owner }),
  });
}

interface EndpointBehavior {
  readonly buildId?: string;
  readonly status: StatusSnapshot;
  readonly onQuit?: () => void;
}

function fakeSession(behaviors: Map<string, EndpointBehavior>) {
  let revision = 0;
  let currentState: DesktopBackendState = Object.freeze({
    revision,
    kind: "connecting",
  });
  let currentApplication: ApplicationIdentity | undefined;
  let currentClient: ControlPlaneClient | undefined;
  const listeners = new Set<(state: DesktopBackendState) => void>();
  const connect = vi.fn(async (endpoint: ControlPlaneEndpoint) => {
    const behavior = behaviors.get(endpoint.address);
    if (behavior === undefined) throw new Error(`unreachable ${endpoint.address}`);
    let resolveDisconnected!: (value: { reason: "closed" | "transport_lost" }) => void;
    const disconnected = new Promise<{ reason: "closed" | "transport_lost" }>((resolve) => {
      resolveDisconnected = resolve;
    });
    const client = {
      disconnected,
      executeApplicationCommand: vi.fn(async (command) => {
        if (command.command === "quit") {
          behavior.onQuit?.();
          resolveDisconnected({ reason: "transport_lost" });
          return { command: "quit", outcome: "drained", snapshot: behavior.status };
        }
        if (command.command === "attach") {
          return { command: "attach", outcome: "attached", snapshot: behavior.status };
        }
        throw new Error(`unexpected command ${command.command}`);
      }),
    } as unknown as ControlPlaneClient;
    currentClient = client;
    currentApplication = Object.freeze({
      id: "Token",
      version: "test",
      ...(behavior.buildId === undefined ? {} : { buildId: behavior.buildId }),
    });
    currentState = Object.freeze({
      revision: ++revision,
      kind: "ready",
      status: behavior.status,
    });
    for (const listener of listeners) listener(currentState);
    return behavior.status;
  });
  const session = {
    connect,
    reconnect: connect,
    client() {
      if (currentClient === undefined || currentState.kind !== "ready") {
        throw new Error("Token Control Plane is unavailable");
      }
      return currentClient;
    },
    application() {
      if (currentApplication === undefined || currentState.kind !== "ready") {
        throw new Error("Token Control Plane is unavailable");
      }
      return currentApplication;
    },
    state: () => currentState,
    trayHealth: () => "ready" as const,
    subscribeState(listener: (state: DesktopBackendState) => void) {
      listeners.add(listener);
      listener(currentState);
      return () => listeners.delete(listener);
    },
    dispose: vi.fn(async () => {
      currentClient = undefined;
      currentApplication = undefined;
      currentState = Object.freeze({ revision: ++revision, kind: "unavailable" });
    }),
  } as ControlPlaneSession;
  return {
    session,
    connect,
    lose() {
      currentClient = undefined;
      currentApplication = undefined;
      currentState = Object.freeze({ revision: ++revision, kind: "unavailable" });
      for (const listener of listeners) listener(currentState);
    },
  };
}

function fakeLease(onBind?: () => void) {
  let bound = false;
  return {
    bind: vi.fn(async (currentOwnership) => {
      bound = currentOwnership?.owner.kind === "desktop";
      onBind?.();
    }),
    isBound: () => bound,
    dispose: vi.fn(() => {
      bound = false;
    }),
  } satisfies DesktopOwnerLeaseClient;
}

function spawnedBackend(options: { exit?: Promise<{ code: number | null; signal: string | null }> } = {}) {
  return {
    pid: 4242,
    exited: options.exit ?? new Promise(() => undefined),
    release: vi.fn(),
  } satisfies SpawnedBackend;
}

function harness(options: {
  discovery: { current: ControlPlaneEndpoint | undefined };
  behaviors: Map<string, EndpointBehavior>;
  launch?: () => Promise<SpawnedBackend>;
  onLeaseBind?: (session: ReturnType<typeof fakeSession>) => void;
  retryDelay?: () => Promise<void>;
  onRecoveryFailure?: (error: unknown) => void;
}) {
  const session = fakeSession(options.behaviors);
  const lease = fakeLease(() => options.onLeaseBind?.(session));
  const launch = vi.fn(
    options.launch ?? (async () => spawnedBackend()),
  );
  const connection = createDesktopBackendConnection({
    discovery: { read: async () => options.discovery.current },
    launcher: { launch },
    session: session.session,
    desktopOwnerLease: lease,
    expectedBuildId: async () => "build-current",
    retryDelay:
      options.retryDelay ??
      (() => new Promise<void>((resolve) => setTimeout(resolve, 0))),
    staleBackendExitTimeoutMs: 100,
    ...(options.onRecoveryFailure === undefined
      ? {}
      : { onRecoveryFailure: options.onRecoveryFailure }),
  });
  return { connection, session, lease, launch };
}

describe("DesktopBackendConnection", () => {
  it("connects to the currently discovered Backend and binds its desktop ownership", async () => {
    const discovery = { current: endpointA as ControlPlaneEndpoint | undefined };
    const owner = ownership("desktop");
    const h = harness({
      discovery,
      behaviors: new Map([[endpointA.address, { buildId: "build-current", status: snapshot(owner) }]]),
    });

    await h.connection.start();

    await vi.waitFor(() => expect(h.session.session.state().kind).toBe("ready"));

    expect(h.session.connect).toHaveBeenCalledWith(endpointA);
    expect(h.lease.bind).toHaveBeenCalledWith(owner);
    expect(h.launch).not.toHaveBeenCalled();
    await h.connection.dispose();
  });

  it("discards the old endpoint after session loss and reconnects through fresh discovery", async () => {
    const discovery = { current: endpointA as ControlPlaneEndpoint | undefined };
    const h = harness({
      discovery,
      behaviors: new Map([
        [endpointA.address, { buildId: "build-current", status: snapshot(ownership("desktop", 1)) }],
        [endpointB.address, { buildId: "build-current", status: snapshot(ownership("desktop", 2)) }],
      ]),
    });
    await h.connection.start();

    await vi.waitFor(() => expect(h.session.session.state().kind).toBe("ready"));

    discovery.current = endpointB;
    h.session.lose();

    await vi.waitFor(() => expect(h.session.connect).toHaveBeenCalledWith(endpointB));
    expect(h.session.connect.mock.calls.filter(([endpoint]) => endpoint === endpointA)).toHaveLength(1);
    await h.connection.dispose();
  });

  it("recovers when the initial session is lost in the narrow start handoff window", async () => {
    const discovery = { current: endpointA as ControlPlaneEndpoint | undefined };
    let interrupted = false;
    const h = harness({
      discovery,
      behaviors: new Map([
        [endpointA.address, { buildId: "build-current", status: snapshot(ownership("desktop", 1)) }],
        [endpointB.address, { buildId: "build-current", status: snapshot(ownership("desktop", 2)) }],
      ]),
      onLeaseBind: (session) => {
        if (interrupted) return;
        interrupted = true;
        discovery.current = endpointB;
        session.lose();
      },
    });

    await h.connection.start();

    await vi.waitFor(() => expect(h.session.connect).toHaveBeenCalledWith(endpointB));
    expect(h.session.connect).toHaveBeenCalledWith(endpointA);
    expect(h.lease.isBound()).toBe(true);
    await h.connection.dispose();
  });

  it("launches only when discovery has no usable Backend, then connects the new publication", async () => {
    const discovery = { current: undefined as ControlPlaneEndpoint | undefined };
    const child = spawnedBackend();
    const h = harness({
      discovery,
      behaviors: new Map([[endpointB.address, { buildId: "build-current", status: snapshot(ownership("desktop")) }]]),
      launch: async () => {
        discovery.current = endpointB;
        return child;
      },
    });

    await h.connection.start();

    await vi.waitFor(() => expect(h.session.connect).toHaveBeenCalledWith(endpointB));
    expect(h.launch).toHaveBeenCalledTimes(1);
    expect(child.release).toHaveBeenCalledTimes(1);
    await h.connection.dispose();
  });

  it("keeps recovering when a launched process exits before any usable publication", async () => {
    const discovery = { current: undefined as ControlPlaneEndpoint | undefined };
    const child = spawnedBackend({ exit: Promise.resolve({ code: 1, signal: null }) });
    const recoveryFailure = vi.fn();
    const h = harness({
      discovery,
      behaviors: new Map(),
      launch: async () => child,
      onRecoveryFailure: recoveryFailure,
    });

    await expect(h.connection.start()).resolves.toBeUndefined();
    await vi.waitFor(() => expect(child.release).toHaveBeenCalled());
    expect(h.session.session.state().kind).not.toBe("ready");
    await h.connection.dispose();
  });

  it("gracefully retires a stale desktop-owned Backend before launching the current build", async () => {
    const discovery = { current: endpointA as ControlPlaneEndpoint | undefined };
    const child = spawnedBackend();
    const behaviors = new Map<string, EndpointBehavior>();
    behaviors.set(endpointA.address, {
      buildId: "build-old",
      status: snapshot(ownership("desktop")),
      onQuit: () => {
        discovery.current = undefined;
      },
    });
    behaviors.set(endpointB.address, {
      buildId: "build-current",
      status: snapshot(ownership("desktop", 2)),
    });
    const h = harness({
      discovery,
      behaviors,
      launch: async () => {
        discovery.current = endpointB;
        return child;
      },
    });

    await h.connection.start();

    await vi.waitFor(() => expect(h.session.connect).toHaveBeenCalledWith(endpointB));
    expect(h.launch).toHaveBeenCalledTimes(1);
    await h.connection.dispose();
  });

  it("does not roll back a different desktop build discovered during recovery", async () => {
    const discovery = { current: endpointA as ControlPlaneEndpoint | undefined };
    const foreignQuit = vi.fn();
    const h = harness({
      discovery,
      behaviors: new Map([
        [endpointA.address, { buildId: "build-current", status: snapshot(ownership("desktop", 1)) }],
        [
          endpointB.address,
          {
            buildId: "build-newer",
            status: snapshot(ownership("desktop", 2)),
            onQuit: foreignQuit,
          },
        ],
      ]),
    });
    await h.connection.start();
    await vi.waitFor(() => expect(h.session.session.state().kind).toBe("ready"));
    expect(h.lease.bind).toHaveBeenCalledTimes(1);

    discovery.current = endpointB;
    h.session.lose();

    await vi.waitFor(() => expect(h.session.connect).toHaveBeenCalledWith(endpointB));
    expect(foreignQuit).not.toHaveBeenCalled();
    expect(h.launch).not.toHaveBeenCalled();
    expect(h.lease.bind).toHaveBeenCalledTimes(1);
    await h.connection.dispose();
  });

  it("does not resurrect a Backend after a foreign-build viewer loses that Backend", async () => {
    const discovery = { current: endpointA as ControlPlaneEndpoint | undefined };
    const h = harness({
      discovery,
      behaviors: new Map([
        [endpointA.address, { buildId: "build-current", status: snapshot(ownership("desktop", 1)) }],
        [endpointB.address, { buildId: "build-newer", status: snapshot(ownership("desktop", 2)) }],
      ]),
    });
    await h.connection.start();
    await vi.waitFor(() => expect(h.session.session.state().kind).toBe("ready"));

    discovery.current = endpointB;
    h.session.lose();
    await vi.waitFor(() => expect(h.session.connect).toHaveBeenCalledWith(endpointB));
    expect(h.lease.isBound()).toBe(false);

    discovery.current = undefined;
    h.session.lose();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(h.launch).not.toHaveBeenCalled();
    expect(h.session.connect).toHaveBeenCalledTimes(2);
    await h.connection.dispose();
  });

  it("preserves a stale-build CLI-owned Backend and never launches a replacement", async () => {
    const discovery = { current: endpointA as ControlPlaneEndpoint | undefined };
    const owner = ownership("cli");
    const h = harness({
      discovery,
      behaviors: new Map([[endpointA.address, { buildId: "build-old", status: snapshot(owner) }]]),
    });

    await h.connection.start();

    await vi.waitFor(() => expect(h.session.session.state().kind).toBe("ready"));
    expect(h.launch).not.toHaveBeenCalled();
    expect(h.lease.bind).toHaveBeenCalledWith(owner);
    await h.connection.dispose();
  });

  it("coalesces repeated unavailable notifications into one recovery flight", async () => {
    const discovery = { current: endpointA as ControlPlaneEndpoint | undefined };
    const h = harness({
      discovery,
      behaviors: new Map([
        [endpointA.address, { buildId: "build-current", status: snapshot(ownership("desktop", 1)) }],
        [endpointB.address, { buildId: "build-current", status: snapshot(ownership("desktop", 2)) }],
      ]),
    });
    await h.connection.start();
    await vi.waitFor(() => expect(h.session.session.state().kind).toBe("ready"));
    discovery.current = endpointB;

    h.session.lose();
    h.session.lose();
    h.session.lose();

    await vi.waitFor(() => expect(h.session.connect).toHaveBeenCalledWith(endpointB));
    expect(h.session.connect).toHaveBeenCalledTimes(2);
    await h.connection.dispose();
  });

  it("continues recovery after the 100-attempt degradation threshold", async () => {
    const discovery = { current: undefined as ControlPlaneEndpoint | undefined };
    const recoveryFailure = vi.fn();
    let recoveryCycles = 0;
    const h = harness({
      discovery,
      behaviors: new Map([
        [endpointA.address, { buildId: "build-current", status: snapshot(ownership("desktop")) }],
      ]),
      retryDelay: async () => {
        recoveryCycles += 1;
        if (recoveryCycles === 101) discovery.current = endpointA;
      },
      onRecoveryFailure: recoveryFailure,
    });

    await h.connection.start();

    await vi.waitFor(() => expect(h.session.connect).toHaveBeenCalledWith(endpointA));
    expect(recoveryCycles).toBeGreaterThan(100);
    expect(recoveryFailure).toHaveBeenCalledTimes(1);
    expect(h.launch).toHaveBeenCalledTimes(1);
    await h.connection.dispose();
  });

  it("keeps one slow spawned candidate and dispose cancels the recovery worker", async () => {
    const discovery = { current: undefined as ControlPlaneEndpoint | undefined };
    const child = spawnedBackend();
    const h = harness({
      discovery,
      behaviors: new Map(),
      launch: async () => child,
      retryDelay: async () => await new Promise<void>(() => undefined),
    });

    await h.connection.start();
    await vi.waitFor(() => expect(h.launch).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(h.launch).toHaveBeenCalledTimes(1);

    await Promise.all([h.connection.dispose(), h.connection.dispose()]);
    expect(child.release).toHaveBeenCalledTimes(1);
    expect(h.session.session.dispose).toHaveBeenCalledTimes(1);
  });
});
