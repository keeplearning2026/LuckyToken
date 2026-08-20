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
 * stopped, rename a model from the Provider-scoped Models card, start
 * serving, make a deterministic request through that model name, and
 * observe it in Overview. The deterministic path never requires an external account or
 * network credential: the local Anthropic-compatible upstream serves the
 * real request, and CommandCode API-key login only stores the typed secret.
 */

const desktopRoot = resolve(import.meta.dirname, "..");

const TEST_PROVIDER_KEY = "deterministic-activation-provider-key";
const TEST_MODEL = "claude-opus-4-7";
const CUSTOM_MODEL_NAME = "activation-anthropic";
const CUSTOM_ALIAS = `anthropic/${CUSTOM_MODEL_NAME}`;
const COMMANDCODE_CUSTOM_MODEL_NAME = "cc-flash";
const COMMANDCODE_CUSTOM_ALIAS = `commandcode-private/${COMMANDCODE_CUSTOM_MODEL_NAME}`;

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

async function sendAnthropicRequest(origin, model) {
  const response = await fetch(`${origin}/v1/messages`, {
    method: "POST",
    headers: {
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
      LUCKYTOKEN_DESKTOP_E2E_NO_LOGIN_ITEM_MUTATION: "1",
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
      // stopped. API-key entry is scoped to a modal card.
      await commandCodeCard.getByRole("button", { name: "API key" }).click();
      const commandCodeLogin = page.getByRole("dialog", {
        name: "CommandCode Private sign in",
      });
      const secretInput = commandCodeLogin.locator('input[type="password"]');
      await secretInput.waitFor();
      await secretInput.fill("sk-activation-commandcode-key");
      await commandCodeLogin.getByRole("button", { name: "Continue" }).click();
      await commandCodeLogin.getByText("Connected", { exact: true }).waitFor();
      await commandCodeLogin.getByRole("button", { name: "Close", exact: true }).click();
      await assert.doesNotReject(async () => {
        const auth = await client.executeAuthCommand({ command: "query" });
        const status = auth.state.providers.find(
          (provider) => provider.providerId === "commandcode-private",
        );
        assert.equal(status?.stored, true);
        assert.equal(status?.unavailable, false);
      });
      assert.equal((await client.getStatus()).modelDataPlane, "stopped");

      // 4. Models are opened from the Provider card; the user sees model
      // names, never the Alias implementation concept.
      await commandCodeCard.getByRole("button", { name: /^Models/u }).click();
      const commandCodeModels = page.getByRole("dialog", {
        name: "CommandCode Private models",
      });
      await commandCodeModels.waitFor();
      assert.equal(await commandCodeModels.getByText(/alias/iu).count(), 0);
      const modelRow = commandCodeModels
        .locator("li.provider-model-row")
        .filter({ hasText: "deepseek/deepseek-v4-flash" });
      await modelRow.waitFor();

      // 5. Rename edits only the model-name suffix. The Provider namespace
      // is fixed in the UI and is constructed again by Backend policy.
      await modelRow.getByRole("button", { name: /rename/i }).click();
      const modelNameEditor = modelRow.locator(".model-name-editor");
      await modelNameEditor.waitFor();
      assert.equal(
        await modelNameEditor.locator(".model-name-prefix").textContent(),
        "commandcode-private/",
      );
      assert.equal(await page.getByText("model-aliases.json").count(), 0);
      const modelNameInput = modelNameEditor.locator('input[type="text"]');
      assert.equal(await modelNameInput.inputValue(), "deepseek-deepseek-v4-flash");
      await modelNameInput.fill(COMMANDCODE_CUSTOM_MODEL_NAME);
      await modelNameEditor.getByRole("button", { name: "Save" }).click();
      await commandCodeModels
        .locator("li.provider-model-row")
        .filter({ hasText: COMMANDCODE_CUSTOM_MODEL_NAME })
        .waitFor();
      await commandCodeModels.getByRole("button", { name: "Close models" }).click();

      // 6. Close and reopen the management UI: model-name state comes from
      // Backend authority, not renderer persistence.
      await page.close();
      page = undefined;
      await waitForNoWindows(application);
      page = await openWindow(application);
      page.setDefaultTimeout(10_000);
      await page.getByRole("button", { name: "Providers" }).click();
      const reopenedCommandCodeCard = page
        .locator("article.provider-card")
        .filter({
          has: page.getByRole("heading", {
            name: "CommandCode Private",
            exact: true,
          }),
        });
      await reopenedCommandCodeCard.getByRole("button", { name: /^Models/u }).click();
      const reopenedCommandCodeModels = page.getByRole("dialog", {
        name: "CommandCode Private models",
      });
      await reopenedCommandCodeModels
        .locator("li.provider-model-row")
        .filter({ hasText: COMMANDCODE_CUSTOM_MODEL_NAME })
        .waitFor();
      await reopenedCommandCodeModels
        .getByRole("button", { name: "Close models" })
        .click();

      const reopenedAnthropicCard = page
        .locator("article.provider-card")
        .filter({ has: page.getByRole("heading", { name: "Anthropic", exact: true }) });
      await reopenedAnthropicCard.waitFor();

      // 7. The internal alias file stores the Provider-namespaced model name;
      // the user never needed to construct that string.
      const aliasFile = JSON.parse(
        await readFile(join(fixture.stateRoot, "model-aliases.json"), "utf8"),
      );
      assert.deepEqual(aliasFile.aliases[COMMANDCODE_CUSTOM_ALIAS], {
        provider: "commandcode-private",
        model: "deepseek/deepseek-v4-flash",
      });

      // 8. Start the Data Plane, log in to the deterministic Anthropic
      // Provider, and rename its model through the same Models card.
      const started = await client.executeRuntimeCommand("start");
      assert.equal(started.outcome, "completed");
      await reopenedAnthropicCard.getByRole("button", { name: "API key" }).click();
      const anthropicLogin = page.getByRole("dialog", {
        name: "Anthropic sign in",
      });
      const anthropicSecret = anthropicLogin.locator('input[type="password"]');
      await anthropicSecret.waitFor();
      await anthropicSecret.fill(TEST_PROVIDER_KEY);
      await anthropicLogin.getByRole("button", { name: "Continue" }).click();
      await anthropicLogin.getByText("Connected", { exact: true }).waitFor();
      await anthropicLogin.getByRole("button", { name: "Close", exact: true }).click();

      await reopenedAnthropicCard.getByRole("button", { name: /^Models/u }).click();
      const anthropicModels = page.getByRole("dialog", { name: "Anthropic models" });
      const anthropicRow = anthropicModels
        .locator("li.provider-model-row")
        .filter({ hasText: TEST_MODEL });
      await anthropicRow.waitFor();
      await anthropicRow.getByRole("button", { name: /rename/i }).click();
      const anthropicModelNameInput = anthropicRow.locator(".model-name-editor input");
      await anthropicModelNameInput.fill(CUSTOM_MODEL_NAME);
      await anthropicRow.getByRole("button", { name: "Save" }).click();
      await anthropicModels
        .locator("li.provider-model-row")
        .filter({ hasText: CUSTOM_MODEL_NAME })
        .waitFor();
      await anthropicModels.getByRole("button", { name: "Close models" }).click();

      // 9. The request uses the internal Provider-namespaced model identity.
      const origin = started.snapshot.dataPlane?.configuredOrigin;
      assert.ok(origin);
      const requestId = await sendAnthropicRequest(origin, CUSTOM_ALIAS);
      assert.equal(upstream.requests.at(-1)?.apiKey, TEST_PROVIDER_KEY);

      // 10. Overview shows the successful request through the real ledger
      // projection, using the client-visible external alias as the Model.
      await page.getByRole("button", { name: "Overview" }).click();
      const row = page.locator(`[data-request-id="${requestId}"]`);
      await row.waitFor();
      const rowText = (await row.textContent()) ?? "";
      assert.match(rowText, /Success/u);
      assert.match(rowText, new RegExp(CUSTOM_ALIAS, "u"));

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
