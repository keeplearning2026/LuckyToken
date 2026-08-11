import Anthropic from "@anthropic-ai/sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createFileCredentialStore } from "../../src/index.js";

const execFileAsync = promisify(execFile);
const npmCli =
  process.env.npm_execpath ??
  join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
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

async function waitForText(
  read: () => string,
  text: string,
  timeoutMs = 15_000,
): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const output = read();
    if (output.includes(text)) return output;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`Timed out waiting for CLI output: ${text}`);
}

function startCli(
  args: readonly string[],
  bridgeSignal = false,
): ChildProcessWithoutNullStreams {
  const command = bridgeSignal
    ? [tsxCli, "test/fixtures/cli-signal-bridge.ts"]
    : [tsxCli, "src/cli.ts", ...args];
  return spawn(process.execPath, command, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...(bridgeSignal
        ? { LUCKYTOKEN_TEST_CLI_ARGS: JSON.stringify(args) }
        : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error) rejectPromise(error);
      else resolvePromise();
    });
  });
}

describe("LuckyToken CLI", () => {
  const directories: string[] = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null) child.kill("SIGTERM");
    }
    await Promise.all(
      servers.splice(0).map(async (server) => {
        if (server.listening) await closeServer(server);
      }),
    );
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("documents serve, login, logout, and the single config authority", async () => {
    const result = await execFileAsync(process.execPath, [npmCli, "start", "--", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 30_000,
    });

    expect(result.stdout).toContain("LuckyToken");
    expect(result.stdout).toContain("--config <path>");
    expect(result.stdout).toContain("login");
    expect(result.stdout).toContain("logout");
    expect(result.stderr).not.toContain("Error");
  }, 30_000);

  it("logs in through Pi, serves the SDK, and shuts down without leaking keys", async () => {
    const upstreamAuthorization: Array<string | undefined> = [];
    const upstream = createServer((request, response) => {
      upstreamAuthorization.push(request.headers.authorization);
      request.resume();
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end(
        [
          JSON.stringify({ type: "text-start", id: "0" }),
          JSON.stringify({ type: "text-delta", id: "0", text: "CLI through Pi" }),
          JSON.stringify({ type: "text-end", id: "0" }),
          JSON.stringify({
            type: "finish",
            finishReason: "stop",
            totalUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
          }),
        ].join("\n"),
      );
    });
    servers.push(upstream);
    await new Promise<void>((resolvePromise, rejectPromise) => {
      upstream.once("error", rejectPromise);
      upstream.listen(0, "127.0.0.1", resolvePromise);
    });
    const upstreamAddress = upstream.address();
    if (upstreamAddress === null || typeof upstreamAddress === "string") {
      throw new Error("Fixture server did not expose a TCP address");
    }

    const directory = await mkdtemp(join(tmpdir(), "luckytoken-cli-e2e-"));
    directories.push(directory);
    const piDirectory = join(directory, "pi");
    await mkdir(piDirectory);
    await writeFile(
      join(piDirectory, "models.json"),
      JSON.stringify({
        providers: {
          "commandcode-private": {
            baseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
            api: "commandcode-private",
            models: [
              {
                id: "configured-model",
                name: "configured-model",
                api: "commandcode-private",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200_000,
                maxTokens: 64_000,
              },
            ],
          },
        },
      }),
      "utf8",
    );
    const configPath = join(directory, "luckytoken.config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        server: { host: "127.0.0.1", port: 0 },
        client: { apiKey: "local-client-secret" },
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

    const serving = startCli(["--config", configPath], true);
    children.push(serving);
    const servingCapture = captureChild(serving);
    const output = await waitForText(servingCapture.stdout, "/v1/messages");
    const endpoint = output.match(/http:\/\/[^\s]+\/v1\/messages/u)?.[0];
    expect(endpoint).toBeDefined();
    const origin = new URL(endpoint as string).origin;
    const client = new Anthropic({
      apiKey: "local-client-secret",
      baseURL: origin,
      maxRetries: 0,
      timeout: 10_000,
    });
    const message = await client.messages.create({
      model: "configured-model",
      max_tokens: 32,
      messages: [{ role: "user", content: "hello" }],
    });

    expect(message.content).toEqual([
      { type: "text", text: "CLI through Pi", citations: null },
    ]);
    expect(upstreamAuthorization).toEqual(["Bearer stored-provider-secret"]);
    expect(`${servingCapture.stdout()}\n${servingCapture.stderr()}`).not.toContain(
      "local-client-secret",
    );
    expect(`${servingCapture.stdout()}\n${servingCapture.stderr()}`).not.toContain(
      "stored-provider-secret",
    );

    serving.stdin.end("SIGTERM\n");
    const servingResult = await servingCapture.result;
    expect(servingResult.code).toBe(0);

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
