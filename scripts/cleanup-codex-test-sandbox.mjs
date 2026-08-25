import { lstat, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

const rootValue = process.env.TOKEN_WATCHDOG_SANDBOX_ROOT?.trim();
const nonce = process.env.TOKEN_WATCHDOG_SANDBOX_NONCE?.trim();
const parentPid = Number.parseInt(
  process.env.TOKEN_WATCHDOG_PARENT_PID ?? "",
  10,
);

function isStrictDescendant(parent, child) {
  const path = relative(parent, child);
  return path.length > 0 && !path.startsWith("..") && !isAbsolute(path);
}

async function validatedRoot() {
  if (!rootValue || !nonce || !Number.isSafeInteger(parentPid) || parentPid <= 0) {
    throw new Error("Codex sandbox watchdog configuration is invalid");
  }
  const resolvedRoot = resolve(rootValue);
  const resolvedCodexHome = resolve(join(resolvedRoot, "codex-home"));
  const [rootStat, codexHomeStat, root, codexHome, temporaryDirectory, lease] =
    await Promise.all([
      lstat(resolvedRoot),
      lstat(resolvedCodexHome),
      realpath(resolvedRoot),
      realpath(resolvedCodexHome),
      realpath(tmpdir()),
      readFile(join(resolvedRoot, ".Token-test-sandbox-lease"), "utf8"),
    ]);
  if (
    rootStat.isSymbolicLink() ||
    codexHomeStat.isSymbolicLink() ||
    !basename(root).startsWith("Token-") ||
    !isStrictDescendant(temporaryDirectory, root) ||
    codexHome !== resolve(join(root, "codex-home")) ||
    lease !== nonce
  ) {
    throw new Error("Codex sandbox watchdog refused an unsafe cleanup target");
  }
  return root;
}

function parentIsAlive() {
  try {
    process.kill(parentPid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

const root = await validatedRoot();
const poll = setInterval(() => {
  if (parentIsAlive()) return;
  clearInterval(poll);
  void validatedRoot()
    .then((verifiedRoot) => rm(verifiedRoot, { recursive: true, force: true }))
    .catch(async (error) => {
      try {
        await lstat(root);
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      } catch {
        // The owner already completed normal cleanup.
      }
    });
}, 50);
