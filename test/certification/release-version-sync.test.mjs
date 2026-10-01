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

  const manifestPaths = [
    "package.json",
    "packages/application-control-plane/package.json",
    "packages/commandcode-model-catalog/package.json",
    "packages/provider-contract/package.json",
    "packages/provider-commandcode-goat/package.json",
    "packages/provider-commandcode-private/package.json",
    "packages/provider-deepseek-response/package.json",
    "packages/desktop-shell/package.json",
  ];
  const dependencySections = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ];

  const manifests = new Map();
  for (const path of manifestPaths) {
    manifests.set(path, path === "package.json" ? root : await readJson(path));
  }
  const internalPackageNames = new Set(
    [...manifests.values()]
      .map((manifest) => manifest.name)
      .filter((name) => typeof name === "string" && name.startsWith("@token/")),
  );

  const lock = await readJson("package-lock.json");
  assert.equal(lock.version, root.version, "package-lock.json must match the root version");

  for (const path of manifestPaths) {
    const manifest = manifests.get(path);
    const packageKey = path === "package.json" ? "" : path.replace(/\/package\.json$/u, "");
    const lockedManifest = lock.packages?.[packageKey];
    assert.equal(manifest.version, root.version, `${path} must match the root version`);
    assert.equal(
      lockedManifest?.version,
      root.version,
      `package-lock.json packages[${JSON.stringify(packageKey)}] must match the root version`,
    );
    for (const section of dependencySections) {
      for (const [name, version] of Object.entries(manifest[section] ?? {})) {
        if (!internalPackageNames.has(name)) continue;
        assert.equal(
          version,
          root.version,
          `${path} ${section}.${name} must match the root version`,
        );
        assert.equal(
          lockedManifest?.[section]?.[name],
          root.version,
          `package-lock.json packages[${JSON.stringify(packageKey)}].${section}.${name} must match the root version`,
        );
      }
    }
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
