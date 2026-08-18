import assert from "node:assert/strict";
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
import test from "node:test";

import { _electron as electron } from "playwright";
import {
  connectControlPlane,
  controlPlaneVersion,
  createNodePipeTransport,
  parseControlPlaneDescriptor,
} from "@luckytoken/application-control-plane/control-plane";

/**
 * Provider Activation Spec §23.7 — packaged Electron activation journey
 * (Ticket 14). A fresh packaged LuckyToken completes the real activation
 * flow end to end: discover Providers, authenticate while the Gateway is
 * stopped, edit a model alias from the model row, start serving, make a
 * deterministic request through the custom alias, and observe it in
 * Activity. The deterministic path never requires an external account or
 * network credential: the local Anthropic-compatible upstream serves the
 * real request, and CommandCode API-key login only stores the typed secret.
 */

const desktopRoot = resolve(import.meta.dirname, "..");

const TEST_PROVIDER_KEY = "deterministic-activation-provider-key";
const TEST_MODEL = "claude-opus-4-7";
const CUSTOM_ALIAS = "activation-anthropic";
const COMMANDCODE_DEFAULT_ALIAS = "commandcode-private/deepseek/deepseek-v4-flash";
const COMMANDCODE_CUSTOM_ALIAS = "cc-flash";

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
    throw new Error("failed to allocate activation journey port");
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
    `data: {"type":"message_start","message":{"id":"msg_activation","type":"message","role":"assistant","model":"${model}","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":4,"output_tokens":0}}}`,
    "",
    "event: content_block_start",
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    "",
    "event: content_block_delta",
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"activation journey ok"}}',
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
      url: request.url,
      apiKey: request.headers["x-api-key"],
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
    throw new Error("local upstream did not bind");
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
    const executable = join(outputRoot, entry.name, "LuckyToken-win32-x64", "LuckyToken.exe");
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

