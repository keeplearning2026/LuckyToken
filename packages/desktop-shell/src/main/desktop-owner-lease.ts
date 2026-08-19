import type {
  ApplicationCommand,
  ApplicationCommandResult,
  ApplicationOwnership,
} from "@luckytoken/application-control-plane/control-plane";

export interface DesktopOwnerLeaseClientDependencies {
  readonly leaseId: string;
  readonly renewIntervalMs: number;
  readonly execute: (command: ApplicationCommand) => Promise<ApplicationCommandResult>;
  readonly onFailure?: () => void;
  readonly setInterval?: typeof globalThis.setInterval;
  readonly clearInterval?: typeof globalThis.clearInterval;
}

export interface DesktopOwnerLeaseClient {
  bind(ownership: ApplicationOwnership | undefined): Promise<void>;
  dispose(): void;
}

/**
 * Electron Main's logical ownership heartbeat. It never watches a Backend
 * process PID: a replacement shell can claim the same desktop-owned Backend
 * during build handoff. A stale shell only renews its original leaseId and
 * cannot reclaim after a newer shell has claimed ownership.
 */
export function createDesktopOwnerLeaseClient(
  dependencies: DesktopOwnerLeaseClientDependencies,
): DesktopOwnerLeaseClient {
  const schedule = dependencies.setInterval ?? globalThis.setInterval;
  const cancel = dependencies.clearInterval ?? globalThis.clearInterval;
  let timer: ReturnType<typeof globalThis.setInterval> | undefined;
  let renewing = false;

  if (
    dependencies.leaseId.length === 0 ||
    dependencies.leaseId.trim() !== dependencies.leaseId ||
    /\s/u.test(dependencies.leaseId)
  ) {
    throw new Error("Desktop owner lease id must be a non-empty token without whitespace");
  }
  if (!Number.isSafeInteger(dependencies.renewIntervalMs) || dependencies.renewIntervalMs <= 0) {
    throw new Error("Desktop owner lease renew interval must be a positive integer");
  }

  const stop = (): void => {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
    renewing = false;
  };

  const renew = async (): Promise<void> => {
    if (renewing || timer === undefined) return;
    renewing = true;
    try {
      const result = await dependencies.execute({
        command: "desktop_owner",
        action: "renew",
        leaseId: dependencies.leaseId,
      });
      if (result.outcome === "conflict" || result.outcome === "unsupported") {
        stop();
        dependencies.onFailure?.();
      } else if (result.outcome !== "lease_renewed") {
        dependencies.onFailure?.();
      }
    } catch {
      // A transient Control Plane reconnect may recover before the Backend
      // lease TTL. Keep the interval alive so the next tick can renew.
      dependencies.onFailure?.();
    } finally {
      renewing = false;
    }
  };

  return Object.freeze({
    async bind(ownership: ApplicationOwnership | undefined): Promise<void> {
      stop();
      if (ownership?.owner.kind !== "desktop") return;
      const result = await dependencies.execute({
        command: "desktop_owner",
        action: "claim",
        leaseId: dependencies.leaseId,
      });
      if (result.outcome !== "lease_claimed") {
        dependencies.onFailure?.();
        throw new Error("LuckyToken Backend refused the desktop ownership lease");
      }
      timer = schedule(() => {
        void renew();
      }, dependencies.renewIntervalMs);
      if (
        typeof timer === "object" &&
        timer !== null &&
        "unref" in timer &&
        typeof timer.unref === "function"
      ) {
        timer.unref();
      }
    },
    dispose: stop,
  });
}
