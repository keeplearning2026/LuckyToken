import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadTokenCliConfig } from "../../src/cli-config.js";
import {
  bindDiagnosticsConfiguration,
  parseDiagnosticsConfiguration,
} from "../../src/diagnostics/configuration.js";

describe("unified diagnostics configuration", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("defaults the single diagnostics snapshot under the config directory", () => {
    const root = resolve("config-root");
    expect(parseDiagnosticsConfiguration(undefined, root)).toMatchObject({
      directory: resolve(root, "state", "request-diagnostics"),
      successArtifacts: { enabled: false },
      maxJourneyArtifactBytes: 4_194_304,
      artifactRetentionAgeMs: 604_800_000,
      maxArtifactJourneys: 1_000,
    });
  });

  it("accepts and deeply freezes the current diagnostics contract", () => {
    const configuration = parseDiagnosticsConfiguration(
      {
        directory: "state/diagnostics",
        successArtifacts: { enabled: true },
        maxJourneyArtifactBytes: 1_024,
        artifactRetentionAgeMs: 2_000,
        maxArtifactJourneys: 25,
      },
      "root",
    );

    expect(configuration).toMatchObject({
      directory: resolve("root", "state", "diagnostics"),
      successArtifacts: { enabled: true },
      maxJourneyArtifactBytes: 1_024,
      artifactRetentionAgeMs: 2_000,
      maxArtifactJourneys: 25,
    });
    expect(Object.isFrozen(configuration)).toBe(true);
    expect(Object.isFrozen(configuration.successArtifacts)).toBe(true);
    expect(bindDiagnosticsConfiguration(configuration)).toBe(configuration);
  });

  it("accepts an authoritative snapshot across module boundaries", () => {
    const parsed = parseDiagnosticsConfiguration(
      { directory: "state/diagnostics" },
      "root",
    );
    const cloned = structuredClone(parsed);

    expect(bindDiagnosticsConfiguration(cloned)).toEqual(parsed);
    expect(() =>
      bindDiagnosticsConfiguration({
        directory: parsed.directory,
        successArtifacts: parsed.successArtifacts,
        maxJourneyArtifactBytes: parsed.maxJourneyArtifactBytes,
        artifactRetentionAgeMs: parsed.artifactRetentionAgeMs,
        maxArtifactJourneys: parsed.maxArtifactJourneys,
      }),
    ).toThrow(/diagnostics-owned snapshot/iu);
  });

  it.each([
    [{ retentionDays: 30 }, "diagnostics.retentionDays is unknown"],
    [
      { successArtifacts: { extra: true } },
      "diagnostics.successArtifacts.extra is unknown",
    ],
    [
      { maxJourneyArtifactBytes: 4_194_305 },
      "diagnostics.maxJourneyArtifactBytes",
    ],
    [{ artifactRetentionAgeMs: 0 }, "diagnostics.artifactRetentionAgeMs"],
    [{ maxArtifactJourneys: 1_001 }, "diagnostics.maxArtifactJourneys"],
  ] as const)("rejects invalid diagnostics input %#", (value, message) => {
    expect(() => parseDiagnosticsConfiguration(value, "root")).toThrow(message);
  });

  it("parses only diagnostics through the config-v2 root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "Token-diag-config-"));
    directories.push(directory);
    const path = join(directory, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: "token-config-v2",
        clientProtocols: { fixture: {} },
        pi: { directory: "pi" },
        diagnostics: {
          directory: "custom/diagnostics",
          successArtifacts: { enabled: true },
          maxJourneyArtifactBytes: 2_048,
          artifactRetentionAgeMs: 3_000,
          maxArtifactJourneys: 30,
        },
      }),
      "utf8",
    );

    const config = await loadTokenCliConfig(path);
    expect(config.diagnostics).toMatchObject({
      directory: resolve(directory, "custom", "diagnostics"),
      successArtifacts: { enabled: true },
      maxJourneyArtifactBytes: 2_048,
      artifactRetentionAgeMs: 3_000,
      maxArtifactJourneys: 30,
    });
  });
});
