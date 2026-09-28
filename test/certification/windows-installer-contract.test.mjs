import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const forgeConfig = require("../../packages/desktop-shell/forge.config.cjs");

test("Windows release make produces one assisted NSIS Setup.exe installer", async () => {
  const windowsMakers = forgeConfig.makers.filter(
    (maker) => maker.platforms === undefined || maker.platforms.includes("win32"),
  );

  assert.deepEqual(
    windowsMakers.map((maker) => maker.name),
    [],
  );
  const builder = require("../../packages/desktop-shell/electron-builder.config.cjs");
  assert.equal(builder.nsis.oneClick, false);
  assert.equal(builder.nsis.perMachine, false);
  assert.equal(builder.artifactName, "Token-Setup.exe");
  const installerChoiceBytes = await readFile(builder.nsis.include);
  assert.deepEqual([...installerChoiceBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const installerChoice = installerChoiceBytes.toString("utf8");
  assert.match(installerChoice, /\$\{NSD_Check\} \$CatalogCheckbox/u);
  assert.match(installerChoice, /CopyFiles \/SILENT/u);
});

test("portable ZIP is not a second Windows release authority", () => {
  const zip = forgeConfig.makers.find(
    (maker) => maker.name === "@electron-forge/maker-zip",
  );
  assert.ok(zip);
  assert.equal(zip.platforms.includes("win32"), false);
});

test("Windows installation certification follows the Token NSIS install root", async () => {
  const script = await readFile(
    join(process.cwd(), "scripts", "windows-release-certification.ps1"),
    "utf8",
  );

  assert.match(script, /Join-Path \$env:LOCALAPPDATA "Programs\\Token"/);
  assert.doesNotMatch(script, /Join-Path \$env:LOCALAPPDATA "luckytoken"/i);
});
