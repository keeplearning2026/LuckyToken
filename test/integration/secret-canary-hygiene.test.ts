import {
  InMemoryCredentialStore,
  type FetchFunction,
} from "@earendil-works/pi-ai";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  connectControlPlane,
  createNodePipeTransport,
  nodePipeFallbackAccess,
  startControlPlane,
  type ControlPlaneEndpoint,
  type RunningControlPlane,
} from "@luckytoken/application-control-plane/control-plane";

import { createFileClientTokenStore } from "../../src/client-auth/file-token-store.js";
import { loadLuckyTokenCliConfig } from "../../src/cli-config.js";
import { createConfiguredLuckyTokenDataPlane } from "../../src/composition.js";
import { createModelsControlPlaneHandler } from "../../src/models-config/control-plane.js";
import { createModelsJsonAuthority } from "../../src/models-config/authority.js";
import {
  createRuntimeDiagnosticsStoreFactory,
  type RuntimeDiagnosticsStore,
} from "../../src/runtime-diagnostics/index.js";
import { composeEffectiveCatalog } from "../../src/providers/effective-composition.js";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");

/**
 * Ticket 10 secret hygiene: even when config values, environment names and
 * command text carry credential canaries, no surface may expose them —
 * effective catalog query/events, Diagnostics DB/WAL, failure journals,
 * CLI output, client-visible errors, model discovery or renderer DTOs.
 */
