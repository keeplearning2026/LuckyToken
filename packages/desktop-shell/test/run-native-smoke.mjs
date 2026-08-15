import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  process.stdout.write("LuckyToken native desktop smoke skipped: Windows only.\n");
  process.exit(0);
}

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const npmCli = process.env.npm_execpath;
if (npmCli === undefined) {
  throw new Error("npm_execpath is required to build the native smoke target");
}
const build = spawnSync(process.execPath, [npmCli, "run", "build:native"], {
  cwd: packageDirectory,
  stdio: "inherit",
});
if (build.error !== undefined) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const smokeScript = fileURLToPath(
  new URL("./native-executable-smoke.ps1", import.meta.url),
);
const smoke = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", smokeScript],
  { cwd: packageDirectory, stdio: "inherit" },
);
if (smoke.error !== undefined) throw smoke.error;
process.exit(smoke.status ?? 1);
