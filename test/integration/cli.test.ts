import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:net";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";

import { afterEach, describe, expect, it } from "vitest";

import {
  createNodePipeTransport,
  nodePipeFallbackAccess,
  startControlPlane,
  type RunningControlPlane,
} from "@luckytoken/application-control-plane/control-plane";

import { createDataPlaneRuntimeSupervisor } from "../../src/runtime-supervisor.js";
import { createSettingsRegistry } from "../../src/settings/catalog.js";
import { createSettingsControlPlaneHandler } from "../../src/settings/control-plane.js";
import { createModelsJsonAuthority } from "../../src/models-config/authority.js";
import { createModelsControlPlaneHandler } from "../../src/models-config/control-plane.js";
import { composeEffectiveCatalog } from "../../src/providers/effective-composition.js";

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
  extraEnv: Record<string, string> = {},
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
      ...extraEnv,
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

describe("LuckyToken CLI", () => {
  const directories: string[] = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  const controlPlanes: RunningControlPlane[] = [];
  const tcpServers: Server[] = [];
  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null) child.kill("SIGTERM");
    }
    await Promise.all(
      controlPlanes.splice(0).map((controlPlane) => controlPlane.close()),
    );
    await Promise.all(
      tcpServers
        .splice(0)
        .map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
    );
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("documents serve, Profile management, and the single config authority", async () => {
    const child = startCli(["--help"]);
    children.push(child);
    const result = await captureChild(child).result;

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("LuckyToken");
    expect(result.stdout).toContain("--config <path>");
    expect(result.stdout).toContain("control profiles");
    expect(result.stdout).toContain("add|reconnect");
    expect(result.stdout).not.toContain("control credentials");
    expect(result.stdout).not.toContain("client-token");
    expect(result.stdout).toContain("control history");
    expect(result.stdout).toContain("Control-command discovery descriptor");
    expect(result.stderr).not.toContain("Error");
  }, 30_000);

  it.each(["login", "logout"])(
    "rejects retired top-level %s in favor of the running Backend Control Plane",
    async (command) => {
      const child = startCli([
        command,
        "fixture-provider",
        "--config",
        "unused-config.json",
      ]);
      children.push(child);
      const result = await captureChild(child).result;

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`Unknown command: ${command}`);
    },
    30_000,
  );

  it("rejects a serve descriptor override so singleton and discovery stay in one current-user domain", async () => {
    const child = startCli([
      "--config",
      "unused-config.json",
      "--descriptor",
      "other-control-plane.json",
    ]);
    children.push(child);
    const result = await captureChild(child).result;

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unknown option: --descriptor");
  }, 30_000);

  it("reads the discovery descriptor and prints status without its capability", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-control-cli-"));
    directories.push(directory);
    const capability = "cli-capability-secret-012345678901234567890123";
    const transport = createNodePipeTransport();
    const controlPlane = await startControlPlane({
      endpoint: {
        address: `\\\\.\\pipe\\luckytoken-cli-${process.pid}`,
        capability,
      },
      application: { id: "luckytoken", version: "cli-test" },
      initialStatus: {
        modelDataPlane: "running",
        provider: "configured",
      },
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
    });
    controlPlanes.push(controlPlane);
    const descriptorPath = join(directory, "control-plane.json");
    await writeFile(
      descriptorPath,
      JSON.stringify(controlPlane.endpoint),
      "utf8",
    );

    const child = startCli([
      "control",
      "status",
      "--descriptor",
      descriptorPath,
    ]);
    children.push(child);
    const result = await captureChild(child).result;

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      sequence: 0,
      modelDataPlane: "running",
      provider: "configured",
    });
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(capability);
  }, 30_000);

  it("queries permanent history through the active Control Plane", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-history-cli-"));
    directories.push(directory);
    const capability = "cli-history-capability-secret-0123456789012345";
    const controlPlane = await startControlPlane({
      endpoint: {
        address: `\\\\.\\pipe\\luckytoken-cli-history-${process.pid}`,
        capability,
      },
      application: { id: "luckytoken", version: "cli-test" },
      initialStatus: { modelDataPlane: "stopped", provider: "configured" },
      historyCommandHandler: async (command) => {
        if (command.command !== "query") {
          throw new Error("unexpected history command");
        }
        return {
          kind: "query",
          result: {
            range: command.range ?? "all",
            counts: { requestLedger: 7, diagnostics: 5, capture: 2 },
          },
        };
      },
      pipeServerFactory: createNodePipeTransport(),
      access: nodePipeFallbackAccess,
    });
    controlPlanes.push(controlPlane);
    const descriptorPath = join(directory, "control-plane.json");
    await writeFile(descriptorPath, JSON.stringify(controlPlane.endpoint), "utf8");
    const child = startCli([
      "control",
      "history",
      "query",
      "--descriptor",
      descriptorPath,
    ]);
    children.push(child);

    const result = await captureChild(child).result;

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      range: "all",
      counts: { requestLedger: 7, diagnostics: 5, capture: 2 },
    });
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(capability);
  }, 30_000);

  it("creates an ordinary backup through the active Control Plane", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-backup-cli-"));
    directories.push(directory);
    const capability = "cli-backup-capability-secret-0123456789012345";
    const destinationPath = join(directory, "backup.json");
    const controlPlane = await startControlPlane({
      endpoint: {
        address: `\\\\.\\pipe\\luckytoken-cli-backup-${process.pid}`,
        capability,
      },
      application: { id: "luckytoken", version: "cli-test" },
      initialStatus: { modelDataPlane: "stopped", provider: "configured" },
      backupCommandHandler: async (command) => {
        expect(command).toEqual({
          command: "create",
          mode: "ordinary",
          destinationPath,
          overwrite: false,
        });
        return {
          outcome: "ok",
          destinationPath,
          manifest: {
            format: "luckytoken-backup",
            formatVersion: 1,
            createdAt: 1,
            sensitive: false,
            entries: [
              {
                id: "config",
                contract: "luckytoken-config",
                version: "luckytoken-config-v1",
                sensitive: false,
              },
            ],
          },
        };
      },
      pipeServerFactory: createNodePipeTransport(),
      access: nodePipeFallbackAccess,
    });
    controlPlanes.push(controlPlane);
    const descriptorPath = join(directory, "control-plane.json");
    await writeFile(descriptorPath, JSON.stringify(controlPlane.endpoint), "utf8");
    const child = startCli([
      "control",
      "backup",
      "ordinary",
      destinationPath,
      "--descriptor",
      descriptorPath,
    ]);
    children.push(child);

    const result = await captureChild(child).result;

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: "ok",
      destinationPath,
      manifest: { sensitive: false },
    });
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(capability);
  }, 30_000);

  it("issues runtime lifecycle commands through the active Control Plane", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "luckytoken-control-command-"),
    );
    directories.push(directory);
    const transport = createNodePipeTransport();
    const supervisor = createDataPlaneRuntimeSupervisor({
      host: "127.0.0.1",
      port: 48766,
      readProvider: () => "unconfigured",
      startListener: async () => ({ close: async () => undefined }),
    });
    const controlPlane = await startControlPlane({
      endpoint: {
        address: `\\\\.\\pipe\\luckytoken-cli-command-${process.pid}`,
        capability: "cli-command-capability-012345678901234567890",
      },
      application: { id: "luckytoken", version: "cli-test" },
      initialStatus: supervisor.initialStatus,
      runtimeCommandHandler: supervisor.execute,
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
    });
    controlPlanes.push(controlPlane);
    const descriptorPath = join(directory, "control-plane.json");
    await writeFile(
      descriptorPath,
      JSON.stringify(controlPlane.endpoint),
      "utf8",
    );

    const start = startCli([
      "control",
      "start",
      "--descriptor",
      descriptorPath,
    ]);
    children.push(start);
    const result = await captureChild(start).result;

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "start",
      outcome: "completed",
      snapshot: { modelDataPlane: "running" },
    });

    const runCommand = async (command: "restart" | "stop") => {
      const child = startCli([
        "control",
        command,
        "--descriptor",
        descriptorPath,
      ]);
      children.push(child);
      return captureChild(child).result;
    };
    const restarted = await runCommand("restart");
    const stopped = await runCommand("stop");
    const repeatedStop = await runCommand("stop");
    expect(JSON.parse(restarted.stdout)).toMatchObject({
      command: "restart",
      outcome: "completed",
      snapshot: { modelDataPlane: "running" },
    });
    expect(JSON.parse(stopped.stdout)).toMatchObject({
      command: "stop",
      outcome: "completed",
      snapshot: { modelDataPlane: "stopped" },
    });
    expect(JSON.parse(repeatedStop.stdout)).toMatchObject({
      command: "stop",
      outcome: "unchanged",
      snapshot: { modelDataPlane: "stopped" },
    });
  }, 30_000);

  it("queries and sets registered settings through the same Control Plane commands", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "luckytoken-control-settings-"),
    );
    directories.push(directory);
    const transport = createNodePipeTransport();
    const registry = createSettingsRegistry({
      async load() {
        return {};
      },
      async save() {},
    });
    const controlPlane = await startControlPlane({
      endpoint: {
        address: `\\\\.\\pipe\\luckytoken-cli-settings-${process.pid}`,
        capability: "cli-settings-capability-0123456789012345678",
      },
      application: { id: "luckytoken", version: "cli-test" },
      initialStatus: {
        modelDataPlane: "stopped",
        provider: "unconfigured",
      },
      settingsCommandHandler: createSettingsControlPlaneHandler(registry),
      settingsProjection: () => registry.snapshot(),
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
    });
    controlPlanes.push(controlPlane);
    const descriptorPath = join(directory, "control-plane.json");
    await writeFile(
      descriptorPath,
      JSON.stringify(controlPlane.endpoint),
      "utf8",
    );

    const query = startCli([
      "control",
      "settings",
      "query",
      "--descriptor",
      descriptorPath,
    ]);
    children.push(query);
    const queryResult = await captureChild(query).result;
    expect(queryResult.code).toBe(0);
    expect(JSON.parse(queryResult.stdout)).toMatchObject({
      outcome: "ok",
      settings: {
        "protocols.anthropic-messages.enabled": { value: true },
      },
    });
    expect(queryResult.stdout).not.toContain("cli-settings-capability");

    const setResult = startCli([
      "control",
      "settings",
      "set",
      "protocols.openai-responses.enabled",
      "false",
      "--descriptor",
      descriptorPath,
    ]);
    children.push(setResult);
    const setOutcome = await captureChild(setResult).result;
    expect(setOutcome.code).toBe(0);
    expect(JSON.parse(setOutcome.stdout)).toMatchObject({ outcome: "applied" });
  }, 30_000);

  it("queries and writes the models.json catalog through the same Control Plane commands", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "luckytoken-control-models-"),
    );
    directories.push(directory);
    const modelsJsonPath = join(directory, "models.json");
    const original = JSON.stringify(
      {
        providers: {
          ollama: {
            baseUrl: "http://localhost:11434/v1",
            api: "openai-completions",
            apiKey: "ollama",
            models: [{ id: "llama3.1:8b" }],
          },
        },
      },
      null,
      2,
    );
    await writeFile(modelsJsonPath, original, "utf8");
    const authority = createModelsJsonAuthority({
      path: modelsJsonPath,
      compose: (providers) => composeEffectiveCatalog(providers),
    });
    const transport = createNodePipeTransport();
    const controlPlane = await startControlPlane({
      endpoint: {
        address: `\\\\.\\\pipe\\\luckytoken-cli-models-${process.pid}`,
        capability: "cli-models-capability-0123456789012345678",
      },
      application: { id: "luckytoken", version: "cli-test" },
      initialStatus: {
        modelDataPlane: "stopped",
        provider: "configured",
      },
      modelsCommandHandler: createModelsControlPlaneHandler(authority),
      modelsProjection: () => authority.snapshot(),
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
    });
    controlPlanes.push(controlPlane);
    const descriptorPath = join(directory, "control-plane.json");
    await writeFile(
      descriptorPath,
      JSON.stringify(controlPlane.endpoint),
      "utf8",
    );

    const query = startCli([
      "control",
      "models",
      "query",
      "--descriptor",
      descriptorPath,
    ]);
    children.push(query);
    const queryResult = await captureChild(query).result;
    expect(queryResult.code).toBe(0);
    expect(JSON.parse(queryResult.stdout)).toMatchObject({
      outcome: "ok",
      state: {
        revision: 0,
        path: modelsJsonPath,
        present: true,
        valid: true,
        raw: original,
      },
    });
    expect(queryResult.stdout).not.toContain("cli-models-capability");

    // A raw write through the CLI applies atomically on the same revision.
    const next =
      '{\n  "providers": {\n    "ollama": {\n      "baseUrl": "http://localhost:11434/v1",\n      "api": "openai-completions",\n      "models": [\n        { "id": "llama3.1:8b", "name": "Llama 3.1 8B (Local)" }\n      ]\n    }\n  }\n}\n';
    const contentFile = join(directory, "next-models.json");
    await writeFile(contentFile, next, "utf8");
    const applied = startCli([
      "control",
      "models",
      "write-raw",
      "0",
      contentFile,
      "--descriptor",
      descriptorPath,
    ]);
    children.push(applied);
    const appliedResult = await captureChild(applied).result;
    expect(appliedResult.code).toBe(0);
    expect(JSON.parse(appliedResult.stdout)).toMatchObject({
      outcome: "ok",
      state: { revision: 1, valid: true, raw: next },
    });
    await expect(readFile(modelsJsonPath, "utf8")).resolves.toBe(next);

    // A second CLI process with a stale revision gets an explicit conflict.
    const staleFile = join(directory, "stale-models.json");
    await writeFile(
      staleFile,
      '{ "providers": { "other": { "baseUrl": "http://x", "api": "openai-completions", "models": [{ "id": "m" }] } } }',
      "utf8",
    );
    const stale = startCli([
      "control",
      "models",
      "write-raw",
      "0",
      staleFile,
      "--descriptor",
      descriptorPath,
    ]);
    children.push(stale);
    const staleResult = await captureChild(stale).result;
    expect(staleResult.code).toBe(0);
    expect(JSON.parse(staleResult.stdout)).toMatchObject({
      outcome: "conflict",
      state: { revision: 1 },
    });
    await expect(readFile(modelsJsonPath, "utf8")).resolves.toBe(next);

    // A structured write shares the same revision stream with the raw one.
    const providersFile = join(directory, "providers.json");
    await writeFile(
      providersFile,
      JSON.stringify({
        ollama: {
          baseUrl: "http://localhost:11434/v1",
          api: "openai-completions",
          models: [{ id: "llama3.1:8b" }],
        },
      }),
      "utf8",
    );
    const structured = startCli([
      "control",
      "models",
      "write-structured",
      "1",
      providersFile,
      "--descriptor",
      descriptorPath,
    ]);
    children.push(structured);
    const structuredResult = await captureChild(structured).result;
    expect(structuredResult.code).toBe(0);
    expect(JSON.parse(structuredResult.stdout)).toMatchObject({
      outcome: "ok",
      state: { revision: 2, valid: true },
    });
    await expect(readFile(modelsJsonPath, "utf8")).resolves.toContain(
      '"ollama"',
    );
  }, 60_000);

  it("does not echo descriptor contents when discovery is malformed", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "luckytoken-control-invalid-"),
    );
    directories.push(directory);
    const descriptorPath = join(directory, "control-plane.json");
    const secret = "descriptor-capability-secret-01234567890123456789";
    await writeFile(descriptorPath, secret, "utf8");

    const child = startCli([
      "control",
      "status",
      "--descriptor",
      descriptorPath,
    ]);
    children.push(child);
    const result = await captureChild(child).result;

    expect(result.code).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(secret);
    expect(result.stderr).toContain("Control Plane descriptor");
  }, 30_000);

  it("keeps a recovery-only Control Plane open for an incompatible owned config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-recovery-cli-"));
    directories.push(directory);
    const stateDirectory = join(directory, ".luckytoken");
    await mkdir(stateDirectory, { recursive: true });
    const configPath = join(stateDirectory, "config.json");
    const original = JSON.stringify({
      schemaVersion: "luckytoken-config-v99",
      credentialCanary: "recovery-config-secret-canary",
    });
    await writeFile(configPath, original, "utf8");
    const descriptorPath = join(stateDirectory, "control-plane.json");
    const serve = startCli(["--config", configPath], true);
    children.push(serve);
    const serving = captureChild(serve);

    await expect
      .poll(
        async () => {
          try {
            const parsed = JSON.parse(await readFile(descriptorPath, "utf8")) as {
              address?: unknown;
              capability?: unknown;
            };
            return typeof parsed.address === "string" && typeof parsed.capability === "string";
          } catch {
            return false;
          }
        },
        { timeout: 10_000, interval: 50 },
      )
      .toBe(true);

    const status = startCli(["control", "status", "--descriptor", descriptorPath]);
    children.push(status);
    const statusResult = await captureChild(status).result;
    expect(statusResult.code).toBe(0);
    expect(JSON.parse(statusResult.stdout)).toMatchObject({
      modelDataPlane: "stopped",
      provider: "unconfigured",
      recovery: {
        mode: "incompatible_configuration",
        issues: [
          {
            path: configPath,
            contract: "luckytoken-config",
            foundVersion: "luckytoken-config-v99",
            expectedVersion: "luckytoken-config-v1",
          },
        ],
      },
    });
    expect(await readFile(configPath, "utf8")).toBe(original);
    expect(`${statusResult.stdout}\n${statusResult.stderr}`).not.toContain(
      "recovery-config-secret-canary",
    );

    serve.stdin.end("stop\n");
    const serveResult = await serving.result;
    expect(serveResult.code).toBe(0);
    expect(await readFile(configPath, "utf8")).toBe(original);
  }, 30_000);

  it("keeps ordinary backup available when an obsolete client-auth file is present", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-recovery-backup-"));
    directories.push(directory);
    const stateDirectory = join(directory, ".luckytoken");
    await mkdir(join(stateDirectory, "pi"), { recursive: true });
    const authPath = join(stateDirectory, "client-auth", "anthropic-messages.json");
    await mkdir(join(stateDirectory, "client-auth"), { recursive: true });
    await writeFile(
      authPath,
      JSON.stringify({
        schemaVersion: "luckytoken-client-auth-v1",
        global: "incompatible-token-secret-canary",
        projects: {},
      }),
      "utf8",
    );
    const configPath = join(stateDirectory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "luckytoken-config-v1",
        server: { port: 0 },
        clientProtocols: {
          "anthropic-messages": {},
        },
        pi: { directory: "pi" },
      }),
      "utf8",
    );
    const descriptorPath = join(stateDirectory, "control-plane.json");
    const destinationPath = join(directory, "ordinary-recovery-backup.json");
    const serve = startCli(["--config", configPath], true);
    children.push(serve);
    const serving = captureChild(serve);
    await expect
      .poll(
        async () => {
          try {
            return typeof JSON.parse(await readFile(descriptorPath, "utf8")).address === "string";
          } catch {
            return false;
          }
        },
        { timeout: 10_000, interval: 50 },
      )
      .toBe(true);

    const backup = startCli([
      "control",
      "backup",
      "ordinary",
      destinationPath,
      "--descriptor",
      descriptorPath,
    ]);
    children.push(backup);
    const backupResult = await captureChild(backup).result;
    expect(backupResult.code).toBe(0);
    expect(JSON.parse(backupResult.stdout)).toMatchObject({
      outcome: "ok",
      manifest: { sensitive: false },
    });
    const artifact = await readFile(destinationPath, "utf8");
    expect(artifact).toContain("luckytoken-config-v1");
    expect(artifact).not.toContain("incompatible-token-secret-canary");

    serve.stdin.end("stop\n");
    expect((await serving.result).code).toBe(0);
  }, 30_000);

  it.each([
    {
      label: "no user Provider",
      providerPackages: undefined,
      expectedProvider: "unconfigured" as const,
    },
  ])(
    "atomically owns discovery and reports $label as $expectedProvider",
    async ({ providerPackages, expectedProvider }) => {
      const directory = await mkdtemp(
        join(tmpdir(), "luckytoken-control-owned-"),
      );
      directories.push(directory);
      const stateDirectory = join(directory, ".luckytoken");
      const piDirectory = join(stateDirectory, "pi");
      await mkdir(piDirectory, { recursive: true });
      const configPath = join(stateDirectory, "config.json");
      await writeFile(
        configPath,
        JSON.stringify({
          schemaVersion: "luckytoken-config-v1",
          server: { port: await reserveFreePort() },
          clientProtocols: {
            "anthropic-messages": {},
            "openai-responses": {},
          },
          ...(providerPackages === undefined ? {} : { providerPackages }),
          pi: { directory: "pi" },
        }),
        "utf8",
      );
      const descriptorPath = join(stateDirectory, "control-plane.json");
      await writeFile(descriptorPath, "stale-descriptor", "utf8");
      const serve = startCli(["--config", configPath], true);
      children.push(serve);
      const serveCapture = captureChild(serve);

      await expect
        .poll(
          async () => {
            try {
              const parsed = JSON.parse(
                await readFile(descriptorPath, "utf8"),
              ) as {
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
          },
          { timeout: 10_000, interval: 50 },
        )
        .toBe(true);
      const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as {
        readonly capability: string;
      };
      const status = startCli([
        "control",
        "status",
        "--descriptor",
        descriptorPath,
      ]);
      children.push(status);
      const statusResult = await captureChild(status).result;
      expect(statusResult.code).toBe(0);
      expect(JSON.parse(statusResult.stdout)).toMatchObject({
        modelDataPlane: "running",
        provider: expectedProvider,
      });
      expect(`${statusResult.stdout}\n${statusResult.stderr}`).not.toContain(
        descriptor.capability,
      );
      expect(serveCapture.stdout()).toContain("POST http://127.0.0.1:");
      expect(serveCapture.stdout()).toContain("/v1/messages");
      expect(serveCapture.stdout()).toContain("/v1/responses");

      serve.stdin.end("stop\n");
      const serveResult = await Promise.race([
        serveCapture.result,
        new Promise<ChildResult>((resolve) =>
          setTimeout(
            () =>
              resolve({
                code: null,
                stdout: serveCapture.stdout(),
                stderr: serveCapture.stderr(),
              }),
            5_000,
          ),
        ),
      ]);
      if (serveResult.code === null) {
        throw new Error(
          `serve shutdown hung\nstdout:\n${serveResult.stdout}\nstderr:\n${serveResult.stderr}`,
        );
      }
      expect(serveResult.code).toBe(0);
      expect(`${serveResult.stdout}\n${serveResult.stderr}`).not.toContain(
        descriptor.capability,
      );
      await expect(readFile(descriptorPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(
        (await readdir(stateDirectory)).filter((name) =>
          name.startsWith("control-plane.json."),
        ),
      ).toEqual([]);
    },
    30_000,
  );

  it("rejects explicit configuration of the bundled CommandCode Provider Package", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "luckytoken-control-bundled-reject-"),
    );
    directories.push(directory);
    const stateDirectory = join(directory, ".luckytoken");
    const piDirectory = join(stateDirectory, "pi");
    await mkdir(piDirectory, { recursive: true });
    const configPath = join(stateDirectory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "luckytoken-config-v1",
        server: { port: await reserveFreePort() },
        clientProtocols: {
          "anthropic-messages": {},
        },
        providerPackages: {
          "@luckytoken/provider-commandcode-private": {},
        },
        pi: { directory: "pi" },
      }),
      "utf8",
    );
    const serve = startCli(["--config", configPath], true);
    children.push(serve);
    const serveCapture = captureChild(serve);
    // The bundled package is a reserved product identity: explicit user
    // configuration is rejected under the current contract instead of
    // being silently ignored or migrated.
    const serveResult = await Promise.race([
      serveCapture.result,
      new Promise<ChildResult>((resolve) =>
        setTimeout(
          () =>
            resolve({
              code: null,
              stdout: serveCapture.stdout(),
              stderr: serveCapture.stderr(),
            }),
          5_000,
        ),
      ),
    ]);
    if (serveResult.code === 0) {
      throw new Error(
        `serve unexpectedly succeeded\nstdout:\n${serveResult.stdout}\nstderr:\n${serveResult.stderr}`,
      );
    }
    expect(`${serveResult.stdout}\n${serveResult.stderr}`).toContain(
      "bundled product Provider",
    );
  });

  it("keeps the Control Plane available when the fixed Data Plane port is occupied", async () => {
    const blocker = createServer();
    tcpServers.push(blocker);
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", resolve);
    });
    const address = blocker.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected a TCP test address");
    }
    const directory = await mkdtemp(
      join(tmpdir(), "luckytoken-control-failure-"),
    );
    directories.push(directory);
    const stateDirectory = join(directory, ".luckytoken");
    await mkdir(join(stateDirectory, "pi"), { recursive: true });
    const configPath = join(stateDirectory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "luckytoken-config-v1",
        server: { port: address.port },
        clientProtocols: {
          "anthropic-messages": {},
        },
        pi: { directory: "pi" },
      }),
      "utf8",
    );
    const descriptorPath = join(stateDirectory, "control-plane.json");
    await writeFile(descriptorPath, "stale-descriptor", "utf8");

    const child = startCli(["--config", configPath], true);
    children.push(child);
    const serving = captureChild(child);
    await expect
      .poll(
        async () => {
          try {
            const parsed = JSON.parse(
              await readFile(descriptorPath, "utf8"),
            ) as {
              readonly address?: unknown;
            };
            return typeof parsed.address === "string";
          } catch {
            return false;
          }
        },
        { timeout: 10_000, interval: 50 },
      )
      .toBe(true);

    const status = startCli([
      "control",
      "status",
      "--descriptor",
      descriptorPath,
    ]);
    children.push(status);
    const statusResult = await captureChild(status).result;

    expect(statusResult.code).toBe(0);
    expect(JSON.parse(statusResult.stdout)).toMatchObject({
      modelDataPlane: "failed",
      dataPlane: {
        configuredPort: address.port,
        failure: {
          code: "port_in_use",
          message:
            "The configured port is already in use. Stop the other application or choose a different port.",
        },
      },
    });
    expect(child.exitCode).toBeNull();

    child.stdin.end("stop\n");
    const result = await serving.result;
    expect(result.code).toBe(0);
    await expect(readFile(descriptorPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (await readdir(stateDirectory)).filter((name) =>
        name.startsWith("control-plane.json."),
      ),
    ).toEqual([]);
  }, 30_000);

  it("treats the removed client-token subcommand as an unknown command", async () => {
    const child = startCli(["client-token", "list", "anthropic-messages"]);
    children.push(child);
    const result = await captureChild(child).result;
    expect(result.code).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("Created global token");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("Rotated the global client token");
  }, 30_000);

});

describe("LuckyToken CLI removed directory-token scopes", () => {
  it("does not expose project-token management through the removed client-token command", async () => {
    const child = startCli(["client-token", "create", "anthropic-messages", "--project", "."]);
    const result = await captureChild(child).result;
    expect(result.code).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("Created project");
  }, 30_000);

});
