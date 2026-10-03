import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { synchronizePiNative } from "./sync-pi-native.mjs";

const PI_PACKAGE = "@earendil-works/pi-ai";
const SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const SDKS = ["openai", "@anthropic-ai/sdk"];

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

/** Synchronize declarations only; certification remains a separate, required step. */
export async function synchronizePiManifests(root, pi, check = false) {
  if (!/^\d+\.\d+\.\d+$/u.test(pi.version)) throw new Error("Pi must have an exact release version");
  for (const sdk of SDKS) {
    if (!/^\d+\.\d+\.\d+$/u.test(pi.dependencies?.[sdk] ?? "")) {
      throw new Error(`Pi must declare an exact ${sdk} version`);
    }
  }
  const manifests = ["package.json"];
  for (const directory of await readdir(resolve(root, "packages"), { withFileTypes: true })) {
    if (directory.isDirectory()) manifests.push(`packages/${directory.name}/package.json`);
  }
  const changes = [];
  for (const relative of manifests) {
    const path = resolve(root, relative);
    const manifest = await readJson(path);
    let changed = false;
    for (const section of SECTIONS) {
      if (manifest[section]?.[PI_PACKAGE] !== undefined && manifest[section][PI_PACKAGE] !== pi.version) {
        manifest[section][PI_PACKAGE] = pi.version;
        changed = true;
      }
    }
    if (relative === "package.json") {
      for (const sdk of SDKS) {
        if (manifest.dependencies[sdk] !== pi.dependencies[sdk]) {
          manifest.dependencies[sdk] = pi.dependencies[sdk];
          changed = true;
        }
      }
    }
    if (changed) changes.push({ path, manifest });
  }
  if (check && changes.length) throw new Error(`Pi dependency declarations differ: ${changes.map(({ path }) => path).join(", ")}`);
  for (const { path, manifest } of changes) await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return changes.length > 0;
}

async function main() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const args = process.argv.slice(2);
  const check = args.length === 1 && args[0] === "--check";
  const version = check ? undefined : args[0];
  if (args.length > 1 || (version !== undefined && !/^\d+\.\d+\.\d+$/u.test(version))) {
    throw new Error("Usage: npm run pi:upgrade -- [exact-version | --check]");
  }
  const npm = (args, encoding) => {
    if (!process.env.npm_execpath) throw new Error("Run this operation through npm run pi:upgrade");
    return execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
      cwd: root, windowsHide: true, ...(encoding ? { encoding } : { stdio: "inherit" }),
    });
  };
  const pi = version === undefined
    ? await readJson(resolve(root, "node_modules/@earendil-works/pi-ai/package.json"))
    : JSON.parse(npm(["view", `${PI_PACKAGE}@${version}`, "--json"], "utf8"));
  if (version !== undefined && pi.version !== version) throw new Error("Registry returned a different Pi release");
  const changed = await synchronizePiManifests(root, pi, check);
  if (version !== undefined || changed) npm(["install", "--ignore-scripts", "--no-audit", "--no-fund"]);
  const lock = await readJson(resolve(root, "package-lock.json"));
  if (lock.packages[`node_modules/${PI_PACKAGE}`]?.version !== pi.version) throw new Error("Pi lockfile version differs");
  await synchronizePiNative(root, check);
  process.stdout.write(`Pi ${pi.version}: declarations, SDK versions and Native envelope copies ${check ? "verified" : "synchronized"}. Run the offline upgrade gates.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
