import { describe, expect, it, vi } from "vitest";
import type {
  ApplicationCommandResult,
  ApplicationOwnership,
} from "@luckytoken/application-control-plane/control-plane";

import { createDesktopOwnerLeaseClient } from "../src/main/desktop-owner-lease.js";

const desktopOwnership: ApplicationOwnership = {
  owner: {
    kind: "desktop",
    pid: 123,
    startedAt: "2026-08-19T00:00:00.000Z",
  },
};

const cliOwnership: ApplicationOwnership = {
  owner: {
    kind: "cli",
    pid: 456,
    startedAt: "2026-08-19T00:00:00.000Z",
  },
};

function result(
  command: "desktop_owner",
  outcome: ApplicationCommandResult["outcome"],
): ApplicationCommandResult {
  return {
    command,
    outcome,
    snapshot: {
      sequence: 1,
      modelDataPlane: "stopped",
      provider: "unconfigured",
      ownership: desktopOwnership,
    },
  } as ApplicationCommandResult;
}

describe("desktop owner lease client", () => {
  it("does nothing when Electron attaches to a CLI-owned Backend", async () => {
    const execute = vi.fn();
    const schedule = vi.fn();
    const client = createDesktopOwnerLeaseClient({
      leaseId: "shell-a",
      renewIntervalMs: 5_000,
      execute,
      setInterval: schedule as unknown as typeof setInterval,
      clearInterval: vi.fn() as unknown as typeof clearInterval,
    });

    await client.bind(cliOwnership);
    expect(client.isBound()).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it("claims a desktop-owned Backend and renews the same logical lease", async () => {
    let tick: (() => void) | undefined;
    const execute = vi
      .fn()
      .mockResolvedValueOnce(result("desktop_owner", "lease_claimed"))
      .mockResolvedValueOnce(result("desktop_owner", "lease_renewed"));
    const client = createDesktopOwnerLeaseClient({
      leaseId: "shell-a",
      renewIntervalMs: 5_000,
      execute,
      setInterval: ((callback: () => void) => {
        tick = callback;
        return 1 as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval,
      clearInterval: vi.fn() as unknown as typeof clearInterval,
    });

    await client.bind(desktopOwnership);
    expect(client.isBound()).toBe(true);
    expect(execute).toHaveBeenNthCalledWith(1, {
      command: "desktop_owner",
      action: "claim",
      leaseId: "shell-a",
    });
    tick?.();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(execute).toHaveBeenNthCalledWith(2, {
      command: "desktop_owner",
      action: "renew",
      leaseId: "shell-a",
    });
  });

  it("stops renewing after the Backend reports that a newer shell owns the lease", async () => {
    let tick: (() => void) | undefined;
    const clear = vi.fn();
    const onFailure = vi.fn();
    const execute = vi
      .fn()
      .mockResolvedValueOnce(result("desktop_owner", "lease_claimed"))
      .mockResolvedValueOnce({
        ...result("desktop_owner", "conflict"),
        conflict: {
          code: "desktop_owner_lease_mismatch" as const,
          message: "The desktop ownership lease belongs to a newer LuckyToken shell.",
        },
      });
    const client = createDesktopOwnerLeaseClient({
      leaseId: "shell-old",
      renewIntervalMs: 5_000,
      execute,
      onFailure,
      setInterval: ((callback: () => void) => {
        tick = callback;
        return 7 as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval,
      clearInterval: clear as unknown as typeof clearInterval,
    });

    await client.bind(desktopOwnership);
    tick?.();
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1));
    expect(client.isBound()).toBe(false);
    expect(clear).toHaveBeenCalled();
  });
});
