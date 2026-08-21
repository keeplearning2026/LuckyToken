import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("GitHub Windows release delegates to the one official release entry", async () => {
  const workflow = await readFile(
    resolve(repositoryRoot, ".github/workflows/windows-release.yml"),
    "utf8",
  );
  assert.match(workflow, /runs-on: windows-2022/u);
  assert.match(workflow, /npm ci --ignore-scripts/u);
  assert.match(workflow, /npm rebuild electron/u);
  assert.match(workflow, /npm run release:windows/u);
  assert.match(workflow, /LUCKYTOKEN_WINDOWS_CERTIFICATE_FILE/u);
  assert.match(workflow, /LUCKYTOKEN_WINDOWS_CERTIFICATE_PASSWORD/u);
  assert.match(workflow, /artifacts\/releases/u);
  assert.equal(workflow.includes("electron-forge make"), false);
});
