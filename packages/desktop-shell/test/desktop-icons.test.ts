import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

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

function paethPredictor(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function decodeRgbaPng(path: string): {
  readonly width: number;
  readonly height: number;
  readonly alphaAt: (x: number, y: number) => number;
  readonly rgbaAt: (
    x: number,
    y: number,
  ) => readonly [red: number, green: number, blue: number, alpha: number];
} {
  const bytes = readFileSync(path);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  expect(bytes.readUInt8(24)).toBe(8);
  expect(bytes.readUInt8(25)).toBe(6);
  expect(bytes.readUInt8(28)).toBe(0);

  const idatChunks: Buffer[] = [];
  for (let offset = 8; offset < bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "IDAT") {
      idatChunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    }
    offset += 12 + length;
  }

  const encoded = inflateSync(Buffer.concat(idatChunks));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  let inputOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = encoded.readUInt8(inputOffset);
    inputOffset += 1;
    for (let x = 0; x < stride; x += 1) {
      const raw = encoded.readUInt8(inputOffset);
      inputOffset += 1;
      const left = x >= 4 ? pixels.readUInt8(y * stride + x - 4) : 0;
      const above = y > 0 ? pixels.readUInt8((y - 1) * stride + x) : 0;
      const upperLeft =
        x >= 4 && y > 0
          ? pixels.readUInt8((y - 1) * stride + x - 4)
          : 0;
      const value = (() => {
        switch (filter) {
          case 0:
            return raw;
          case 1:
            return raw + left;
          case 2:
            return raw + above;
          case 3:
            return raw + Math.floor((left + above) / 2);
          case 4:
            return raw + paethPredictor(left, above, upperLeft);
          default:
            throw new Error(`Unsupported PNG filter ${filter}`);
        }
      })();
      pixels.writeUInt8(value & 0xff, y * stride + x);
    }
  }

  return {
    width,
    height,
    alphaAt: (x, y) => pixels.readUInt8(y * stride + x * 4 + 3),
    rgbaAt: (x, y) => {
      const offset = y * stride + x * 4;
      return [
        pixels.readUInt8(offset),
        pixels.readUInt8(offset + 1),
        pixels.readUInt8(offset + 2),
        pixels.readUInt8(offset + 3),
      ];
    },
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
      tray: join("D:/Token/packages/desktop-shell", "assets", "icon.png"),
    });
    expect(
      resolveDesktopIconPaths({
        packaged: true,
        resourcesPath: "C:/Program Files/Token/resources",
        appPath: "ignored",
      }),
    ).toEqual({
      window: join("C:/Program Files/Token/resources", "icon.png"),
      tray: join("C:/Program Files/Token/resources", "icon.png"),
    });
  });

  it("ships one transparent rounded-square application master for both window and tray", () => {
    expect(pngMetadata(join(assetRoot, "icon.png"))).toEqual({
      width: 1024,
      height: 1024,
      colorType: 6,
    });

    const icon = decodeRgbaPng(join(assetRoot, "icon.png"));
    const corners: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [icon.width - 1, 0],
      [0, icon.height - 1],
      [icon.width - 1, icon.height - 1],
    ];
    for (const [x, y] of corners) {
      expect(icon.alphaAt(x, y)).toBe(0);
    }
    const edgeInset = Math.floor(icon.width / 64);
    expect(icon.alphaAt(Math.floor(icon.width / 2), edgeInset)).toBeGreaterThan(0);
    expect(icon.alphaAt(edgeInset, Math.floor(icon.height / 2))).toBeGreaterThan(0);
    expect(
      icon.alphaAt(Math.floor(icon.width / 2), Math.floor(icon.height / 2)),
    ).toBeGreaterThan(250);

    const [red, green, blue, alpha] = icon.rgbaAt(
      Math.floor(icon.width / 8),
      Math.floor(icon.height / 8),
    );
    expect(Math.min(red, green, blue)).toBeGreaterThanOrEqual(245);
    expect(Math.max(red, green, blue) - Math.min(red, green, blue)).toBeLessThanOrEqual(5);
    expect(alpha).toBeGreaterThan(250);
  });

  it("derives the Windows and macOS containers from the application master", () => {
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

    const macPngs = new Map<string, Buffer>();
    for (let offset = 8; offset < icns.length; ) {
      const type = icns.subarray(offset, offset + 4).toString("ascii");
      const length = icns.readUInt32BE(offset + 4);
      macPngs.set(type, icns.subarray(offset + 8, offset + length));
      offset += length;
    }
    expect([...macPngs.keys()]).toEqual([
      "icp4",
      "icp5",
      "icp6",
      "ic07",
      "ic08",
      "ic09",
      "ic10",
    ]);
    expect(macPngs.get("ic10")).toEqual(readFileSync(join(assetRoot, "icon.png")));

    const windows256Length = ico.readUInt32LE(14);
    const windows256Offset = ico.readUInt32LE(18);
    expect(
      ico.subarray(windows256Offset, windows256Offset + windows256Length),
    ).toEqual(macPngs.get("ic08"));
  });

  it("configures the packaged app, runtime resources, and Squirrel installer", () => {
    const config = require("../forge.config.cjs") as ForgeConfiguration;
    expect(config.packagerConfig.icon).toBe(join(assetRoot, "icon"));
    expect(config.packagerConfig.extraResource).toEqual(
      ["backend", join(assetRoot, "icon.png")],
    );
    expect(
      config.makers.find((maker) => maker.name === "@electron-forge/maker-squirrel")
        ?.config.setupIcon,
    ).toBe(join(assetRoot, "icon.ico"));
  });
});
