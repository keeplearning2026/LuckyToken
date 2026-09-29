import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { buildScriptForPlatform } from "../../scripts/build-installer.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("root build selects the native desktop distribution", async () => {
  const manifest = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
  assert.equal(manifest.scripts.build, "node scripts/build-installer.mjs");
  assert.equal(buildScriptForPlatform("win32"), "build:windows-installer");
  assert.equal(buildScriptForPlatform("darwin"), "build:macos-installer");
  assert.equal(buildScriptForPlatform("linux"), "build:linux-bundle");
  assert.throws(() => buildScriptForPlatform("freebsd"), /No Token desktop distribution/u);
  assert.match(manifest.scripts["build:windows-installer"], /release:sync-version.*build:packages.*make/u);
  assert.match(manifest.scripts["build:macos-installer"], /release:sync-version.*build:packages.*make:macos-installer/u);
  assert.match(manifest.scripts["build:linux-bundle"], /release:sync-version.*build:packages.*make:linux-bundle/u);
  assert.match(manifest.scripts["test:distribution:inner"], /build:desktop-package/u);
});
