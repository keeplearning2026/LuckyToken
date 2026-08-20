import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  it("configures Client Protocols without any client-auth file", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-cli-"));
    directories.push(root);
    const directory = join(root, ".luckytoken");
    await mkdir(directory);
    const path = join(directory, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: "luckytoken-config-v1",
        server: { port: 0 },
        clientProtocols: {
          "anthropic-messages": {},
          "future-client-protocol": {},
        },
        pi: { directory: "pi" },
      }),
      "utf8",
    );

    const config = await loadLuckyTokenCliConfig(path);
    expect(config).toMatchObject({
      configPath: resolve(path),
      server: { host: "127.0.0.1", port: 0 },
      clientProtocols: {
        "anthropic-messages": {
          adapterConfiguration: {
            conversion: {
              request: { unknownContent: "error", unresolvedToolCall: "xrepair", localCacheControl: "ignore" },
              response: { unknownPiContent: "error" },
            },
          },
        },
        "future-client-protocol": {},
      },
      pi: { directory: resolve(directory, "pi") },
      limits: { maxRequestBytes: 32 * 1024 * 1024, requestTimeoutMs: 120_000 },
    });
    expect(config.providerPackages).toEqual({});
    expect(Object.getPrototypeOf(config.providerPackages)).toBeNull();
    expect(config.failureLogging.directory).toBe(resolve(directory, "logs/failed-requests"));
    expect(Object.getPrototypeOf(config.clientProtocols)).toBeNull();
    expect(config.clientProtocols["toString"]).toBeUndefined();
  });

  it("defaults the canonical models.json to the config data directory and never to Pi Agent's or the Pi credential directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-cli-"));
    directories.push(directory);
    const path = join(directory, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: "luckytoken-config-v1",
        server: { port: 0 },
        clientProtocols: {
          "anthropic-messages": {
            authFile: "client-auth/anthropic-messages.json",
          },
        },
        pi: { directory: "pi" },
      }),
      "utf8",
    );

    const config = await loadLuckyTokenCliConfig(path);
    // The canonical models.json sits next to the config file (the desktop
    // layout's `~/.luckytoken/models.json`), never inside the Pi credential
    // directory (`<pi.directory>/models.json`) and never Pi Agent's own
    // `~/.pi/agent/models.json`.
    expect(config.pi.modelsJson).toBe(resolve(directory, "models.json"));
    expect(config.pi.modelsJson).not.toBe(resolve(directory, "pi", "models.json"));
    expect(config.pi.modelsJson).not.toContain(join("pi", "models.json"));
    expect(config.pi.modelsJson).not.toContain(".pi");
    expect(config.pi.modelsJson).not.toContain("agent");
    expect(config.pi.modelsJson.startsWith(resolve(directory))).toBe(true);

    // An explicit modelsJson keeps its own resolution.
    const explicitPath = join(directory, "config-explicit.json");
    await writeFile(
      explicitPath,
      JSON.stringify({
        schemaVersion: "luckytoken-config-v1",
        server: { port: 0 },
        clientProtocols: {
          "anthropic-messages": {
            authFile: "client-auth/anthropic-messages.json",
          },
        },
        pi: { directory: "pi", modelsJson: "models/custom.json" },
      }),
      "utf8",
    );
    const explicit = await loadLuckyTokenCliConfig(explicitPath);
    expect(explicit.pi.modelsJson).toBe(
      resolve(directory, "models", "custom.json"),
    );
  });

  it("preserves raw configuration under validated Provider Package names", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-cli-"));
    directories.push(directory);
    const path = join(directory, "config.json");
    const packageConfiguration = {
      conversion: { response: { unknownEvent: "ignore" } },
    };
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: "luckytoken-config-v1",
        clientProtocols: {
          fixture: { authFile: "fixture.json" },
        },
        providerPackages: {
          "@luckytoken/provider-commandcode-private": packageConfiguration,
        },
        pi: { directory: "pi" },
      }),
      "utf8",
    );

    const config = await loadLuckyTokenCliConfig(path);

    expect(
      config.providerPackages["@luckytoken/provider-commandcode-private"],
    ).toEqual(packageConfiguration);
  });

  it("preserves a protocol id named __proto__ as data rather than map structure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-cli-"));
    directories.push(directory);
    const path = join(directory, "config.json");
    await writeFile(
      path,
      '{"schemaVersion":"luckytoken-config-v1","clientProtocols":{"__proto__":{"authFile":"proto.json"}},"pi":{"directory":"pi"}}',
      "utf8",
    );

    const config = await loadLuckyTokenCliConfig(path);

    expect(Object.keys(config.clientProtocols)).toEqual(["__proto__"]);
    expect(Object.hasOwn(config.clientProtocols, "__proto__")).toBe(true);
    expect(config.clientProtocols["__proto__"]?.authFile).toBe(
      resolve(directory, "proto.json"),
    );
  });

  it("refuses an unversioned legacy config instead of migrating or overwriting it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-cli-legacy-"));
    directories.push(directory);
    const path = join(directory, "config.json");
    const original = JSON.stringify({
      clientProtocols: { fixture: { authFile: "fixture.json" } },
      pi: { directory: "pi" },
    });
    await writeFile(path, original, "utf8");

    await expect(loadLuckyTokenCliConfig(path)).rejects.toThrow(
      "schemaVersion is incompatible",
    );
    await expect(readFile(path, "utf8")).resolves.toBe(original);
  });

  it.each([
    [
      {
        schemaVersion: "luckytoken-config-v1",
        clientProtocols: { fixture: { authFile: "fixture.json" } },
        pi: { directory: "pi" },
        extra: true,
      },
    ],
    [
      {
        schemaVersion: "luckytoken-config-v1",
        server: { port: 65_536 },
        clientProtocols: { fixture: { authFile: "fixture.json" } },
        pi: { directory: "pi" },
      },
    ],
    [{ schemaVersion: "luckytoken-config-v1", clientProtocols: {}, pi: { directory: "pi" } }],
    [
      {
        schemaVersion: "luckytoken-config-v1",
        clientProtocols: { fixture: { authFile: "" } },
        pi: { directory: "pi" },
      },
    ],
    [
      {
        schemaVersion: "luckytoken-config-v1",
        clientProtocols: {
          fixture: { authFile: "fixture.json", extra: true },
        },
        pi: { directory: "pi" },
      },
    ],
    [
      {
        schemaVersion: "luckytoken-config-v1",
        clientProtocols: {
          first: { authFile: "shared.json" },
          second: { authFile: "./shared.json" },
        },
        pi: { directory: "pi" },
      },
    ],
    [
      {
        schemaVersion: "luckytoken-config-v1",
        client: { apiKey: "legacy", projectDir: "legacy-project" },
        pi: { directory: "pi" },
      },
    ],
    [
      {
        schemaVersion: "luckytoken-config-v1",
        clientProtocols: { fixture: { authFile: "fixture.json" } },
        pi: { directory: "" },
      },
    ],
    [
      {
        schemaVersion: "luckytoken-config-v1",
        clientProtocols: { fixture: { authFile: "fixture.json" } },
        providerAdapters: { "commandcode-private": {} },
        pi: { directory: "pi" },
      },
    ],
    [
      {
        schemaVersion: "luckytoken-config-v1",
        clientProtocols: { fixture: { authFile: "fixture.json" } },
        providerPackages: { "../private-provider": {} },
        pi: { directory: "pi" },
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
        schemaVersion: "luckytoken-config-v1",
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
