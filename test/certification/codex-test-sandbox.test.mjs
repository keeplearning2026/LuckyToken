import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const guardPath = join(repositoryRoot, "scripts", "run-with-codex-test-sandbox.mjs");

test("every repository test entrypoint uses the Codex test guard", async () => {
  const rootManifest = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  );
  const desktopManifest = JSON.parse(
    await readFile(
      join(repositoryRoot, "packages", "desktop-shell", "package.json"),
      "utf8",
    ),
  );
  const onlineCodexManifest = JSON.parse(
    await readFile(join(repositoryRoot, "onlinetest", "codex_cli", "package.json"), "utf8"),
  );
  const onlineClaudeManifest = JSON.parse(
    await readFile(join(repositoryRoot, "onlinetest", "claude", "package.json"), "utf8"),
  );
  const windowsCertification = await readFile(
    join(repositoryRoot, "scripts", "windows-release-certification.ps1"),
    "utf8",
  );
  const rootEntrypoints = [
    "test",
    "test:release",
    "test:certification",
    "test:unit",
    "test:integration",
    "test:distribution",
    "test:online",
    "test:online-responses",
    "test:online-codex",
    "test:online-claude",
    "test:cache",
  ];
  const desktopEntrypoints = [
    "test",
    "test:e2e",
    "test:product-e2e",
    "test:product-e2e:run",
  ];

  for (const name of rootEntrypoints) {
    assert.match(
      rootManifest.scripts[name] ?? "",
      /run-with-codex-test-sandbox\.mjs/u,
      `root ${name} must use the Codex test guard`,
    );
  }
  for (const name of desktopEntrypoints) {
    assert.match(
      desktopManifest.scripts[name] ?? "",
      /run-with-codex-test-sandbox\.mjs/u,
      `desktop ${name} must use the Codex test guard`,
    );
  }
  for (const [name, manifest] of [
    ["online Codex", onlineCodexManifest],
    ["online Claude", onlineClaudeManifest],
  ]) {
    assert.match(
      manifest.scripts.test ?? "",
      /run-with-codex-test-sandbox\.mjs/u,
      `${name} test must use the Codex test guard`,
    );
  }
  assert.match(
    windowsCertification,
    /\$env:CODEX_HOME\s*=\s*\$testCodexHome/u,
    "installed-product certification must use a temporary Codex home",
  );
  assert.match(
    windowsCertification,
    /Remove-Item Env:CODEX_HOME/u,
    "installed-product certification must restore the inherited Codex environment",
  );
});

test("the test guard modifies copied inputs and cleans them after failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "luckytoken-codex-guard-certification-"));
  const originalCodexHome = join(root, "source-codex-home");
  const configPath = join(originalCodexHome, "config.toml");
  const catalogPath = join(originalCodexHome, "luckytoken-model-catalog.json");
  const reportPath = join(root, "child-report.json");
  const originalConfig = Buffer.from('model = "user-owned"\n', "utf8");

  try {
    await mkdir(originalCodexHome, { recursive: true });
    await writeFile(configPath, originalConfig);

    const copiedConfig = 'model = "test-copy"\n';
    const copiedCatalog = '{"models":[]}\n';
    const childProgram = [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const config = path.join(process.env.CODEX_HOME, 'config.toml');",
      "const catalog = path.join(process.env.CODEX_HOME, 'luckytoken-model-catalog.json');",
      "const initialConfig = fs.readFileSync(config, 'utf8');",
      `fs.writeFileSync(config, ${JSON.stringify(copiedConfig)});`,
      `fs.writeFileSync(catalog, ${JSON.stringify(copiedCatalog)});`,
      "fs.writeFileSync(process.env.LUCKYTOKEN_CHILD_REPORT, JSON.stringify({ codexHome: process.env.CODEX_HOME, initialConfig }));",
      "process.exitCode = 7;",
    ].join("");
    const environment = {
      ...process.env,
      CODEX_HOME: originalCodexHome,
      LUCKYTOKEN_CHILD_REPORT: reportPath,
    };
    delete environment.LUCKYTOKEN_TEST_CODEX_SANDBOX;

    const result = spawnSync(
      process.execPath,
      [guardPath, "--", process.execPath, "-e", childProgram],
      {
        cwd: repositoryRoot,
        env: environment,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 7, result.stderr || result.stdout);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.notEqual(resolve(report.codexHome), resolve(originalCodexHome));
    assert.equal(report.initialConfig, originalConfig.toString("utf8"));
    assert.deepEqual(await readFile(configPath), originalConfig);
    await assert.rejects(access(catalogPath), { code: "ENOENT" });
    await assert.rejects(access(report.codexHome), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
