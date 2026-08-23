import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";

import { afterEach, describe, expect, it } from "vitest";

import {
  connectControlPlane,
  createNodePipeTransport,
  nodePipeFallbackAccess,
  startControlPlane,
  type ControlPlaneClient,
  type RunningControlPlane,
} from "@luckytoken/application-control-plane/control-plane";

import { createSettingsRegistry } from "../../src/settings/catalog.js";
import {
  createUnsupportedAutoStartRegistrar,
  executeAutoStart,
} from "../../src/auto-start.js";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");

interface ChildResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function captureChild(child: ChildProcessWithoutNullStreams): {
  readonly result: Promise<ChildResult>;
  readonly stdout: () => string;
  readonly stderr: () => string;
} {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const result = new Promise<ChildResult>((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("exit", (code) => resolvePromise({ code, stdout, stderr }));
  });
  return { result, stdout: () => stdout, stderr: () => stderr };
}

function startCli(
  args: readonly string[],
  bridgeSignal = false,
): ChildProcessWithoutNullStreams {
  const command = bridgeSignal
    ? [tsxCli, "test/fixtures/cli-signal-bridge.ts"]
    : [tsxCli, "src/cli.ts", ...args];
  const configIndex = args.indexOf("--config");
  const configPath = configIndex < 0 ? undefined : args[configIndex + 1];
  const configDirectory = configPath === undefined ? undefined : dirname(configPath);
  const fixtureHome =
    configDirectory === undefined
      ? undefined
      : basename(configDirectory) === ".luckytoken"
        ? dirname(configDirectory)
        : configDirectory;
  return spawn(process.execPath, command, {
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
      ...(bridgeSignal
        ? { LUCKYTOKEN_TEST_CLI_ARGS: JSON.stringify(args) }
        : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function reserveFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("LuckyToken CLI ownership lifecycle", () => {
  const directories: string[] = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  const controlPlanes: RunningControlPlane[] = [];

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null) child.kill("SIGTERM");
    }
    await Promise.all(
      controlPlanes.splice(0).map((controlPlane) => controlPlane.close()),
    );
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  async function writeServeState(
    options: {
      readonly settings?: Readonly<Record<string, unknown>>;
      readonly port?: number;
    } = {},
  ) {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-owner-cli-"));
    directories.push(directory);
    const stateDirectory = join(directory, ".luckytoken");
    await mkdir(join(stateDirectory, "pi"), { recursive: true });
    const configPath = join(stateDirectory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "luckytoken-config-v2",
        server: {
          port: options.port ?? (await reserveFreePort()),
        },
        clientProtocols: {
          "anthropic-messages": {},
          "openai-responses": {},
        },
        pi: { directory: "pi" },
      }),
      "utf8",
    );
    if (options.settings !== undefined) {
      await writeFile(
        join(stateDirectory, "settings.json"),
        JSON.stringify(options.settings),
        "utf8",
      );
    }
    const descriptorPath = join(stateDirectory, "control-plane.json");
    await writeFile(descriptorPath, "stale-descriptor", "utf8");
    return { directory, stateDirectory, configPath, descriptorPath };
  }

  async function waitForDescriptor(
    descriptorPath: string,
    child?: ChildProcessWithoutNullStreams,
  ): Promise<unknown> {
    await expect
      .poll(
        async () => {
          // Under full-suite load, parallel tsx child boots can exceed a
          // short budget; fail fast if the child exited instead of waiting.
          if (child !== undefined && child.exitCode !== null) {
            throw new Error(`serve exited before publishing its descriptor`);
          }
          try {
            const parsed = JSON.parse(
              await readFile(descriptorPath, "utf8"),
            ) as {
              address?: unknown;
            };
            return typeof parsed.address === "string";
          } catch {
            return false;
          }
        },
        { timeout: 30_000, interval: 50 },
      )
      .toBe(true);
    return JSON.parse(await readFile(descriptorPath, "utf8"));
  }

  async function connectToServe(
    descriptorPath: string,
    requestIdPrefix: string,
  ) {
    const descriptor = await waitForDescriptor(descriptorPath);
    const endpoint = descriptor as {
      readonly address: string;
      readonly capability: string;
    };
    let next = 0;
    // The owner publishes its descriptor before its Control Plane pipe is
    // ready; retry the connect until the pipe accepts clients.
    let lastError: unknown;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        return await connectControlPlane(endpoint, {
          createRequestId: () => `${requestIdPrefix}-${++next}`,
          pipeConnector: createNodePipeTransport(),
        });
      } catch (error) {
        lastError = error;
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
    }
    throw lastError;
  }

  /** The owner publishes its descriptor before its Data Plane finishes
   *  starting; wait for the running state so snapshot assertions are
   *  deterministic. */
  async function waitForRunning(client: ControlPlaneClient): Promise<void> {
    await expect
      .poll(async () => (await client.getStatus()).modelDataPlane, {
        timeout: 10_000,
        interval: 50,
      })
      .toBe("running");
  }

  async function waitForStartSettled(client: ControlPlaneClient): Promise<void> {
    await expect
      .poll(async () => (await client.getStatus()).modelDataPlane, {
        timeout: 10_000,
        interval: 50,
      })
      .not.toBe("starting");
  }

  it("attaches a second launch to the active instance instead of starting another Data Plane", async () => {
    const { configPath, descriptorPath } = await writeServeState();
    const first = startCli(["--config", configPath], true);
    children.push(first);
    const firstCapture = captureChild(first);
    await waitForDescriptor(descriptorPath);

    const second = startCli(["--config", configPath]);
    children.push(second);
    const secondResult = await captureChild(second).result;

    expect(secondResult.code).toBe(0);
    expect(secondResult.stdout).toContain("LuckyToken is already running");
    expect(secondResult.stdout).toContain("No second Data Plane was started");
    // The attached launch never starts its own gateway or prints routes.
    expect(secondResult.stdout).not.toContain("POST http");
    expect(first.exitCode).toBeNull();

    const status = await connectToServe(descriptorPath, "attach-status");
    await status.hello(3);
    await waitForRunning(status);
    await expect(status.getStatus()).resolves.toMatchObject({
      modelDataPlane: "running",
      ownership: { owner: { kind: "cli" } },
    });
    await status.close();

    first.stdin.end("stop\n");
    const firstResult = await firstCapture.result;
    expect(firstResult.code).toBe(0);
  }, 30_000);

  it("refuses a non-owner quit without explicit acknowledgement and keeps the headless owner alive", async () => {
    const { configPath, descriptorPath } = await writeServeState();
    const serve = startCli(["--config", configPath]);
    children.push(serve);
    const serving = captureChild(serve);
    await waitForDescriptor(descriptorPath);

    const client = await connectToServe(descriptorPath, "refused-quit");
    await client.hello(3);
    // The gateway starts asynchronously after the descriptor is published;
    // wait for the running state before the quit so the refused-quit
    // snapshot is deterministic.
    await waitForRunning(client);
    const result = await client.executeApplicationCommand({
      command: "quit",
      acknowledged: false,
    });
    expect(result).toMatchObject({
      command: "quit",
      outcome: "conflict",
      conflict: { code: "quit_requires_explicit_confirmation" },
      snapshot: { modelDataPlane: "running" },
    });
    await client.close();

    // The user-started headless process was not silently killed.
    expect(serve.exitCode).toBeNull();
    const status = await connectToServe(descriptorPath, "after-refusal");
    await status.hello(3);
    await expect(status.getStatus()).resolves.toMatchObject({
      modelDataPlane: "running",
    });
    const shutdown = await status.executeApplicationCommand({
      command: "quit",
      acknowledged: true,
    });
    expect(shutdown).toMatchObject({ command: "quit", outcome: "drained" });
    await status.close();

    const result2 = await serving.result;
    expect(result2.code).toBe(0);
  }, 60_000);

  it("an acknowledged quit drains the active set and exits the owner process", async () => {
    const { configPath, descriptorPath } = await writeServeState();
    const serve = startCli(["--config", configPath]);
    children.push(serve);
    const serving = captureChild(serve);
    await waitForDescriptor(descriptorPath);

    const client = await connectToServe(descriptorPath, "acknowledged-quit");
    await client.hello(3);
    const result = await client.executeApplicationCommand({
      command: "quit",
      acknowledged: true,
    });
    expect(result).toMatchObject({
      command: "quit",
      outcome: "drained",
      snapshot: { modelDataPlane: "stopped" },
    });
    await client.close();

    await expect
      .poll(() => serve.exitCode, { timeout: 10_000, interval: 50 })
      .not.toBeNull();
    const exit = await serving.result;
    expect(exit.code).toBe(0);
    expect(`${exit.stdout}\n${exit.stderr}`).toContain("application quit");
    await expect(readFile(descriptorPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 60_000);

  it("aborts remaining requests after the configured drain timeout next to the config file", async () => {
    const { configPath, descriptorPath } = await writeServeState({
      settings: { "application.quitDrainTimeoutMs": 300 },
    });
    const serve = startCli(["--config", configPath]);
    children.push(serve);
    const serving = captureChild(serve);
    await waitForDescriptor(descriptorPath);

    // Hold a request in-flight against the real Data Plane: the handler
    // reads the declared body, so a stalled body keeps the request active.
    await expect
      .poll(() => serving.stdout().includes("POST http"), {
        timeout: 10_000,
        interval: 50,
      })
      .toBe(true);
    const originLine = serving
      .stdout()
      .split("\n")
      .find((line) => line.includes("POST http"));
    if (originLine === undefined) throw new Error("serve printed no route");
    const origin = new URL(
      originLine.slice(originLine.indexOf("POST ") + "POST ".length),
    );
    const stalled = httpRequest({
      hostname: origin.hostname,
      port: Number(origin.port),
      path: "/v1/messages",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "1000",
        authorization: "Bearer lt_any",
      },
    });
    stalled.write('{"model":"', "utf8");
    const aborted = new Promise<void>((resolve) => {
      stalled.once("error", () => resolve());
      stalled.once("close", () => resolve());
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    const client = await connectToServe(descriptorPath, "timeout-quit");
    await client.hello(3);
    const quitStartedAt = Date.now();
    const result = await client.executeApplicationCommand({
      command: "quit",
      acknowledged: true,
    });
    const drainElapsed = Date.now() - quitStartedAt;
    await client.close();

    expect(result).toMatchObject({
      command: "quit",
      outcome: "timed_out",
      snapshot: { modelDataPlane: "stopped" },
    });
    // The canonical settings.json next to the config file must be loaded: a
    // configured 300 ms timeout aborts well below the 5000 ms default, so
    // the elapsed quit round trip proves the fixture was honored.
    expect(drainElapsed).toBeLessThan(2500);
    await aborted;
    // Admission is closed once the drain finished: new requests are refused.
    await expect(
      fetch(`${origin}/v1/messages`, { method: "POST" }),
    ).rejects.toThrow();
    await expect
      .poll(() => serve.exitCode, { timeout: 10_000, interval: 50 })
      .not.toBeNull();
    const exit = await serving.result;
    expect(exit.code).toBe(0);
    expect(`${exit.stdout}
${exit.stderr}`).toContain("timed out");
    await expect(readFile(descriptorPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 30_000);

  it("queries and changes Windows login auto-start through the control command", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-auto-start-"));
    directories.push(directory);
    const registrar = createUnsupportedAutoStartRegistrar();
    const enabled: boolean[] = [];
    const host = await startControlPlane({
      endpoint: {
        address: `\\\\.\\pipe\\luckytoken-auto-start-${process.pid}`,
        capability: "auto-start-capability-012345678901234567890123",
      },
      application: { id: "luckytoken", version: "cli-test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      applicationCommandHandler: async (command) => {
        if (command.command !== "auto_start") return { outcome: "attached" };
        const execution = await executeAutoStart(
          {
            async enable() {
              enabled.push(true);
              await registrar.enable();
            },
            async disable() {
              enabled.push(false);
              await registrar.disable();
            },
            status: registrar.status,
          },
          command.action,
        );
        return {
          outcome: execution.outcome,
          ...(execution.error === undefined ? {} : { error: execution.error }),
          ...(execution.enabled === undefined
            ? {}
            : { autoStart: { enabled: execution.enabled } }),
        };
      },
      pipeServerFactory: createNodePipeTransport(),
      access: nodePipeFallbackAccess,
    });
    controlPlanes.push(host);
    const descriptorPath = join(directory, "control-plane.json");
    await writeFile(descriptorPath, JSON.stringify(host.endpoint), "utf8");

    const run = async (action: "status" | "enable" | "disable") => {
      const child = startCli([
        "control",
        "auto-start",
        action,
        "--descriptor",
        descriptorPath,
      ]);
      children.push(child);
      return captureChild(child).result;
    };

    const status = await run("status");
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      command: "auto_start",
      outcome: "ok",
      autoStart: { enabled: false },
    });

    const enable = await run("enable");
    expect(enable.code).toBe(0);
    expect(JSON.parse(enable.stdout)).toMatchObject({
      command: "auto_start",
      outcome: "unsupported",
    });

    const disable = await run("disable");
    expect(disable.code).toBe(0);
    expect(JSON.parse(disable.stdout)).toMatchObject({
      command: "auto_start",
      outcome: "unsupported",
    });
    expect(enabled).toEqual([true, false]);
    expect(`${status.stdout}\n${status.stderr}`).not.toContain(
      "auto-start-capability",
    );
  }, 30_000);

  it("reads the effective Windows login auto-start status from the real serve", async () => {
    const { configPath, descriptorPath } = await writeServeState();
    const serve = startCli(["--config", configPath]);
    children.push(serve);
    const serving = captureChild(serve);
    await waitForDescriptor(descriptorPath);

    const status = startCli([
      "control",
      "auto-start",
      "status",
      "--descriptor",
      descriptorPath,
    ]);
    children.push(status);
    const result = await captureChild(status).result;

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      readonly command: string;
      readonly outcome: string;
      readonly autoStart: { readonly enabled: boolean };
    };
    expect(parsed.command).toBe("auto_start");
    expect(parsed.outcome).toBe("ok");
    expect(typeof parsed.autoStart.enabled).toBe("boolean");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("control-plane");

    // Windows cannot deliver SIGTERM to another process; end the owner
    // through the acknowledged application quit like an attached client.
    const client = await connectToServe(descriptorPath, "auto-start-quit");
    await client.hello(3);
    await client.executeApplicationCommand({
      command: "quit",
      acknowledged: true,
    });
    await client.close();
    await expect
      .poll(() => serve.exitCode, { timeout: 10_000, interval: 50 })
      .not.toBeNull();
    const exit = await serving.result;
    expect(exit.code).toBe(0);
  }, 30_000);

  it("reports desktop ownership when serve starts as the desktop-owned backend", async () => {
    const { configPath, descriptorPath } = await writeServeState();
    const serve = startCli([
      "--config",
      configPath,
      "--owner",
      "desktop",
    ]);
    children.push(serve);
    const serving = captureChild(serve);
    await waitForDescriptor(descriptorPath, serve);

    const client = await connectToServe(descriptorPath, "desktop-owner");
    await client.hello(3);
    await waitForRunning(client);
    await expect(client.getStatus()).resolves.toMatchObject({
      modelDataPlane: "running",
      ownership: { owner: { kind: "desktop" } },
    });

    const result = await client.executeApplicationCommand({
      command: "quit",
      acknowledged: true,
    });
    expect(result).toMatchObject({ command: "quit", outcome: "drained" });
    await client.close();

    await expect
      .poll(() => serve.exitCode, { timeout: 10_000, interval: 50 })
      .not.toBeNull();
    const exit = await serving.result;
    expect(exit.code).toBe(0);
    await expect(readFile(descriptorPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 30_000);

  it("reads the configured quit drain timeout from registered settings", async () => {
    const registry = createSettingsRegistry({
      async load() {
        return { "application.quitDrainTimeoutMs": 12345 };
      },
      async save() {},
    });
    await registry.load();
    const setting = registry.query(["application.quitDrainTimeoutMs"])[
      "application.quitDrainTimeoutMs"
    ];
    expect(setting).toMatchObject({
      key: "application.quitDrainTimeoutMs",
      type: "number",
      default: 5000,
      value: 12345,
      applyMode: "hot-apply",
    });
  });

  it("creates the first-run config when the desktop launcher asks, and never overwrites an existing one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-first-run-cli-"));
    directories.push(directory);
    const stateDirectory = join(directory, ".luckytoken");
    await mkdir(join(stateDirectory, "pi"), { recursive: true });
    const configPath = join(stateDirectory, "config.json");
    const descriptorPath = join(stateDirectory, "control-plane.json");

    const serve = startCli([
      "--config",
      configPath,
      "--owner",
      "desktop",
      "--desktop-exe",
      "C:\\Program Files\\LuckyToken\\LuckyToken.exe",
      "--create-first-run-config",
    ]);
    children.push(serve);
    const serving = captureChild(serve);
    await waitForDescriptor(descriptorPath, serve);

    const client = await connectToServe(descriptorPath, "first-run");
    await client.hello(3);
    await waitForStartSettled(client);
    const firstStatus = await client.getStatus();
    expect(firstStatus).toMatchObject({
      ownership: { owner: { kind: "desktop" } },
    });
    if (firstStatus.modelDataPlane === "failed") {
      expect(firstStatus.dataPlane?.failure?.code).toBe("port_in_use");
    } else {
      expect(firstStatus.modelDataPlane).toBe("running");
    }

    // The first-run template must be an actual valid config. A busy default
    // port may prevent this test process from binding, but only that bounded
    // runtime conflict is accepted here.
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
      readonly schemaVersion?: unknown;
    };
    expect(parsed.schemaVersion).toBe("luckytoken-config-v2");

    const result = await client.executeApplicationCommand({
      command: "quit",
      acknowledged: true,
    });
    expect(result).toMatchObject({ command: "quit", outcome: "drained" });
    await expect
      .poll(() => serve.exitCode, { timeout: 10_000, interval: 50 })
      .not.toBeNull();
    const exit = await serving.result;
    expect(exit.code).toBe(0);

    // A second launch with the same flag leaves the user's file untouched.
    const original = await readFile(configPath, "utf8");
    const second = startCli([
      "--config",
      configPath,
      "--owner",
      "desktop",
      "--desktop-exe",
      "C:\\Program Files\\LuckyToken\\LuckyToken.exe",
      "--create-first-run-config",
    ]);
    children.push(second);
    const secondCapture = captureChild(second);
    await waitForDescriptor(descriptorPath, second);
    const secondClient = await connectToServe(descriptorPath, "first-run-2");
    await secondClient.hello(3);
    const quitResult = await secondClient.executeApplicationCommand({
      command: "quit",
      acknowledged: true,
    });
    expect(quitResult).toMatchObject({ command: "quit", outcome: "drained" });
    await expect
      .poll(() => second.exitCode, { timeout: 10_000, interval: 50 })
      .not.toBeNull();
    await secondCapture.result;
    expect(await readFile(configPath, "utf8")).toBe(original);
  }, 45_000);
});
