import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  connectControlPlane,
  createNodePipeTransport,
} from "@luckytoken/application-control-plane/control-plane";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");
const backendRoot = join(
  repositoryRoot,
  "packages",
  "desktop-shell",
  "backend",
);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("the assembled release backend serves as a desktop-owned instance from the installed layout", async () => {
  const nodeExe = join(backendRoot, "node", "node.exe");
  const cliScript = join(backendRoot, "dist", "cli.js");
  for (const path of [nodeExe, cliScript]) {
    assert.ok(
      await exists(path),
      `release backend is missing ${path}; run npm run release:assemble-backend`,
    );
  }

  const directory = await mkdtemp(join(tmpdir(), "luckytoken-release-serve-"));
  const userRoot = join(directory, "home");
  await mkdir(join(userRoot, ".luckytoken", "pi"), { recursive: true });
  const configPath = join(userRoot, ".luckytoken", "config.json");
  const descriptorPath = join(directory, "control-plane.json");
  try {
    const serve = execFileAsync(
      nodeExe,
      [
        cliScript,
        "serve",
        "--config",
        configPath,
        "--descriptor",
        descriptorPath,
        "--owner",
        "desktop",
        "--create-first-run-config",
      ],
      {
        cwd: backendRoot,
        env: { ...process.env, USERPROFILE: userRoot },
        maxBuffer: 8 * 1024 * 1024,
      },
    );

    let endpoint;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const raw = await readFile(descriptorPath, "utf8");
        const parsed = JSON.parse(raw);
        if (typeof parsed.pipeName === "string") {
          endpoint = parsed;
          break;
        }
      } catch {
        // not published yet
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    assert.ok(endpoint !== undefined, "serve must publish its descriptor");

    // The first-run template was created by the TypeScript side, and the
    // Data Plane is reachable from the installed layout.
    assert.equal(
      JSON.parse(await readFile(configPath, "utf8")).schemaVersion,
      "luckytoken-config-v1",
    );

    let client;
    let lastError;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        client = await connectControlPlane(endpoint, {
          createRequestId: () => `release-serve-${attempt}`,
          pipeConnector: createNodePipeTransport(),
        });
        break;
      } catch (error) {
        lastError = error;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
    }
    assert.ok(client !== undefined, `connect failed: ${String(lastError)}`);
    try {
      const hello = await client.hello(1);
      assert.equal(hello.type, "compatible");
      assert.equal(hello.application.version, "0.1.0");
      assert.equal(hello.contractVersion, 1);

      let status;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        status = await client.getStatus();
        if (status.modelDataPlane === "running") break;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
      assert.equal(status.modelDataPlane, "running");
      assert.equal(status.ownership.owner.kind, "desktop");

      const quit = await client.executeApplicationCommand({
        command: "quit",
        acknowledged: true,
      });
      assert.equal(quit.command, "quit");
      assert.equal(quit.outcome, "drained");
    } finally {
      await client.close().catch(() => undefined);
    }

    const { stdout } = await serve;
    assert.match(stdout, /application quit/u);
    assert.ok(!stdout.includes("raw secret"), "no credential material in output");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);
