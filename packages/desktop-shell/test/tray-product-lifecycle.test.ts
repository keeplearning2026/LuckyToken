import { describe, expect, it, vi } from "vitest";

import {
  startElectronDesktopLifecycle,
  type DesktopInstanceActivation,
} from "../src/main/electron-app-lifecycle.js";

function activation(
  buildId: string,
  attempt: DesktopInstanceActivation["attempt"] = "initial",
): DesktopInstanceActivation {
  return {
    contract: "luckytoken-desktop-instance-v1",
    buildId,
    attempt,
  };
}

describe("tray-only Electron product lifecycle", () => {
  it("starts one tray with no management window and opens only on demand", async () => {
    let trayOpen: (() => void) | undefined;
    let trayQuit: (() => void) | undefined;
    let secondInstance: ((value: unknown) => void) | undefined;
    const openWindow = vi.fn();
    const quitProduct = vi.fn();
    const exitDesktop = vi.fn();
    const startupOrder: string[] = [];
    const createTray = vi.fn((actions: { open: () => void; quit: () => void }) => {
      startupOrder.push("tray");
      trayOpen = actions.open;
      trayQuit = actions.quit;
    });
    const startBackendRecovery = vi.fn(() => startupOrder.push("recovery"));

    const result = await startElectronDesktopLifecycle({
      buildId: "build-a",
      requestSingleInstanceLock: () => true,
      releaseSingleInstanceLock: vi.fn(),
      waitForPrimaryHandoff: async () => undefined,
      whenReady: async () => undefined,
      onSecondInstance: (listener) => {
        secondInstance = listener;
      },
      onWindowAllClosed: vi.fn(),
      exitDesktop,
      quitProduct,
      openWindow,
      createTray,
      startBackendRecovery,
    });

    expect(result).toBe("primary");
    expect(startupOrder).toEqual(["tray", "recovery"]);
    expect(createTray).toHaveBeenCalledTimes(1);
    expect(openWindow).not.toHaveBeenCalled();

    trayOpen?.();
    trayOpen?.();
    secondInstance?.(activation("build-a"));
    expect(openWindow).toHaveBeenCalledTimes(3);

    trayQuit?.();
    expect(quitProduct).toHaveBeenCalledTimes(1);
    expect(exitDesktop).not.toHaveBeenCalled();
  });

  it("never creates tray or window for a secondary process and never asks Backend to quit", async () => {
    const exitDesktop = vi.fn();
    const quitProduct = vi.fn();
    const openWindow = vi.fn();
    const createTray = vi.fn();
    const requestSingleInstanceLock = vi
      .fn<(value: DesktopInstanceActivation) => boolean>()
      .mockReturnValue(false);

    const result = await startElectronDesktopLifecycle({
      buildId: "build-a",
      requestSingleInstanceLock,
      releaseSingleInstanceLock: vi.fn(),
      waitForPrimaryHandoff: async () => undefined,
      whenReady: async () => undefined,
      onSecondInstance: vi.fn(),
      onWindowAllClosed: vi.fn(),
      exitDesktop,
      quitProduct,
      openWindow,
      createTray,
      startBackendRecovery: vi.fn(),
    });

    expect(result).toBe("secondary");
    expect(exitDesktop).toHaveBeenCalledTimes(1);
    expect(quitProduct).not.toHaveBeenCalled();
    expect(createTray).not.toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
  });
});
