import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Compile the same self-contained diagnostics actor used in the release.
// tsx inserts module-scope compiler helpers into Function.toString() bodies.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (process.env.TOKEN_TEST_CODEX_SANDBOX !== "1" || !process.env.CODEX_HOME) {
  throw new Error("Run diagnostics online certification through the Codex test sandbox");
}
const build = await mkdtemp(join(root, ".diagnostics-online-"));
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: "inherit", windowsHide: true });
  child.once("error", reject);
  child.once("exit", (code) => resolve(code ?? 1));
});
try {
  const compiled = await run([join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json", "--outDir", build]);
  process.exitCode = compiled === 0
    ? await run([join(build, "test/online/run-diagnostics-unredacted.js")])
    : compiled;
} finally {
  await rm(build, { recursive: true, force: true });
}
