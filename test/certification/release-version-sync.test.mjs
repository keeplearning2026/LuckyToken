import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

async function readJson(path) {
  return JSON.parse(await readFile(resolve(repositoryRoot, path), "utf8"));
}

test("release version is single-sourced and every shipped surface agrees", async () => {
  const root = await readJson("package.json");
  assert.match(
    root.version,
    /^\d+\.\d+\.\d+$/u,
    "root package.json must carry the official release version",
  );
  assert.notEqual(root.version, "0.0.0", "no placeholder version may be released");

  for (const path of [
    "packages/application-control-plane/package.json",
    "packages/provider-contract/package.json",
    "packages/provider-commandcode-private/package.json",
    "packages/desktop-shell/package.json",
  ]) {
    const manifest = await readJson(path);
    assert.equal(manifest.version, root.version, `${path} must match the root version`);
  }

  // The Control Plane hello payload must read the same source of truth at
  // runtime instead of re-declaring a second literal.
  const versionModule = await readFile(resolve(repositoryRoot, "src/version.ts"), "utf8");
  assert.match(versionModule, /package\.json/u, "the hello version must read package.json");

  const cliSource = await readFile(resolve(repositoryRoot, "src/cli.ts"), "utf8");
  assert.ok(
    !cliSource.includes('version: "0.0.0"') && !cliSource.includes('applicationVersion: "0.0.0"'),
    "the CLI must not re-declare a hardcoded application version",
  );
});
