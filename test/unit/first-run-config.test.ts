import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFirstRunConfig } from "../../src/first-run-config.js";
import { DEFAULT_MAX_REQUEST_BYTES } from "../../src/data-plane-limits.js";

describe("desktop first-run configuration template", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("creates a valid owned config with both default client protocols when absent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-first-run-"));
    directories.push(directory);
    const configPath = join(directory, "config.json");

    await createFirstRunConfig(configPath);

    const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
      readonly schemaVersion?: unknown;
      readonly server?: { readonly port?: unknown };
      readonly clientProtocols?: Record<string, unknown>;
      readonly pi?: { readonly directory?: unknown };
      readonly limits?: { readonly maxRequestBytes?: unknown };
    };
    expect(parsed.schemaVersion).toBe("luckytoken-config-v1");
    expect(parsed.server).toEqual({ port: 3000 });
    expect(parsed.clientProtocols).toHaveProperty("anthropic-messages");
    expect(parsed.clientProtocols).toHaveProperty("openai-responses");
    expect(parsed.clientProtocols?.["anthropic-messages"]).not.toHaveProperty("authFile");
    expect(parsed.clientProtocols?.["openai-responses"]).not.toHaveProperty("authFile");
    expect(parsed.pi).toHaveProperty("directory");
    expect(DEFAULT_MAX_REQUEST_BYTES).toBe(256 * 1024 * 1024);
    expect(parsed.limits?.maxRequestBytes).toBe(DEFAULT_MAX_REQUEST_BYTES);

    if (process.platform === "win32") return; // Windows mode bits are advisory
    const mode = await stat(configPath);
    expect(mode.mode & 0o777).toBe(0o600);
  });

  it("is idempotent: an existing config is never overwritten", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-first-run-"));
    directories.push(directory);
    const configPath = join(directory, "config.json");

    await createFirstRunConfig(configPath);
    const original = await readFile(configPath, "utf8");
    await createFirstRunConfig(configPath);
    expect(await readFile(configPath, "utf8")).toBe(original);
  });

  it("does not touch a deliberately incompatible existing config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-first-run-"));
    directories.push(directory);
    const configPath = join(directory, "config.json");
    const incompatible = "not-a-luckytoken-config";
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(configPath, incompatible, "utf8"),
    );

    await createFirstRunConfig(configPath);
    expect(await readFile(configPath, "utf8")).toBe(incompatible);
  });
});
