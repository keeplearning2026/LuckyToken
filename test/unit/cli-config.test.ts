import { link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("resolves a protocol-neutral auth file for each configured Client Protocol", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-cli-"));
    directories.push(root);
    const directory = join(root, ".luckytoken");
    await mkdir(directory);
    const path = join(directory, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        server: { port: 0 },
        clientProtocols: {
          "anthropic-messages": {
            authFile: "client-auth/anthropic-messages.json",
          },
          "future-client-protocol": {
            authFile: "client-auth/future-client-protocol.json",
          },
        },
        pi: { directory: "pi" },
      }),
      "utf8",
    );

    const config = await loadLuckyTokenCliConfig(path);
    expect(config).toEqual({
      configPath: resolve(path),
      server: { host: "127.0.0.1", port: 0 },
      clientProtocols: {
        "anthropic-messages": {
          authFile: resolve(directory, "client-auth/anthropic-messages.json"),
        },
        "future-client-protocol": {
          authFile: resolve(directory, "client-auth/future-client-protocol.json"),
        },
      },
      pi: { directory: resolve(directory, "pi") },
      limits: { maxRequestBytes: 32 * 1024 * 1024, requestTimeoutMs: 120_000 },
    });
    expect(Object.getPrototypeOf(config.clientProtocols)).toBeNull();
    expect(config.clientProtocols["toString"]).toBeUndefined();
  });

  it("preserves a protocol id named __proto__ as data rather than map structure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-cli-"));
    directories.push(directory);
    const path = join(directory, "config.json");
    await writeFile(
      path,
      '{"clientProtocols":{"__proto__":{"authFile":"proto.json"}},"pi":{"directory":"pi"}}',
      "utf8",
    );

    const config = await loadLuckyTokenCliConfig(path);

    expect(Object.keys(config.clientProtocols)).toEqual(["__proto__"]);
    expect(Object.hasOwn(config.clientProtocols, "__proto__")).toBe(true);
    expect(config.clientProtocols["__proto__"]?.authFile).toBe(
      resolve(directory, "proto.json"),
    );
  });

  it.each([
    [
      {
        clientProtocols: { fixture: { authFile: "fixture.json" } },
        pi: { directory: "pi" },
        extra: true,
      },
    ],
    [
      {
        server: { port: 65_536 },
        clientProtocols: { fixture: { authFile: "fixture.json" } },
        pi: { directory: "pi" },
      },
    ],
    [{ clientProtocols: {}, pi: { directory: "pi" } }],
    [
      {
        clientProtocols: { fixture: { authFile: "" } },
        pi: { directory: "pi" },
      },
    ],
    [
      {
        clientProtocols: {
          fixture: { authFile: "fixture.json", extra: true },
        },
        pi: { directory: "pi" },
      },
    ],
    [
      {
        clientProtocols: {
          first: { authFile: "shared.json" },
          second: { authFile: "./shared.json" },
        },
        pi: { directory: "pi" },
      },
    ],
    [
      {
        client: { apiKey: "legacy", projectDir: "legacy-project" },
        pi: { directory: "pi" },
      },
    ],
    [
      {
        clientProtocols: { fixture: { authFile: "fixture.json" } },
        pi: { directory: "" },
      },
    ],
  ])("rejects invalid or unknown configuration %#", async (input) => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-cli-"));
    directories.push(directory);
    const path = join(directory, "config.json");
    await writeFile(path, JSON.stringify(input), "utf8");

    await expect(loadLuckyTokenCliConfig(path)).rejects.toThrow();
  });

  it("rejects distinct auth-file paths that are hard links to one physical file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-cli-"));
    directories.push(directory);
    const firstAuthFile = join(directory, "first.json");
    const secondAuthFile = join(directory, "second.json");
    await writeFile(firstAuthFile, "{}", "utf8");
    await link(firstAuthFile, secondAuthFile);
    const path = join(directory, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        clientProtocols: {
          first: { authFile: "first.json" },
          second: { authFile: "second.json" },
        },
        pi: { directory: "pi" },
      }),
      "utf8",
    );

    await expect(loadLuckyTokenCliConfig(path)).rejects.toThrow(
      "auth files must be unique",
    );
  });
});
