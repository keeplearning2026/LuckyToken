import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const forgeConfig = require("../../packages/desktop-shell/forge.config.cjs");

test("Windows release make produces one assisted NSIS Setup.exe installer", async () => {
  const desktopPackage = require("../../packages/desktop-shell/package.json");
  assert.match(desktopPackage.devDependencies.electron, /^\d+\.\d+\.\d+$/u);

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
  assert.equal(builder.publish, null);
  const installerChoiceBytes = await readFile(builder.nsis.include);
  assert.deepEqual([...installerChoiceBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const installerChoice = installerChoiceBytes.toString("utf8");
  assert.doesNotMatch(installerChoice, /CatalogOverwrite|CatalogCheckbox|NSD_Check/u);
  assert.match(installerChoice, /CreateDirectory "\$PROFILE\\\.Token"[\s\S]*CopyFiles \/SILENT/u);
});

test("local make retains only one installer while release make keeps the candidate", async () => {
  const desktopPackage = require("../../packages/desktop-shell/package.json");
  assert.equal(
    desktopPackage.scripts.make,
    "npm run assemble:backend && npm run make:installer-only",
  );
  assert.equal(
    desktopPackage.scripts["make:prepared"],
    "npm run clean:electron && node scripts/make-windows-nsis.mjs",
  );

  const makeScript = await readFile(
    join(
      process.cwd(),
      "packages",
      "desktop-shell",
      "scripts",
      "make-windows-nsis.mjs",
    ),
    "utf8",
  );
  assert.match(makeScript, /process\.argv\.includes\("--installer-only"\)/u);
  assert.match(makeScript, /const installerRoot = join\(repositoryRoot, "installer"\)/u);
  assert.match(makeScript, /copyFile\(installer, retainedInstaller\)/u);
  assert.match(makeScript, /rm\(outputRoot, \{ recursive: true, force: true \}\)/u);
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
  assert.match(script, /Get-FileHash -LiteralPath \$bundledCatalog -Algorithm SHA256/u);
  assert.match(script, /catalog-sentinel-differs-from-bundled/u);
  assert.match(script, /reinstall-replaces-user-catalog/u);
});
