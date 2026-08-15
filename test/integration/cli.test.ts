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
import { join, relative } from "node:path";
import { createRequire } from "node:module";

import { afterEach, describe, expect, it } from "vitest";

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
      tcpServers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
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
    expect(result.stderr).not.toContain("Error");
  }, 30_000);

  it("reads the discovery descriptor and prints status without its capability", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-control-cli-"));
    directories.push(directory);
    const capability = "cli-capability-secret-012345678901234567890123";
    const transport = createNodePipeTransport();
    const controlPlane = await startControlPlane({
      endpoint: {
        pipeName: `\\\\.\\pipe\\luckytoken-cli-${process.pid}`,
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

  it("does not echo descriptor contents when discovery is malformed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-control-invalid-"));
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

  it.each([
    {
      label: "no user Provider",
      providerPackages: undefined,
      expectedProvider: "unconfigured" as const,
    },
    {
      label: "a configured Provider Package",
      providerPackages: {
        "@luckytoken/provider-commandcode-private": {},
      },
      expectedProvider: "configured" as const,
    },
  ])("atomically owns discovery and reports $label as $expectedProvider", async ({
    providerPackages,
    expectedProvider,
  }) => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-control-owned-"));
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
        server: { host: "127.0.0.1", port: 0 },
        clientProtocols: {
          "anthropic-messages": {
            authFile: "client-auth/anthropic-messages.json",
          },
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
      .poll(async () => {
        try {
          const parsed = JSON.parse(await readFile(descriptorPath, "utf8")) as {
            pipeName?: unknown;
            capability?: unknown;
          };
          return (
            typeof parsed.pipeName === "string" &&
            typeof parsed.capability === "string"
          );
        } catch {
          return false;
        }
      }, { timeout: 10_000, interval: 50 })
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
  }, 30_000);

  it("removes owned discovery and temporary files when Data Plane startup fails", async () => {
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
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-control-failure-"));
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

    const child = startCli(["--config", configPath]);
    children.push(child);
    const result = await captureChild(child).result;

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("EADDRINUSE");
    await expect(readFile(descriptorPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (await readdir(stateDirectory)).filter((name) =>
        name.startsWith("control-plane.json."),
      ),
    ).toEqual([]);
  }, 30_000);

  it("creates and lists a token for any configured Client Protocol without protocol branches", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-client-token-cli-"));
    directories.push(root);
    const stateDirectory = join(root, ".luckytoken");
    await mkdir(stateDirectory);
    const configPath = join(stateDirectory, "config.json");
    const authFile = join(
      stateDirectory,
      "client-auth",
      "future-client-protocol.json",
    );
    await writeFile(
      configPath,
      JSON.stringify({
        clientProtocols: {
          "future-client-protocol": {
            authFile: "client-auth/future-client-protocol.json",
          },
        },
        pi: { directory: "pi" },
      }),
      "utf8",
    );

    const create = startCli([
      "client-token",
      "create",
      "future-client-protocol",
      "--global",
      "--config",
      configPath,
    ]);
    children.push(create);
    const createResult = await captureChild(create).result;
    expect(createResult.code).toBe(0);
    const token = createResult.stdout.match(/\b(lt_[A-Za-z0-9_-]{43})\b/u)?.[1];
    expect(token).toBeDefined();
    expect(createResult.stdout).toContain("Restart LuckyToken");

    const list = startCli([
      "client-token",
      "list",
      "future-client-protocol",
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

  it("creates, rotates, and removes one project token while runtime snapshots stay immutable", async () => {
    const root = await mkdtemp(join(process.cwd(), ".tmp-client-token-cli-"));
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
        clientProtocols: {
          "fixture-client": { authFile: "client-auth/fixture.json" },
        },
        pi: { directory: "pi" },
      }),
      "utf8",
    );
    const scopeArgs = ["--project", relative(process.cwd(), projectDir)];
    const run = async (args: readonly string[]) => {
      const child = startCli(args);
      children.push(child);
      return captureChild(child).result;
    };

    const created = await run([
      "client-token",
      "create",
      "fixture-client",
      ...scopeArgs,
      "--token",
      "manual-project-token",
      "--config",
      configPath,
    ]);
    expect(created.code).toBe(0);
    expect(created.stdout).not.toContain("manual-project-token");
    const store = createFileClientTokenStore({ path: authFile });
    const oldAuthority = await loadFileClientTokenAuthority(authFile);
    expect(oldAuthority.authorize("manual-project-token")).toEqual({ projectDir });

    const duplicate = await run([
      "client-token",
      "create",
      "fixture-client",
      ...scopeArgs,
      "--token",
      "unexpected-overwrite",
      "--config",
      configPath,
    ]);
    expect(duplicate.code).toBe(1);
    expect(duplicate.stderr).toContain("already has a token");

    const rotated = await run([
      "client-token",
      "rotate",
      "fixture-client",
      ...scopeArgs,
      "--token",
      "rotated-project-token",
      "--config",
      configPath,
    ]);
    expect(rotated.code).toBe(0);
    const newAuthority = await loadFileClientTokenAuthority(authFile);
    expect(oldAuthority.authorize("manual-project-token")).toEqual({ projectDir });
    expect(oldAuthority.authorize("rotated-project-token")).toBeUndefined();
    expect(newAuthority.authorize("manual-project-token")).toBeUndefined();
    expect(newAuthority.authorize("rotated-project-token")).toEqual({ projectDir });

    const removed = await run([
      "client-token",
      "remove",
      "fixture-client",
      ...scopeArgs,
      "--config",
      configPath,
    ]);
    expect(removed.code).toBe(0);
    await expect(store.list()).resolves.toEqual([]);
    await expect(loadFileClientTokenAuthority(authFile)).rejects.toThrow(
      "must contain at least one token",
    );
    expect(newAuthority.authorize("rotated-project-token")).toEqual({ projectDir });
  }, 30_000);

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
    expect(logoutResult.stdout).toContain(
      "Removed the stored credential for CommandCode Private",
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
