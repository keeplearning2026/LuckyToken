import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { resolveDesktopIconPaths } from "../src/main/desktop-icons.js";

const require = createRequire(import.meta.url);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetRoot = join(packageRoot, "assets");

interface ForgeConfiguration {
  readonly packagerConfig: {
    readonly icon: string;
    readonly extraResource: readonly string[];
  };
  readonly makers: ReadonlyArray<{
    readonly name: string;
    readonly config: {
      readonly setupIcon?: string;
    };
  }>;
}

function pngMetadata(path: string): {
  readonly width: number;
  readonly height: number;
  readonly colorType: number;
} {
  const bytes = readFileSync(path);
  expect(bytes.subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    colorType: bytes.readUInt8(25),
  };
}

describe("Electron desktop icons", () => {
  it("resolves package-local development assets and packaged resources", () => {
    expect(
      resolveDesktopIconPaths({
        packaged: false,
        resourcesPath: "C:/Electron/resources",
        appPath: "D:/Token/packages/desktop-shell",
      }),
    ).toEqual({
      window: join("D:/Token/packages/desktop-shell", "assets", "icon.png"),
      tray: join("D:/Token/packages/desktop-shell", "assets", "tray-icon.png"),
    });
    expect(
      resolveDesktopIconPaths({
        packaged: true,
        resourcesPath: "C:/Program Files/Token/resources",
        appPath: "ignored",
      }),
    ).toEqual({
      window: join("C:/Program Files/Token/resources", "icon.png"),
      tray: join("C:/Program Files/Token/resources", "tray-icon.png"),
    });
  });

  it("ships an opaque application master and transparent tray PNG assets at their contracted sizes", () => {
    expect(pngMetadata(join(assetRoot, "icon.png"))).toEqual({
      width: 1024,
      height: 1024,
      colorType: 2,
    });
    expect(pngMetadata(join(assetRoot, "tray-icon.png"))).toEqual({
      width: 32,
      height: 32,
      colorType: 6,
    });
    expect(pngMetadata(join(assetRoot, "tray-icon@2x.png"))).toEqual({
      width: 64,
      height: 64,
      colorType: 6,
    });
  });

  it("ships a seven-resolution Windows icon and a structurally valid macOS icon", () => {
    const ico = readFileSync(join(assetRoot, "icon.ico"));
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(7);
    const dimensions = Array.from({ length: 7 }, (_, index) => {
      const width = ico.readUInt8(6 + index * 16);
      return width === 0 ? 256 : width;
    });
    expect(dimensions).toEqual([256, 128, 64, 48, 32, 24, 16]);

    const icns = readFileSync(join(assetRoot, "icon.icns"));
    expect(icns.subarray(0, 4).toString("ascii")).toBe("icns");
    expect(icns.readUInt32BE(4)).toBe(icns.length);
  });

  it("configures the packaged app, runtime resources, and Squirrel installer", () => {
    const config = require("../forge.config.cjs") as ForgeConfiguration;
    expect(config.packagerConfig.icon).toBe(join(assetRoot, "icon"));
    expect(config.packagerConfig.extraResource).toEqual(
      expect.arrayContaining([
        join(assetRoot, "icon.png"),
        join(assetRoot, "tray-icon.png"),
        join(assetRoot, "tray-icon@2x.png"),
      ]),
    );
    expect(
      config.makers.find((maker) => maker.name === "@electron-forge/maker-squirrel")
        ?.config.setupIcon,
    ).toBe(join(assetRoot, "icon.ico"));
  });
});
