import type { ProviderUsageAuthority, ProviderUsageState } from "./contract.js";

const MAX_CONCURRENT_REFRESHES = 3;

export interface ProviderUsageAutoRefresh {
  start(): void;
  reschedule(): void;
  close(): Promise<void>;
}

/**
 * Providers this cycle must attempt. Externally-connected Codex Providers are
 * included before their first observation and again after any bounded
 * transient failure; the delegation itself stays in the credential boundary,
 * which only refreshes near expiry. Only the documented terminal class stops
 * the attempts, and a changed `auth.json` revision resumes them (plan section
 * 6).
 */
function refreshTarget(provider: ProviderUsageState): string | undefined {
  if (provider.state === "unobserved") return provider.providerId;
  if (provider.state === "observed") {
    return provider.refreshable ? provider.observation.providerId : undefined;
  }
  if (provider.state === "unavailable") {
    return provider.reason === "terminal" ? undefined : provider.providerId;
  }
  return undefined;
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
      providerIds = snapshot.providers.flatMap((provider) => {
        const target = refreshTarget(provider);
        return target === undefined ? [] : [target];
      });
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
