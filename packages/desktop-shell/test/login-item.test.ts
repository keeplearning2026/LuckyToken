import { describe, expect, it, vi } from "vitest";

import {
  cleanupRepositoryBuildLoginItems,
  effectiveDesktopAutoStart,
  reconcileInstalledLoginItem,
  setInstalledDesktopAutoStart,
  type DesktopLoginItemPlatform,
  type DesktopLoginItemSnapshot,
} from "../src/main/login-item.js";

function platform(snapshot: DesktopLoginItemSnapshot) {
  const set = vi.fn();
  const get = vi.fn(() => snapshot);
  return { api: { get, set } satisfies DesktopLoginItemPlatform, get, set };
}

describe("Windows desktop login-item ownership", () => {
  it("removes stale repository build login items without touching installed or machine entries", () => {
    const { api, set } = platform({
      openAtLogin: false,
      launchItems: [
        {
          name: "LuckyToken-old-test",
          path: "D:\\project\\LuckyToken\\packages\\desktop-shell\\.electron-out\\123\\LuckyToken.exe",
          args: [],
          scope: "user",
          enabled: true,
        },
        {
          name: "LuckyToken",
          path: "C:\\Program Files\\LuckyToken\\LuckyToken.exe",
          args: [],
          scope: "user",
          enabled: true,
        },
        {
          name: "LuckyToken-machine",
          path: "D:\\project\\LuckyToken\\.electron-out\\machine\\LuckyToken.exe",
          args: [],
          scope: "machine",
          enabled: true,
        },
      ],
    });

    expect(cleanupRepositoryBuildLoginItems(api)).toBe(1);
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({
      openAtLogin: false,
      path: "D:\\project\\LuckyToken\\packages\\desktop-shell\\.electron-out\\123\\LuckyToken.exe",
      args: [],
      name: "LuckyToken-old-test",
    });
  });

  it("migrates legacy per-user LuckyToken startup entries to the current installed executable", () => {
    const { api, set } = platform({
      openAtLogin: false,
      launchItems: [
        {
          name: "legacy-luckytoken",
          path: "C:\\old\\LuckyToken.exe",
          args: ["--legacy"],
          scope: "user",
          enabled: true,
        },
        {
          name: "test-luckytoken",
          path: "D:\\repo\\.electron-out\\42\\LuckyToken.exe",
          args: [],
          scope: "user",
          enabled: false,
        },
      ],
    });

    expect(
      reconcileInstalledLoginItem(api, "C:\\Program Files\\LuckyToken\\LuckyToken.exe"),
    ).toBe(true);
    expect(set).toHaveBeenNthCalledWith(1, {
      openAtLogin: false,
      path: "C:\\old\\LuckyToken.exe",
      args: ["--legacy"],
      name: "legacy-luckytoken",
    });
    expect(set).toHaveBeenNthCalledWith(2, {
      openAtLogin: false,
      path: "D:\\repo\\.electron-out\\42\\LuckyToken.exe",
      args: [],
      name: "test-luckytoken",
    });
    expect(set).toHaveBeenNthCalledWith(3, {
      openAtLogin: true,
      path: "C:\\Program Files\\LuckyToken\\LuckyToken.exe",
      args: [],
      enabled: true,
      name: "LuckyToken",
    });
  });

  it("normalizes a same-path legacy registration name to one canonical LuckyToken item", () => {
    const { api, set } = platform({
      openAtLogin: true,
      executableWillLaunchAtLogin: true,
      launchItems: [
        {
          name: "legacy-electron-app-id",
          path: "C:\\Program Files\\LuckyToken\\LuckyToken.exe",
          args: ["--old"],
          scope: "user",
          enabled: true,
        },
      ],
    });

    expect(
      reconcileInstalledLoginItem(api, "C:\\Program Files\\LuckyToken\\LuckyToken.exe"),
    ).toBe(true);
    expect(set).toHaveBeenNthCalledWith(1, {
      openAtLogin: false,
      path: "C:\\Program Files\\LuckyToken\\LuckyToken.exe",
      args: ["--old"],
      name: "legacy-electron-app-id",
    });
    expect(set).toHaveBeenNthCalledWith(2, {
      openAtLogin: true,
      path: "C:\\Program Files\\LuckyToken\\LuckyToken.exe",
      args: [],
      enabled: true,
      name: "LuckyToken",
    });
  });

  it("preserves a disabled Startup Approval state while moving the registration", () => {
    const { api, set } = platform({
      openAtLogin: false,
      launchItems: [
        {
          name: "LuckyToken",
          path: "C:\\old\\LuckyToken.exe",
          args: [],
          scope: "user",
          enabled: false,
        },
      ],
    });

    expect(
      reconcileInstalledLoginItem(api, "C:\\new\\LuckyToken.exe"),
    ).toBe(false);
    expect(set).toHaveBeenLastCalledWith({
      openAtLogin: true,
      path: "C:\\new\\LuckyToken.exe",
      args: [],
      enabled: false,
      name: "LuckyToken",
    });
  });

  it("uses executableWillLaunchAtLogin as the effective Windows state", () => {
    const { api } = platform({
      openAtLogin: true,
      executableWillLaunchAtLogin: false,
    });
    expect(effectiveDesktopAutoStart(api, "C:\\LuckyToken.exe")).toBe(false);
  });

  it("enabling replaces stale user entries and disabling removes every per-user LuckyToken entry", () => {
    const stale: DesktopLoginItemSnapshot = {
      openAtLogin: false,
      executableWillLaunchAtLogin: true,
      launchItems: [
        {
          name: "old",
          path: "C:\\old\\LuckyToken.exe",
          args: [],
          scope: "user",
          enabled: true,
        },
      ],
    };
    const enabled = platform(stale);
    expect(
      setInstalledDesktopAutoStart(enabled.api, "C:\\new\\LuckyToken.exe", true),
    ).toBe(true);
    expect(enabled.set).toHaveBeenCalledWith({
      openAtLogin: true,
      path: "C:\\new\\LuckyToken.exe",
      args: [],
      enabled: true,
      name: "LuckyToken",
    });

    const disabled = platform({
      ...stale,
      executableWillLaunchAtLogin: false,
      launchItems: [
        ...(stale.launchItems ?? []),
        {
          name: "LuckyToken",
          path: "C:\\new\\LuckyToken.exe",
          args: [],
          scope: "user" as const,
          enabled: true,
        },
      ],
    });
    expect(
      setInstalledDesktopAutoStart(disabled.api, "C:\\new\\LuckyToken.exe", false),
    ).toBe(false);
    expect(disabled.set).toHaveBeenCalledWith({
      openAtLogin: false,
      path: "C:\\new\\LuckyToken.exe",
      args: [],
      name: "LuckyToken",
    });
  });
});
