import { describe, expect, it, vi } from "vitest";

import { createDesktopOwnerLeaseAuthority } from "../../src/desktop-owner-lease.js";

describe("desktop owner lease authority", () => {
  it("lets a new desktop shell replace the previous lease and rejects stale renewals", async () => {
    let now = 1_000;
    const expired = vi.fn(async () => undefined);
    const lease = createDesktopOwnerLeaseAuthority({
      ttlMs: 15_000,
      now: () => now,
      onExpired: expired,
    });

    lease.claim("shell-a");
    now += 5_000;
    expect(lease.renew("shell-a")).toBe(true);

    lease.claim("shell-b");
    expect(lease.renew("shell-a")).toBe(false);
    expect(lease.renew("shell-b")).toBe(true);
    expect(lease.current()).toMatchObject({ leaseId: "shell-b" });
    expect(expired).not.toHaveBeenCalled();
  });

  it("expires only after the deadline and invokes retirement exactly once", async () => {
    let now = 10_000;
    const expired = vi.fn(async () => undefined);
    const lease = createDesktopOwnerLeaseAuthority({
      ttlMs: 1_000,
      now: () => now,
      onExpired: expired,
    });

    lease.claim("shell-a");
    now = 10_999;
    await expect(lease.expireIfNeeded()).resolves.toBe(false);
    now = 11_000;
    await expect(lease.expireIfNeeded()).resolves.toBe(true);
    await expect(lease.expireIfNeeded()).resolves.toBe(false);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(lease.current()).toBeUndefined();
  });

  it("has no expiry work before a claim when no initial claim is required", async () => {
    const expired = vi.fn(async () => undefined);
    const lease = createDesktopOwnerLeaseAuthority({
      ttlMs: 1,
      now: () => 100,
      onExpired: expired,
    });

    await expect(lease.expireIfNeeded()).resolves.toBe(false);
    expect(expired).not.toHaveBeenCalled();
  });

  it("retires a desktop-owned Backend that never receives its initial shell claim", async () => {
    let now = 100;
    const expired = vi.fn(async () => undefined);
    const lease = createDesktopOwnerLeaseAuthority({
      ttlMs: 1_000,
      now: () => now,
      onExpired: expired,
      requireInitialClaim: true,
    });

    now = 1_099;
    await expect(lease.expireIfNeeded()).resolves.toBe(false);
    now = 1_100;
    await expect(lease.expireIfNeeded()).resolves.toBe(true);
    expect(expired).toHaveBeenCalledTimes(1);
  });
});
