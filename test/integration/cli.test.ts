import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:net";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createRequire } from "node:module";

import { afterEach, describe, expect, it } from "vitest";

import lockfile from "proper-lockfile";

import {
  createNodePipeTransport,
  nodePipeFallbackAccess,
  startControlPlane,
  type RunningControlPlane,
} from "@luckytoken/application-control-plane/control-plane";

import { createFileCredentialStore } from "../../src/index.js";
import {
  createFileClientTokenStore,
  loadFileClientTokenAuthority,
} from "../../src/client-auth/file-token-store.js";
import { createClientTokenControlPlaneHandler } from "../../src/client-auth/control-plane.js";
import {
  createLiveClientTokenAuthority,
  type LiveClientTokenAuthority,
} from "../../src/client-auth/live-authority.js";
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
  return spawn(process.execPath, command, {
    cwd: process.cwd(),
    env: {
      ...process.env,
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
  let nextClientTokenPipe = 0;

  /** Starts a Control Plane serving the given live authorities and returns
   *  the discovery descriptor path the CLI connects through. */
  async function startClientTokenBackend(options: {
    readonly authorities: Readonly<Record<string, LiveClientTokenAuthority>>;
  }): Promise<string> {
    const directory = await mkdtemp(
      join(tmpdir(), "luckytoken-client-token-cp-"),
    );
    directories.push(directory);
    const endpoint = {
      address: `\\\\.\\pipe\\luckytoken-cli-token-${process.pid}-${++nextClientTokenPipe}`,
      capability: "cli-client-token-capability-01234567890123",
    };
    const controlPlane = await startControlPlane({
      endpoint,
      application: { id: "luckytoken", version: "cli-test" },
      initialStatus: { modelDataPlane: "running", provider: "configured" },
      clientTokenCommandHandler: createClientTokenControlPlaneHandler({
        authorities: () => options.authorities,
        protocolNames: {
          "anthropic-messages": "Anthropic Messages",
          "openai-responses": "OpenAI Responses",
        },
      }),
      pipeServerFactory: createNodePipeTransport(),
      access: nodePipeFallbackAccess,
    });
    controlPlanes.push(controlPlane);
    const descriptorPath = join(directory, "control-plane.json");
    await writeFile(descriptorPath, JSON.stringify(endpoint), "utf8");
    return descriptorPath;
  }

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

  it("documents serve, login, logout, and the single config authority", async () => {
    const child = startCli(["--help"]);
    children.push(child);
    const result = await captureChild(child).result;

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("LuckyToken");
    expect(result.stdout).toContain("--config <path>");
    expect(result.stdout).toContain("login");
    expect(result.stdout).toContain("logout");
    expect(result.stdout).toContain("client-token");
    expect(result.stdout).toContain("control history");
    expect(result.stderr).not.toContain("Error");
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
        "server.port": { value: 3000, effective: 3000 },
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
    const serve = startCli(
      ["--config", configPath, "--descriptor", descriptorPath],
      true,
    );
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

  it("keeps ordinary backup available when an unrelated owned store is incompatible", async () => {
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
        server: { host: "127.0.0.1", port: 0 },
        clientProtocols: {
          "anthropic-messages": {
            authFile: "client-auth/anthropic-messages.json",
          },
        },
        pi: { directory: "pi" },
      }),
      "utf8",
    );
    const descriptorPath = join(stateDirectory, "control-plane.json");
    const destinationPath = join(directory, "ordinary-recovery-backup.json");
    const serve = startCli(
      ["--config", configPath, "--descriptor", descriptorPath],
      true,
    );
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
      const authPath = join(
        stateDirectory,
        "client-auth",
        "anthropic-messages.json",
      );
      await createFileClientTokenStore({ path: authPath }).create(
        { type: "global" },
        "serve-test-token",
      );
      const responsesAuthPath = join(
        stateDirectory,
        "client-auth",
        "openai-responses.json",
      );
      await createFileClientTokenStore({ path: responsesAuthPath }).create(
        { type: "global" },
        "serve-responses-test-token",
      );
      const configPath = join(stateDirectory, "config.json");
      await writeFile(
        configPath,
        JSON.stringify({
          schemaVersion: "luckytoken-config-v1",
          server: { host: "127.0.0.1", port: await reserveFreePort() },
          clientProtocols: {
            "anthropic-messages": {
              authFile: "client-auth/anthropic-messages.json",
            },
            "openai-responses": {
              authFile: "client-auth/openai-responses.json",
            },
          },
          ...(providerPackages === undefined ? {} : { providerPackages }),
          pi: { directory: "pi" },
        }),
        "utf8",
      );
      const descriptorPath = join(stateDirectory, "control-plane.json");
      await writeFile(descriptorPath, "stale-descriptor", "utf8");
      const serve = startCli(
        ["--config", configPath, "--descriptor", descriptorPath],
        true,
      );
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
    const authPath = join(
      stateDirectory,
      "client-auth",
      "anthropic-messages.json",
    );
    await createFileClientTokenStore({ path: authPath }).create(
      { type: "global" },
      "serve-test-token",
    );
    const configPath = join(stateDirectory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "luckytoken-config-v1",
        server: { host: "127.0.0.1", port: await reserveFreePort() },
        clientProtocols: {
          "anthropic-messages": {
            authFile: "client-auth/anthropic-messages.json",
          },
        },
        providerPackages: {
          "@luckytoken/provider-commandcode-private": {},
        },
        pi: { directory: "pi" },
      }),
      "utf8",
    );
    const descriptorPath = join(stateDirectory, "control-plane.json");
    const serve = startCli(
      ["--config", configPath, "--descriptor", descriptorPath],
      true,
    );
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
    const authPath = join(
      stateDirectory,
      "client-auth",
      "anthropic-messages.json",
    );
    await createFileClientTokenStore({ path: authPath }).create(
      { type: "global" },
      "startup-failure-token",
    );
    const configPath = join(stateDirectory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "luckytoken-config-v1",
        server: { host: "127.0.0.1", port: address.port },
        clientProtocols: {
          "anthropic-messages": {
            authFile: "client-auth/anthropic-messages.json",
          },
        },
        pi: { directory: "pi" },
      }),
      "utf8",
    );
    const descriptorPath = join(stateDirectory, "control-plane.json");
    await writeFile(descriptorPath, "stale-descriptor", "utf8");

    const child = startCli(
      ["--config", configPath, "--descriptor", descriptorPath],
      true,
    );
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

  it("lists masked tokens and reveals the active global token through the running Control Plane", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-client-token-cli-"));
    directories.push(root);
    const authFile = join(root, "client-auth", "anthropic-messages.json");
    const store = createFileClientTokenStore({ path: authFile });
    const live = await createLiveClientTokenAuthority({
      store,
      generateToken: () => "canary-cli-global-token-1",
    });
    await live.ensureGlobal();
    const descriptorPath = await startClientTokenBackend({
      authorities: { "anthropic-messages": live },
    });

    const list = startCli([
      "client-token",
      "list",
      "anthropic-messages",
      "--descriptor",
      descriptorPath,
    ]);
    children.push(list);
    const listResult = await captureChild(list).result;
    expect(listResult.code).toBe(0);
    expect(listResult.stdout).toContain("global");
    expect(listResult.stdout).toContain("…");
    // The masked list never exposes the raw secret.
    expect(listResult.stdout).not.toContain("canary-cli-global-token-1");

    const reveal = startCli([
      "client-token",
      "reveal",
      "anthropic-messages",
      "--descriptor",
      descriptorPath,
    ]);
    children.push(reveal);
    const revealResult = await captureChild(reveal).result;
    expect(revealResult.code).toBe(0);
    expect(revealResult.stdout.trim()).toBe("canary-cli-global-token-1");
  }, 30_000);

  it("rotates and removes the live global token with a locked revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-client-token-cli-"));
    directories.push(root);
    const authFile = join(root, "client-auth", "anthropic-messages.json");
    const store = createFileClientTokenStore({ path: authFile });
    const live = await createLiveClientTokenAuthority({
      store,
      generateToken: () => "canary-cli-global-token-2",
    });
    await live.ensureGlobal();
    const descriptorPath = await startClientTokenBackend({
      authorities: { "anthropic-messages": live },
    });
    const run = async (args: readonly string[]) => {
      const child = startCli(["client-token", ...args]);
      children.push(child);
      return captureChild(child).result;
    };

    const rotated = await run([
      "rotate",
      "anthropic-messages",
      "--token",
      "canary-cli-rotated-token-3",
      "--descriptor",
      descriptorPath,
    ]);
    expect(rotated.code).toBe(0);
    expect(rotated.stdout).toContain("Rotated the global client token");
    expect(rotated.stdout).not.toContain("canary-cli-rotated-token-3");
    // Hot-applied: the authority rejects the prior token immediately.
    expect(live.authorize("canary-cli-global-token-2")).toBeUndefined();
    expect(live.authorize("canary-cli-rotated-token-3")).toEqual({});

    const removed = await run([
      "remove",
      "anthropic-messages",
      "--descriptor",
      descriptorPath,
    ]);
    expect(removed.code).toBe(0);
    expect(removed.stdout).toContain("Removed the global client token");
    expect(removed.stdout).toContain("return 401");
    expect(live.authorize("canary-cli-rotated-token-3")).toBeUndefined();

    const missing = await run([
      "remove",
      "anthropic-messages",
      "--descriptor",
      descriptorPath,
    ]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("does not exist");
  }, 30_000);

  it("creates and lists a global token offline without ever printing it in the list", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "luckytoken-client-token-offline-"),
    );
    directories.push(root);
    const stateDirectory = join(root, ".luckytoken");
    await mkdir(stateDirectory);
    const configPath = join(stateDirectory, "config.json");
    const authFile = join(
      stateDirectory,
      "client-auth",
      "anthropic-messages.json",
    );
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "luckytoken-config-v1",
        clientProtocols: {
          "anthropic-messages": {
            authFile: "client-auth/anthropic-messages.json",
          },
        },
        pi: { directory: "pi" },
      }),
      "utf8",
    );

    const create = startCli([
      "client-token",
      "create",
      "anthropic-messages",
      "--global",
      "--config",
      configPath,
    ]);
    children.push(create);
    const createResult = await captureChild(create).result;
    expect(createResult.code).toBe(0);
    const token = createResult.stdout.match(/\b(lt_[A-Za-z0-9_-]{43})\b/u)?.[1];
    expect(token).toBeDefined();
    expect(createResult.stdout).toContain("Created global token");
    expect(createResult.stdout).toContain("Restart LuckyToken");

    const list = startCli([
      "client-token",
      "list",
      "anthropic-messages",
      "--config",
      configPath,
    ]);
    children.push(list);
    const listResult = await captureChild(list).result;
    expect(listResult.code).toBe(0);
    expect(listResult.stdout).toContain("global");
    expect(listResult.stdout).not.toContain(token as string);
    const authority = await loadFileClientTokenAuthority(authFile);
    expect(authority.authorize(token as string)).toEqual({});
  }, 30_000);

  it("creates, rotates, and removes one project token offline", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "luckytoken-client-token-offline-"),
    );
    directories.push(root);
    const stateDirectory = join(root, ".luckytoken");
    const projectDir = join(root, "project");
    await mkdir(stateDirectory);
    await mkdir(projectDir);
    const configPath = join(stateDirectory, "config.json");
    const authFile = join(stateDirectory, "client-auth", "fixture.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "luckytoken-config-v1",
        clientProtocols: {
          "fixture-client": { authFile: "client-auth/fixture.json" },
        },
        pi: { directory: "pi" },
      }),
      "utf8",
    );
    const run = async (args: readonly string[]) => {
      const child = startCli(["client-token", ...args]);
      children.push(child);
      return captureChild(child).result;
    };

    const created = await run([
      "create",
      "fixture-client",
      "--project",
      projectDir,
      "--token",
      "manual-project-token",
      "--config",
      configPath,
    ]);
    expect(created.code).toBe(0);
    expect(created.stdout).toContain("Created project");
    expect(created.stdout).not.toContain("manual-project-token");
    const oldAuthority = await loadFileClientTokenAuthority(authFile);
    expect(oldAuthority.authorize("manual-project-token")).toEqual({
      projectDir,
    });

    const duplicate = await run([
      "create",
      "fixture-client",
      "--project",
      projectDir,
      "--token",
      "unexpected-overwrite",
      "--config",
      configPath,
    ]);
    expect(duplicate.code).toBe(1);
    expect(duplicate.stderr).toContain("already has a token");

    const rotated = await run([
      "rotate",
      "fixture-client",
      "--project",
      projectDir,
      "--token",
      "rotated-project-token",
      "--config",
      configPath,
    ]);
    expect(rotated.code).toBe(0);
    expect(rotated.stdout).toContain("Rotated project");
    expect(rotated.stdout).toContain("Restart LuckyToken");
    const newAuthority = await loadFileClientTokenAuthority(authFile);
    expect(oldAuthority.authorize("manual-project-token")).toEqual({
      projectDir,
    });
    expect(oldAuthority.authorize("rotated-project-token")).toBeUndefined();
    expect(newAuthority.authorize("manual-project-token")).toBeUndefined();
    expect(newAuthority.authorize("rotated-project-token")).toEqual({
      projectDir,
    });

    const removed = await run([
      "remove",
      "fixture-client",
      "--project",
      projectDir,
      "--config",
      configPath,
    ]);
    expect(removed.code).toBe(0);
    expect(removed.stdout).toContain("Removed project");
    await expect(loadFileClientTokenAuthority(authFile)).rejects.toThrow(
      "must contain at least one token",
    );
    expect(newAuthority.authorize("rotated-project-token")).toEqual({
      projectDir,
    });
  }, 30_000);

  it("requires exactly one of --descriptor or --config for client-token", async () => {
    const child = startCli(["client-token", "list", "anthropic-messages"]);
    children.push(child);
    const result = await captureChild(child).result;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--descriptor");
    expect(result.stderr).toContain("--config");
  }, 30_000);

  it("races two offline CLI mutations from the same revision without losing an update", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-client-token-race-"));
    directories.push(root);
    const stateDirectory = join(root, ".luckytoken");
    await mkdir(stateDirectory);
    const configPath = join(stateDirectory, "config.json");
    const authFile = join(
      stateDirectory,
      "client-auth",
      "anthropic-messages.json",
    );
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "luckytoken-config-v1",
        clientProtocols: {
          "anthropic-messages": {
            authFile: "client-auth/anthropic-messages.json",
          },
        },
        pi: { directory: "pi" },
      }),
      "utf8",
    );
    const seed = createFileClientTokenStore({ path: authFile });
    await seed.create({ type: "global" }, "canary-race-seed", 0);

    // Hold the filesystem lock so both CLI processes snapshot revision 1
    // (snapshots never block) and then wait on the mutation lock; releasing
    // makes exactly one mutation win and the other observe the stale
    // revision after lock acquisition.
    const release = await lockfile.lock(authFile, {
      realpath: false,
      stale: 30_000,
      retries: 0,
    });
    const first = startCli([
      "client-token",
      "rotate",
      "anthropic-messages",
      "--global",
      "--token",
      "canary-race-cli-a",
      "--config",
      configPath,
    ]);
    const second = startCli([
      "client-token",
      "rotate",
      "anthropic-messages",
      "--global",
      "--token",
      "canary-race-cli-b",
      "--config",
      configPath,
    ]);
    children.push(first, second);
    const firstCapture = captureChild(first);
    const secondCapture = captureChild(second);
    // Long enough for both processes to finish config load and snapshot, and
    // short enough to stay inside their lock retry budget.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(first.exitCode).toBeNull();
    expect(second.exitCode).toBeNull();
    await release();

    const [firstResult, secondResult] = await Promise.all([
      firstCapture.result,
      secondCapture.result,
    ]);
    // Both snapshots observed revision 1 while the lock was held, so exactly
    // one mutation wins and the other reports the stale conflict.
    expect([firstResult.code, secondResult.code].sort()).toEqual([0, 1]);
    const loser = firstResult.code === 1 ? firstResult : secondResult;
    expect(loser.stderr).toContain("stale");

    const persisted = JSON.parse(await readFile(authFile, "utf8")) as {
      readonly global: string;
      readonly revision: number;
    };
    expect(["canary-race-cli-a", "canary-race-cli-b"]).toContain(
      persisted.global,
    );
    expect(persisted.revision).toBe(2);
    // No lock or temporary artifacts remain next to the token file.
    expect(await readdir(join(stateDirectory, "client-auth"))).toEqual([
      "anthropic-messages.json",
    ]);
  }, 60_000);

  it("logs in and out through a configured Provider Package without leaking the key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-cli-e2e-"));
    directories.push(directory);
    const stateDirectory = join(directory, ".luckytoken");
    const piDirectory = join(stateDirectory, "pi");
    await mkdir(piDirectory, { recursive: true });
    const configPath = join(stateDirectory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "luckytoken-config-v1",
        server: { host: "127.0.0.1", port: 0 },
        clientProtocols: {
          "anthropic-messages": {
            authFile: "client-auth/anthropic-messages.json",
          },
        },
        providerPackages: {
          "@luckytoken/provider-commandcode-private": {},
        },
        pi: { directory: "pi" },
      }),
      "utf8",
    );

    const login = startCli([
      "login",
      "commandcode-private",
      "--config",
      configPath,
    ]);
    children.push(login);
    const loginCapture = captureChild(login);
    login.stdin.end("stored-provider-secret\n");
    const loginResult = await loginCapture.result;
    expect(loginResult.code).toBe(0);
    expect(loginResult.stdout).toContain("Authenticated CommandCode Private");
    expect(`${loginResult.stdout}\n${loginResult.stderr}`).not.toContain(
      "stored-provider-secret",
    );

    await expect(
      createFileCredentialStore(join(piDirectory, "auth.json")).read(
        "commandcode-private",
      ),
    ).resolves.toEqual({ type: "api_key", key: "stored-provider-secret" });

    const logout = startCli([
      "logout",
      "commandcode-private",
      "--config",
      configPath,
    ]);
    children.push(logout);
    const logoutCapture = captureChild(logout);
    const logoutResult = await logoutCapture.result;
    expect(logoutResult.code).toBe(0);
    // Ticket 12: logout reports the exact stored-credential removal message.
    expect(logoutResult.stdout).toContain(
      "Stored credential removed for CommandCode Private",
    );
    expect(`${logoutResult.stdout}\n${logoutResult.stderr}`).not.toContain(
      "stored-provider-secret",
    );
    await expect(
      createFileCredentialStore(join(piDirectory, "auth.json")).read(
        "commandcode-private",
      ),
    ).resolves.toBeUndefined();
  }, 30_000);
});

