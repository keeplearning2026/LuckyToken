import { describe, expect, it, vi } from "vitest";

import {
  createBackendSupervisor,
  type BackendChild,
} from "../src/main/backend-supervisor.js";
import { resolveBundledBackendLaunch } from "../src/main/electron-backend-supervisor.js";

const endpoint = Object.freeze({
  address: "local-test-address",
  capability: "backend-supervisor-capability-01234567890123456789",
});

describe("BackendSupervisor", () => {
  it("resolves bundled Backend paths without exposing Backend internals", () => {
    expect(
      resolveBundledBackendLaunch({
        resourcesPath: "C:/Program/LuckyToken/resources",
        desktopExecutable: "C:/Program/LuckyToken/LuckyToken.exe",
        packaged: true,
        homeDirectory: "C:/Users/tester",
      }),
    ).toEqual({
      executable: expect.stringMatching(/resources[\\/]backend[\\/]node[\\/]node\.exe$/u),
      cliScript: expect.stringMatching(/resources[\\/]backend[\\/]dist[\\/]cli\.js$/u),
      configPath: expect.stringMatching(/Users[\\/]tester[\\/]\.luckytoken[\\/]config\.json$/u),
      descriptorPath: expect.stringMatching(/Users[\\/]tester[\\/]\.luckytoken[\\/]control-plane\.json$/u),
    });
  });

  it("attaches to a ready existing Backend without spawning", async () => {
    const spawn = vi.fn();
    const supervisor = createBackendSupervisor({
      discoverReadyBackend: async () => endpoint,
      spawnBackend: spawn,
      waitForReadyBackend: vi.fn(),
    });

    await expect(supervisor.ensureRunning()).resolves.toEqual({
      source: "existing",
      endpoint,
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(supervisor.current()).toEqual({ source: "existing", endpoint });
  });

  it("spawns once, waits for readiness, and reports only attachment facts", async () => {
    const release = vi.fn();
    const child: BackendChild = { pid: 4242, release };
    const spawn = vi.fn(async () => child);
    const waitForReadyBackend = vi.fn(async () => endpoint);
    const supervisor = createBackendSupervisor({
      discoverReadyBackend: async () => undefined,
      spawnBackend: spawn,
      waitForReadyBackend,
    });

    const [first, second] = await Promise.all([
      supervisor.ensureRunning(),
      supervisor.ensureRunning(),
    ]);
    expect(first).toEqual({ source: "spawned", endpoint, childPid: 4242 });
    expect(second).toEqual(first);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(waitForReadyBackend).toHaveBeenCalledTimes(1);

    await supervisor.dispose();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("disposing an attachment to a foreign Backend never performs process termination", async () => {
    const spawn = vi.fn();
    const supervisor = createBackendSupervisor({
      discoverReadyBackend: async () => endpoint,
      spawnBackend: spawn,
      waitForReadyBackend: vi.fn(),
    });

    await supervisor.ensureRunning();
    await supervisor.dispose();
    expect(spawn).not.toHaveBeenCalled();
  });
});
