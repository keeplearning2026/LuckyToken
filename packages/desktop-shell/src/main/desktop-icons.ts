import { join } from "node:path";

export interface DesktopIconLocationOptions {
  readonly packaged: boolean;
  readonly resourcesPath: string;
  readonly appPath: string;
}

export interface DesktopIconPaths {
  readonly window: string;
  readonly tray: string;
}

/**
 * Packaged runtime assets live outside app.asar under process.resourcesPath.
 * Development uses the package-local assets directory so the same files are
 * exercised without copying them into Electron's installation directory.
 */
export function resolveDesktopIconPaths(
  options: DesktopIconLocationOptions,
): DesktopIconPaths {
  const root = options.packaged
    ? options.resourcesPath
    : join(options.appPath, "assets");
  return Object.freeze({
    window: join(root, "icon.png"),
    tray: join(root, "tray-icon.png"),
  });
}