describe("secret canary hygiene across public surfaces", () => {
  const CANARY_ENV = "CANARY_ENV_NAME_42";
  const CANARY_COMMAND = "canary-command-text-77";
  const CANARY_KEY = "sk-canary-key-value-123456789";
  const CANARY_HEADER = "header-canary-value-987654321";
  const CANARY_MODEL_HEADER = "model-header-canary-55555";

  const directories: string[] = [];
  const compositions: Array<{ diagnosticsStore: { close(): void }; requestLedger: { close(): void }; deepCaptureStore: { close(): void } }> = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  const hosts: RunningControlPlane[] = [];
  let nextPipe = 0;

  afterEach(async () => {
    compositions.splice(0).forEach((composition) => {
      composition.diagnosticsStore.close();
      composition.requestLedger.close();
        composition.deepCaptureStore.close();
    });
    await Promise.all(hosts.splice(0).map((host) => host.close()));
    children.splice(0).forEach((child) => child.kill());
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  const secretsJson = {
    providers: {
      "secret-gw": {
        baseUrl: "https://secret-gw.example.com",
        api: "anthropic-messages",
        apiKey: CANARY_KEY,
        headers: { "X-Secret": CANARY_HEADER, "X-Env-Ref": `$${CANARY_ENV}` },
        authHeader: true,
        models: [
          { id: "m1", headers: { "X-Model-Secret": CANARY_MODEL_HEADER } },
        ],
        modelOverrides: {
          m1: { headers: { "X-Command": `!${CANARY_COMMAND}` } },
        },
      },
    },
  };

  async function serve(options: {
    readonly failureLoggingDetail?: "safe" | "full";
    readonly env?: Readonly<Record<string, string>>;
    readonly fetch?: FetchFunction;
    readonly onInvalidModelsJson?: (error: unknown) => void;
  } = {}) {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-canary-serve-"));
    directories.push(directory);
    const stateDirectory = join(directory, ".luckytoken");
    const piDirectory = join(stateDirectory, "pi");
    await mkdir(piDirectory, { recursive: true });
    const clientAuthPath = join(
      stateDirectory,
      "client-auth",
      "anthropic-messages.json",
    );
    await createFileClientTokenStore({ path: clientAuthPath }).create(
      { type: "global" },
      "client-token-canary",
    );
    const modelsJsonPath = join(piDirectory, "models.json");
    await writeFile(modelsJsonPath, JSON.stringify(secretsJson), "utf8");
    const configPath = join(stateDirectory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "luckytoken-config-v1",
        server: { port: 0 },
        clientProtocols: {
          "anthropic-messages": {
            authFile: "client-auth/anthropic-messages.json",
          },
        },
        pi: { directory: "pi", modelsJson: "pi/models.json" },
        failureLogging: {
          detail: options.failureLoggingDetail ?? "safe",
          directory: "logs/failed-requests",
        },
        runtimeDiagnostics: { directory: "diagnostics" },
      }),
      "utf8",
    );
    const composition = await createConfiguredLuckyTokenDataPlane({
      config: await loadLuckyTokenCliConfig(configPath),
      fetch: options.fetch ?? (async () => new Response()),
      credentials: new InMemoryCredentialStore(),
      configValueAdapters: {
        envSource: (name) => options.env?.[name],
        commandRunner: () => undefined,
      },
      createMessageId: () => "msg_canary",
      createSessionId: () => "00000000-0000-4000-8000-000000000020",
      now: () => 1_786_400_000_000,
      ...(options.onInvalidModelsJson === undefined
        ? {}
        : { onInvalidModelsJson: options.onInvalidModelsJson }),
    });
    compositions.push(composition);
    return { composition, stateDirectory, modelsJsonPath };
  }

  function anthropicRequest(model: string): Request {
    return new Request("http://luckytoken.test/v1/messages", {
      method: "POST",
      headers: {
        authorization: "Bearer client-token-canary",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 32,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
  }

  it("keeps every canary out of the client-visible error and the failure journal (safe and full)", async () => {
    const { composition, stateDirectory } = await serve({
      // The referenced env var and the command are missing: resolution fails
      // while the error chain itself carries the canary sources.
      env: { [CANARY_ENV]: "value-from-env-canary" },
    });
    const response = await composition.runtime.handle(
      anthropicRequest("secret-gw/m1"),
    );
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain(CANARY_ENV);
    expect(body).not.toContain(CANARY_COMMAND);
    expect(body).not.toContain(CANARY_KEY);
    expect(body).not.toContain(CANARY_HEADER);
    expect(body).not.toContain(CANARY_MODEL_HEADER);

    // Safe-detail journal: only hashes, never messages.
    const safeJournal = await readJournal(stateDirectory);
    expect(safeJournal).not.toContain(CANARY_ENV);
    expect(safeJournal).not.toContain(CANARY_COMMAND);
    expect(safeJournal).not.toContain(CANARY_KEY);
    expect(safeJournal.exceptionChain[0]).toMatchObject({
      messageLength: expect.any(Number),
      messageHash: expect.any(String),
    });
  });

  it("keeps every canary out of the full-detail journal even though the error chain carries them", async () => {
    const { composition, stateDirectory } = await serve({
      failureLoggingDetail: "full",
      env: { [CANARY_ENV]: "value-from-env-canary" },
    });
    const response = await composition.runtime.handle(
      anthropicRequest("secret-gw/m1"),
    );
    expect(response.status).toBe(500);
    const journal = await readJournal(stateDirectory);
    const journalText = JSON.stringify(journal);
    expect(journalText).not.toContain(CANARY_ENV);
    expect(journalText).not.toContain(CANARY_COMMAND);
    expect(journalText).not.toContain(CANARY_KEY);
    expect(journalText).not.toContain(CANARY_HEADER);
    expect(journalText).not.toContain(CANARY_MODEL_HEADER);
    // The bounded structural failure detail is preserved (provider id and
    // the fixed description), never the env var name or command text.
    const messages = journal.exceptionChain
      .map((entry: { message?: string }) => entry.message ?? "")
      .join("\n");
    expect(messages).toContain(
      'Failed to resolve model "secret-gw/m1" header "X-Command" from shell command',
    );
    expect(messages).not.toContain(CANARY_ENV);
  });

  it("keeps canaries out of model discovery and the catalog projection", async () => {
    const { composition } = await serve();
    const discovery = await composition.runtime.handle(
      new Request("http://luckytoken.test/v1/models", { method: "GET" }),
    );
    expect(discovery.status).toBe(200);
    const discoveryText = await discovery.text();
    // models.json providers are intentionally hidden from shared discovery;
    // the canaries must never appear either way.
    expect(discoveryText).not.toContain("secret-gw");
    expect(discoveryText).not.toContain(CANARY_KEY);
    expect(discoveryText).not.toContain(CANARY_HEADER);
    expect(discoveryText).not.toContain(CANARY_ENV);
    expect(discoveryText).not.toContain(CANARY_COMMAND);

    const catalog = JSON.stringify(composeEffectiveCatalog(secretsJson.providers));
    expect(catalog).toContain("secret-gw");
    expect(catalog).not.toContain(CANARY_KEY);
    expect(catalog).not.toContain(CANARY_HEADER);
    expect(catalog).not.toContain(CANARY_MODEL_HEADER);
    expect(catalog).not.toContain(CANARY_ENV);
    expect(catalog).not.toContain(CANARY_COMMAND);
    expect(catalog).not.toContain("apiKey");
    expect(catalog).not.toContain("headers");
  });

  it("never routes resolution failures into the Runtime Diagnostics DB/WAL", async () => {
    // The Diagnostics store is a low-frequency lifecycle channel (Ticket 07):
    // per-request auth/header resolution failures are journaled by the
    // invocation journal, never recorded here. After failing requests the
    // store must contain no canary bytes.
    const { composition, stateDirectory } = await serve({
      env: { [CANARY_ENV]: "value-from-env-canary" },
    });
    const response = await composition.runtime.handle(
      anthropicRequest("secret-gw/m1"),
    );
    expect(response.status).toBe(500);
    const diagnosticsRoot = join(stateDirectory, "diagnostics");
    const files = await readdirRecursive(diagnosticsRoot);
    for (const file of files) {
      const bytes = await readFile(file, "utf8");
      expect(bytes).not.toContain(CANARY_KEY);
      expect(bytes).not.toContain(CANARY_ENV);
      expect(bytes).not.toContain(CANARY_COMMAND);
      expect(bytes).not.toContain(CANARY_HEADER);
      expect(bytes).not.toContain(CANARY_MODEL_HEADER);
    }
  });

  it("redacts known credential values before committing diagnostics records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-canary-diag-"));
    directories.push(directory);
    const store: RuntimeDiagnosticsStore =
      await createRuntimeDiagnosticsStoreFactory({
        configuration: {
          directory: join(directory, "diagnostics"),
        },
        now: () => 1_786_400_000_000,
        // F4: the composition attaches the credential authorities' narrow
        // known-value scrubber to the store before any producer runs.
        scrub: (value) => value.replaceAll(CANARY_KEY, "[REDACTED]"),
      }).open();
    store.append({
      level: "error",
      text: `resolution failed with ${CANARY_KEY}`,
    });
    const records = await store.query({ limit: 10 });
    const text = JSON.stringify(records);
    expect(text).not.toContain(CANARY_KEY);
    expect(text).toContain("[REDACTED]");
    await store.close();
  });

  it("keeps canaries out of the CLI status output and the catalog projection inside models query", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-canary-cp-"));
    directories.push(directory);
    const path = join(directory, "models.json");
    await writeFile(path, JSON.stringify(secretsJson), "utf8");
    const authority = createModelsJsonAuthority({
      path,
      compose: (providers) => composeEffectiveCatalog(providers),
    });
    const endpoint: ControlPlaneEndpoint = {
      address: `\\\\.\\pipe\\luckytoken-canary-${process.pid}-${++nextPipe}`,
      capability: "canary-catalog-capability-0123456789012345678901",
    };
    const host = await startControlPlane({
      endpoint,
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      modelsCommandHandler: createModelsControlPlaneHandler(authority),
      modelsProjection: () => authority.snapshot(),
      pipeServerFactory: createNodePipeTransport(),
      access: nodePipeFallbackAccess,
    });
    hosts.push(host);
    const descriptorPath = join(directory, "control-plane.json");
    await writeFile(descriptorPath, JSON.stringify(endpoint), "utf8");

    // The status channel carries only the sanitized ModelsProjection; it is
    // the exact same response the CLI `control status` prints verbatim.
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => "canary-status-request-1",
      pipeConnector: createNodePipeTransport(),
    });
    const hello = await client.hello(1);
    if (hello.type !== "compatible") {
      throw new Error("Control Plane hello failed");
    }
    const status = await client.getStatus();
    await client.close();
    const statusText = JSON.stringify(status);
    expect(statusText).toContain("luckytoken");
    expect(statusText).not.toContain(CANARY_KEY);
    expect(statusText).not.toContain(CANARY_HEADER);
    expect(statusText).not.toContain(CANARY_ENV);
    expect(statusText).not.toContain(CANARY_COMMAND);

    // The CLI models query prints the full state verbatim; the raw file bytes
    // are the editor channel, but the effective catalog projection inside is
    // secret-free.
    const query = await runCli([
      "control",
      "models",
      "query",
      "--descriptor",
      descriptorPath,
    ]);
    expect(query.code).toBe(0);
    const state = JSON.parse(query.stdout) as { state?: { catalog?: unknown } };
    expect(state.state?.catalog).toBeDefined();
    const catalogText = JSON.stringify(state.state?.catalog);
    expect(catalogText).toContain("secret-gw");
    expect(catalogText).not.toContain(CANARY_KEY);
    expect(catalogText).not.toContain(CANARY_HEADER);
    expect(catalogText).not.toContain(CANARY_ENV);
    expect(catalogText).not.toContain(CANARY_COMMAND);
    expect(catalogText).not.toContain("apiKey");
    expect(catalogText).not.toContain("headers");
  }, 60_000);

  async function runCli(
    args: readonly string[],
  ): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
    const child = spawn(process.execPath, [tsxCli, "src/cli.ts", ...args], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const code = await new Promise<number | null>((resolvePromise, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("exit", (exitCode) => resolvePromise(exitCode));
    });
    return { code, stdout, stderr };
  }

  async function readJournal(stateDirectory: string): Promise<{
    exceptionChain: Array<Record<string, unknown>>;
  }> {
    const journalRoot = join(stateDirectory, "logs", "failed-requests");
    const days = await readdirRecursive(journalRoot);
    expect(days.length).toBeGreaterThan(0);
    const content = await readFile(days[0]!, "utf8");
    return JSON.parse(content) as unknown as {
      exceptionChain: Array<Record<string, unknown>>;
    };
  }
});

async function readdirRecursive(root: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const out: string[] = [];
  const walk = async (entry: string): Promise<void> => {
    const entries = await readdir(entry, { withFileTypes: true });
    for (const child of entries) {
      const path = join(entry, child.name);
      if (child.isDirectory()) await walk(path);
      else if (child.isFile()) out.push(path);
    }
  };
  try {
    await walk(root);
  } catch {
    return out;
  }
  return out;
}
