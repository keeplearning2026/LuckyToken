import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadLuckyTokenCliConfig } from "../../src/cli-config.js";
import {
  bindRuntimeDiagnosticsConfiguration,
  parseRuntimeDiagnosticsConfiguration,
} from "../../src/runtime-diagnostics/index.js";

describe("Runtime Diagnostics configuration", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("defaults the diagnostics directory under the config directory", () => {
    const root = resolve("config-root");
    const configuration = parseRuntimeDiagnosticsConfiguration(
      undefined,
      root,
    );
    expect(configuration.directory).toBe(resolve(root, "state", "diagnostics"));
  });

  it("accepts only a diagnostics-owned snapshot", () => {
    const configuration = parseRuntimeDiagnosticsConfiguration(
      { directory: "state/diagnostics" },
      "root",
    );
    expect(bindRuntimeDiagnosticsConfiguration(configuration)).toBe(
      configuration,
    );
    expect(() =>
      bindRuntimeDiagnosticsConfiguration({ directory: "elsewhere" }),
    ).toThrow(/diagnostics-owned snapshot/iu);
  });

  it("accepts a structurally valid authoritative snapshot across module boundaries", () => {
    // A configuration snapshot parsed in one module instance must bind in
    // another: ownership is a versioned marker contract, not object identity.
    const first = parseRuntimeDiagnosticsConfiguration(
      { directory: "state/diagnostics" },
      "root",
    );
    // structuredClone preserves the version marker across a module boundary
    // (e.g. IPC or a fresh module instance).
    const cloned = structuredClone(first);
    expect(bindRuntimeDiagnosticsConfiguration(cloned)).toEqual(first);
    // A plain structurally similar object without the marker is refused.
    expect(() =>
      bindRuntimeDiagnosticsConfiguration(
        Object.freeze({ directory: first.directory }),
      ),
    ).toThrow();
    expect(() =>
      bindRuntimeDiagnosticsConfiguration(
        Object.freeze({ directory: first.directory, retentionDays: 30 }),
      ),
    ).toThrow();
  });

  it("rejects unknown diagnostics fields", () => {
    expect(() =>
      parseRuntimeDiagnosticsConfiguration(
        { directory: "state/diagnostics", retentionDays: 30 },
        "root",
      ),
    ).toThrow(/unknown/iu);
  });

  it("parses runtimeDiagnostics through the strict CLI config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-diag-config-"));
    directories.push(directory);
    const path = join(directory, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: "luckytoken-config-v1",
        clientProtocols: { fixture: {} },
        pi: { directory: "pi" },
        runtimeDiagnostics: { directory: "custom/diagnostics" },
      }),
      "utf8",
    );

    const config = await loadLuckyTokenCliConfig(path);
    expect(config.runtimeDiagnostics.directory).toBe(
      resolve(directory, "custom", "diagnostics"),
    );
  });

  it("accepts the example config with the diagnostics key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-diag-example-"));
    directories.push(directory);
    const path = join(directory, "config.json");
    const example = JSON.parse(
      await import("node:fs/promises").then((fs) =>
        fs.readFile(join(process.cwd(), "luckytoken.config.example.json"), "utf8"),
      ),
    ) as Record<string, unknown>;
    await writeFile(path, JSON.stringify(example), "utf8");

    const config = await loadLuckyTokenCliConfig(path);
    expect(config.runtimeDiagnostics.directory).toBe(
      resolve(directory, "state", "diagnostics"),
    );
  });
});
