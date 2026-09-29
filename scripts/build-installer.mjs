import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function buildScriptForPlatform(platform) {
  switch (platform) {
    case "win32": return "build:windows-installer";
    case "darwin": return "build:macos-installer";
    case "linux": return "build:linux-bundle";
    default: throw new Error(`No Token desktop distribution is configured for ${platform}`);
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const script = buildScriptForPlatform(process.platform);
  const npmCli = process.env.npm_execpath;
  if (npmCli === undefined) throw new Error("Run this build through npm run build");
  const child = spawn(process.execPath, [npmCli, "run", script], {
    cwd: repositoryRoot,
    stdio: "inherit",
    windowsHide: true,
  });
  child.once("error", (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (signal !== null) {
      process.stderr.write(`Token build interrupted by ${signal}\n`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = code ?? 1;
  });
}
