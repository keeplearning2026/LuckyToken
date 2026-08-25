import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const forgeConfig = require("../../packages/desktop-shell/forge.config.cjs");

test("Windows release make produces one Squirrel Setup.exe installer", () => {
  const windowsMakers = forgeConfig.makers.filter(
    (maker) => maker.platforms === undefined || maker.platforms.includes("win32"),
  );

  assert.deepEqual(
    windowsMakers.map((maker) => maker.name),
    ["@electron-forge/maker-squirrel"],
  );
  assert.equal(windowsMakers[0].config.name, "Token");
  assert.equal(windowsMakers[0].config.exe, "Token.exe");
  assert.equal(windowsMakers[0].config.setupExe, "Token-Setup.exe");
  assert.equal(windowsMakers[0].config.noMsi, true);
});

test("portable ZIP is not a second Windows release authority", () => {
  const zip = forgeConfig.makers.find(
    (maker) => maker.name === "@electron-forge/maker-zip",
  );
  assert.ok(zip);
  assert.equal(zip.platforms.includes("win32"), false);
});

test("Windows installation certification follows the Token Squirrel install root", async () => {
  const script = await readFile(
    join(process.cwd(), "scripts", "windows-release-certification.ps1"),
    "utf8",
  );

  assert.match(script, /Join-Path \$env:LOCALAPPDATA "Token"/);
  assert.doesNotMatch(script, /Join-Path \$env:LOCALAPPDATA "luckytoken"/i);
});
