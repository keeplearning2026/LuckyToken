import { spawn, spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const guardPath = join(repositoryRoot, "scripts", "run-with-codex-test-sandbox.mjs");
const vitestPath = join(repositoryRoot, "node_modules", "vitest", "vitest.mjs");

async function waitForFile(path, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForMissing(path, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for cleanup of ${path}`);
}

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

test("the test guard rewrites the copied Codex catalog path into the sandbox", async () => {
  const root = await mkdtemp(join(tmpdir(), "luckytoken-codex-guard-catalog-"));
  const originalCodexHome = join(root, "source-codex-home");
  const configPath = join(originalCodexHome, "config.toml");
  const catalogPath = join(originalCodexHome, "luckytoken-model-catalog.json");
  const reportPath = join(root, "child-report.json");
  const originalCatalog = '{"models":[{"slug":"user-owned"}]}\n';
  const originalConfig = [
    'model = "user-owned"',
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    "[features]",
    "responses_websockets_v2 = true",
    "",
  ].join("\n");

  try {
    await mkdir(originalCodexHome, { recursive: true });
    await writeFile(configPath, originalConfig, "utf8");
    await writeFile(catalogPath, originalCatalog, "utf8");

    const childProgram = [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const config = path.join(process.env.CODEX_HOME, 'config.toml');",
      "const catalog = path.join(process.env.CODEX_HOME, 'luckytoken-model-catalog.json');",
      "fs.writeFileSync(process.env.LUCKYTOKEN_CHILD_REPORT, JSON.stringify({ codexHome: process.env.CODEX_HOME, config: fs.readFileSync(config, 'utf8'), catalog: fs.readFileSync(catalog, 'utf8') }));",
    ].join("");
    const environment = {
      ...process.env,
      CODEX_HOME: originalCodexHome,
      LUCKYTOKEN_CHILD_REPORT: reportPath,
    };
    delete environment.LUCKYTOKEN_TEST_CODEX_SANDBOX;
    delete environment.LUCKYTOKEN_TEST_CODEX_SANDBOX_ROOT;
    delete environment.LUCKYTOKEN_TEST_CODEX_SANDBOX_NONCE;

    const result = spawnSync(
      process.execPath,
      [guardPath, "--", process.execPath, "-e", childProgram],
      {
        cwd: repositoryRoot,
        env: environment,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    const expectedConfig = originalConfig.replace(
      `model_catalog_json = ${JSON.stringify(catalogPath)}`,
      `model_catalog_json = ${JSON.stringify(join(report.codexHome, "luckytoken-model-catalog.json"))}`,
    );
    assert.equal(report.config, expectedConfig);
    assert.equal(report.catalog, originalCatalog);
    assert.equal(await readFile(configPath, "utf8"), originalConfig);
    assert.equal(await readFile(catalogPath, "utf8"), originalCatalog);
    await assert.rejects(access(report.codexHome), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the test guard removes an external catalog path when no catalog was copied", async () => {
  const root = await mkdtemp(join(tmpdir(), "luckytoken-codex-guard-no-catalog-"));
  const originalCodexHome = join(root, "source-codex-home");
  const configPath = join(originalCodexHome, "config.toml");
  const reportPath = join(root, "child-report.json");
  const originalConfig = [
    'model = "user-owned"',
    `model_catalog_json = ${JSON.stringify(join(root, "external-catalog.json"))}`,
    "[features]",
    "responses_websockets_v2 = true",
    "",
  ].join("\n");

  try {
    await mkdir(originalCodexHome, { recursive: true });
    await writeFile(configPath, originalConfig, "utf8");
    const childProgram = [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const config = path.join(process.env.CODEX_HOME, 'config.toml');",
      "fs.writeFileSync(process.env.LUCKYTOKEN_CHILD_REPORT, JSON.stringify({ codexHome: process.env.CODEX_HOME, config: fs.readFileSync(config, 'utf8') }));",
    ].join("");
    const environment = {
      ...process.env,
      CODEX_HOME: originalCodexHome,
      LUCKYTOKEN_CHILD_REPORT: reportPath,
    };
    delete environment.LUCKYTOKEN_TEST_CODEX_SANDBOX;
    delete environment.LUCKYTOKEN_TEST_CODEX_SANDBOX_ROOT;
    delete environment.LUCKYTOKEN_TEST_CODEX_SANDBOX_NONCE;

    const result = spawnSync(
      process.execPath,
      [guardPath, "--", process.execPath, "-e", childProgram],
      {
        cwd: repositoryRoot,
        env: environment,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(
      report.config,
      ['model = "user-owned"', "[features]", "responses_websockets_v2 = true", ""].join("\n"),
    );
    assert.equal(await readFile(configPath, "utf8"), originalConfig);
    await assert.rejects(access(report.codexHome), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("direct Vitest rewrites copied Codex paths and removes its sandbox", async () => {
  const root = await mkdtemp(join(tmpdir(), "luckytoken-direct-vitest-certification-"));
  const originalCodexHome = join(root, "source-codex-home");
  const configPath = join(originalCodexHome, "config.toml");
  const catalogPath = join(originalCodexHome, "luckytoken-model-catalog.json");
  const reportPath = join(root, "child-report.json");
  const originalCatalog = '{"models":[{"slug":"user-owned"}]}\n';
  const originalConfig = [
    'model = "user-owned"',
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    "",
  ].join("\n");

  try {
    await mkdir(originalCodexHome, { recursive: true });
    await writeFile(configPath, originalConfig, "utf8");
    await writeFile(catalogPath, originalCatalog, "utf8");
    const environment = {
      ...process.env,
      CODEX_HOME: originalCodexHome,
      LUCKYTOKEN_CHILD_REPORT: reportPath,
    };
    delete environment.LUCKYTOKEN_TEST_CODEX_SANDBOX;
    delete environment.LUCKYTOKEN_TEST_CODEX_SANDBOX_ROOT;
    delete environment.LUCKYTOKEN_TEST_CODEX_SANDBOX_NONCE;

    const result = spawnSync(
      process.execPath,
      [
        vitestPath,
        "run",
        "test/unit/test-codex-environment-isolation.test.ts",
      ],
      {
        cwd: repositoryRoot,
        env: environment,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.notEqual(resolve(report.codexHome), resolve(originalCodexHome));
    assert.equal(await readFile(configPath, "utf8"), originalConfig);
    assert.equal(await readFile(catalogPath, "utf8"), originalCatalog);
    await assert.rejects(access(report.codexHome), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the test guard rejects an unleased inherited sandbox", async () => {
  const root = await mkdtemp(join(tmpdir(), "luckytoken-unleased-codex-home-"));
  const reportPath = join(root, "child-report.json");
  const childProgram =
    "require('node:fs').writeFileSync(process.env.LUCKYTOKEN_CHILD_REPORT, 'executed');";
  const environment = {
    ...process.env,
    CODEX_HOME: root,
    LUCKYTOKEN_CHILD_REPORT: reportPath,
    LUCKYTOKEN_TEST_CODEX_SANDBOX: "1",
  };
  delete environment.LUCKYTOKEN_TEST_CODEX_SANDBOX_ROOT;
  delete environment.LUCKYTOKEN_TEST_CODEX_SANDBOX_NONCE;

  try {
    const result = spawnSync(
      process.execPath,
      [guardPath, "--", process.execPath, "-e", childProgram],
      {
        cwd: repositoryRoot,
        env: environment,
        encoding: "utf8",
      },
    );

    assert.notEqual(result.status, 0, result.stderr || result.stdout);
    await assert.rejects(access(reportPath), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("direct Vitest rejects an unleased inherited sandbox", async () => {
  const root = await mkdtemp(join(tmpdir(), "luckytoken-unleased-vitest-home-"));
  const reportPath = join(root, "child-report.json");
  const environment = {
    ...process.env,
    CODEX_HOME: root,
    LUCKYTOKEN_CHILD_REPORT: reportPath,
    LUCKYTOKEN_TEST_CODEX_SANDBOX: "1",
  };
  delete environment.LUCKYTOKEN_TEST_CODEX_SANDBOX_ROOT;
  delete environment.LUCKYTOKEN_TEST_CODEX_SANDBOX_NONCE;

  try {
    const result = spawnSync(
      process.execPath,
      [
        vitestPath,
        "run",
        "test/unit/test-codex-environment-isolation.test.ts",
      ],
      {
        cwd: repositoryRoot,
        env: environment,
        encoding: "utf8",
      },
    );

    assert.notEqual(result.status, 0, result.stderr || result.stdout);
    await assert.rejects(access(reportPath), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the test guard rejects a linked Codex home even with a matching lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "luckytoken-linked-codex-home-"));
  const leaseRoot = join(root, "lease-root");
  const realCodexHome = join(root, "real-codex-home");
  const linkedCodexHome = join(leaseRoot, "codex-home");
  const reportPath = join(root, "child-report.json");
  const nonce = "linked-home-nonce";
  const childProgram =
    "require('node:fs').writeFileSync(process.env.LUCKYTOKEN_CHILD_REPORT, 'executed');";

  try {
    await mkdir(leaseRoot, { recursive: true });
    await mkdir(realCodexHome, { recursive: true });
    await symlink(
      realCodexHome,
      linkedCodexHome,
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeFile(
      join(leaseRoot, ".luckytoken-test-sandbox-lease"),
      nonce,
      "utf8",
    );
    const result = spawnSync(
      process.execPath,
      [guardPath, "--", process.execPath, "-e", childProgram],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          CODEX_HOME: linkedCodexHome,
          LUCKYTOKEN_CHILD_REPORT: reportPath,
          LUCKYTOKEN_TEST_CODEX_SANDBOX: "1",
          LUCKYTOKEN_TEST_CODEX_SANDBOX_ROOT: leaseRoot,
          LUCKYTOKEN_TEST_CODEX_SANDBOX_NONCE: nonce,
        },
        encoding: "utf8",
      },
    );

    assert.notEqual(result.status, 0, result.stderr || result.stdout);
    await assert.rejects(access(reportPath), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("direct Vitest rejects a linked Codex home even with a matching lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "luckytoken-linked-vitest-home-"));
  const leaseRoot = join(root, "lease-root");
  const realCodexHome = join(root, "real-codex-home");
  const linkedCodexHome = join(leaseRoot, "codex-home");
  const reportPath = join(root, "child-report.json");
  const nonce = "linked-vitest-nonce";

  try {
    await mkdir(leaseRoot, { recursive: true });
    await mkdir(realCodexHome, { recursive: true });
    await symlink(
      realCodexHome,
      linkedCodexHome,
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeFile(
      join(leaseRoot, ".luckytoken-test-sandbox-lease"),
      nonce,
      "utf8",
    );
    const result = spawnSync(
      process.execPath,
      [
        vitestPath,
        "run",
        "test/unit/test-codex-environment-isolation.test.ts",
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          CODEX_HOME: linkedCodexHome,
          LUCKYTOKEN_CHILD_REPORT: reportPath,
          LUCKYTOKEN_TEST_CODEX_SANDBOX: "1",
          LUCKYTOKEN_TEST_CODEX_SANDBOX_ROOT: leaseRoot,
          LUCKYTOKEN_TEST_CODEX_SANDBOX_NONCE: nonce,
        },
        encoding: "utf8",
      },
    );

    assert.notEqual(result.status, 0, result.stderr || result.stdout);
    await assert.rejects(access(reportPath), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("direct Vitest removes its sandbox when setup fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "luckytoken-vitest-setup-failure-"));
  const originalCodexHome = join(root, "source-codex-home");
  const isolatedTemp = join(root, "isolated-temp");

  try {
    await mkdir(join(originalCodexHome, "config.toml"), { recursive: true });
    await mkdir(isolatedTemp, { recursive: true });
    const environment = {
      ...process.env,
      CODEX_HOME: originalCodexHome,
      TEMP: isolatedTemp,
      TMP: isolatedTemp,
      TMPDIR: isolatedTemp,
    };
    delete environment.LUCKYTOKEN_TEST_CODEX_SANDBOX;
    delete environment.LUCKYTOKEN_TEST_CODEX_SANDBOX_ROOT;
    delete environment.LUCKYTOKEN_TEST_CODEX_SANDBOX_NONCE;

    const result = spawnSync(
      process.execPath,
      [
        vitestPath,
        "run",
        "test/unit/test-codex-environment-isolation.test.ts",
      ],
      {
        cwd: repositoryRoot,
        env: environment,
        encoding: "utf8",
      },
    );

    assert.notEqual(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(
      (await readdir(isolatedTemp)).filter((entry) =>
        entry.startsWith("luckytoken-vitest-codex-"),
      ),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("direct Vitest removes its sandbox when the runner is terminated", async () => {
  const root = await mkdtemp(join(tmpdir(), "luckytoken-vitest-cancellation-"));
  const originalCodexHome = join(root, "source-codex-home");
  const isolatedTemp = join(root, "isolated-temp");
  const reportPath = join(root, "child-report.json");
  let child;

  try {
    await mkdir(originalCodexHome, { recursive: true });
    await mkdir(isolatedTemp, { recursive: true });
    const environment = {
      ...process.env,
      CODEX_HOME: originalCodexHome,
      TEMP: isolatedTemp,
      TMP: isolatedTemp,
      TMPDIR: isolatedTemp,
      LUCKYTOKEN_CHILD_REPORT: reportPath,
      LUCKYTOKEN_TEST_HOLD_OPEN: "1",
    };
    delete environment.LUCKYTOKEN_TEST_CODEX_SANDBOX;
    delete environment.LUCKYTOKEN_TEST_CODEX_SANDBOX_ROOT;
    delete environment.LUCKYTOKEN_TEST_CODEX_SANDBOX_NONCE;

    child = spawn(
      process.execPath,
      [
        vitestPath,
        "run",
        "test/unit/test-codex-environment-isolation.test.ts",
      ],
      {
        cwd: repositoryRoot,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    const report = JSON.parse(await waitForFile(reportPath));
    const exited = new Promise((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    assert.equal(child.kill("SIGTERM"), true, output);
    await exited;

    await waitForMissing(report.codexHome);
    assert.deepEqual(
      (await readdir(isolatedTemp)).filter((entry) =>
        entry.startsWith("luckytoken-vitest-codex-"),
      ),
      [],
    );
  } finally {
    if (child !== undefined && child.exitCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("the test guard removes its sandbox when the guard is terminated", async () => {
  const root = await mkdtemp(join(tmpdir(), "luckytoken-guard-cancellation-"));
  const originalCodexHome = join(root, "source-codex-home");
  const isolatedTemp = join(root, "isolated-temp");
  const reportPath = join(root, "child-report.json");
  let guard;
  let workloadPid;

  try {
    await mkdir(originalCodexHome, { recursive: true });
    await mkdir(isolatedTemp, { recursive: true });
    const childProgram = [
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.env.LUCKYTOKEN_CHILD_REPORT, JSON.stringify({ codexHome: process.env.CODEX_HOME, pid: process.pid }));",
      "setInterval(() => {}, 1000);",
    ].join("");
    const environment = {
      ...process.env,
      CODEX_HOME: originalCodexHome,
      TEMP: isolatedTemp,
      TMP: isolatedTemp,
      TMPDIR: isolatedTemp,
      LUCKYTOKEN_CHILD_REPORT: reportPath,
    };
    delete environment.LUCKYTOKEN_TEST_CODEX_SANDBOX;
    delete environment.LUCKYTOKEN_TEST_CODEX_SANDBOX_ROOT;
    delete environment.LUCKYTOKEN_TEST_CODEX_SANDBOX_NONCE;

    guard = spawn(
      process.execPath,
      [guardPath, "--", process.execPath, "-e", childProgram],
      {
        cwd: repositoryRoot,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let output = "";
    guard.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    guard.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    const report = JSON.parse(await waitForFile(reportPath));
    workloadPid = report.pid;
    const exited = new Promise((resolveExit, rejectExit) => {
      guard.once("error", rejectExit);
      guard.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    assert.equal(guard.kill("SIGTERM"), true, output);
    await exited;
    try {
      process.kill(workloadPid, "SIGKILL");
    } catch {
      // The workload already exited with its parent.
    }

    await waitForMissing(report.codexHome);
    assert.deepEqual(
      (await readdir(isolatedTemp)).filter((entry) =>
        entry.startsWith("luckytoken-test-codex-"),
      ),
      [],
    );
  } finally {
    if (guard !== undefined && guard.exitCode === null) guard.kill("SIGKILL");
    if (workloadPid !== undefined) {
      try {
        process.kill(workloadPid, "SIGKILL");
      } catch {
        // The workload has exited.
      }
    }
    await rm(root, { recursive: true, force: true });
  }
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
