import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadTokenCliConfig } from "../../src/cli-config.js";
import { createFirstRunConfig } from "../../src/first-run-config.js";

const LEGACY_DIAGNOSTICS_KEYS = [
  "failureLogging",
  "runtimeDiagnostics",
  "requestLedger",
  "deepDiagnostics",
] as const;

function v2Config(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    schemaVersion: "token-config-v2",
    clientProtocols: { "anthropic-messages": {} },
    pi: { directory: "pi" },
    diagnostics: {},
    ...overrides,
  };
}

describe("Token config v2 diagnostics cutover", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("accepts only the v2 diagnostics root and resolves its directory from the application-state root", async () => {
    const root = await mkdtemp(join(tmpdir(), "token-config-v2-"));
    directories.push(root);
    const applicationStateRoot = join(root, ".Token");
    const configPath = join(applicationStateRoot, "config.json");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify(v2Config()), "utf8");

    const loaded = (await loadTokenCliConfig(configPath)) as unknown as
      Record<string, unknown>;
    const expectedDiagnosticsDirectory = resolve(
      applicationStateRoot,
      "state/request-diagnostics",
    );
    expect(loaded).toMatchObject({
      schemaVersion: "token-config-v2",
      diagnostics: {
        directory: expectedDiagnosticsDirectory,
        maxJsonArtifactBytes: 67_108_864,
        maxJourneyArtifactBytes: 536_870_912,
        maxArtifactDiskBytes: 5_368_709_120,
        artifactRetentionAgeMs: 604_800_000,
        maxArtifactJourneys: 1_000,
      },
    });
    expect(expectedDiagnosticsDirectory).not.toBe(
      resolve(process.cwd(), "state/request-diagnostics"),
    );
    expect(process.env.CODEX_HOME).toBeTruthy();
    expect(expectedDiagnosticsDirectory).not.toBe(
      resolve(process.env.CODEX_HOME!, "state/request-diagnostics"),
    );
    for (const key of LEGACY_DIAGNOSTICS_KEYS) {
      expect(Object.hasOwn(loaded, key)).toBe(false);
    }

    await writeFile(
      configPath,
      JSON.stringify(v2Config({ schemaVersion: "token-config-v1" })),
      "utf8",
    );
    await expect(loadTokenCliConfig(configPath)).rejects.toThrow(
      /schemaVersion.*incompatible/i,
    );

    for (const key of LEGACY_DIAGNOSTICS_KEYS) {
      await writeFile(
        configPath,
        JSON.stringify(v2Config({ [key]: {} })),
        "utf8",
      );
      await expect(loadTokenCliConfig(configPath)).rejects.toThrow(
        `Token config root has unknown field: ${key}`,
      );
    }
  });

  it("writes first-run configuration with only the v2 diagnostics defaults", async () => {
    const applicationStateRoot = await mkdtemp(
      join(tmpdir(), "Token-first-run-v2-"),
    );
    directories.push(applicationStateRoot);
    const configPath = join(applicationStateRoot, "config.json");

    await createFirstRunConfig(configPath);

    const parsed = JSON.parse(
      await readFile(configPath, "utf8"),
    ) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      schemaVersion: "token-config-v2",
      diagnostics: {
        directory: "state/request-diagnostics",
        maxJsonArtifactBytes: 67_108_864,
        maxJourneyArtifactBytes: 536_870_912,
        maxArtifactDiskBytes: 5_368_709_120,
        artifactRetentionAgeMs: 604_800_000,
        maxArtifactJourneys: 1_000,
      },
    });
    for (const key of LEGACY_DIAGNOSTICS_KEYS) {
      expect(Object.hasOwn(parsed, key)).toBe(false);
    }
  });
});
