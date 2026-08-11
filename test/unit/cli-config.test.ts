import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadLuckyTokenCliConfig } from "../../src/cli-config.js";

describe("LuckyToken CLI configuration", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("resolves only filesystem facts relative to the config file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-cli-"));
    directories.push(directory);
    const path = join(directory, "luckytoken.config.json");
    await writeFile(
      path,
      JSON.stringify({
        server: { port: 0 },
        client: { apiKey: "local-client-key", projectDir: "workspace" },
        pi: { directory: "pi" },
      }),
      "utf8",
    );

    await expect(loadLuckyTokenCliConfig(path)).resolves.toEqual({
      configPath: resolve(path),
      server: { host: "127.0.0.1", port: 0 },
      client: {
        apiKey: "local-client-key",
        projectDir: resolve(directory, "workspace"),
      },
      pi: { directory: resolve(directory, "pi") },
      limits: { maxRequestBytes: 1_048_576, requestTimeoutMs: 120_000 },
    });
  });

  it.each([
    [{ client: { apiKey: "key" }, pi: { directory: "pi" }, extra: true }],
    [{ server: { port: 65_536 }, client: { apiKey: "key" }, pi: { directory: "pi" } }],
    [{ client: { apiKey: "" }, pi: { directory: "pi" } }],
    [{ client: { apiKey: "key" }, pi: { directory: "" } }],
  ])("rejects invalid or unknown configuration %#", async (input) => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-cli-"));
    directories.push(directory);
    const path = join(directory, "luckytoken.config.json");
    await writeFile(path, JSON.stringify(input), "utf8");

    await expect(loadLuckyTokenCliConfig(path)).rejects.toThrow();
  });
});
