import assert from "node:assert/strict";
import test from "node:test";

import {
  launcherConfig,
  parseLauncherJson,
  validateReleaseLayout,
} from "../../scripts/release-layout.mjs";

test("launcher.json contract is stable and resolvable by the Electron backend supervisor", () => {
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
