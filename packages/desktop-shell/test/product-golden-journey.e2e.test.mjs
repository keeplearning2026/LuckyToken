import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { _electron as electron } from "playwright";
import {
  connectControlPlane,
  controlPlaneVersion,
  createNodePipeTransport,
  parseControlPlaneDescriptor,
} from "@luckytoken/application-control-plane/control-plane";

const execFileAsync = promisify(execFile);
const desktopRoot = resolve(import.meta.dirname, "..");

const TEST_PROVIDER_KEY = "deterministic-product-provider-key";
const TEST_CODEX_TOKEN = "deterministic-product-codex-token";
const TEST_MODEL = "claude-opus-4-7";
const TEST_ALIAS = "product-anthropic";

const delay = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

async function freePort() {
  const server = createNetServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("failed to allocate product certification port");
  }
  const port = address.port;
  await new Promise((resolvePromise, reject) => {
    server.close((error) => (error === undefined ? resolvePromise() : reject(error)));
  });
  return port;
}

function anthropicSse(model = TEST_MODEL) {
  return [
    "event: message_start",
    `data: {"type":"message_start","message":{"id":"msg_product","type":"message","role":"assistant","model":"${model}","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":4,"output_tokens":0}}}`,
    "",
    "event: content_block_start",
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    "",
    "event: content_block_delta",
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"product journey ok"}}',
    "",
    "event: content_block_stop",
    'data: {"type":"content_block_stop","index":0}',
    "",
    "event: message_delta",
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}',
    "",
    "event: message_stop",
    'data: {"type":"message_stop"}',
    "",
    "",
  ].join("\n");
}

async function startLocalAnthropicUpstream() {
  const requests = [];
  const server = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({
      method: request.method,
      url: request.url,
      apiKey: request.headers["x-api-key"],
      authorization: request.headers.authorization,
      body,
    });

    if (request.url?.startsWith("/v1/messages")) {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      response.end(anthropicSse());
      return;
    }
    if (request.url?.includes("/provider/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [] }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("local upstream did not bind a TCP port");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise((resolvePromise, reject) =>
        server.close((error) => (error === undefined ? resolvePromise() : reject(error))),
      ),
  };
}

