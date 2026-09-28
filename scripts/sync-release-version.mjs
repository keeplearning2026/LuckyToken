import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The root package.json is the single source of truth for the release
// version. Every shipped surface that must report or embed a version is
// rewritten here; the certification test `release-version-sync` fails the
// release if any surface diverges from this sync step.

const scriptDirectory = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");

async function readJson(path) {
  return JSON.parse(await readFile(resolve(repositoryRoot, path), "utf8"));
}

async function writeJson(path, value) {
  await writeFile(resolve(repositoryRoot, path), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const manifestPaths = [
  "package.json",
  "packages/application-control-plane/package.json",
  "packages/commandcode-model-catalog/package.json",
  "packages/provider-contract/package.json",
  "packages/provider-commandcode-goat/package.json",
  "packages/provider-commandcode-private/package.json",
  "packages/desktop-shell/package.json",
];

const dependencySections = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

const manifests = new Map();
for (const path of manifestPaths) manifests.set(path, await readJson(path));

const root = manifests.get("package.json");
if (!/^\d+\.\d+\.\d+$/u.test(root.version)) {
  throw new Error(`Invalid release version in package.json: ${root.version}`);
}

const internalPackageNames = new Set(
  [...manifests.values()]
    .map((manifest) => manifest.name)
    .filter((name) => typeof name === "string" && name.startsWith("@token/")),
);

function syncInternalDependencies(manifest, version) {
  let changed = false;
  for (const section of dependencySections) {
    const dependencies = manifest[section];
    if (dependencies === undefined) continue;
    for (const name of Object.keys(dependencies)) {
      if (!internalPackageNames.has(name) || dependencies[name] === version) continue;
      dependencies[name] = version;
      changed = true;
    }
  }
  return changed;
}

for (const path of manifestPaths) {
  const manifest = manifests.get(path);
  let changed = false;
  if (path !== "package.json" && manifest.version !== root.version) {
    manifest.version = root.version;
    changed = true;
  }
  changed = syncInternalDependencies(manifest, root.version) || changed;
  if (changed) await writeJson(path, manifest);
}

