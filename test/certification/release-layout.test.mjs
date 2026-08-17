import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  launcherConfig,
  parseLauncherJson,
  releaseNsisHookConfig,
  validateReleaseLayout,
} from "../../scripts/release-layout.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("launcher.json contract is stable and resolvable by the Rust launcher", () => {
  assert.deepEqual(launcherConfig(), {
    backendNodeExecutable: "backend/node/node.exe",
    backendCliScript: "backend/dist/cli.js",
  });

  const parsed = parseLauncherJson(
    JSON.stringify({
      backendNodeExecutable: "backend/node/node.exe",
      backendCliScript: "backend/dist/cli.js",
    }),
  );
  assert.deepEqual(parsed, {
    backendNodeExecutable: "backend/node/node.exe",
    backendCliScript: "backend/dist/cli.js",
  });
});

test("launcher.json parsing fails closed on malformed or foreign shapes", () => {
  for (const invalid of [
    "",
    "not-json",
    "{}",
    JSON.stringify({ backendNodeExecutable: "a" }),
    JSON.stringify({ backendCliScript: "b" }),
    JSON.stringify({
      backendNodeExecutable: "a",
      backendCliScript: "b",
      extra: "foreign",
    }),
    JSON.stringify({ backendNodeExecutable: "", backendCliScript: "b" }),
    JSON.stringify({ backendNodeExecutable: "a", backendCliScript: "" }),
  ]) {
    assert.equal(parseLauncherJson(invalid), undefined, `must reject: ${invalid}`);
  }
});

test("release layout validation requires the exe sibling contract", () => {
  assert.deepEqual(
    validateReleaseLayout({
      launcherJson: "not-json",
      nodeExecutableExists: true,
      cliScriptExists: true,
    }),
    ["launcher.json is invalid"],
  );
  assert.deepEqual(
    validateReleaseLayout({
      launcherJson: JSON.stringify(launcherConfig()),
      nodeExecutableExists: false,
      cliScriptExists: true,
    }),
    ["backend/node/node.exe is missing"],
  );
  assert.deepEqual(
    validateReleaseLayout({
      launcherJson: JSON.stringify(launcherConfig()),
      nodeExecutableExists: true,
      cliScriptExists: false,
    }),
    ["backend/dist/cli.js is missing"],
  );
  assert.deepEqual(
    validateReleaseLayout({
      launcherJson: JSON.stringify(launcherConfig()),
      nodeExecutableExists: true,
      cliScriptExists: true,
    }),
    [],
  );
});

test("release NSIS installer is wired to clear its install-location memory on uninstall", async () => {
  const hook = releaseNsisHookConfig();
  const srcTauri = resolve(repositoryRoot, "packages", "desktop-shell", "src-tauri");
  const releaseConfig = JSON.parse(
    await readFile(resolve(srcTauri, "tauri.release.conf.json"), "utf8"),
  );
  assert.equal(
    releaseConfig.bundle.windows.nsis.installerHooks,
    hook.hooksFile,
    "tauri.release.conf.json must reference the NSIS hooks file",
  );

  const hooksSource = await readFile(resolve(srcTauri, hook.hooksFile), "utf8");
  assert.ok(
    hooksSource.includes(`!macro ${hook.requiredMacro}`),
    `${hook.hooksFile} must define ${hook.requiredMacro}`,
  );
  assert.ok(
    hooksSource.includes(hook.requiredFragment),
    `${hook.hooksFile} must unconditionally delete the install-location key`,
  );
});
