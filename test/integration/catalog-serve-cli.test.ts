import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";

import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");

interface ChildResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function captureChild(child: ChildProcessWithoutNullStreams): {
  readonly result: Promise<ChildResult>;
} {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const result = new Promise<ChildResult>((resolve) => {
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { result };
}

function startCli(args: readonly string[]): ChildProcessWithoutNullStreams {
  const configIndex = args.indexOf("--config");
  const configPath = configIndex < 0 ? undefined : args[configIndex + 1];
  const configDirectory = configPath === undefined ? undefined : dirname(configPath);
  const fixtureHome =
    configDirectory === undefined
      ? undefined
      : basename(configDirectory) === ".luckytoken"
        ? dirname(configDirectory)
        : configDirectory;
  return spawn(process.execPath, [tsxCli, "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...(fixtureHome === undefined
        ? {}
        : {
            HOME: fixtureHome,
            USERPROFILE: fixtureHome,
            CODEX_HOME: join(fixtureHome, ".codex"),
          }),
      NO_COLOR: "1",
    },
    stdio: "pipe",
  });
}

async function reserveFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as { readonly port: number };
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * Ticket 11 serve wiring seam: the running LuckyToken instance owns the
 * validated catalog cache under the configured application directory and
 * serves the versioned catalog commands through the Control Plane. The
 * CLI `control catalog` commands drive the real serve process end to end.
 */
describe("catalog serve wiring", () => {
  const children: ChildProcessWithoutNullStreams[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      children.splice(0).map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        await new Promise<void>((resolve) => {
          child.once("close", () => resolve());
          child.kill();
        });
      }),
    );
    await Promise.all(
      roots.splice(0).map((root) =>
        rm(root, { recursive: true, force: true }).catch(() => undefined),
      ),
    );
  });

  it(
    "serves catalog queries and manual refresh through the running instance",
    { timeout: 60_000 },
    async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-catalog-serve-"));
    roots.push(root);
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { recursive: true });
    const configPath = join(root, "luckytoken.config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "luckytoken-config-v2",
        server: { port: await reserveFreePort() },
        clientProtocols: {
          "anthropic-messages": {
          },
        },
        pi: { directory: "pi" },
      }),
      "utf8",
    );
    const descriptorPath = join(root, ".luckytoken", "control-plane.json");
    const serve = startCli(["--config", configPath]);
    children.push(serve);
    const serveCapture = captureChild(serve);

    await expect
      .poll(async () => {
        try {
          const parsed = JSON.parse(await readFile(descriptorPath, "utf8")) as {
            address?: unknown;
            capability?: unknown;
          };
          return (
            typeof parsed.address === "string" &&
            typeof parsed.capability === "string"
          );
        } catch {
          return false;
        }
      }, { timeout: 10_000, interval: 50 })
      .toBe(true);

    // Wait for the model gateway to start: only then is the refresh
    // controller bound and the active catalog snapshot served.
    await expect
      .poll(async () => {
        const status = startCli(["control", "status", "--descriptor", descriptorPath]);
        children.push(status);
        const result = await captureChild(status).result;
        if (result.code !== 0) return false;
        const parsed = JSON.parse(result.stdout) as { modelDataPlane: string };
        return parsed.modelDataPlane === "running";
      }, { timeout: 10_000, interval: 50 })
      .toBe(true);

    // Catalog query through the running instance.
    const query = startCli([
      "control",
      "catalog",
      "query",
      "--descriptor",
      descriptorPath,
    ]);
    children.push(query);
    const queryResult = await captureChild(query).result;
    expect(queryResult.code).toBe(0);
    const queried = JSON.parse(queryResult.stdout) as {
      outcome: string;
      snapshot: {
        version: number;
        modelsJsonValid: boolean;
        providers: readonly unknown[];
      };
    };
    expect(queried.outcome).toBe("ok");
    expect(queried.snapshot.version).toBeGreaterThan(0);
    expect(queried.snapshot.modelsJsonValid).toBe(true);
    expect(queried.snapshot.providers.length).toBeGreaterThan(0);

    // Manual refresh returns bounded per-Provider results.
    const refresh = startCli([
      "control",
      "catalog",
      "refresh-manual",
      "--descriptor",
      descriptorPath,
    ]);
    children.push(refresh);
    const refreshResult = await captureChild(refresh).result;
    expect(refreshResult.code).toBe(0);
    const refreshed = JSON.parse(refreshResult.stdout) as {
      outcome: string;
      snapshot: { version: number };
      refresh?: { trigger: string; providers: readonly unknown[] };
    };
    expect(refreshed.outcome).toBe("ok");
    expect(refreshed.refresh?.trigger).toBe("manual");
    expect(Array.isArray(refreshed.refresh?.providers)).toBe(true);
    expect(refreshed.snapshot.version).toBeGreaterThan(
      queried.snapshot.version,
    );

    // The catalog-triggered status publish must preserve the gateway's
    // data plane facts (origin/port), not replace them with a bare
    // model/provider projection.
    const status = startCli([
      "control",
      "status",
      "--descriptor",
      descriptorPath,
    ]);
    children.push(status);
    const statusResult = await captureChild(status).result;
    expect(statusResult.code).toBe(0);
    const statusSnapshot = JSON.parse(statusResult.stdout) as {
      modelDataPlane: string;
      dataPlane?: { configuredOrigin?: string; configuredPort?: number };
    };
    expect(statusSnapshot.modelDataPlane).toBe("running");
    expect(statusSnapshot.dataPlane?.configuredPort).toBeGreaterThan(0);
    expect(statusSnapshot.dataPlane?.configuredOrigin).toContain("127.0.0.1");

    // The cache file is a transparent LuckyToken-owned file under the
    // configured application directory. With no dynamic Providers
    // configured nothing is persisted; when a Provider publishes cached
    // facts the file must carry the LuckyToken schema identity.
    const cachePath = join(root, "pi", "models-catalog-cache.json");
    const cacheBytes = await readFile(cachePath, "utf8").catch(() => undefined);
    if (cacheBytes !== undefined) {
      const cache = JSON.parse(cacheBytes) as { schema: string };
      expect(cache.schema).toBe("luckytoken-catalog-cache-v1");
    }

    expect(serveCapture).toBeDefined();
    serve.kill();
  });
});
