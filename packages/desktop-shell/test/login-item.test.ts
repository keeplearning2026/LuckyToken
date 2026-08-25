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
          name: "Token-old-test",
          path: "D:\\project\\LuckyToken\\packages\\desktop-shell\\.electron-out\\123\\Token.exe",
          args: [],
          scope: "user",
          enabled: true,
        },
        {
          name: "Token",
          path: "C:\\Program Files\\Token\\Token.exe",
          args: [],
          scope: "user",
          enabled: true,
        },
        {
          name: "Token-machine",
          path: "D:\\project\\LuckyToken\\.electron-out\\machine\\Token.exe",
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
      path: "D:\\project\\LuckyToken\\packages\\desktop-shell\\.electron-out\\123\\Token.exe",
      args: [],
      name: "Token-old-test",
    });
  });

  it("reconciles stale per-user Token startup entries to the current installed executable", () => {
    const { api, set } = platform({
      openAtLogin: false,
      launchItems: [
        {
          name: "legacy-luckytoken",
          path: "C:\\old\\Token.exe",
          args: ["--legacy"],
          scope: "user",
          enabled: true,
        },
        {
          name: "test-luckytoken",
          path: "D:\\repo\\.electron-out\\42\\Token.exe",
          args: [],
          scope: "user",
          enabled: false,
        },
      ],
    });

    expect(
      reconcileInstalledLoginItem(api, "C:\\Program Files\\Token\\Token.exe"),
    ).toBe(true);
    expect(set).toHaveBeenNthCalledWith(1, {
      openAtLogin: false,
      path: "C:\\old\\Token.exe",
      args: ["--legacy"],
      name: "legacy-luckytoken",
    });
    expect(set).toHaveBeenNthCalledWith(2, {
      openAtLogin: false,
      path: "D:\\repo\\.electron-out\\42\\Token.exe",
      args: [],
      name: "test-luckytoken",
    });
    expect(set).toHaveBeenNthCalledWith(3, {
      openAtLogin: true,
      path: "C:\\Program Files\\Token\\Token.exe",
      args: [],
      enabled: true,
      name: "Token",
    });
  });

  it("normalizes a stale registration name to one canonical Token item", () => {
    const { api, set } = platform({
      openAtLogin: true,
      executableWillLaunchAtLogin: true,
      launchItems: [
        {
          name: "legacy-electron-app-id",
          path: "C:\\Program Files\\Token\\Token.exe",
          args: ["--old"],
          scope: "user",
          enabled: true,
        },
      ],
    });

    expect(
      reconcileInstalledLoginItem(api, "C:\\Program Files\\Token\\Token.exe"),
    ).toBe(true);
    expect(set).toHaveBeenNthCalledWith(1, {
      openAtLogin: false,
      path: "C:\\Program Files\\Token\\Token.exe",
      args: ["--old"],
      name: "legacy-electron-app-id",
    });
    expect(set).toHaveBeenNthCalledWith(2, {
      openAtLogin: true,
      path: "C:\\Program Files\\Token\\Token.exe",
      args: [],
      enabled: true,
      name: "Token",
    });
  });

  it("preserves a disabled Startup Approval state while moving the registration", () => {
    const { api, set } = platform({
      openAtLogin: false,
      launchItems: [
        {
          name: "Token",
          path: "C:\\old\\Token.exe",
          args: [],
          scope: "user",
          enabled: false,
        },
      ],
    });

    expect(
      reconcileInstalledLoginItem(api, "C:\\new\\Token.exe"),
    ).toBe(false);
    expect(set).toHaveBeenLastCalledWith({
      openAtLogin: true,
      path: "C:\\new\\Token.exe",
      args: [],
      enabled: false,
      name: "Token",
    });
  });

  it("uses executableWillLaunchAtLogin as the effective Windows state", () => {
    const { api } = platform({
      openAtLogin: true,
      executableWillLaunchAtLogin: false,
    });
    expect(effectiveDesktopAutoStart(api, "C:\\Token.exe")).toBe(false);
  });

  it("enabling replaces stale user entries and disabling removes every per-user Token entry", () => {
    const stale: DesktopLoginItemSnapshot = {
      openAtLogin: false,
      executableWillLaunchAtLogin: true,
      launchItems: [
        {
          name: "old",
          path: "C:\\old\\Token.exe",
          args: [],
          scope: "user",
          enabled: true,
        },
      ],
    };
    const enabled = platform(stale);
    expect(
      setInstalledDesktopAutoStart(enabled.api, "C:\\new\\Token.exe", true),
    ).toBe(true);
    expect(enabled.set).toHaveBeenCalledWith({
      openAtLogin: true,
      path: "C:\\new\\Token.exe",
      args: [],
      enabled: true,
      name: "Token",
    });

    const disabled = platform({
      ...stale,
      executableWillLaunchAtLogin: false,
      launchItems: [
        ...(stale.launchItems ?? []),
        {
          name: "Token",
          path: "C:\\new\\Token.exe",
          args: [],
          scope: "user" as const,
          enabled: true,
        },
      ],
    });
    expect(
      setInstalledDesktopAutoStart(disabled.api, "C:\\new\\Token.exe", false),
    ).toBe(false);
    expect(disabled.set).toHaveBeenCalledWith({
      openAtLogin: false,
      path: "C:\\new\\Token.exe",
      args: [],
      name: "Token",
    });
  });
});
