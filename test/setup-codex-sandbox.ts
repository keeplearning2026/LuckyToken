import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const SANDBOX_MARKER = "LUCKYTOKEN_TEST_CODEX_SANDBOX";
const SANDBOX_ROOT = "LUCKYTOKEN_TEST_CODEX_SANDBOX_ROOT";
const SANDBOX_NONCE = "LUCKYTOKEN_TEST_CODEX_SANDBOX_NONCE";
const SANDBOX_LEASE_FILE = ".luckytoken-test-sandbox-lease";

function rewriteModelCatalogPath(
  content: string,
  catalogPath: string | undefined,
): string {
  const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const rewritten: string[] = [];
  let inspectingRoot = true;
  let assignmentCount = 0;

  for (const line of lines) {
    if (inspectingRoot && /^\s*\[/u.test(line)) inspectingRoot = false;
    const assignment = inspectingRoot
      ? line.match(
          /^(\s*)(?:model_catalog_json|"model_catalog_json"|'model_catalog_json')\s*=.*$/u,
        )
      : null;
    if (assignment === null) {
      rewritten.push(line);
      continue;
    }
    assignmentCount += 1;
    if (assignmentCount > 1) {
      throw new Error(
        "Codex test sandbox cannot safely rewrite duplicate model_catalog_json assignments",
      );
    }
    if (catalogPath !== undefined) {
      rewritten.push(
        `${assignment[1]}model_catalog_json = ${JSON.stringify(catalogPath)}`,
      );
    }
  }

  return rewritten.join(lineEnding);
}

function isStrictDescendant(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path.length > 0 && !path.startsWith("..") && !isAbsolute(path);
}

function assertInheritedSandbox(): void {
  const rootValue = process.env[SANDBOX_ROOT]?.trim();
  const nonce = process.env[SANDBOX_NONCE]?.trim();
  const codexHomeValue = process.env.CODEX_HOME?.trim();
  if (!rootValue || !nonce || !codexHomeValue) {
    throw new Error(
      "P0 test isolation breach: inherited Codex sandbox lease is incomplete",
    );
  }

  const resolvedRoot = resolve(rootValue);
  const resolvedCodexHome = resolve(codexHomeValue);
  let root: string;
  let codexHome: string;
  let temporaryDirectory: string;
  let rootIsLink: boolean;
  let codexHomeIsLink: boolean;
  try {
    rootIsLink = lstatSync(resolvedRoot).isSymbolicLink();
    codexHomeIsLink = lstatSync(resolvedCodexHome).isSymbolicLink();
    root = realpathSync(resolvedRoot);
    codexHome = realpathSync(resolvedCodexHome);
    temporaryDirectory = realpathSync(tmpdir());
  } catch {
    throw new Error(
      "P0 test isolation breach: inherited Codex sandbox paths are unavailable",
    );
  }
  if (
    rootIsLink ||
    codexHomeIsLink ||
    !isStrictDescendant(temporaryDirectory, root) ||
    codexHome !== resolve(join(root, "codex-home"))
  ) {
    throw new Error(
      "P0 test isolation breach: inherited Codex sandbox paths are invalid",
    );
  }

  let lease: string | undefined;
  try {
    lease = readFileSync(join(root, SANDBOX_LEASE_FILE), "utf8");
  } catch {
    lease = undefined;
  }
  if (lease !== nonce) {
    throw new Error(
      "P0 test isolation breach: inherited Codex sandbox lease is invalid",
    );
  }
}

function createDirectVitestSandbox(
  sourceCodexHome: string,
): { readonly root: string; readonly codexHome: string; readonly nonce: string } {
  const root = mkdtempSync(join(tmpdir(), "luckytoken-vitest-codex-"));
  const codexHome = join(root, "codex-home");
  try {
    const nonce = randomUUID();
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(root, SANDBOX_LEASE_FILE), nonce, "utf8");

    const sourceCatalogPath = join(
      sourceCodexHome,
      "luckytoken-model-catalog.json",
    );
    const sandboxCatalogPath = join(
      codexHome,
      "luckytoken-model-catalog.json",
    );
    const catalogExists = existsSync(sourceCatalogPath);
    if (catalogExists) copyFileSync(sourceCatalogPath, sandboxCatalogPath);

    const sourceConfigPath = join(sourceCodexHome, "config.toml");
    if (existsSync(sourceConfigPath)) {
      writeFileSync(
        join(codexHome, "config.toml"),
        rewriteModelCatalogPath(
          readFileSync(sourceConfigPath, "utf8"),
          catalogExists ? sandboxCatalogPath : undefined,
        ),
        "utf8",
      );
    }
    return { root, codexHome, nonce };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function restoreEnvironment(
  previous: Readonly<Record<string, string | undefined>>,
): void {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function startCleanupWatchdog(root: string, nonce: string): void {
  const environment: NodeJS.ProcessEnv = {
    LUCKYTOKEN_WATCHDOG_PARENT_PID: String(process.pid),
    LUCKYTOKEN_WATCHDOG_SANDBOX_ROOT: root,
    LUCKYTOKEN_WATCHDOG_SANDBOX_NONCE: nonce,
  };
  for (const name of ["SystemRoot", "TEMP", "TMP", "TMPDIR"] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  const watchdog = spawn(
    process.execPath,
    [
      resolve(
        import.meta.dirname,
        "..",
        "scripts",
        "cleanup-codex-test-sandbox.mjs",
      ),
    ],
    {
      detached: true,
      env: environment,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  watchdog.unref();
}

export default function setupCodexSandbox(): (() => void) | undefined {
  if (process.env[SANDBOX_MARKER] === "1") {
    assertInheritedSandbox();
    return undefined;
  }

  const previous = Object.freeze({
    CODEX_HOME: process.env.CODEX_HOME,
    [SANDBOX_MARKER]: process.env[SANDBOX_MARKER],
    [SANDBOX_ROOT]: process.env[SANDBOX_ROOT],
    [SANDBOX_NONCE]: process.env[SANDBOX_NONCE],
  });
  const sourceCodexHome = previous.CODEX_HOME?.trim()
    ? resolve(previous.CODEX_HOME)
    : resolve(join(homedir(), ".codex"));
  const sandbox = createDirectVitestSandbox(sourceCodexHome);
  process.env.CODEX_HOME = sandbox.codexHome;
  process.env[SANDBOX_MARKER] = "1";
  process.env[SANDBOX_ROOT] = sandbox.root;
  process.env[SANDBOX_NONCE] = sandbox.nonce;
  startCleanupWatchdog(sandbox.root, sandbox.nonce);

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    restoreEnvironment(previous);
    rmSync(sandbox.root, { recursive: true, force: true });
  };
  const signals: readonly NodeJS.Signals[] = process.platform === "win32"
    ? ["SIGINT", "SIGTERM", "SIGBREAK"]
    : ["SIGINT", "SIGTERM", "SIGHUP"];
  const handlers = new Map<NodeJS.Signals, () => void>();
  const removeHooks = (): void => {
    process.off("exit", dispose);
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
  for (const signal of signals) {
    const handler = (): void => {
      removeHooks();
      dispose();
      process.kill(process.pid, signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  process.once("exit", dispose);

  return () => {
    removeHooks();
    dispose();
  };
}
