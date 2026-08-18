import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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

const desktopRoot = resolve(import.meta.dirname, "..");

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("failed to allocate E2E TCP port");
  }
  const port = address.port;
  await new Promise((resolvePromise, reject) => {
    server.close((error) => (error === undefined ? resolvePromise() : reject(error)));
  });
  return port;
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
      // Ignore partial/other-platform package outputs.
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const latest = candidates[0];
  if (latest === undefined) throw new Error("no packaged LuckyToken executable found");
  return latest.executable;
}

async function writeConfig(home, port) {
  const root = join(home, ".luckytoken");
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "config.json"),
    `${JSON.stringify(
      {
        schemaVersion: "luckytoken-config-v1",
        server: { host: "127.0.0.1", port },
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
  return join(root, "control-plane.json");
}

async function waitForEndpoint(descriptorPath) {
  let lastError;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return parseControlPlaneDescriptor(JSON.parse(await readFile(descriptorPath, "utf8")));
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
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
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
  }
  throw lastError ?? new Error("Control Plane did not become connectable");
}

async function waitForRunning(client) {
  let status;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    status = await client.getStatus();
    if (status.modelDataPlane === "running") return status;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Data Plane did not reach running state: ${status?.modelDataPlane ?? "unknown"}`);
}

async function openWindow(application) {
  await application.evaluate(({ app }) => {
    app.emit("second-instance", {}, [], "");
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const windows = application.windows();
    if (windows.length === 1) return windows[0];
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("management window did not open");
}

async function waitForNoWindows(application) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (application.windows().length === 0) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("management window did not close");
}

test(
  "packaged Electron destroys and reconstructs the renderer while Backend stays authoritative",
  { skip: process.platform !== "win32", timeout: 90_000 },
  async () => {
    const executablePath = await latestPackagedExecutable();
    const home = await mkdtemp(join(tmpdir(), "luckytoken-electron-e2e-"));
    const port = await freePort();
    const descriptorPath = await writeConfig(home, port);
    const appData = join(home, "AppData", "Roaming");
    const localAppData = join(home, "AppData", "Local");
    await Promise.all([mkdir(appData, { recursive: true }), mkdir(localAppData, { recursive: true })]);

    let application;
    let client;
    try {
      application = await electron.launch({
        executablePath,
        env: {
          ...process.env,
          USERPROFILE: home,
          HOME: home,
          APPDATA: appData,
          LOCALAPPDATA: localAppData,
        },
      });

      const endpoint = await waitForEndpoint(descriptorPath);
      client = await connect(endpoint);
      await client.getStatus();
      assert.equal(application.windows().length, 0, "tray startup must create no renderer window");

      const first = await openWindow(application);
      first.setDefaultTimeout(10_000);
      await first.getByRole("button", { name: "Settings" }).waitFor();
      assert.equal(application.windows().length, 1);

      await first.close();
      await waitForNoWindows(application);

      const running = await waitForRunning(client);
      const origin = running.dataPlane?.configuredOrigin;
      assert.ok(origin, "running status must expose the configured Data Plane origin");
      const dataPlaneResponse = await fetch(`${origin}/v1/models`);
      assert.ok(dataPlaneResponse.status >= 100, "Data Plane must remain reachable while UI is closed");

      const enabled = await client.executeSettingsCommand({
        command: "set",
        key: "diagnostics.deepCapture.enabled",
        value: true,
      });
      assert.equal(enabled.settings["diagnostics.deepCapture.enabled"]?.value, true);

      const second = await openWindow(application);
      second.setDefaultTimeout(10_000);
      await second.getByRole("button", { name: "Settings" }).click();
      await second.getByRole("tab", { name: "Advanced" }).click();
      await second.getByRole("button", { name: "Disable deep diagnostics" }).waitFor();
      assert.equal(application.windows().length, 1);

      await second.close();
      await waitForNoWindows(application);
      const disabled = await client.executeSettingsCommand({
        command: "set",
        key: "diagnostics.deepCapture.enabled",
        value: false,
      });
      assert.equal(disabled.settings["diagnostics.deepCapture.enabled"]?.value, false);

      const third = await openWindow(application);
      third.setDefaultTimeout(10_000);
      await third.getByRole("button", { name: "Settings" }).click();
      await third.getByRole("tab", { name: "Advanced" }).click();
      await third.getByRole("button", { name: "Enable deep diagnostics" }).waitFor();
      assert.equal(application.windows().length, 1, "reopen must create exactly one fresh renderer");
      await third.close();
      await waitForNoWindows(application);

      const quit = await client.executeApplicationCommand({ command: "quit", acknowledged: true });
      assert.ok(quit.outcome === "drained" || quit.outcome === "timed_out");
      await client.close();
      client = undefined;
    } finally {
      if (client !== undefined) {
        await Promise.race([
          client
            .executeApplicationCommand({ command: "quit", acknowledged: true })
            .catch(() => undefined),
          new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000)),
        ]);
        await client.close().catch(() => undefined);
      }
      if (application !== undefined) {
        const process = application.process();
        const exited = new Promise((resolvePromise) => process.once("exit", resolvePromise));
        await application.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
        await Promise.race([
          exited,
          new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000)),
        ]);
        if (process.exitCode === null) process.kill();
      }
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
    }
  },
);
