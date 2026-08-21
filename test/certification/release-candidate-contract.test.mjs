import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { discoverWindowsCandidate } from "../../scripts/release-candidate.mjs";

async function writeCandidate(root) {
  const packageRoot = join(root, "LuckyToken-win32-x64");
  const makeRoot = join(root, "make", "squirrel.windows", "x64");
  await Promise.all([
    mkdir(join(packageRoot, "resources", "backend"), { recursive: true }),
    mkdir(makeRoot, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(packageRoot, "LuckyToken.exe"), "exe", "utf8"),
    writeFile(
      join(packageRoot, "resources", "backend", "build-id.txt"),
      `${"a".repeat(64)}\n`,
      "utf8",
    ),
    writeFile(join(makeRoot, "LuckyToken-Setup.exe"), "setup", "utf8"),
    writeFile(join(makeRoot, "LuckyToken-0.1.0-full.nupkg"), "nupkg", "utf8"),
    writeFile(join(makeRoot, "RELEASES"), "release metadata", "utf8"),
  ]);
  return { packageRoot, makeRoot };
}

test("release discovery binds one packaged EXE to one Squirrel installer", async () => {
  const root = await mkdtemp(join(tmpdir(), "luckytoken-release-candidate-"));
  try {
    const { packageRoot, makeRoot } = await writeCandidate(root);
    assert.deepEqual(await discoverWindowsCandidate(root, "0.1.0"), {
      outputRoot: root,
      packageRoot,
      packagedExecutable: join(packageRoot, "LuckyToken.exe"),
      backendBuildIdPath: join(
        packageRoot,
        "resources",
        "backend",
        "build-id.txt",
      ),
      installer: join(makeRoot, "LuckyToken-Setup.exe"),
      nupkg: join(makeRoot, "LuckyToken-0.1.0-full.nupkg"),
      releases: join(makeRoot, "RELEASES"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release discovery fails closed when a second installer exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "luckytoken-release-candidate-"));
  try {
    const { makeRoot } = await writeCandidate(root);
    await writeFile(join(makeRoot, "foreign-Setup.exe"), "foreign", "utf8");
    await assert.rejects(
      discoverWindowsCandidate(root, "0.1.0"),
      /expected exactly one Squirrel Setup\.exe/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
