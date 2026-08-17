import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { launcherConfig } from "./release-layout.mjs";

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");

async function runNpm(arguments_, options) {
  return process.platform === "win32"
    ? execFileAsync(
        process.env.ComSpec ?? "cmd.exe",
        ["/d", "/s", "/c", "npm.cmd", ...arguments_],
        options,
      )
    : execFileAsync("npm", arguments_, options);
}

/**
 * Ticket 26 installed layout: assemble the portable Node backend the
 * desktop shell launches. The output directory is
 * packages/desktop-shell/backend (next to the Tauri resources that the
 * installer ships), containing:
 *   node/node.exe        the pinned portable Node executable
 *   dist/                the compiled LuckyToken core (cli.js entry)
 *   node_modules/        the production dependency tree
 *   launcher.json        the stable launch contract next to the exe
 */
export async function assembleReleaseBackend({
  nodeExecutable = process.execPath,
  destination = join(
    repositoryRoot,
    "packages",
    "desktop-shell",
    "backend",
  ),
} = {}) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(join(destination, "node"), { recursive: true });
  await mkdir(join(destination, "dist"), { recursive: true });

  // 1. Copy the fixed Node executable (portable runtime pin).
  await cp(nodeExecutable, join(destination, "node", "node.exe"));

  // 2. Compile the core and copy the built dist tree (cli.js + support).
  await runNpm(["run", "build:root"], { cwd: repositoryRoot, stdio: "inherit" });
  const rootDist = join(repositoryRoot, "dist");
  await copyTree(rootDist, join(destination, "dist"));

  // 3. Pack and install the production dependency tree. The tarballs stay
  //    in the layout so the installed dependency graph is reproducible.
  const packTargets = [
    { directory: ".", name: "luckytoken" },
    {
      directory: "packages/provider-contract",
      name: "@luckytoken/provider-contract",
    },
    {
      directory: "packages/provider-commandcode-private",
      name: "@luckytoken/provider-commandcode-private",
    },
    {
      directory: "packages/application-control-plane",
      name: "@luckytoken/application-control-plane",
    },
  ];
  const tarballs = [];
  for (const target of packTargets) {
    await mkdir(join(destination, "tarballs"), { recursive: true });
    const packSource = join(repositoryRoot, target.directory);
    const result = await runNpm(
      ["pack", packSource, "--json", "--pack-destination", join(destination, "tarballs")],
      { cwd: repositoryRoot, maxBuffer: 16 * 1024 * 1024 },
    );
    const reports = JSON.parse(result.stdout);
    tarballs.push({
      name: target.name,
      path: join(destination, "tarballs", reports[0].filename),
    });
  }
  const dependencies = Object.fromEntries(
    tarballs.map((tarball) => [tarball.name, `file:${tarball.path}`]),
  );
  // The root package's production dependency on the pinned Pi runtime must
  // resolve from the installed tree.
  const rootPackage = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  );
  for (const dependency of [
    "@earendil-works/pi-ai",
    "proper-lockfile",
    "typebox",
  ]) {
    dependencies[dependency] = rootPackage.dependencies[dependency];
  }
  await writeFile(
    join(destination, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        type: "module",
        version: rootPackage.version,
        dependencies,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await runNpm(
    [
      "install",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
    ],
    { cwd: destination, maxBuffer: 16 * 1024 * 1024 },
  );
  await rm(join(destination, "package-lock.json"), { force: true }).catch(
    () => undefined,
  );

  // 4. Write the stable launcher contract the Rust shell resolves next to
  //    the desktop executable.
  await writeFile(
    join(destination, "launcher.json"),
    `${JSON.stringify(launcherConfig(), null, 2)}\n`,
    "utf8",
  );
  return destination;
}

async function copyTree(source, destination) {
  await mkdir(destination, { recursive: true });
  await cp(source, destination, { recursive: true });
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  assembleReleaseBackend()
    .then((destination) => {
      process.stdout.write(`Assembled release backend at ${destination}\n`);
    })
    .catch((error) => {
      process.stderr.write(`LuckyToken: ${error.message}\n`);
      process.exitCode = 1;
    });
}
