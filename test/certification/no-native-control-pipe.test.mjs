import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");

async function exists(relative) {
  try {
    await access(resolve(root, relative));
    return true;
  } catch {
    return false;
  }
}

test("production build and release contain no native Control Pipe path", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const serializedManifest = JSON.stringify(manifest);
  assert.ok(!serializedManifest.includes("control-pipe-win-native"));
  assert.ok(!serializedManifest.includes("build:native-control-pipe"));

  const releaseAssembly = await readFile(
    resolve(root, "scripts/assemble-release-backend.mjs"),
    "utf8",
  );
  assert.ok(!releaseAssembly.includes("control-pipe-win-native"));

  assert.equal(await exists("packages/control-pipe-win-native/package.json"), false);
  assert.equal(await exists("packages/control-pipe-win-native/Cargo.toml"), false);
  assert.equal(await exists("src/windows-control-pipe.ts"), false);
  assert.equal(await exists("scripts/build-native-control-pipe.cjs"), false);
});