async function createFixture(home, upstreamOrigin, dataPlanePort) {
  const stateRoot = join(home, ".luckytoken");
  await mkdir(join(stateRoot, "pi"), { recursive: true });
  await mkdir(join(stateRoot, "client-auth"), { recursive: true });

  // The only authored user file is models.json (the local deterministic
  // Anthropic-compatible upstream). The alias file is deliberately absent:
  // the journey proves generated defaults and model-row alias editing.
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
  return {
    stateRoot,
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

async function waitForState(client, predicate, label) {
  let status;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    status = await client.getStatus();
    if (predicate(status)) return status;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${label}: ${status?.modelDataPlane ?? "unknown"}`);
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

async function sendAnthropicRequest(origin, clientToken, model) {
  const response = await fetch(`${origin}/v1/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${clientToken}`,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 32,
      messages: [{ role: "user", content: "hello activation" }],
    }),
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  assert.match(body, /activation journey ok/u);
  return response.headers.get("x-luckytoken-request-id");
}

async function revealAnthropicClientToken(client) {
  const listed = await client.executeClientTokenCommand({
    command: "list",
    protocolId: "anthropic-messages",
  });
  assert.equal(listed.outcome, "ok");
  assert.ok(
    listed.scopes?.some((scope) => scope.type === "global"),
    "enabled Anthropic protocol must own its boot-created global client token",
  );
  const revealed = await client.executeClientTokenCommand({
    command: "reveal",
    protocolId: "anthropic-messages",
    scope: { type: "global" },
  });
  assert.equal(revealed.outcome, "ok");
  assert.ok(revealed.token);
  return revealed.token;
}

test(
  "packaged Electron completes the full Provider activation journey with the Gateway stopped",
  { skip: process.platform !== "win32", timeout: 180_000 },
  async () => {
    const executablePath = await latestPackagedExecutable();
    const upstream = await startLocalAnthropicUpstream();
    const home = await mkdtemp(join(tmpdir(), "luckytoken-activation-journey-"));
    const dataPlanePort = await freePort();
    const fixture = await createFixture(home, upstream.origin, dataPlanePort);
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
    };

    let application;
    let client;
    let page;
    try {
      application = await electron.launch({ executablePath, env: environment });
      const endpoint = await waitForEndpoint(fixture.descriptorPath);
      client = await connect(endpoint);
      await waitForState(
        client,
        (status) => status.modelDataPlane === "running",
        "initial Data Plane running",
      );

      // 1. Fresh packaged product: the Providers page shows CommandCode
      // Private (LuckyToken-bundled) plus Pi built-ins.
      page = await openWindow(application);
      page.setDefaultTimeout(10_000);
      await page.getByRole("button", { name: "Providers" }).click();
      const commandCodeCard = page
        .locator("article.provider-card")
        .filter({ has: page.getByRole("heading", { name: "CommandCode Private", exact: true }) });
      await commandCodeCard.waitFor();
      assert.match(await commandCodeCard.textContent(), /LuckyToken/u);
      const anthropicCard = page
        .locator("article.provider-card")
        .filter({ has: page.getByRole("heading", { name: "Anthropic", exact: true }) });
      await anthropicCard.waitFor();
      assert.match(await anthropicCard.textContent(), /Built in/u);

      // 2. Stop the Gateway: Provider discovery, Auth query, Catalog query
      // and the visible Providers product surface remain usable.
      const stopped = await client.executeRuntimeCommand("stop");
      assert.equal(stopped.outcome, "completed");
      assert.equal(stopped.snapshot.modelDataPlane, "stopped");
      await commandCodeCard.waitFor();
      await anthropicCard.waitFor();
      const authWhileStopped = await client.executeAuthCommand({ command: "query" });
      assert.equal(authWhileStopped.outcome, "ok");
      const catalogWhileStopped = await client.executeCatalogCommand({ command: "query" });
      assert.equal(catalogWhileStopped.outcome, "ok");

      // 3. Complete a CommandCode API-key login while the Gateway is
      // stopped, through the real Electron Main/preload/Control Plane path.
      await commandCodeCard.getByRole("button", { name: /api key/i }).click();
      const secretInput = page.locator('.auth-interaction input[type="password"]');
      await secretInput.waitFor();
      await secretInput.fill("sk-activation-commandcode-key");
      await page.getByRole("button", { name: "Continue" }).click();
      await page
        .getByRole("status")
        .filter({ hasText: /CommandCode Private connected/i })
        .waitFor();
      await assert.doesNotReject(async () => {
        const auth = await client.executeAuthCommand({ command: "query" });
        const status = auth.state.providers.find(
          (provider) => provider.providerId === "commandcode-private",
        );
        assert.equal(status?.stored, true);
        assert.equal(status?.unavailable, false);
      });
      assert.equal((await client.getStatus()).modelDataPlane, "stopped");

      // 4. The model row shows the generated providerId/modelId default
      // alias before any user alias configuration.
      const knownModels = page.locator(".provider-model-list");
      await knownModels.waitFor();
      const modelRow = knownModels
        .locator("li.provider-model-row")
        .filter({ hasText: COMMANDCODE_DEFAULT_ALIAS });
      await modelRow.waitFor();

      // 5. Use the model-row Add alias action to save a custom alias; the
      // editor exposes no Provider selector or raw file mechanics.
      await modelRow.getByRole("button", { name: /add alias/i }).click();
      const aliasInput = page.locator('.alias-editor input[type="text"]');
      await aliasInput.waitFor();
      assert.equal(await page.locator(".alias-editor select").count(), 0);
      assert.equal(await page.getByText("model-aliases.json").count(), 0);
      await aliasInput.fill(COMMANDCODE_CUSTOM_ALIAS);
      await page.getByRole("button", { name: "Save", exact: true }).click();
      const updatedRow = knownModels
        .locator("li.provider-model-row")
        .filter({ hasText: COMMANDCODE_CUSTOM_ALIAS });
      await updatedRow.waitFor();

      // 6. Close and reopen the management UI: alias state comes from the
      // Backend, not renderer persistence.
      await page.close();
      page = undefined;
      await waitForNoWindows(application);
      page = await openWindow(application);
      page.setDefaultTimeout(10_000);
      await page.getByRole("button", { name: "Providers" }).click();
      const reopenedAnthropicCard = page
        .locator("article.provider-card")
        .filter({ has: page.getByRole("heading", { name: "Anthropic", exact: true }) });
      await reopenedAnthropicCard.waitFor();
      const reopenedKnownModels = page.locator(".provider-model-list");
      await reopenedKnownModels.waitFor();
      await reopenedKnownModels
        .locator("li.provider-model-row")
        .filter({ hasText: COMMANDCODE_CUSTOM_ALIAS })
        .waitFor();

      // 7. The user alias file stores only the override; the generated
      // default for the same target is suppressed.
      const aliasFile = JSON.parse(
        await readFile(join(fixture.stateRoot, "model-aliases.json"), "utf8"),
      );
      assert.deepEqual(aliasFile.aliases[COMMANDCODE_CUSTOM_ALIAS], {
        provider: "commandcode-private",
        model: "deepseek/deepseek-v4-flash",
      });

      // 8. Start the Data Plane without restarting the Backend; then log in
      // to the deterministic Anthropic provider and give its model a custom
      // alias through the same model-row action.
      const started = await client.executeRuntimeCommand("start");
      assert.equal(started.outcome, "completed");
      await reopenedAnthropicCard.getByRole("button", { name: /api key/i }).click();
      const anthropicSecret = page.locator('.auth-interaction input[type="password"]');
      await anthropicSecret.waitFor();
      await anthropicSecret.fill(TEST_PROVIDER_KEY);
      await page.getByRole("button", { name: "Continue" }).click();
      await page
        .getByRole("status")
        .filter({ hasText: /Anthropic connected/i })
        .waitFor();
      const anthropicRow = page
        .locator(".provider-model-list li.provider-model-row")
        .filter({ hasText: `anthropic/${TEST_MODEL}` });
      await anthropicRow.waitFor();
      await anthropicRow.getByRole("button", { name: /add alias/i }).click();
      const anthropicAliasInput = page.locator('.alias-editor input[type="text"]');
      await anthropicAliasInput.fill(CUSTOM_ALIAS);
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page
        .locator(".provider-model-list li.provider-model-row")
        .filter({ hasText: CUSTOM_ALIAS })
        .waitFor();

      // 9. Send a real deterministic request using the custom alias through
      // the production protocol/Provider execution path.
      const clientToken = await revealAnthropicClientToken(client);
      const origin = started.snapshot.dataPlane?.configuredOrigin;
      assert.ok(origin);
      const requestId = await sendAnthropicRequest(origin, clientToken, CUSTOM_ALIAS);
      assert.equal(upstream.requests.at(-1)?.apiKey, TEST_PROVIDER_KEY);

      // 10. Activity shows the successful request through the real ledger
      // projection.
      await page.getByRole("button", { name: "Activity" }).click();
      const row = page.locator(`[data-request-id="${requestId}"]`);
      await row.waitFor();
      assert.match((await row.textContent()) ?? "", /success/u);

      const quit = await client.executeApplicationCommand({
        command: "quit",
        acknowledged: true,
      });
      assert.ok(quit.outcome === "drained" || quit.outcome === "timed_out");
      await client.close();
      client = undefined;
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
