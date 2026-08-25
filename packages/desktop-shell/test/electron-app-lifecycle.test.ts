import { describe, expect, it, vi } from "vitest";

import {
  createSecureManagementWindowOptions,
  desktopInstanceUserDataPath,
  quitTokenProduct,
  startElectronDesktopLifecycle,
  type DesktopInstanceActivation,
} from "../src/main/electron-app-lifecycle.js";

function activation(
  buildId: string,
  attempt: DesktopInstanceActivation["attempt"] = "initial",
): DesktopInstanceActivation {
  return {
    contract: "token-desktop-instance-v1",
    buildId,
    attempt,
  };
}

describe("Electron desktop lifecycle seam", () => {
  it("isolates disposable .electron-out builds from the installed product instance domain", () => {
    const isolated = desktopInstanceUserDataPath({
      executablePath: "D:\\project\\Token\\packages\\desktop-shell\\.electron-out\\123\\Token.exe",
      appDataPath: "app-data-root",
      buildId: "abcdef0123456789abcdef0123456789abcdef",
    });
    expect(isolated?.replaceAll("\\", "/")).toBe(
      "app-data-root/@token/desktop-shell-builds/abcdef0123456789abcdef0123456789",
    );
    expect(
      desktopInstanceUserDataPath({
        executablePath: "C:\\Program Files\\Token\\Token.exe",
        appDataPath: "C:\\Users\\tester\\AppData\\Roaming",
        buildId: "abcdef",
      }),
    ).toBeUndefined();
  });

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

  it("exits a secondary desktop locally without attempting product/Backend quit", async () => {
    const exitDesktop = vi.fn();
    const quitProduct = vi.fn();
    const openWindow = vi.fn();
    const onSecondInstance = vi.fn();
    const requestSingleInstanceLock = vi
      .fn<(value: DesktopInstanceActivation) => boolean>()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false);

    const result = await startElectronDesktopLifecycle({
      buildId: "build-a",
      requestSingleInstanceLock,
      releaseSingleInstanceLock: vi.fn(),
      waitForPrimaryHandoff: async () => undefined,
      whenReady: async () => undefined,
      onSecondInstance,
      onWindowAllClosed: vi.fn(),
      exitDesktop,
      quitProduct,
      openWindow,
      createTray: vi.fn(),
      startBackendRecovery: vi.fn(),
    });

    expect(result).toBe("secondary");
    expect(requestSingleInstanceLock).toHaveBeenNthCalledWith(
      1,
      activation("build-a", "initial"),
    );
    expect(requestSingleInstanceLock).toHaveBeenNthCalledWith(
      2,
      activation("build-a", "handoff_retry"),
    );
    expect(exitDesktop).toHaveBeenCalledTimes(1);
    expect(quitProduct).not.toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
    expect(onSecondInstance).not.toHaveBeenCalled();
  });

  it("can become primary on the handoff retry after an older build releases the lock", async () => {
    const requestSingleInstanceLock = vi
      .fn<(value: DesktopInstanceActivation) => boolean>()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const createTray = vi.fn();
    const exitDesktop = vi.fn();

    const result = await startElectronDesktopLifecycle({
      buildId: "build-new",
      requestSingleInstanceLock,
      releaseSingleInstanceLock: vi.fn(),
      waitForPrimaryHandoff: async () => undefined,
      whenReady: async () => undefined,
      onSecondInstance: vi.fn(),
      onWindowAllClosed: vi.fn(),
      exitDesktop,
      quitProduct: vi.fn(),
      openWindow: vi.fn(),
      createTray,
      startBackendRecovery: vi.fn(),
    });

    expect(result).toBe("primary");
    expect(exitDesktop).not.toHaveBeenCalled();
    expect(createTray).toHaveBeenCalledTimes(1);
  });

  it("hands the desktop shell to a different build without stopping the Backend", async () => {
    let secondInstance: ((value: unknown) => void) | undefined;
    const releaseSingleInstanceLock = vi.fn();
    const exitDesktop = vi.fn();
    const quitProduct = vi.fn();
    const openWindow = vi.fn();

    await startElectronDesktopLifecycle({
      buildId: "build-old",
      requestSingleInstanceLock: () => true,
      releaseSingleInstanceLock,
      waitForPrimaryHandoff: async () => undefined,
      whenReady: async () => undefined,
      onSecondInstance: (listener) => {
        secondInstance = listener;
      },
      onWindowAllClosed: vi.fn(),
      exitDesktop,
      quitProduct,
      openWindow,
      createTray: vi.fn(),
      startBackendRecovery: vi.fn(),
    });

    secondInstance?.(activation("build-new"));
    expect(releaseSingleInstanceLock).toHaveBeenCalledTimes(1);
    expect(exitDesktop).toHaveBeenCalledTimes(1);
    expect(quitProduct).not.toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
  });

  it("activates the existing window for the same build and ignores its retry probe", async () => {
    let secondInstance: ((value: unknown) => void) | undefined;
    const openWindow = vi.fn();
    const exitDesktop = vi.fn();
    const createTray = vi.fn();
    let windowAllClosed: (() => void) | undefined;

    const result = await startElectronDesktopLifecycle({
      buildId: "build-a",
      requestSingleInstanceLock: () => true,
      releaseSingleInstanceLock: vi.fn(),
      waitForPrimaryHandoff: async () => undefined,
      whenReady: async () => undefined,
      onSecondInstance: (listener) => {
        secondInstance = listener;
      },
      onWindowAllClosed: (listener) => {
        windowAllClosed = listener;
      },
      exitDesktop,
      quitProduct: vi.fn(),
      openWindow,
      createTray,
      startBackendRecovery: vi.fn(),
    });

    expect(result).toBe("primary");
    expect(createTray).toHaveBeenCalledTimes(1);
    expect(openWindow).not.toHaveBeenCalled();

    secondInstance?.(activation("build-a", "initial"));
    expect(openWindow).toHaveBeenCalledTimes(1);
    secondInstance?.(activation("build-a", "handoff_retry"));
    expect(openWindow).toHaveBeenCalledTimes(1);
    windowAllClosed?.();
    expect(exitDesktop).not.toHaveBeenCalled();
  });

  it("keeps backward-compatible activation behavior for an older shell with no identity payload", async () => {
    let secondInstance: ((value: unknown) => void) | undefined;
    const openWindow = vi.fn();

    await startElectronDesktopLifecycle({
      buildId: "build-a",
      requestSingleInstanceLock: () => true,
      releaseSingleInstanceLock: vi.fn(),
      waitForPrimaryHandoff: async () => undefined,
      whenReady: async () => undefined,
      onSecondInstance: (listener) => {
        secondInstance = listener;
      },
      onWindowAllClosed: vi.fn(),
      exitDesktop: vi.fn(),
      quitProduct: vi.fn(),
      openWindow,
      createTray: vi.fn(),
      startBackendRecovery: vi.fn(),
    });

    secondInstance?.(undefined);
    expect(openWindow).toHaveBeenCalledTimes(1);
  });

  it("quits the desktop only after an acknowledged Backend drain outcome", async () => {
    const quitDesktop = vi.fn();
    const onFailure = vi.fn();

    await expect(
      quitTokenProduct({
        backendOwnerKind: () => "desktop",
        ownsDesktopBackend: () => true,
        requestBackendQuit: async () => ({ outcome: "drained" }),
        quitDesktop,
        onFailure,
      }),
    ).resolves.toBe(true);
    expect(quitDesktop).toHaveBeenCalledTimes(1);
    expect(onFailure).not.toHaveBeenCalled();

    quitDesktop.mockClear();
    await expect(
      quitTokenProduct({
        backendOwnerKind: () => "desktop",
        ownsDesktopBackend: () => true,
        requestBackendQuit: async () => ({ outcome: "conflict" }),
        quitDesktop,
        onFailure,
      }),
    ).resolves.toBe(false);
    expect(quitDesktop).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it("never lets a viewer shell quit a desktop-owned Backend whose lease it does not hold", async () => {
    const quitDesktop = vi.fn();
    const requestBackendQuit = vi.fn(async () => ({ outcome: "drained" }));
    await expect(
      quitTokenProduct({
        backendOwnerKind: () => "desktop",
        ownsDesktopBackend: () => false,
        requestBackendQuit,
        quitDesktop,
      }),
    ).resolves.toBe(true);
    expect(quitDesktop).toHaveBeenCalledTimes(1);
    expect(requestBackendQuit).not.toHaveBeenCalled();
  });

  it("quits only the Electron shell when attached to a CLI-owned Backend", async () => {
    const quitDesktop = vi.fn();
    const requestBackendQuit = vi.fn(async () => ({ outcome: "drained" }));
    await expect(
      quitTokenProduct({
        backendOwnerKind: () => "cli",
        ownsDesktopBackend: () => false,
        requestBackendQuit,
        quitDesktop,
      }),
    ).resolves.toBe(true);
    expect(quitDesktop).toHaveBeenCalledTimes(1);
    expect(requestBackendQuit).not.toHaveBeenCalled();
  });

  it("keeps Electron alive when Backend ownership is unknown", async () => {
    const quitDesktop = vi.fn();
    const onFailure = vi.fn();
    await expect(
      quitTokenProduct({
        backendOwnerKind: () => undefined,
        ownsDesktopBackend: () => false,
        requestBackendQuit: async () => ({ outcome: "drained" }),
        quitDesktop,
        onFailure,
      }),
    ).resolves.toBe(false);
    expect(quitDesktop).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it("keeps Electron alive when Backend quit is unavailable", async () => {
    const quitDesktop = vi.fn();
    const onFailure = vi.fn();
    await expect(
      quitTokenProduct({
        backendOwnerKind: () => "desktop",
        ownsDesktopBackend: () => true,
        requestBackendQuit: async () => {
          throw new Error("Control Plane unavailable");
        },
        quitDesktop,
        onFailure,
      }),
    ).resolves.toBe(false);
    expect(quitDesktop).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledTimes(1);
  });
});
