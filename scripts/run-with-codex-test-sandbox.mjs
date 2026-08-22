import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";

const SANDBOX_MARKER = "LUCKYTOKEN_TEST_CODEX_SANDBOX";
const SANDBOX_ROOT = "LUCKYTOKEN_TEST_CODEX_SANDBOX_ROOT";
const SANDBOX_NONCE = "LUCKYTOKEN_TEST_CODEX_SANDBOX_NONCE";
const SANDBOX_LEASE_FILE = ".luckytoken-test-sandbox-lease";
const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const CODEX_CONFIG_FILE = "config.toml";
const CODEX_CATALOG_FILE = "luckytoken-model-catalog.json";

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

function isStrictDescendant(parent, child) {
  const path = relative(parent, child);
  return path.length > 0 && !path.startsWith("..") && !isAbsolute(path);
}

async function assertInheritedSandbox(env) {
  const rootValue = env[SANDBOX_ROOT]?.trim();
  const nonce = env[SANDBOX_NONCE]?.trim();
  const codexHomeValue = env.CODEX_HOME?.trim();
  const piAgentDirectoryValue = env.PI_CODING_AGENT_DIR?.trim();
  if (!rootValue || !nonce || !codexHomeValue || !piAgentDirectoryValue) {
    throw new Error(
      "P0 test isolation breach: inherited Codex sandbox lease is incomplete",
    );
  }
  const resolvedRoot = resolve(rootValue);
  const resolvedCodexHome = resolve(codexHomeValue);
  const resolvedPiAgentDirectory = resolve(piAgentDirectoryValue);
  const [rootStat, codexHomeStat, piAgentDirectoryStat, root, codexHome, piAgentDirectory, temporaryDirectory] =
    await Promise.all([
      lstat(resolvedRoot),
      lstat(resolvedCodexHome),
      lstat(resolvedPiAgentDirectory),
      realpath(resolvedRoot),
      realpath(resolvedCodexHome),
      realpath(resolvedPiAgentDirectory),
      realpath(tmpdir()),
    ]).catch(() => {
      throw new Error(
        "P0 test isolation breach: inherited Codex sandbox paths are unavailable",
      );
    });
  if (
    rootStat.isSymbolicLink() ||
    codexHomeStat.isSymbolicLink() ||
    piAgentDirectoryStat.isSymbolicLink() ||
    !isStrictDescendant(temporaryDirectory, root) ||
    codexHome !== resolve(join(root, "codex-home")) ||
    piAgentDirectory !== resolve(join(root, "pi-agent"))
  ) {
    throw new Error(
      "P0 test isolation breach: inherited Codex sandbox paths are invalid",
    );
  }
  const lease = await readFile(join(root, SANDBOX_LEASE_FILE), "utf8").catch(
    () => undefined,
  );
  if (lease !== nonce) {
    throw new Error(
      "P0 test isolation breach: inherited Codex sandbox lease is invalid",
    );
  }
}

function startCleanupWatchdog(root, nonce) {
  const environment = {
    LUCKYTOKEN_WATCHDOG_PARENT_PID: String(process.pid),
    LUCKYTOKEN_WATCHDOG_SANDBOX_ROOT: root,
    LUCKYTOKEN_WATCHDOG_SANDBOX_NONCE: nonce,
  };
  for (const name of ["SystemRoot", "TEMP", "TMP", "TMPDIR"]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  const watchdog = spawn(
    process.execPath,
    [join(REPOSITORY_ROOT, "scripts", "cleanup-codex-test-sandbox.mjs")],
    {
      detached: true,
      env: environment,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  watchdog.unref();
}

function rewriteModelCatalogPath(content, catalogPath) {
  const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  let assignmentCount = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*\[/u.test(line)) break;
    const assignment = line.match(
      /^(\s*)(?:model_catalog_json|"model_catalog_json"|'model_catalog_json')\s*=.*$/u,
    );
    if (assignment === null) continue;
    assignmentCount += 1;
    if (assignmentCount > 1) {
      throw new Error(
        "Codex test sandbox cannot safely rewrite duplicate model_catalog_json assignments",
      );
    }
    lines[index] = catalogPath === undefined
      ? undefined
      : `${assignment[1]}model_catalog_json = ${JSON.stringify(catalogPath)}`;
  }

  return lines.filter((line) => line !== undefined).join(lineEnding);
}

async function copyTestInputs(sourceCodexHome, sandboxCodexHome) {
  const sourceCatalogPath = join(sourceCodexHome, CODEX_CATALOG_FILE);
  const sandboxCatalogPath = join(sandboxCodexHome, CODEX_CATALOG_FILE);
  const catalogExists = await exists(sourceCatalogPath);
  if (catalogExists) {
    await copyFile(sourceCatalogPath, sandboxCatalogPath);
  }

  const sourceConfigPath = join(sourceCodexHome, CODEX_CONFIG_FILE);
  if (await exists(sourceConfigPath)) {
    const sourceConfig = await readFile(sourceConfigPath, "utf8");
    await writeFile(
      join(sandboxCodexHome, CODEX_CONFIG_FILE),
      rewriteModelCatalogPath(
        sourceConfig,
        catalogExists ? sandboxCatalogPath : undefined,
      ),
      "utf8",
    );
  }
}

async function main() {
  const { command, args } = commandLine();
  if (process.env[SANDBOX_MARKER] === "1") {
    await assertInheritedSandbox(process.env);
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
  const sandboxPiAgentDirectory = join(guardRoot, "pi-agent");
  const sandboxNonce = randomUUID();

  try {
    await mkdir(sandboxCodexHome, { recursive: true });
    await mkdir(sandboxPiAgentDirectory, { recursive: true });
    await writeFile(
      join(guardRoot, SANDBOX_LEASE_FILE),
      sandboxNonce,
      "utf8",
    );
    startCleanupWatchdog(guardRoot, sandboxNonce);
    await copyTestInputs(sourceCodexHome, sandboxCodexHome);
    const result = await run(command, args, {
      ...process.env,
      CODEX_HOME: sandboxCodexHome,
      PI_CODING_AGENT_DIR: sandboxPiAgentDirectory,
      [SANDBOX_MARKER]: "1",
      [SANDBOX_ROOT]: guardRoot,
      [SANDBOX_NONCE]: sandboxNonce,
    });
    process.exitCode = exitCodeFor(result);
  } finally {
    await rm(guardRoot, { recursive: true, force: true });
  }
}

await main();
