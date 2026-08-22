import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");

function runNpm(arguments_, options) {
  return process.platform === "win32"
    ? execFileAsync(
        process.env.ComSpec ?? "cmd.exe",
        ["/d", "/s", "/c", "npm.cmd", ...arguments_],
        options,
      )
    : execFileAsync("npm", arguments_, options);
}

async function pack(
  packageDirectory,
  destination,
) {
  const { stdout } = await runNpm(
    ["pack", packageDirectory, "--json", "--pack-destination", destination],
    { cwd: repositoryRoot, maxBuffer: 8 * 1024 * 1024 },
  );
  const reports = JSON.parse(stdout);
  assert.equal(reports.length, 1);
  const report = reports[0];
  for (const entry of report.files) {
    assert.ok(
      entry.path === "package.json" ||
        entry.path === "README.md" ||
        entry.path.startsWith("dist/"),
      `${report.name} packed an unexpected file: ${entry.path}`,
    );
  }
  return join(destination, report.filename);
}

test("installs all distribution tarballs and resolves the Provider from node_modules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "luckytoken-package-smoke-"));
  try {
    const contractTarball = await pack(
      join(repositoryRoot, "packages", "provider-contract"),
      directory,
    );
    const catalogTarball = await pack(
      join(repositoryRoot, "packages", "commandcode-model-catalog"),
      directory,
    );
    const privateProviderTarball = await pack(
      join(repositoryRoot, "packages", "provider-commandcode-private"),
      directory,
    );
    const goatProviderTarball = await pack(
      join(repositoryRoot, "packages", "provider-commandcode-goat"),
      directory,
    );
    const controlPlaneTarball = await pack(
      join(repositoryRoot, "packages", "application-control-plane"),
      directory,
    );
    const rootTarball = await pack(repositoryRoot, directory);
    await writeFile(
      join(directory, "package.json"),
      `${JSON.stringify({
        private: true,
        type: "module",
        dependencies: {
          "@earendil-works/pi-ai": `file:${join(
            repositoryRoot,
            "node_modules",
            "@earendil-works",
            "pi-ai",
          )}`,
          "@luckytoken/commandcode-model-catalog": `file:${catalogTarball}`,
          "@luckytoken/provider-contract": `file:${contractTarball}`,
          "@luckytoken/provider-commandcode-private": `file:${privateProviderTarball}`,
          "@luckytoken/provider-commandcode-goat": `file:${goatProviderTarball}`,
          "@luckytoken/application-control-plane": `file:${controlPlaneTarball}`,
          luckytoken: `file:${rootTarball}`,
        },
      }, null, 2)}\n`,
      "utf8",
    );
    await runNpm(
      ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: directory, maxBuffer: 8 * 1024 * 1024 },
    );
    await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        [
          'import assert from "node:assert/strict";',
          'const contract = await import("@luckytoken/provider-contract/package");',
          'const catalog = await import("@luckytoken/commandcode-model-catalog");',
          'const privateProviderModule = await import("@luckytoken/provider-commandcode-private");',
          'const goatProviderModule = await import("@luckytoken/provider-commandcode-goat");',
          'const luckytoken = await import("luckytoken");',
          "assert.equal(contract.PROVIDER_PACKAGE_CONTRACT_VERSION, 1);",
          "const input = {",
          "configuration: {},",
          'configurationPath: "providerPackages.fixture",',
          "host: { fetch: globalThis.fetch, now: () => 1, createUuid: () => \"00000000-0000-4000-8000-000000000006\" },",
          "};",
          "const privateProvider = privateProviderModule.providerPackage.createProvider(input);",
          "const goatProvider = goatProviderModule.providerPackage.createProvider(input);",
          'assert.equal(privateProvider.id, "commandcode-private");',
          'assert.equal(goatProvider.id, "commandcode-goat");',
          "assert.deepEqual(privateProvider.getModels().map(({ id }) => id), catalog.COMMANDCODE_MODEL_FACTS.map(({ id }) => id));",
          "assert.deepEqual(goatProvider.getModels().map(({ id }) => id), catalog.COMMANDCODE_MODEL_FACTS.filter(({ minimumPlan }) => minimumPlan === \"go\" || minimumPlan === \"goat\").map(({ id }) => id));",
          'assert.equal(typeof luckytoken.createLuckyTokenRuntime, "function");',
        ].join("\n"),
      ],
      { cwd: directory, maxBuffer: 8 * 1024 * 1024 },
    );
    const installedPrivateProvider = JSON.parse(
      await readFile(
        join(
          directory,
          "node_modules",
          "@luckytoken",
          "provider-commandcode-private",
          "package.json",
        ),
        "utf8",
      ),
    );
    const installedGoatProvider = JSON.parse(
      await readFile(
        join(
          directory,
          "node_modules",
          "@luckytoken",
          "provider-commandcode-goat",
          "package.json",
        ),
        "utf8",
      ),
    );
    assert.equal(installedPrivateProvider.version, "0.1.0");
    assert.equal(installedGoatProvider.version, "0.1.0");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
