import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("GitHub macOS packaging builds the installer on a macOS runner without claiming a release", async () => {
  const workflow = await readFile(
    resolve(repositoryRoot, ".github/workflows/macos-package.yml"),
    "utf8",
  );
  assert.match(workflow, /runs-on: \$\{\{ inputs\.runner \}\}/u);
  assert.match(workflow, /default: macos-/u);
  assert.match(workflow, /npm ci --ignore-scripts/u);
  assert.match(workflow, /npm rebuild electron/u);
  assert.match(workflow, /npm run release:assemble-backend/u);
  assert.match(workflow, /npm run make:prepared --workspace @token\/desktop-shell/u);
  assert.match(workflow, /\*\.dmg/u);
  assert.match(workflow, /include-hidden-files: true/u);
  assert.equal(workflow.includes("release:windows"), false);
  assert.equal(workflow.includes("artifacts/releases"), false);
});