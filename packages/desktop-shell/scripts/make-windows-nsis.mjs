import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = join(desktopRoot, ".electron-out");

async function directories() {
  return new Set((await readdir(outputRoot, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  })).filter((entry) => entry.isDirectory()).map((entry) => entry.name));
}

async function run(script, args, env = process.env) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: desktopRoot,
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolveRun() : reject(new Error(`${script} exited with ${code}`)));
  });
}

const before = await directories();
await run(require.resolve("@electron-forge/cli/dist/electron-forge.js"), ["package"]);
const added = [...await directories()].filter((name) => !before.has(name));
if (added.length !== 1) throw new Error(`Expected one packaged output, found ${added.length}`);
const releaseRoot = join(outputRoot, added[0]);
await run(require.resolve("electron-builder/cli.js"), [
  "--win", "nsis", "--x64",
  "--prepackaged", join(releaseRoot, "token-win32-x64"),
  "--config", join(desktopRoot, "electron-builder.config.cjs"),
], {
  ...process.env,
  TOKEN_NSIS_OUTPUT: join(releaseRoot, "make", "nsis"),
  ...(process.env.TOKEN_WINDOWS_CERTIFICATE_FILE === undefined ? {} : {
    WIN_CSC_LINK: process.env.TOKEN_WINDOWS_CERTIFICATE_FILE,
    WIN_CSC_KEY_PASSWORD: process.env.TOKEN_WINDOWS_CERTIFICATE_PASSWORD,
  }),
});
