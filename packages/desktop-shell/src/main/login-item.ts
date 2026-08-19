export const luckyTokenLoginItemName = "LuckyToken";

export interface DesktopLoginItem {
  readonly name: string;
  readonly path: string;
  readonly args: readonly string[];
  readonly scope: "user" | "machine";
  readonly enabled: boolean;
}

export interface DesktopLoginItemSnapshot {
  readonly openAtLogin: boolean;
  readonly executableWillLaunchAtLogin?: boolean;
  readonly launchItems?: readonly DesktopLoginItem[];
}

export interface DesktopLoginItemPlatform {
  get(options?: {
    readonly path?: string;
    readonly args?: readonly string[];
  }): DesktopLoginItemSnapshot;
  set(settings: {
    readonly openAtLogin: boolean;
    readonly path?: string;
    readonly args?: readonly string[];
    readonly enabled?: boolean;
    readonly name?: string;
  }): void;
}

function normalizedPath(path: string): string {
  return path.replaceAll("\\", "/").toLowerCase();
}

function sameExecutable(left: string, right: string): boolean {
  return normalizedPath(left) === normalizedPath(right);
}

function isLuckyTokenExecutable(path: string): boolean {
  return normalizedPath(path).endsWith("/luckytoken.exe");
}

function isRepositoryBuildPath(path: string): boolean {
  return normalizedPath(path).includes("/.electron-out/");
}

function userLuckyTokenItems(
  snapshot: DesktopLoginItemSnapshot,
): readonly DesktopLoginItem[] {
  return (snapshot.launchItems ?? []).filter(
    (item) => item.scope === "user" && isLuckyTokenExecutable(item.path),
  );
}

function removeLoginItem(
  platform: DesktopLoginItemPlatform,
  item: DesktopLoginItem,
): void {
  platform.set({
    openAtLogin: false,
    path: item.path,
    args: [...item.args],
    name: item.name,
  });
}

/**
 * Repository `.electron-out` builds are disposable and must never survive a
 * Windows sign-in. Remove only stale repository-build entries; an installed
 * LuckyToken login item is left untouched.
 */
export function cleanupRepositoryBuildLoginItems(
  platform: DesktopLoginItemPlatform,
): number {
  const stale = userLuckyTokenItems(platform.get()).filter((item) =>
    isRepositoryBuildPath(item.path),
  );
  for (const item of stale) removeLoginItem(platform, item);
  return stale.length;
}

/**
 * Installed product startup migrates any older per-user LuckyToken login item
 * to the currently running executable. Presence is preserved independently
 * from Windows Startup Approval (`enabled`) so user intent is not widened.
 */
export function reconcileInstalledLoginItem(
  platform: DesktopLoginItemPlatform,
  currentExecutable: string,
): boolean {
  const items = userLuckyTokenItems(platform.get());
  const canonical = items.find(
    (item) =>
      sameExecutable(item.path, currentExecutable) &&
      item.name === luckyTokenLoginItemName &&
      item.args.length === 0,
  );
  const stale = items.filter((item) => item !== canonical);
  if (stale.length === 0) {
    return canonical?.enabled ?? effectiveDesktopAutoStart(platform, currentExecutable);
  }

  const enabled = canonical?.enabled ?? stale.some((item) => item.enabled);
  for (const item of stale) removeLoginItem(platform, item);
  if (canonical === undefined) {
    platform.set({
      openAtLogin: true,
      path: currentExecutable,
      args: [],
      enabled,
      name: luckyTokenLoginItemName,
    });
  }
  return enabled;
}

export function effectiveDesktopAutoStart(
  platform: DesktopLoginItemPlatform,
  currentExecutable: string,
): boolean {
  const current = platform.get({ path: currentExecutable, args: [] });
  return current.executableWillLaunchAtLogin ?? current.openAtLogin;
}

/** Set the installed product login item and remove stale per-user duplicates. */
export function setInstalledDesktopAutoStart(
  platform: DesktopLoginItemPlatform,
  currentExecutable: string,
  enabled: boolean,
): boolean {
  const items = userLuckyTokenItems(platform.get());
  for (const item of items) removeLoginItem(platform, item);
  if (enabled) {
    platform.set({
      openAtLogin: true,
      path: currentExecutable,
      args: [],
      enabled: true,
      name: luckyTokenLoginItemName,
    });
  } else {
    platform.set({
      openAtLogin: false,
      path: currentExecutable,
      args: [],
      name: luckyTokenLoginItemName,
    });
  }
  return effectiveDesktopAutoStart(platform, currentExecutable);
}
