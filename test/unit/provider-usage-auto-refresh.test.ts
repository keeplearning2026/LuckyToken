import { afterEach, describe, expect, it, vi } from "vitest";

import { createProviderUsageAutoRefresh } from "../../src/provider-usage/auto-refresh.js";
import type { ProviderUsageAuthority, ProviderUsageSnapshot } from "../../src/provider-usage/contract.js";

const snapshot: ProviderUsageSnapshot = {
  providers: [
    { state: "unobserved", providerId: "goat" },
    {
      state: "observed",
      observation: { providerId: "private", observedAt: 1, windows: [], budgets: [] },
      refreshable: true,
    },
    {
      state: "observed",
      observation: { providerId: "passive", observedAt: 1, windows: [], budgets: [] },
      refreshable: false,
    },
    { state: "unsupported", providerId: "unsupported", reason: "binding" },
  ],
};

function authority(
  refresh: ReturnType<typeof vi.fn>,
  query = vi.fn(async () => snapshot),
): Pick<ProviderUsageAuthority, "query" | "refresh"> {
  return { query, refresh } as Pick<ProviderUsageAuthority, "query" | "refresh">;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Provider Usage automatic refresh", () => {
  it("waits for the configured interval and refreshes only eligible Providers", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async (providerId: string) => { void providerId; });
    const query = vi.fn(async () => snapshot);
    const runner = createProviderUsageAutoRefresh({ authority: authority(refresh, query), intervalMinutes: () => 15 });
    runner.start();

    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect(query).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh.mock.calls.map(([id]) => id).sort()).toEqual(["goat", "private"]);
    expect(query).toHaveBeenCalledTimes(1);

    await runner.close();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("applies interval changes without waiting for the previous timer", async () => {
    vi.useFakeTimers();
    let minutes = 15;
    const refresh = vi.fn(async (providerId: string) => { void providerId; });
    const query = vi.fn(async () => snapshot);
    const runner = createProviderUsageAutoRefresh({ authority: authority(refresh, query), intervalMinutes: () => minutes });
    runner.start();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    minutes = 2;
    runner.reschedule();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(query).toHaveBeenCalledTimes(1);
    await runner.close();
  });

  it("never overlaps cycles and contains an acquisition failure", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    const refresh = vi.fn(async (providerId: string) => {
      if (providerId === "goat") await blocker;
      else throw new Error("offline");
    });
    const query = vi.fn(async () => snapshot);
    const runner = createProviderUsageAutoRefresh({ authority: authority(refresh, query), intervalMinutes: () => 1 });
    runner.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(query).toHaveBeenCalledTimes(1);
    release?.();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(query).toHaveBeenCalledTimes(2);
    await runner.close();
  });
});
