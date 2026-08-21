import type {
  ControlPlaneClient,
  ControlPlaneEndpoint,
} from "@luckytoken/application-control-plane/control-plane";

import type { BackendLauncher, SpawnedBackend } from "./backend-launcher.js";
import type { ControlPlaneSession } from "./control-plane-session.js";
import type { DesktopOwnerLeaseClient } from "./desktop-owner-lease.js";

export interface DesktopBackendDiscovery {
  read(): Promise<ControlPlaneEndpoint | undefined>;
}

export interface DesktopBackendConnection {
  start(): Promise<void>;
  dispose(): Promise<void>;
}

export interface DesktopBackendConnectionDependencies {
  readonly discovery: DesktopBackendDiscovery;
  readonly launcher: BackendLauncher;
  readonly session: ControlPlaneSession;
  readonly desktopOwnerLease: DesktopOwnerLeaseClient;
  readonly expectedBuildId: () => Promise<string>;
  readonly retryDelay?: () => Promise<void>;
  readonly staleBackendExitTimeoutMs?: number;
  readonly onRecoveryFailure?: (error: unknown) => void;
}

type ConnectAttempt = "connected" | "retry";

async function waitForStaleBackendExit(
  client: ControlPlaneClient,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.disconnected.then(() => undefined),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Stale LuckyToken desktop Backend did not exit")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createDesktopBackendConnection(
  dependencies: DesktopBackendConnectionDependencies,
): DesktopBackendConnection {
  const retryDelay =
    dependencies.retryDelay ??
    (() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
  const staleBackendExitTimeoutMs = dependencies.staleBackendExitTimeoutMs ?? 5_000;
  let disposed = false;
  let started = false;
  let recoveryEnabled = true;
  let generation = 0;
  let activeTask: Promise<void> | undefined;
  let unsubscribeState: (() => void) | undefined;

  const connectEndpoint = async (
    endpoint: ControlPlaneEndpoint,
    expectedBuildId: string,
    reconnecting: boolean,
  ): Promise<ConnectAttempt> => {
    let status;
    try {
      status = reconnecting
        ? await dependencies.session.reconnect(endpoint)
        : await dependencies.session.connect(endpoint);
    } catch {
      return "retry";
    }

    const application = dependencies.session.application();
    const foreignDesktopBuild =
      application.buildId !== expectedBuildId &&
      status.ownership?.owner.kind === "desktop";
    if (foreignDesktopBuild && !reconnecting) {
      const client = dependencies.session.client();
      const result = await client.executeApplicationCommand({
        command: "quit",
        acknowledged: true,
      });
      if (result.outcome !== "drained" && result.outcome !== "timed_out") {
        throw new Error("Stale LuckyToken desktop Backend could not be replaced");
      }
      await waitForStaleBackendExit(client, staleBackendExitTimeoutMs);
      return "retry";
    }

    try {
      const attached = await dependencies.session
        .client()
        .executeApplicationCommand({ command: "attach" });
      if (foreignDesktopBuild) {
        // A different desktop build became authoritative while this shell was
        // already running. Treat it as a permanent viewer handoff for this
        // shell: it must neither steal the new lease nor resurrect an older
        // Backend after the authoritative shell intentionally quits.
        recoveryEnabled = false;
        dependencies.desktopOwnerLease.dispose();
      } else {
        await dependencies.desktopOwnerLease.bind(attached.snapshot.ownership);
      }
      return "connected";
    } catch {
      return "retry";
    }
  };

  const resolveConnection = async (
    reconnecting: boolean,
    myGeneration: number,
  ): Promise<void> => {
    const expectedBuildId = await dependencies.expectedBuildId();
    let spawned: SpawnedBackend | undefined;
    let childExit: Awaited<SpawnedBackend["exited"]> | undefined;
    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (disposed || myGeneration !== generation) {
          throw new Error("LuckyToken desktop Backend connection was disposed");
        }

        const endpoint = await dependencies.discovery.read().catch(() => undefined);
        if (endpoint !== undefined) {
          const outcome = await connectEndpoint(endpoint, expectedBuildId, reconnecting);
          if (outcome === "connected") return;
        }

        if (spawned === undefined) {
          spawned = await dependencies.launcher.launch();
        }

        const wake = await Promise.race([
          spawned.exited.then((exit) => ({ kind: "exit" as const, exit })),
          retryDelay().then(() => ({ kind: "retry" as const })),
        ]);
        if (wake.kind === "exit") {
          childExit = wake.exit;
          const finalEndpoint = await dependencies.discovery.read().catch(() => undefined);
          if (finalEndpoint !== undefined) {
            const outcome = await connectEndpoint(
              finalEndpoint,
              expectedBuildId,
              reconnecting,
            );
            if (outcome === "connected") return;
          }
          throw new Error(
            `LuckyToken Backend exited before becoming management-ready (code=${String(childExit.code)}, signal=${String(childExit.signal)})`,
          );
        }
      }
      throw new Error("LuckyToken Backend did not become management-ready");
    } finally {
      spawned?.release();
    }
  };

  const ensureConnection = (reconnecting: boolean): Promise<void> => {
    if (disposed) {
      return Promise.reject(new Error("LuckyToken desktop Backend connection is disposed"));
    }
    if (activeTask !== undefined) return activeTask;
    const myGeneration = generation;
    activeTask = resolveConnection(reconnecting, myGeneration).finally(() => {
      activeTask = undefined;
    });
    return activeTask;
  };

  return Object.freeze({
    async start(): Promise<void> {
      if (disposed) throw new Error("LuckyToken desktop Backend connection is disposed");
      if (started) return;
      unsubscribeState ??= dependencies.session.subscribeState((state) => {
        if (!started || disposed || !recoveryEnabled || state.kind !== "unavailable") return;
        void ensureConnection(true).catch((error) => {
          dependencies.onRecoveryFailure?.(error);
        });
      });
      await ensureConnection(false);
      started = true;
      if (recoveryEnabled && dependencies.session.state().kind === "unavailable") {
        await ensureConnection(true);
      }
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      generation += 1;
      unsubscribeState?.();
      unsubscribeState = undefined;
      dependencies.desktopOwnerLease.dispose();
      await activeTask?.catch(() => undefined);
      await dependencies.session.dispose();
      started = false;
    },
  });
}