async function latestPackagedExecutable() {
  const outputRoot = join(desktopRoot, ".electron-out");
  const entries = await readdir(outputRoot, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const executable = join(
      outputRoot,
      entry.name,
      "LuckyToken-win32-x64",
      "LuckyToken.exe",
    );
    try {
      const metadata = await stat(executable);
      candidates.push({ executable, mtimeMs: metadata.mtimeMs });
    } catch {
      // Ignore partial/other-platform outputs.
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const latest = candidates[0];
  if (latest === undefined) throw new Error("no packaged LuckyToken executable found");
  return latest.executable;
}

async function createProductFixture(home, upstreamOrigin, dataPlanePort) {
  const stateRoot = join(home, ".luckytoken");
  const codexHome = join(home, ".codex");
  await Promise.all([
    mkdir(join(stateRoot, "pi"), { recursive: true }),
    mkdir(join(stateRoot, "client-auth"), { recursive: true }),
    mkdir(codexHome, { recursive: true }),
  ]);

  await writeFile(
    join(stateRoot, "models.json"),
    `${JSON.stringify(
      {
        providers: {
          anthropic: {
            baseUrl: upstreamOrigin,
            models: [{ id: TEST_MODEL }],
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await writeFile(
    join(stateRoot, "model-aliases.json"),
    `${JSON.stringify(
      { aliases: { [TEST_ALIAS]: `anthropic/${TEST_MODEL}` } },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await writeFile(
    join(stateRoot, "config.json"),
    `${JSON.stringify(
      {
        schemaVersion: "luckytoken-config-v1",
        server: { host: "127.0.0.1", port: dataPlanePort },
        clientProtocols: {
          "anthropic-messages": {
            authFile: "client-auth/anthropic-messages.json",
            conversion: {
              request: {
                unknownContent: "error",
                unresolvedToolCall: "xrepair",
                localCacheControl: "ignore",
              },
              response: { unknownPiContent: "error" },
            },
          },
          "openai-responses": {
            authFile: "client-auth/openai-responses.json",
            stateFile: "state/openai-responses.json",
            conversion: {
              request: {
                privilegedMessages: "first",
                unknownInputItem: "error",
                orphanToolOutput: "error",
                unresolvedToolCall: "xrepair",
                futureReasoningEffort: "max",
              },
              response: { unknownPiContent: "error", storeFalse: "honor" },
            },
          },
        },
        providerPackages: {},
        failureLogging: {
          directory: "logs/failed-requests",
          detail: "safe",
          maxFileBytes: 1048576,
          retentionDays: 30,
          maxFiles: 1000,
          logCancellation: true,
        },
        runtimeDiagnostics: { directory: "state/diagnostics" },
        deepDiagnostics: {
          directory: "state/deep-diagnostics",
          enabled: false,
          maxCaptureBytes: 4194304,
          retentionAgeMs: 604800000,
          maxCaptures: 1000,
        },
        pi: { directory: "pi" },
        limits: { maxRequestBytes: 1048576, requestTimeoutMs: 120000 },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await writeFile(join(codexHome, "config.toml"), "# LuckyToken product certification\n", "utf8");
  await writeFile(
    join(codexHome, "auth.json"),
    `${JSON.stringify({
      tokens: {
        access_token: TEST_CODEX_TOKEN,
        account_id: "product-certification-account",
      },
    })}\n`,
    "utf8",
  );

  return {
    stateRoot,
    codexHome,
    configPath: join(stateRoot, "config.json"),
    descriptorPath: join(stateRoot, "control-plane.json"),
  };
}

async function waitForEndpoint(descriptorPath) {
  let lastError;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return parseControlPlaneDescriptor(
        JSON.parse(await readFile(descriptorPath, "utf8")),
      );
    } catch (error) {
      lastError = error;
      await delay(50);
    }
  }
  throw lastError ?? new Error("Control Plane descriptor did not appear");
}

async function connect(endpoint) {
  let lastError;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    let client;
    try {
      client = await connectControlPlane(endpoint, {
        createRequestId: randomUUID,
        pipeConnector: createNodePipeTransport(),
      });
      const hello = await client.hello(controlPlaneVersion);
      assert.equal(hello.type, "compatible");
      return client;
    } catch (error) {
      lastError = error;
      await client?.close().catch(() => undefined);
      await delay(50);
    }
  }
  throw lastError ?? new Error("Control Plane did not become connectable");
}

async function waitForRunning(client) {
  let status;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    status = await client.getStatus();
    if (status.modelDataPlane === "running") return status;
    if (status.modelDataPlane === "failed") {
      throw new Error(
        status.dataPlane?.failure?.message ?? "Data Plane failed during product certification",
      );
    }
    await delay(50);
  }
  throw new Error(`Data Plane did not reach running: ${status?.modelDataPlane ?? "unknown"}`);
}

async function openWindow(application) {
  await application.evaluate(({ app }) => {
    app.emit("second-instance", {}, [], "");
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const windows = application.windows();
    if (windows.length === 1) return windows[0];
    await delay(25);
  }
  throw new Error("management window did not open");
}

async function waitForNoWindows(application) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (application.windows().length === 0) return;
    await delay(25);
  }
  throw new Error("management window did not close");
}

async function waitForBackendExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise((resolvePromise) => child.once("exit", resolvePromise)),
    delay(timeoutMs),
  ]);
}

function spawnReleaseBackend(fixture, environment) {
  const executable = join(
    desktopRoot,
    "backend",
    "node",
    process.platform === "win32" ? "node.exe" : "node",
  );
  const cli = join(desktopRoot, "backend", "dist", "cli.js");
  const child = spawn(
    executable,
    [
      cli,
      "serve",
      "--config",
      fixture.configPath,
      "--descriptor",
      fixture.descriptorPath,
      "--owner",
      "cli",
    ],
    {
      cwd: join(desktopRoot, "backend"),
      env: environment,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk.toString();
  });
  return { child, output: () => output };
}

async function processTreeSnapshot(rootIds) {
  const roots = rootIds.filter((id) => Number.isSafeInteger(id) && id > 0);
  const command = `
$rootIds = @(${roots.join(",")})
$all = @(Get-CimInstance Win32_Process)
$ids = @($rootIds)
for ($round = 0; $round -lt 8; $round++) {
  $next = @($all | Where-Object { $ids -contains $_.ParentProcessId } | ForEach-Object { [int]$_.ProcessId })
  $new = @($next | Where-Object { $ids -notcontains $_ })
  if ($new.Count -eq 0) { break }
  $ids += $new
}
$rows = @()
foreach ($processId in ($ids | Sort-Object -Unique)) {
  try {
    $p = Get-Process -Id $processId -ErrorAction Stop
    $rows += [pscustomobject]@{
      id = [int]$p.Id
      workingSet = [double]$p.WorkingSet64
      privateMemory = [double]$p.PrivateMemorySize64
      cpuSeconds = if ($null -eq $p.CPU) { 0.0 } else { [double]$p.CPU }
    }
  } catch {}
}
$rows | ConvertTo-Json -Compress
`;
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-Command", command],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return [];
  const parsed = JSON.parse(trimmed);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function sampleProcessRoots(rootIds, intervalMs = 500) {
  const before = await processTreeSnapshot(rootIds);
  await delay(intervalMs);
  const after = await processTreeSnapshot(rootIds);
  const previousCpu = new Map(before.map((row) => [row.id, row.cpuSeconds]));
  let cpuDelta = 0;
  for (const row of after) {
    const prior = previousCpu.get(row.id);
    if (prior !== undefined) cpuDelta += Math.max(0, row.cpuSeconds - prior);
  }
  const bytesToMiB = (bytes) => Math.round((bytes / 1024 / 1024) * 10) / 10;
  return {
    processCount: after.length,
    workingSetMiB: bytesToMiB(after.reduce((sum, row) => sum + row.workingSet, 0)),
    privateMemoryMiB: bytesToMiB(
      after.reduce((sum, row) => sum + row.privateMemory, 0),
    ),
    idleCpuPercentOneCore:
      Math.round((cpuDelta / (intervalMs / 1000)) * 1000) / 10,
  };
}

async function electronProcessTypes(application) {
  return application.evaluate(({ app }) =>
    app.getAppMetrics().map((metric) => ({
      pid: metric.pid,
      type: metric.type,
      workingSetKb: metric.memory.workingSetSize,
      privateKb: metric.memory.privateBytes,
      cpuPercent: metric.cpu.percentCPUUsage,
    })),
  );
}

const rendererLike = (row) => /tab|renderer/iu.test(row.type);

async function waitForNoRendererProcesses(application) {
  let metrics = [];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    metrics = await electronProcessTypes(application);
    if (metrics.filter(rendererLike).length === 0) return metrics;
    await delay(50);
  }
  throw new Error(
    `renderer process did not exit after BrowserWindow destruction: ${metrics
      .map((row) => `${row.type}:${row.pid}`)
      .join(", ")}`,
  );
}

async function sendResponsesRequest(origin, clientToken, message) {
  const response = await fetch(`${origin}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${clientToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: TEST_ALIAS,
      input: message,
      stream: false,
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.match(JSON.stringify(body), /product journey ok/u);
  const requestId = response.headers.get("x-luckytoken-request-id");
  assert.ok(requestId, "successful request must expose the LuckyToken request id");
  return requestId;
}

async function revealResponsesClientToken(client) {
  const listed = await client.executeClientTokenCommand({
    command: "list",
    protocolId: "openai-responses",
  });
  assert.equal(listed.outcome, "ok");
  assert.ok(
    listed.scopes?.some((scope) => scope.type === "global"),
    "enabled Responses protocol must own its boot-created global client token",
  );
  const revealed = await client.executeClientTokenCommand({
    command: "reveal",
    protocolId: "openai-responses",
    scope: { type: "global" },
  });
  assert.equal(revealed.outcome, "ok");
  assert.ok(revealed.token);
  return revealed.token;
}

test(
  "release product golden journey reaches first successful request and survives tray-only use",
  { skip: process.platform !== "win32", timeout: 120_000 },
  async () => {
    const executablePath = await latestPackagedExecutable();
    const upstream = await startLocalAnthropicUpstream();
    const home = await mkdtemp(join(tmpdir(), "luckytoken-product-golden-"));
    const dataPlanePort = await freePort();
    const fixture = await createProductFixture(home, upstream.origin, dataPlanePort);
    const appData = join(home, "AppData", "Roaming");
    const localAppData = join(home, "AppData", "Local");
    await Promise.all([
      mkdir(appData, { recursive: true }),
      mkdir(localAppData, { recursive: true }),
    ]);
    const environment = {
      ...process.env,
      USERPROFILE: home,
      HOME: home,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      CODEX_HOME: fixture.codexHome,
    };

    const backend = spawnReleaseBackend(fixture, environment);
    let client;
    let application;
    let page;
    try {
      const endpoint = await waitForEndpoint(fixture.descriptorPath);
      client = await connect(endpoint);
      const running = await waitForRunning(client);
      const backendPid = running.ownership?.owner.pid;
      assert.equal(running.ownership?.owner.kind, "cli");
      assert.ok(backendPid);
      const backendOnly = await sampleProcessRoots([backendPid]);

      application = await electron.launch({
        executablePath,
        env: environment,
      });
      await delay(250);
      assert.equal(application.windows().length, 0, "desktop must remain tray-only at startup");
      const attached = await client.getStatus();
      assert.equal(
        attached.ownership?.owner.pid,
        backendPid,
        "Electron must attach to the existing Backend rather than spawn another owner",
      );
      const trayOnly = await sampleProcessRoots([
        backendPid,
        application.process().pid,
      ]);
      const trayProcessTypes = await electronProcessTypes(application);

      const openStartedAt = Date.now();
      page = await openWindow(application);
      page.setDefaultTimeout(10_000);
      await page.getByRole("button", { name: "Providers" }).waitFor();
      const uiColdOpenMs = Date.now() - openStartedAt;
      const uiOpen = await sampleProcessRoots([
        backendPid,
        application.process().pid,
      ]);
      const uiProcessTypes = await electronProcessTypes(application);

      await page.getByRole("button", { name: "Providers" }).click();
      const anthropicCard = page
        .locator("article.provider-card")
        .filter({ has: page.getByRole("heading", { name: "Anthropic", exact: true }) });
      await anthropicCard.waitFor();
      await anthropicCard.getByRole("button", { name: /api key/i }).click();
      const secretInput = page.locator('.auth-interaction input[type="password"]');
      await secretInput.waitFor();
      await secretInput.fill(TEST_PROVIDER_KEY);
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("status").filter({ hasText: /Anthropic connected/i }).waitFor();
      await assert.doesNotReject(async () => {
        const auth = await client.executeAuthCommand({ command: "query" });
        const status = auth.state.providers.find((provider) => provider.providerId === "anthropic");
        assert.equal(status?.stored, true);
        assert.equal(status?.unavailable, false);
      });

      // Provider Activation (Spec v1.0 §14): the coarse Provider readiness
      // is derived from Catalog model availability, which the Backend
      // republishes after the login-triggered refresh. Connect requires a
      // usable Provider, so wait for the authoritative convergence.
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const status = await client.getStatus();
        if (status.provider === "configured") break;
        await delay(50);
      }
      assert.equal((await client.getStatus()).provider, "configured");

      await page.getByRole("button", { name: "Connect" }).click();
      await page.getByRole("button", { name: "Configure Codex" }).click();
      await page.getByRole("heading", { name: "Codex is ready" }).waitFor();
      const codexConfig = await readFile(join(fixture.codexHome, "config.toml"), "utf8");
      assert.match(codexConfig, /openai_base_url/u);
      assert.match(codexConfig, /model_catalog_json/u);

      const clientToken = await revealResponsesClientToken(client);
      const firstRequestId = await sendResponsesRequest(
        running.dataPlane.configuredOrigin,
        clientToken,
        "first product request",
      );
      assert.equal(upstream.requests.at(-1)?.apiKey, TEST_PROVIDER_KEY);

      await page.getByRole("button", { name: "Activity" }).click();
      const firstRow = page.locator(`[data-request-id="${firstRequestId}"]`);
      await firstRow.waitFor();
      await assert.doesNotReject(async () => {
        assert.match((await firstRow.textContent()) ?? "", /success/u);
        assert.match((await firstRow.textContent()) ?? "", new RegExp(TEST_MODEL, "u"));
      });
      await page.getByRole("button", { name: "Analytics" }).click();
      await page.getByText(/100\.0% success/u).waitFor();

      await page.close();
      page = undefined;
      await waitForNoWindows(application);
      const secondRequestId = await sendResponsesRequest(
        running.dataPlane.configuredOrigin,
        clientToken,
        "tray-only request",
      );
      assert.equal(application.windows().length, 0);

      page = await openWindow(application);
      page.setDefaultTimeout(10_000);
      await page.getByRole("button", { name: "Activity" }).click();
      const secondRow = page.locator(`[data-request-id="${secondRequestId}"]`);
      await secondRow.waitFor();
      assert.match((await secondRow.textContent()) ?? "", /success/u);
      await page.close();
      page = undefined;
      await waitForNoWindows(application);

      const afterCloseTypes = await waitForNoRendererProcesses(application);
      assert.equal(
        afterCloseTypes.filter(rendererLike).length,
        0,
        "tray-only state must retain no renderer process",
      );
      assert.ok(
        uiProcessTypes.filter(rendererLike).length >= 1,
        "UI-open state must contain a renderer process",
      );

      const evidence = {
        schemaVersion: "luckytoken-electron-resource-evidence-v1",
        onlineProviderVerification: {
          performed: false,
          reason: "deterministic local Anthropic-compatible upstream",
        },
        states: {
          backendOnly,
          trayOnly: {
            ...trayOnly,
            browserWindows: 0,
            electronProcessTypes: trayProcessTypes.map((row) => row.type),
          },
          uiOpen: {
            ...uiOpen,
            browserWindows: 1,
            uiColdOpenMs,
            electronProcessTypes: uiProcessTypes.map((row) => row.type),
          },
        },
      };
      assert.ok(evidence.states.backendOnly.processCount >= 1);
      assert.ok(evidence.states.trayOnly.processCount > evidence.states.backendOnly.processCount);
      assert.ok(evidence.states.uiOpen.privateMemoryMiB > 0);
      assert.ok(evidence.states.uiOpen.uiColdOpenMs >= 0);
      const serializedEvidence = `${JSON.stringify(evidence, null, 2)}\n`;
      assert.ok(!serializedEvidence.includes(TEST_PROVIDER_KEY));
      assert.ok(!serializedEvidence.includes(TEST_CODEX_TOKEN));
      await mkdir(join(desktopRoot, ".electron-out"), { recursive: true });
      await writeFile(
        join(desktopRoot, ".electron-out", "product-certification-resource.json"),
        serializedEvidence,
        "utf8",
      );
      process.stdout.write(`LuckyToken product resource evidence: ${JSON.stringify(evidence.states)}\n`);

      const quit = await client.executeApplicationCommand({
        command: "quit",
        acknowledged: true,
      });
      assert.ok(quit.outcome === "drained" || quit.outcome === "timed_out");
      await client.close();
      client = undefined;
      await waitForBackendExit(backend.child);
      assert.notEqual(backend.child.exitCode, null, backend.output());
    } finally {
      if (page !== undefined && !page.isClosed()) await page.close().catch(() => undefined);
      if (client !== undefined) {
        await Promise.race([
          client
            .executeApplicationCommand({ command: "quit", acknowledged: true })
            .catch(() => undefined),
          delay(2_000),
        ]);
        await client.close().catch(() => undefined);
      }
      if (backend.child.exitCode === null) backend.child.kill();
      await waitForBackendExit(backend.child, 2_000);
      if (application !== undefined) {
        const process = application.process();
        const exited = new Promise((resolvePromise) => process.once("exit", resolvePromise));
        await application.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
        await Promise.race([exited, delay(2_000)]);
        if (process.exitCode === null) process.kill();
      }
      await upstream.close().catch(() => undefined);
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
    }
  },
);
