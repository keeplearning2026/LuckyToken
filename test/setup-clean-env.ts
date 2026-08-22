import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll } from "vitest";

/**
 * Neutralize Anthropic SDK credential env vars that can leak from the host
 * shell (e.g. Claude Code sets ANTHROPIC_AUTH_TOKEN).
 *
 * The Anthropic SDK reads these automatically and, when one is present, sends
 * it alongside the explicit apiKey passed by a test. The local server's
 * strict dual-credential check (src/auth.ts parseClientCredential) rejects a
 * request that carries both a Bearer token and a differing x-api-key, which
 * makes otherwise-passing tests fail with a spurious 401. Deleting them here
 * keeps every test hermetic regardless of the caller's environment.
 */
delete process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

/**
 * A test must never resolve the user's real Codex home. The normal npm test
 * entrypoints provide a process-level sandbox; this fallback also protects
 * direct Vitest invocations.
 */
const inheritedSandbox =
  process.env.LUCKYTOKEN_TEST_CODEX_SANDBOX === "1" &&
  process.env.CODEX_HOME?.trim();
const previousCodexHome = process.env.CODEX_HOME;
const directVitestRoot = inheritedSandbox
  ? undefined
  : mkdtempSync(join(tmpdir(), "luckytoken-vitest-codex-"));

if (directVitestRoot !== undefined) {
  const codexHome = join(directVitestRoot, "codex-home");
  mkdirSync(codexHome, { recursive: true });
  const sourceCodexHome = previousCodexHome?.trim()
    ? resolve(previousCodexHome)
    : resolve(join(homedir(), ".codex"));
  for (const relativePath of ["config.toml", "luckytoken-model-catalog.json"]) {
    const sourcePath = join(sourceCodexHome, relativePath);
    if (existsSync(sourcePath)) copyFileSync(sourcePath, join(codexHome, relativePath));
  }
  process.env.CODEX_HOME = codexHome;
  process.env.LUCKYTOKEN_TEST_CODEX_SANDBOX = "1";
}

const resolvedCodexHome = resolve(process.env.CODEX_HOME ?? "");
const realDefaultCodexHome = resolve(join(homedir(), ".codex"));
if (resolvedCodexHome === realDefaultCodexHome) {
  throw new Error("P0 test isolation breach: Vitest resolved the real Codex home.");
}

afterAll(() => {
  if (directVitestRoot === undefined) return;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  delete process.env.LUCKYTOKEN_TEST_CODEX_SANDBOX;
  rmSync(directVitestRoot, { recursive: true, force: true });
});
