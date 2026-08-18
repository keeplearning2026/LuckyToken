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

const root = await readJson("package.json");
if (!/^\d+\.\d+\.\d+$/u.test(root.version)) {
  throw new Error(`Invalid release version in package.json: ${root.version}`);
}

for (const path of [
  "packages/application-control-plane/package.json",
  "packages/provider-contract/package.json",
  "packages/provider-commandcode-private/package.json",
  "packages/desktop-shell/package.json",
]) {
  const manifest = await readJson(path);
  if (manifest.version !== root.version) {
    manifest.version = root.version;
    await writeJson(path, manifest);
  }
}

