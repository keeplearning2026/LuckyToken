import { spawn } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";

const SANDBOX_MARKER = "LUCKYTOKEN_TEST_CODEX_SANDBOX";
const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const COPIED_CODEX_INPUTS = Object.freeze([
  "config.toml",
  "luckytoken-model-catalog.json",
]);

function commandLine() {
  const separator = process.argv.indexOf("--", 2);
  if (separator < 0 || separator === process.argv.length - 1) {
    throw new Error(
      "Usage: node scripts/run-with-codex-test-sandbox.mjs -- <command> [args...]",
    );
  }
  return {
    command: process.argv[separator + 1],
    args: process.argv.slice(separator + 2),
  };
}

function executableFor(command) {
  if (process.platform !== "win32" || isAbsolute(command) || command.includes("\\")) {
    return command;
  }
  return new Set(["npm", "npx", "tsx", "vitest"]).has(command)
    ? `${command}.cmd`
    : command;
}

function invocationFor(command, args, env) {
  if (command === "npm" && env.npm_execpath) {
    return { executable: process.execPath, args: [env.npm_execpath, ...args] };
  }
  if (command === "vitest") {
    return {
      executable: process.execPath,
      args: [join(REPOSITORY_ROOT, "node_modules", "vitest", "vitest.mjs"), ...args],
    };
  }
  if (command === "tsx") {
    return {
      executable: process.execPath,
      args: [join(REPOSITORY_ROOT, "node_modules", "tsx", "dist", "cli.mjs"), ...args],
    };
  }
  return { executable: executableFor(command), args };
}

async function run(command, args, env) {
  return new Promise((resolveExit, reject) => {
    const invocation = invocationFor(command, args, env);
    const child = spawn(invocation.executable, invocation.args, {
      cwd: process.cwd(),
      env,
      stdio: "inherit",
      shell:
        process.platform === "win32" && invocation.executable.endsWith(".cmd"),
      windowsHide: true,
    });
    let forwardedSignal = null;
    const signals = process.platform === "win32"
      ? ["SIGINT", "SIGTERM", "SIGBREAK"]
      : ["SIGINT", "SIGTERM", "SIGHUP"];
    const handlers = new Map(
      signals.map((signal) => [
        signal,
        () => {
          forwardedSignal ??= signal;
          child.kill(signal);
        },
      ]),
    );
    const cleanupHandlers = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    };
    for (const [signal, handler] of handlers) process.on(signal, handler);
    child.once("error", (error) => {
      cleanupHandlers();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanupHandlers();
      resolveExit({ code: code ?? 1, signal: signal ?? forwardedSignal });
    });
  });
}

function exitCodeFor(result) {
  if (result.signal === "SIGINT") return 130;
  if (result.signal === "SIGTERM") return 143;
  if (result.signal !== null) return 1;
  return result.code;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function copyTestInputs(sourceCodexHome, sandboxCodexHome) {
  for (const relativePath of COPIED_CODEX_INPUTS) {
    const sourcePath = join(sourceCodexHome, relativePath);
    if (await exists(sourcePath)) {
      await copyFile(sourcePath, join(sandboxCodexHome, relativePath));
    }
  }
}

async function main() {
  const { command, args } = commandLine();
  if (process.env[SANDBOX_MARKER] === "1") {
    const result = await run(command, args, process.env);
    process.exitCode = exitCodeFor(result);
    return;
  }

  const configuredCodexHome = process.env.CODEX_HOME?.trim();
  const sourceCodexHome = configuredCodexHome
    ? resolve(configuredCodexHome)
    : join(homedir(), ".codex");
  const guardRoot = await mkdtemp(join(tmpdir(), "luckytoken-test-codex-"));
  const sandboxCodexHome = join(guardRoot, "codex-home");

  try {
    await mkdir(sandboxCodexHome, { recursive: true });
    await copyTestInputs(sourceCodexHome, sandboxCodexHome);
    const result = await run(command, args, {
      ...process.env,
      CODEX_HOME: sandboxCodexHome,
      [SANDBOX_MARKER]: "1",
    });
    process.exitCode = exitCodeFor(result);
  } finally {
    await rm(guardRoot, { recursive: true, force: true });
  }
}

await main();
