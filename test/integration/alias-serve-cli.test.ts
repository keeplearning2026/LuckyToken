import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");

interface ChildResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function captureChild(child: ChildProcessWithoutNullStreams): Promise<ChildResult> {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function startCli(args: readonly string[]): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [tsxCli, "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, NO_COLOR: "1" },
    stdio: "pipe",
  });
}

async function reserveFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("port unavailable");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("Public Model serve wiring", () => {
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

  it("serves Public Model queries and port mutation while retiring the raw alias CLI", { timeout: 60_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-public-model-serve-"));
    roots.push(root);
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { recursive: true });
    const initialPort = await reserveFreePort();
    const nextPort = await reserveFreePort();
    const configPath = join(root, "luckytoken.config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "luckytoken-config-v1",
        server: { port: initialPort },
        clientProtocols: { "anthropic-messages": {} },
        pi: { directory: "pi" },
      }),
      "utf8",
    );
    const descriptorPath = join(stateDirectory, "control-plane.json");
    const serve = startCli(["--config", configPath, "--descriptor", descriptorPath]);
    children.push(serve);

    await expect
      .poll(async () => {
        try {
          const parsed = JSON.parse(await readFile(descriptorPath, "utf8")) as {
            address?: unknown;
            capability?: unknown;
          };
          return typeof parsed.address === "string" && typeof parsed.capability === "string";
        } catch {
          return false;
        }
      }, { timeout: 10_000, interval: 50 })
      .toBe(true);

    await expect
      .poll(async () => {
        const status = startCli(["control", "status", "--descriptor", descriptorPath]);
        children.push(status);
        const result = await captureChild(status);
        if (result.code !== 0) return false;
        return (JSON.parse(result.stdout) as { modelDataPlane: string }).modelDataPlane === "running";
      }, { timeout: 10_000, interval: 50 })
      .toBe(true);

    const query = startCli(["control", "public-models", "query", "--descriptor", descriptorPath]);
    children.push(query);
    const queriedResult = await captureChild(query);
    expect(queriedResult.code).toBe(0);
    const queried = JSON.parse(queriedResult.stdout) as {
      outcome: string;
      state: { revision: number; endpoint: { host: string; port: number } };
    };
    expect(queried).toMatchObject({
      outcome: "ok",
      state: { endpoint: { host: "127.0.0.1", port: initialPort } },
    });

    const setPort = startCli([
      "control",
      "public-models",
      "set-port",
      String(queried.state.revision),
      String(nextPort),
      "--descriptor",
      descriptorPath,
    ]);
    children.push(setPort);
    const setResult = await captureChild(setPort);
    expect(setResult.code).toBe(0);
    expect(JSON.parse(setResult.stdout)).toMatchObject({
      outcome: "ok",
      state: { endpoint: { host: "127.0.0.1", port: nextPort } },
    });

    await expect
      .poll(async () => {
        try {
          const persisted = JSON.parse(await readFile(join(root, "public-models.json"), "utf8")) as {
            endpoint?: { port?: number };
          };
          return persisted.endpoint?.port;
        } catch {
          return undefined;
        }
      }, { timeout: 5_000, interval: 50 })
      .toBe(nextPort);

    const retired = startCli(["control", "aliases", "query", "--descriptor", descriptorPath]);
    children.push(retired);
    const retiredResult = await captureChild(retired);
    expect(retiredResult.code).not.toBe(0);
  });
});
