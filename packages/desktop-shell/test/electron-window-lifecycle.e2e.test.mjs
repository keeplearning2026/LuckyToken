import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

async function writeConfig(home, port) {
  const root = join(home, ".luckytoken");
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "config.json"),
    `${JSON.stringify(
      {
        schemaVersion: "luckytoken-config-v2",
        server: { port },
        clientProtocols: {
          "anthropic-messages": {
            conversion: {
              request: {
                unknownContent: "error",
                localCacheControl: "ignore",
              },
              response: { unknownPiContent: "error" },
            },
          },
          "openai-responses": {
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
        diagnostics: {
          directory: "state/request-diagnostics",
          successArtifacts: { enabled: false },
          maxJourneyArtifactBytes: 4194304,
          artifactRetentionAgeMs: 604800000,
          maxArtifactJourneys: 1000,
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
  throw new Error(
    `Data Plane did not reach running state: ${JSON.stringify(status)}`,
  );
}

async function waitForBackendReplacement(
  descriptorPath,
  previousPid,
  expectedBuildId,
) {
  let lastError;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    let candidate;
    try {
      const endpoint = parseControlPlaneDescriptor(
        JSON.parse(await readFile(descriptorPath, "utf8")),
      );
      candidate = await connectControlPlane(endpoint, {
        createRequestId: randomUUID,
        pipeConnector: createNodePipeTransport(),
      });
      const hello = await candidate.hello(controlPlaneVersion);
      assert.equal(hello.type, "compatible");
      const status = await candidate.getStatus();
      if (
        status.ownership?.owner.pid !== previousPid &&
        hello.application.buildId === expectedBuildId
      ) {
        return { client: candidate, hello, status };
      }
    } catch (error) {
      lastError = error;
    }
    await candidate?.close().catch(() => undefined);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw lastError ?? new Error("current bundled Backend did not replace the stale desktop Backend");
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

async function waitForProcessExit(child, message) {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise((resolvePromise) => child.once("exit", resolvePromise)),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(message)), 5_000),
    ),
  ]);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid, message, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!processExists(pid)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(message);
}

test(
  "packaged Electron destroys and reconstructs the renderer while Backend stays authoritative",
  { skip: process.platform !== "win32", timeout: 90_000 },
  async () => {
    const executablePath = await resolvePackagedExecutable(desktopRoot);
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
          LUCKYTOKEN_DESKTOP_E2E_NO_LOGIN_ITEM_MUTATION: "1",
          USERPROFILE: home,
          HOME: home,
          CODEX_HOME: join(home, ".codex"),
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

      const second = await openWindow(application);
      second.setDefaultTimeout(10_000);
      await second.getByRole("button", { name: "Settings" }).click();
      await second.getByRole("tab", { name: "Advanced" }).click();
      await second.getByRole("heading", { name: "Recent Runtime Events" }).waitFor();
      assert.equal(application.windows().length, 1);

      await second.close();
      await waitForNoWindows(application);

      const third = await openWindow(application);
      third.setDefaultTimeout(10_000);
      await third.getByRole("button", { name: "Settings" }).click();
      await third.getByRole("tab", { name: "Advanced" }).click();
      await third.getByRole("heading", { name: "Recent Runtime Events" }).waitFor();
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

test(
  "a desktop-owned Backend retires after its Electron owner is forcibly terminated",
  { skip: process.platform !== "win32", timeout: 90_000 },
  async () => {
    const executablePath = await resolvePackagedExecutable(desktopRoot);
    const home = await mkdtemp(join(tmpdir(), "luckytoken-electron-owner-lease-"));
    const port = await freePort();
    const descriptorPath = await writeConfig(home, port);
    const appData = join(home, "AppData", "Roaming");
    const localAppData = join(home, "AppData", "Local");
    await Promise.all([mkdir(appData, { recursive: true }), mkdir(localAppData, { recursive: true })]);

    let application;
    let client;
    let backendPid;
    let electronMainPid;
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
      const endpoint = await waitForEndpoint(descriptorPath);
      client = await connect(endpoint);
      const status = await client.getStatus();
      assert.equal(status.ownership?.owner.kind, "desktop");
      backendPid = status.ownership?.owner.pid;
      assert.ok(backendPid, "desktop-owned Backend must publish its owner PID");
      assert.equal(application.windows().length, 0, "tray-first startup must not require a renderer");
      electronMainPid = await application.evaluate(() => process.pid);
      assert.ok(processExists(electronMainPid), "Electron Main PID must exist before forced termination");

      process.kill(electronMainPid);
      await waitForPidExit(
        electronMainPid,
        "Electron Main did not exit after the forced termination",
        5_000,
      );

      await Promise.race([
        client.disconnected,
        (async () => {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 17_000));
          const probe = await client.executeApplicationCommand({
            command: "desktop_owner",
            action: "claim",
            leaseId: "packaged-e2e-diagnostic-claim",
          });
          throw new Error(
            `desktop-owned Backend remained connected after lease expiry; lease probe outcome=${probe.outcome}`,
          );
        })(),
      ]);
      await waitForPidExit(
        backendPid,
        "desktop-owned Backend process remained alive after owner lease expiry",
        5_000,
      );
      await client.close().catch(() => undefined);
      client = undefined;
      await application.close().catch(() => undefined);
      application = undefined;
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
        if (electronMainPid !== undefined && processExists(electronMainPid)) {
          process.kill(electronMainPid);
        }
        await application.close().catch(() => undefined);
      }
      if (backendPid !== undefined && processExists(backendPid)) {
        // Cleanup only: the assertion above proves the product behavior.
        // If it failed, a direct Control Plane quit was already attempted.
        await waitForPidExit(backendPid, "Backend cleanup did not finish", 5_000).catch(() => undefined);
      }
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
    }
  },
);

test(
  "a repository packaged build is never blocked by a product-domain legacy shell",
  { skip: process.platform !== "win32", timeout: 90_000 },
  async () => {
    const repositoryExecutable = await resolvePackagedExecutable(desktopRoot);
    const root = await mkdtemp(join(tmpdir(), "luckytoken-electron-instance-domain-"));
    const installedDirectory = join(root, "installed", "LuckyToken-win32-x64");
    await cp(dirname(repositoryExecutable), installedDirectory, { recursive: true });
    const legacyExecutable = join(installedDirectory, "LuckyToken.exe");
    const legacyBuildId = "0".repeat(64);
    await writeFile(
      join(installedDirectory, "resources", "backend", "build-id.txt"),
      `${legacyBuildId}\n`,
      "utf8",
    );
    const expectedBuildId = (
      await readFile(
        join(dirname(repositoryExecutable), "resources", "backend", "build-id.txt"),
        "utf8",
      )
    ).trim();
    assert.match(expectedBuildId, /^[a-f0-9]{64}$/u);
    assert.notEqual(expectedBuildId, legacyBuildId);
    const home = join(root, "home");
    const port = await freePort();
    const descriptorPath = await writeConfig(home, port);
    const appData = join(home, "AppData", "Roaming");
    const localAppData = join(home, "AppData", "Local");
    await Promise.all([mkdir(appData, { recursive: true }), mkdir(localAppData, { recursive: true })]);
    const environment = {
      ...process.env,
      LUCKYTOKEN_DESKTOP_E2E_NO_LOGIN_ITEM_MUTATION: "1",
      USERPROFILE: home,
      HOME: home,
      CODEX_HOME: join(home, ".codex"),
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
    };

    let legacy;
    let legacyProcess;
    let current;
    let currentProcess;
    let client;
    try {
      legacy = await electron.launch({
        executablePath: legacyExecutable,
        env: environment,
      });
      legacyProcess = legacy.process();
      const endpoint = await waitForEndpoint(descriptorPath);
      client = await connect(endpoint);
      const legacyHello = await client.hello(controlPlaneVersion);
      assert.equal(legacyHello.type, "compatible");
      assert.equal(legacyHello.application.buildId, legacyBuildId);
      const before = await waitForRunning(client);
      const backendPid = before.ownership?.owner.pid;
      assert.ok(backendPid);

      current = await electron.launch({
        executablePath: repositoryExecutable,
        env: environment,
      });
      currentProcess = current.process();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));

      assert.equal(
        legacyProcess.exitCode,
        null,
        "legacy product-domain shell may remain alive during the one-time transition",
      );
      assert.equal(
        currentProcess.exitCode,
        null,
        "repository build must not be rejected by a legacy product-domain lock",
      );
      const legacyUserData = await legacy.evaluate(({ app }) => app.getPath("userData"));
      const currentUserData = await current.evaluate(({ app }) => app.getPath("userData"));
      assert.notEqual(currentUserData, legacyUserData);
      assert.match(
        currentUserData.replaceAll("\\", "/"),
        /@luckytoken\/desktop-shell-builds\/[a-f0-9]{32}$/u,
      );

      await Promise.race([
        client.disconnected,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("legacy desktop Backend remained connected")),
            10_000,
          ),
        ),
      ]);
      await client.close().catch(() => undefined);
      client = undefined;

      const replacement = await waitForBackendReplacement(
        descriptorPath,
        backendPid,
        expectedBuildId,
      );
      client = replacement.client;
      const after = await waitForRunning(client);
      assert.notEqual(
        after.ownership?.owner.pid,
        backendPid,
        "repository build must replace a stale desktop-owned Backend build",
      );
      assert.equal(replacement.hello.application.buildId, expectedBuildId);

      const page = await openWindow(current);
      page.setDefaultTimeout(10_000);
      await page.getByRole("button", { name: "Overview", exact: true }).waitFor();
      await page.getByText("Running", { exact: true }).waitFor();
      await page.close();
      await waitForNoWindows(current);

      const quit = await client.executeApplicationCommand({
        command: "quit",
        acknowledged: true,
      });
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
      for (const [application, child] of [
        [current, currentProcess],
        [legacy, legacyProcess],
      ]) {
        if (application === undefined || child === undefined || child.exitCode !== null) {
          continue;
        }
        await application.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
        await Promise.race([
          new Promise((resolvePromise) => child.once("exit", resolvePromise)),
          new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000)),
        ]);
        if (child.exitCode === null) child.kill();
      }
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  },
);

test(
  "a newly launched packaged shell path replaces a stale primary without restarting the Backend",
  { skip: process.platform !== "win32", timeout: 90_000 },
  async () => {
    const sourceExecutable = await resolvePackagedExecutable(desktopRoot);
    const root = await mkdtemp(join(tmpdir(), "luckytoken-electron-handoff-"));
    const primaryDirectory = join(root, "primary");
    const replacementDirectory = join(root, "replacement");
    await Promise.all([
      cp(dirname(sourceExecutable), primaryDirectory, { recursive: true }),
      cp(dirname(sourceExecutable), replacementDirectory, { recursive: true }),
    ]);
    const primaryExecutable = join(primaryDirectory, "LuckyToken.exe");
    const replacementExecutable = join(replacementDirectory, "LuckyToken.exe");
    const home = join(root, "home");
    const port = await freePort();
    const descriptorPath = await writeConfig(home, port);
    const appData = join(home, "AppData", "Roaming");
    const localAppData = join(home, "AppData", "Local");
    await Promise.all([mkdir(appData, { recursive: true }), mkdir(localAppData, { recursive: true })]);
    const environment = {
      ...process.env,
      LUCKYTOKEN_DESKTOP_E2E_NO_LOGIN_ITEM_MUTATION: "1",
      USERPROFILE: home,
      HOME: home,
      CODEX_HOME: join(home, ".codex"),
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
    };

    let primary;
    let primaryProcess;
    let replacement;
    let replacementProcess;
    let client;
    try {
      primary = await electron.launch({
        executablePath: primaryExecutable,
        env: environment,
      });
      primaryProcess = primary.process();
      const endpoint = await waitForEndpoint(descriptorPath);
      client = await connect(endpoint);
      const before = await waitForRunning(client);
      const backendPid = before.ownership?.owner.pid;
      assert.ok(backendPid, "desktop-owned Backend must expose its owner pid");
      assert.equal(primary.windows().length, 0);

      replacement = await electron.launch({
        executablePath: replacementExecutable,
        env: environment,
      });
      replacementProcess = replacement.process();

      await waitForProcessExit(
        primaryProcess,
        "stale Electron shell did not exit during build handoff",
      );
      assert.equal(
        replacementProcess.exitCode,
        null,
        "replacement Electron shell must remain alive",
      );

      const after = await client.getStatus();
      assert.equal(
        after.ownership?.owner.pid,
        backendPid,
        "desktop shell handoff must preserve the authoritative Backend process",
      );
      assert.equal(after.modelDataPlane, "running");

      const page = await openWindow(replacement);
      page.setDefaultTimeout(10_000);
      await page.getByRole("button", { name: "Overview", exact: true }).waitFor();
      assert.equal(replacement.windows().length, 1);
      await page.close();
      await waitForNoWindows(replacement);

      const quit = await client.executeApplicationCommand({
        command: "quit",
        acknowledged: true,
      });
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
      for (const [application, child] of [
        [replacement, replacementProcess],
        [primary, primaryProcess],
      ]) {
        if (application === undefined || child === undefined || child.exitCode !== null) {
          continue;
        }
        await application.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
        await Promise.race([
          new Promise((resolvePromise) => child.once("exit", resolvePromise)),
          new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000)),
        ]);
        if (child.exitCode === null) child.kill();
      }
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  },
);
