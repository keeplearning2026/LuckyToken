import type { ProviderUsageAuthority } from "./contract.js";

const MAX_CONCURRENT_REFRESHES = 3;

export interface ProviderUsageAutoRefresh {
  start(): void;
  reschedule(): void;
  close(): Promise<void>;
}

export function createProviderUsageAutoRefresh(options: {
  readonly authority: Pick<ProviderUsageAuthority, "query" | "refresh">;
  readonly intervalMinutes: () => number;
}): ProviderUsageAutoRefresh {
  let started = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;

  const clearTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const refreshEligible = async (): Promise<void> => {
    let providerIds: string[];
    try {
      const snapshot = await options.authority.query();
      providerIds = snapshot.providers.flatMap((provider) =>
        provider.state === "unobserved" ||
        (provider.state === "observed" && provider.refreshable)
          ? [provider.state === "observed"
              ? provider.observation.providerId
              : provider.providerId]
          : [],
      );
    } catch {
      return;
    }
    let index = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(MAX_CONCURRENT_REFRESHES, providerIds.length) },
        async () => {
          while (!closed && index < providerIds.length) {
            const providerId = providerIds[index++];
            if (providerId === undefined) break;
            try {
              await options.authority.refresh(providerId);
            } catch {
              // Usage acquisition remains observational.
            }
          }
        },
      ),
    );
  };

  const schedule = (): void => {
    if (!started || closed || active !== undefined) return;
    const intervalMs = options.intervalMinutes() * 60_000;
    timer = setTimeout(() => {
      timer = undefined;
      active = refreshEligible().finally(() => {
        active = undefined;
        schedule();
      });
    }, intervalMs);
    timer.unref();
  };

  return Object.freeze({
    start() {
      if (started || closed) return;
      started = true;
      active = refreshEligible().finally(() => {
        active = undefined;
        schedule();
      });
    },
    reschedule() {
      clearTimer();
      schedule();
    },
    async close() {
      closed = true;
      clearTimer();
      await active;
    },
  });
}
