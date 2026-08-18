import { describe, expect, it, vi } from "vitest";

import { startElectronDesktopLifecycle } from "../src/main/electron-app-lifecycle.js";

describe("tray-only Electron product lifecycle", () => {
  it("starts one tray with no management window and opens only on demand", async () => {
    let trayOpen: (() => void) | undefined;
    let trayQuit: (() => void) | undefined;
    let secondInstance: (() => void) | undefined;
    const openWindow = vi.fn();
    const quit = vi.fn();
    const createTray = vi.fn((actions: { open: () => void; quit: () => void }) => {
      trayOpen = actions.open;
      trayQuit = actions.quit;
    });

    const result = await startElectronDesktopLifecycle({
      requestSingleInstanceLock: () => true,
      whenReady: async () => undefined,
      onSecondInstance: (listener) => {
        secondInstance = listener;
      },
      onWindowAllClosed: vi.fn(),
      quit,
      openWindow,
      createTray,
    });

    expect(result).toBe("primary");
    expect(createTray).toHaveBeenCalledTimes(1);
    expect(openWindow).not.toHaveBeenCalled();

    trayOpen?.();
    trayOpen?.();
    secondInstance?.();
    expect(openWindow).toHaveBeenCalledTimes(3);

    trayQuit?.();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("never creates tray or window for a secondary process", async () => {
    const quit = vi.fn();
    const openWindow = vi.fn();
    const createTray = vi.fn();

    const result = await startElectronDesktopLifecycle({
      requestSingleInstanceLock: () => false,
      whenReady: async () => undefined,
      onSecondInstance: vi.fn(),
      onWindowAllClosed: vi.fn(),
      quit,
      openWindow,
      createTray,
    });

    expect(result).toBe("secondary");
    expect(quit).toHaveBeenCalledTimes(1);
    expect(createTray).not.toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
  });
});
