import { describe, expect, it, vi } from "vitest";

import {
  createSecureManagementWindowOptions,
  startElectronDesktopLifecycle,
} from "../src/main/electron-app-lifecycle.js";

describe("Electron desktop lifecycle seam", () => {
  it("uses secure renderer defaults", () => {
    expect(createSecureManagementWindowOptions("C:/app/preload.js")).toMatchObject({
      show: false,
      webPreferences: {
        preload: "C:/app/preload.js",
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });
  });

  it("quits a secondary desktop process without creating a window", async () => {
    const quit = vi.fn();
    const openWindow = vi.fn();
    const onSecondInstance = vi.fn();

    const result = await startElectronDesktopLifecycle({
      requestSingleInstanceLock: () => false,
      whenReady: async () => undefined,
      onSecondInstance,
      quit,
      openWindow,
    });

    expect(result).toBe("secondary");
    expect(quit).toHaveBeenCalledTimes(1);
    expect(openWindow).not.toHaveBeenCalled();
    expect(onSecondInstance).not.toHaveBeenCalled();
  });

  it("opens one primary window after ready and reuses the open operation for second-instance activation", async () => {
    let secondInstance: (() => void) | undefined;
    const openWindow = vi.fn();
    const quit = vi.fn();

    const result = await startElectronDesktopLifecycle({
      requestSingleInstanceLock: () => true,
      whenReady: async () => undefined,
      onSecondInstance: (listener) => {
        secondInstance = listener;
      },
      quit,
      openWindow,
    });

    expect(result).toBe("primary");
    expect(openWindow).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();

    secondInstance?.();
    expect(openWindow).toHaveBeenCalledTimes(2);
  });
});
