import assert from "node:assert/strict";
import { createRequire } from "node:module";
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
  assert.equal(windowsMakers[0].config.name, "LuckyToken");
  assert.equal(windowsMakers[0].config.exe, "LuckyToken.exe");
  assert.equal(windowsMakers[0].config.setupExe, "LuckyToken-Setup.exe");
  assert.equal(windowsMakers[0].config.noMsi, true);
});

test("portable ZIP is not a second Windows release authority", () => {
  const zip = forgeConfig.makers.find(
    (maker) => maker.name === "@electron-forge/maker-zip",
  );
  assert.ok(zip);
  assert.equal(zip.platforms.includes("win32"), false);
});
