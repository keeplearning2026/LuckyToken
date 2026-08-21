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
  const disposeController = new AbortController();
  let recoveryTask: Promise<void> | undefined;
  let unsubscribeState: (() => void) | undefined;

  const waitForRetry = async (): Promise<boolean> => {
    let onDispose: (() => void) | undefined;
    const disposedWake = new Promise<false>((resolve) => {
      onDispose = () => resolve(false);
      disposeController.signal.addEventListener("abort", onDispose, { once: true });
    });
    try {
      return await Promise.race([retryDelay().then(() => true), disposedWake]);
    } finally {
      if (onDispose !== undefined) {
        disposeController.signal.removeEventListener("abort", onDispose);
      }
    }
  };

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

  const waitForRecoveryWake = async (
    spawned: SpawnedBackend,
  ): Promise<
    | { readonly kind: "disposed" }
    | { readonly kind: "exit"; readonly exit: Awaited<SpawnedBackend["exited"]> }
    | { readonly kind: "retry" }
  > => {
    let onDispose: (() => void) | undefined;
    const disposedWake = new Promise<{ readonly kind: "disposed" }>((resolve) => {
      onDispose = () => resolve({ kind: "disposed" });
      disposeController.signal.addEventListener("abort", onDispose, { once: true });
    });
    try {
      return await Promise.race([
        spawned.exited.then((exit) => ({ kind: "exit" as const, exit })),
        retryDelay().then(() => ({ kind: "retry" as const })),
        disposedWake,
      ]);
    } finally {
      if (onDispose !== undefined) {
        disposeController.signal.removeEventListener("abort", onDispose);
      }
    }
  };

  const resolveConnection = async (reconnecting: boolean): Promise<void> => {
    let spawned: SpawnedBackend | undefined;
    let attempts = 0;
    let recoveryDifficultyReported = false;
    let lastFailure: unknown = new Error(
      "LuckyToken Backend did not become management-ready",
    );
    try {
      while (!disposed && recoveryEnabled) {
        let expectedBuildId: string;
        try {
          expectedBuildId = await dependencies.expectedBuildId();
        } catch (error) {
          lastFailure = error;
          attempts += 1;
          if (attempts >= 100 && !recoveryDifficultyReported) {
            recoveryDifficultyReported = true;
            dependencies.onRecoveryFailure?.(lastFailure);
          }
          if (!(await waitForRetry())) return;
          continue;
        }

        const endpoint = await dependencies.discovery.read().catch(() => undefined);
        if (endpoint !== undefined) {
          const outcome = await connectEndpoint(endpoint, expectedBuildId, reconnecting);
          if (outcome === "connected") {
            recoveryDifficultyReported = false;
            attempts = 0;
            return;
          }
          lastFailure = new Error("LuckyToken Control Plane connection failed");
        }

        if (spawned === undefined) {
          try {
            spawned = await dependencies.launcher.launch();
          } catch (error) {
            lastFailure = error;
            attempts += 1;
            if (attempts >= 100 && !recoveryDifficultyReported) {
              recoveryDifficultyReported = true;
              dependencies.onRecoveryFailure?.(lastFailure);
            }
            if (!(await waitForRetry())) return;
            continue;
          }
        }

        const wake = await waitForRecoveryWake(spawned);
        if (wake.kind === "disposed") return;
        if (wake.kind === "exit") {
          spawned.release();
          spawned = undefined;
          const finalEndpoint = await dependencies.discovery.read().catch(() => undefined);
          if (finalEndpoint !== undefined) {
            const outcome = await connectEndpoint(
              finalEndpoint,
              expectedBuildId,
              reconnecting,
            );
            if (outcome === "connected") return;
          }
          lastFailure = new Error(
            `LuckyToken Backend exited before becoming management-ready (code=${String(wake.exit.code)}, signal=${String(wake.exit.signal)})`,
          );
          // A dead candidate cannot justify an immediate second launch. Give
          // discovery another complete recovery interval first.
          if (!(await waitForRetry())) return;
        }
        attempts += 1;
        if (attempts >= 100 && !recoveryDifficultyReported) {
          recoveryDifficultyReported = true;
          dependencies.onRecoveryFailure?.(lastFailure);
        }
      }
    } finally {
      spawned?.release();
    }
  };

  const ensureConnection = (reconnecting: boolean): void => {
    if (disposed || !recoveryEnabled || recoveryTask !== undefined) return;
    recoveryTask = resolveConnection(reconnecting).finally(() => {
      recoveryTask = undefined;
      if (
        started &&
        !disposed &&
        recoveryEnabled &&
        dependencies.session.state().kind === "unavailable"
      ) {
        ensureConnection(true);
      }
    });
  };

  return Object.freeze({
    async start(): Promise<void> {
      if (disposed) throw new Error("LuckyToken desktop Backend connection is disposed");
      if (started) return;
      started = true;
      unsubscribeState ??= dependencies.session.subscribeState((state) => {
        if (!started || disposed || !recoveryEnabled || state.kind !== "unavailable") return;
        ensureConnection(true);
      });
      ensureConnection(false);
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      disposeController.abort();
      unsubscribeState?.();
      unsubscribeState = undefined;
      dependencies.desktopOwnerLease.dispose();
      await recoveryTask?.catch(() => undefined);
      await dependencies.session.dispose();
      started = false;
    },
  });
}
