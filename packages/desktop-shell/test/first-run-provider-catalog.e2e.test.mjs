import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
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
import { resolvePackagedExecutable } from "./support/packaged-executable.mjs";

const desktopRoot = resolve(import.meta.dirname, "..");
const delay = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

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
    if (status.modelDataPlane === "failed" || status.recovery !== undefined) break;
    await delay(50);
  }
  throw new Error(`blank first run did not start: ${JSON.stringify(status)}`);
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

test(
  "a blank installed-user profile starts and shows the built-in Provider catalog",
  { skip: process.platform !== "win32", timeout: 90_000 },
  async () => {
    const executablePath = await resolvePackagedExecutable(desktopRoot);
    const home = await mkdtemp(join(tmpdir(), "luckytoken-first-run-"));
    const appData = join(home, "AppData", "Roaming");
    const localAppData = join(home, "AppData", "Local");
    const stateRoot = join(home, ".luckytoken");
    await Promise.all([
      mkdir(appData, { recursive: true }),
      mkdir(localAppData, { recursive: true }),
    ]);

    let application;
    let client;
    let page;
    try {
      application = await electron.launch({
        executablePath,
        env: {
          ...process.env,
          LUCKYTOKEN_DESKTOP_E2E_NO_LOGIN_ITEM_MUTATION: "1",
          USERPROFILE: home,
          HOME: home,
          CODEX_HOME: join(home, ".codex"),
          APPDATA: appData,
          LOCALAPPDATA: localAppData,
        },
      });
      const endpoint = await waitForEndpoint(join(stateRoot, "control-plane.json"));
      client = await connect(endpoint);
      const status = await waitForRunning(client);
      assert.equal(status.recovery, undefined);

      const catalog = await client.executeCatalogCommand({ command: "query" });
      assert.equal(catalog.outcome, "ok");
      assert.ok(catalog.snapshot.providers.length > 0);
      const providerIds = catalog.snapshot.providers.map(
        (provider) => provider.providerId,
      );
      assert.ok(providerIds.includes("anthropic"));
      assert.ok(providerIds.includes("commandcode-private"));
      assert.ok(providerIds.includes("commandcode-goat"));

      const config = JSON.parse(
        await readFile(join(stateRoot, "config.json"), "utf8"),
      );
      assert.deepEqual(config.server, { port: 3000 });
      assert.equal("host" in config.server, false);
      assert.equal(
        "authFile" in config.clientProtocols["anthropic-messages"],
        false,
      );
      assert.equal(
        "authFile" in config.clientProtocols["openai-responses"],
        false,
      );

      page = await openWindow(application);
      page.setDefaultTimeout(10_000);
      await page.getByRole("button", { name: "Providers" }).click();
      await page
        .getByRole("heading", { name: "CommandCode Private", exact: true })
        .waitFor();
      await page
        .getByRole("heading", { name: "CommandCode Goat", exact: true })
        .waitFor();
      await page
        .getByRole("heading", { name: "Anthropic", exact: true })
        .waitFor();
      assert.ok((await page.locator("article.provider-card").count()) > 0);

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
        const child = application.process();
        if (child.exitCode === null) {
          await application.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
          await Promise.race([
            new Promise((resolvePromise) => child.once("exit", resolvePromise)),
            delay(2_000),
          ]);
          if (child.exitCode === null) child.kill();
        }
      }
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
    }
  },
);
