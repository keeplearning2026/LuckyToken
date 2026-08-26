import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetRoot = join(packageRoot, "assets");
const masterPath = join(assetRoot, "icon.png");
const temporaryRoot = mkdtempSync(join(tmpdir(), "token-desktop-icons-"));

function pngAtSize(size) {
  if (size === 1024) return readFileSync(masterPath);
  const outputPath = join(temporaryRoot, `icon-${size}.png`);
  execFileSync(
    "magick",
    [
      masterPath,
      "-background",
      "none",
      "-filter",
      "Lanczos",
      "-resize",
      `${size}x${size}!`,
      "-strip",
      "-define",
      "png:exclude-chunk=date,time",
      outputPath,
    ],
    { stdio: "inherit" },
  );
  return readFileSync(outputPath);
}

function writeWindowsIcon(images) {
  const headerLength = 6 + images.length * 16;
  const header = Buffer.alloc(headerLength);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let imageOffset = headerLength;
  images.forEach(({ size, png }, index) => {
    const offset = 6 + index * 16;
    header.writeUInt8(size === 256 ? 0 : size, offset);
    header.writeUInt8(size === 256 ? 0 : size, offset + 1);
    header.writeUInt8(0, offset + 2);
    header.writeUInt8(0, offset + 3);
    header.writeUInt16LE(1, offset + 4);
    header.writeUInt16LE(32, offset + 6);
    header.writeUInt32LE(png.length, offset + 8);
    header.writeUInt32LE(imageOffset, offset + 12);
    imageOffset += png.length;
  });

  writeFileSync(
    join(assetRoot, "icon.ico"),
    Buffer.concat([header, ...images.map(({ png }) => png)]),
  );
}

function writeMacIcon(images) {
  const chunks = images.map(({ type, png }) => {
    const chunk = Buffer.alloc(8 + png.length);
    chunk.write(type, 0, 4, "ascii");
    chunk.writeUInt32BE(chunk.length, 4);
    png.copy(chunk, 8);
    return chunk;
  });
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
  writeFileSync(join(assetRoot, "icon.icns"), Buffer.concat([header, ...chunks]));
}

try {
  const pngBySize = new Map(
    [16, 24, 32, 48, 64, 128, 256, 512, 1024].map((size) => [
      size,
      pngAtSize(size),
    ]),
  );
  writeWindowsIcon(
    [256, 128, 64, 48, 32, 24, 16].map((size) => ({
      size,
      png: pngBySize.get(size),
    })),
  );
  writeMacIcon(
    [
      ["icp4", 16],
      ["icp5", 32],
      ["icp6", 64],
      ["ic07", 128],
      ["ic08", 256],
      ["ic09", 512],
      ["ic10", 1024],
    ].map(([type, size]) => ({
      type,
      png: pngBySize.get(size),
    })),
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