describe("LuckyToken CLI canonical directory scopes (Ticket 17)", () => {
  const directories: string[] = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  const controlPlanes: RunningControlPlane[] = [];
  let nextPipe = 0;

  afterEach(async () => {
    await Promise.all(children.splice(0).map((child) => child.kill()));
    await Promise.all(controlPlanes.splice(0).map((plane) => plane.close()));
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  async function startDirectoryBackend(options: {
    readonly authorities: Readonly<Record<string, LiveClientTokenAuthority>>;
  }): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-cli-dir-cp-"));
    directories.push(directory);
    const endpoint = {
      address: `\\\\.\\pipe\\luckytoken-cli-dir-token-${process.pid}-${++nextPipe}`,
      capability: "cli-dir-token-capability-012345678901234567",
    };
    const controlPlane = await startControlPlane({
      endpoint,
      application: { id: "luckytoken", version: "cli-test" },
      initialStatus: { modelDataPlane: "running", provider: "configured" },
      clientTokenCommandHandler: createClientTokenControlPlaneHandler({
        authorities: () => options.authorities,
        protocolNames: {
          "anthropic-messages": "Anthropic Messages",
        },
      }),
      pipeServerFactory: createNodePipeTransport(),
      access: nodePipeFallbackAccess,
    });
    controlPlanes.push(controlPlane);
    const descriptorPath = join(directory, "descriptor.json");
    await writeFile(descriptorPath, JSON.stringify(endpoint), "utf8");
    return descriptorPath;
  }

  it("creates, reveals, rotates, and removes one canonical directory scope through the live Control Plane", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-cli-dir-live-"));
    directories.push(root);
    const projectDir = join(root, "project");
    await mkdir(projectDir, { recursive: true });
    const link = join(root, "project-link");
    await symlink(projectDir, link, "junction").catch(() =>
      symlink(projectDir, link, "dir"),
    );
    const authFile = join(root, "client-auth", "anthropic-messages.json");
    const store = createFileClientTokenStore({ path: authFile });
    const live = await createLiveClientTokenAuthority({
      store,
      generateToken: () => "canary-cli-global-token-1",
    });
    await live.ensureGlobal();
    const descriptorPath = await startDirectoryBackend({
      authorities: { "anthropic-messages": live },
    });
    const run = async (args: readonly string[]) => {
      const child = startCli(["client-token", ...args]);
      children.push(child);
      return captureChild(child).result;
    };

    const created = await run([
      "create",
      "anthropic-messages",
      "--project",
      projectDir,
      "--token",
      "canary-cli-dir-token-1",
      "--descriptor",
      descriptorPath,
    ]);
    expect(created.code).toBe(0);
    expect(created.stdout).toContain("Created project");
    expect(created.stdout).not.toContain("canary-cli-dir-token-1");

    // The same scope through the junction alias already exists.
    const duplicate = await run([
      "create",
      "anthropic-messages",
      "--project",
      link,
      "--token",
      "canary-cli-dir-token-2",
      "--descriptor",
      descriptorPath,
    ]);
    expect(duplicate.code).toBe(1);
    expect(duplicate.stderr).toContain("already has a token");

    const list = await run([
      "list",
      "anthropic-messages",
      "--descriptor",
      descriptorPath,
    ]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(projectDir);
    expect(list.stdout).not.toContain("alias");
    expect(list.stdout).not.toContain("canary-cli-dir-token-1");

    const reveal = await run([
      "reveal",
      "anthropic-messages",
      "--project",
      link,
      "--descriptor",
      descriptorPath,
    ]);
    expect(reveal.code).toBe(0);
    expect(reveal.stdout.trim()).toBe("canary-cli-dir-token-1");

    const rotated = await run([
      "rotate",
      "anthropic-messages",
      "--project",
      link,
      "--token",
      "canary-cli-dir-token-3",
      "--descriptor",
      descriptorPath,
    ]);
    expect(rotated.code).toBe(0);
    expect(live.authorize("canary-cli-dir-token-1")).toBeUndefined();
    expect(live.authorize("canary-cli-dir-token-3")).toEqual({ projectDir });

    const removed = await run([
      "remove",
      "anthropic-messages",
      "--project",
      projectDir,
      "--descriptor",
      descriptorPath,
    ]);
    expect(removed.code).toBe(0);
    expect(removed.stdout).toContain("Removed project");
    expect(live.authorize("canary-cli-dir-token-3")).toBeUndefined();
  }, 60_000);

  it("rejects a nonexistent live directory scope value-free", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-cli-dir-missing-"));
    directories.push(root);
    const authFile = join(root, "client-auth", "anthropic-messages.json");
    const store = createFileClientTokenStore({ path: authFile });
    const live = await createLiveClientTokenAuthority({ store });
    await live.ensureGlobal();
    const descriptorPath = await startDirectoryBackend({
      authorities: { "anthropic-messages": live },
    });
    const child = startCli([
      "client-token",
      "create",
      "anthropic-messages",
      "--project",
      join(root, "missing"),
      "--descriptor",
      descriptorPath,
    ]);
    children.push(child);
    const result = await captureChild(child).result;
    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain(root);
    expect(result.stderr).not.toContain("missing");
  }, 30_000);

  it("canonicalizes a relative project path offline from a controlled working directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-cli-dir-relative-"));
    directories.push(root);
    const projectDir = join(root, "project");
    await mkdir(projectDir, { recursive: true });
    const stateDirectory = join(root, ".luckytoken");
    await mkdir(stateDirectory);
    const configPath = join(stateDirectory, "config.json");
    const authFile = join(stateDirectory, "client-auth", "fixture.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "luckytoken-config-v1",
        clientProtocols: {
          "fixture-client": { authFile: "client-auth/fixture.json" },
        },
        pi: { directory: "pi" },
      }),
      "utf8",
    );
    const runInCwd = async (args: readonly string[]) => {
      const child = spawn(
        process.execPath,
        [
          tsxCli,
          join(process.cwd(), "src", "cli.ts"),
          ...["client-token", ...args],
        ],
        {
          cwd: root,
          env: { ...process.env },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      children.push(child);
      return captureChild(child).result;
    };

    // Relative alias "./project" resolves against the spawned CLI's cwd.
    const created = await runInCwd([
      "create",
      "fixture-client",
      "--project",
      `project${sep}..${sep}project`,
      "--token",
      "canary-relative-token-1",
      "--config",
      configPath,
    ]);
    expect(created.code).toBe(0);
    expect(created.stdout).toContain("Created project");
    expect(created.stdout).not.toContain("canary-relative-token-1");
    const authority = await loadFileClientTokenAuthority(authFile);
    // Only the canonical identity was persisted; a dot-relative alias
    // cannot create a second scope.
    expect(authority.authorize("canary-relative-token-1")).toEqual({
      projectDir,
    });
    const duplicate = await runInCwd([
      "create",
      "fixture-client",
      "--project",
      `project${sep}..${sep}project`,
      "--config",
      configPath,
    ]);
    expect(duplicate.code).toBe(1);
    expect(duplicate.stderr).toContain("already has a token");

    const rotated = await runInCwd([
      "rotate",
      "fixture-client",
      "--project",
      join(".", "project"),
      "--token",
      "canary-relative-token-2",
      "--config",
      configPath,
    ]);
    expect(rotated.code).toBe(0);
    const rotatedAuthority = await loadFileClientTokenAuthority(authFile);
    expect(rotatedAuthority.authorize("canary-relative-token-1")).toBeUndefined();
    expect(rotatedAuthority.authorize("canary-relative-token-2")).toEqual({
      projectDir,
    });
  }, 60_000);

  it("manages an orphaned directory scope offline by its stored canonical identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-cli-dir-orphan-"));
    directories.push(root);
    const projectDir = join(root, "project");
    await mkdir(projectDir, { recursive: true });
    const stateDirectory = join(root, ".luckytoken");
    await mkdir(stateDirectory);
    const configPath = join(stateDirectory, "config.json");
    const authFile = join(stateDirectory, "client-auth", "fixture.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "luckytoken-config-v1",
        clientProtocols: {
          "fixture-client": { authFile: "client-auth/fixture.json" },
        },
        pi: { directory: "pi" },
      }),
      "utf8",
    );
    const run = async (args: readonly string[]) => {
      const child = startCli(["client-token", ...args]);
      children.push(child);
      return captureChild(child).result;
    };

    const created = await run([
      "create",
      "fixture-client",
      "--project",
      projectDir,
      "--token",
      "canary-orphan-offline-1",
      "--config",
      configPath,
    ]);
    expect(created.code).toBe(0);
    // The directory disappears; only the persisted canonical scope stays.
    await rm(projectDir, { recursive: true, force: true });

    // The offline list still shows the stored canonical identity.
    const listed = await run([
      "list",
      "fixture-client",
      "--config",
      configPath,
    ]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain(projectDir);
    expect(listed.stdout).not.toContain("canary-orphan-offline-1");

    // Rotate by the stored canonical identity: the new token retains the
    // same stored canonical projectDir.
    const rotated = await run([
      "rotate",
      "fixture-client",
      "--project",
      projectDir,
      "--token",
      "canary-orphan-offline-2",
      "--config",
      configPath,
    ]);
    expect(rotated.code).toBe(0);
    expect(rotated.stdout).toContain("Rotated project");
    const rotatedAuthority = await loadFileClientTokenAuthority(authFile);
    expect(rotatedAuthority.authorize("canary-orphan-offline-1")).toBeUndefined();
    expect(rotatedAuthority.authorize("canary-orphan-offline-2")).toEqual({
      projectDir,
    });

    // Remove by the stored canonical identity succeeds.
    const removed = await run([
      "remove",
      "fixture-client",
      "--project",
      projectDir,
      "--config",
      configPath,
    ]);
    expect(removed.code).toBe(0);
    expect(removed.stdout).toContain("Removed project");
    await expect(
      loadFileClientTokenAuthority(authFile),
    ).rejects.toThrow("must contain at least one token");
  }, 60_000);

  it("still rejects offline create and arbitrary missing lookups after directory disappearance", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-cli-dir-orphan-"));
    directories.push(root);
    const projectDir = join(root, "project");
    await mkdir(projectDir, { recursive: true });
    const stateDirectory = join(root, ".luckytoken");
    await mkdir(stateDirectory);
    const configPath = join(stateDirectory, "config.json");
    const authFile = join(stateDirectory, "client-auth", "fixture.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "luckytoken-config-v1",
        clientProtocols: {
          "fixture-client": { authFile: "client-auth/fixture.json" },
        },
        pi: { directory: "pi" },
      }),
      "utf8",
    );
    const run = async (args: readonly string[]) => {
      const child = startCli(["client-token", ...args]);
      children.push(child);
      return captureChild(child).result;
    };

    const created = await run([
      "create",
      "fixture-client",
      "--project",
      projectDir,
      "--token",
      "canary-orphan-offline-1",
      "--config",
      configPath,
    ]);
    expect(created.code).toBe(0);
    await rm(projectDir, { recursive: true, force: true });

    // Creating a token for the missing directory still fails offline, and
    // nothing new is persisted.
    const createMissing = await run([
      "create",
      "fixture-client",
      "--project",
      projectDir,
      "--token",
      "canary-orphan-offline-2",
      "--config",
      configPath,
    ]);
    expect(createMissing.code).toBe(1);
    expect(createMissing.stderr).toContain("does not exist");
    expect(createMissing.stdout).not.toContain("canary-orphan-offline-2");
    // An arbitrary missing path (not a persisted canonical identity) can
    // never manage or match the orphan scope.
    const arbitrary = join(root, "never-existed");
    const removed = await run([
      "remove",
      "fixture-client",
      "--project",
      arbitrary,
      "--config",
      configPath,
    ]);
    expect(removed.code).toBe(1);
    expect(removed.stderr).toContain("does not exist");
    // The orphan scope is untouched.
    const authority = await loadFileClientTokenAuthority(authFile);
    expect(authority.authorize("canary-orphan-offline-1")).toEqual({
      projectDir,
    });
  }, 60_000);
});
