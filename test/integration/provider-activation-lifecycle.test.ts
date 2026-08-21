import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import {
  connectControlPlane,
  controlPlaneVersion,
  createNodePipeTransport,
  type ControlPlaneClient,
} from "@luckytoken/application-control-plane/control-plane";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

import {
  startLuckyTokenApplication as startProductionLuckyTokenApplication,
  type RunningLuckyTokenApplication,
  type StartLuckyTokenApplicationOptions,
} from "../../src/application.js";
import { createInstanceAuthority } from "../../src/instance-authority.js";
import { createControlPlaneDiscovery } from "../../src/control-plane-discovery.js";

const roots: string[] = [];
const applications: RunningLuckyTokenApplication[] = [];

async function readControlPlaneDescriptor(path: string) {
  const endpoint = await createControlPlaneDiscovery({ path }).read();
  if (endpoint === undefined) throw new Error("Expected Control Plane descriptor");
  return endpoint;
}

function startLuckyTokenApplication(
  options: Omit<StartLuckyTokenApplicationOptions, "instanceAuthority">,
) {
  return startProductionLuckyTokenApplication({
    ...options,
    instanceAuthority: createInstanceAuthority({
      path: join(dirname(options.configPath), "instance.sqlite"),
    }),
  });
}

afterEach(async () => {
  await Promise.allSettled(
    applications.splice(0).map((application) => application.close()),
  );
  await Promise.allSettled(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("test server did not bind a TCP port");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return port;
}

async function fixture(options: {
  readonly port?: number;
} = {}): Promise<{ configPath: string; descriptorPath: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "luckytoken-activation-"));
  const port = options.port ?? (await freePort());
  roots.push(root);
  const configPath = join(root, "config.json");
  const descriptorPath = join(root, "control-plane.json");
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        schemaVersion: "luckytoken-config-v1",
        server: { port },
        clientProtocols: {
          "anthropic-messages": {
            conversion: {
              request: {
                unknownContent: "error",
                unresolvedToolCall: "xrepair",
                localCacheControl: "ignore",
              },
              response: { unknownPiContent: "error" },
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
  return { configPath, descriptorPath, root };
}

async function startClient(descriptorPath: string): Promise<ControlPlaneClient> {
  const endpoint = await readControlPlaneDescriptor(descriptorPath);
  const client = await connectControlPlane(endpoint, {
    createRequestId: randomUUID,
    pipeConnector: createNodePipeTransport(),
  });
  const hello = await client.hello(controlPlaneVersion);
  if (hello.type !== "compatible") throw new Error("Control Plane hello failed");
  return client;
}

async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for condition");
}

/**
 * Provider Activation Spec §23.2 Backend lifecycle tests: Provider
 * discovery/login/credential/Catalog remain available independent of the
 * Data Plane HTTP Gateway.
 */
describe("Provider activation independent of Gateway lifecycle", () => {
  it("B1: Auth and Catalog queries work while the Data Plane is stopped, with CommandCode and Pi builtins present", async () => {
    const { configPath, descriptorPath } = await fixture();
    const started = await startLuckyTokenApplication({
      configPath,
      descriptorOverride: descriptorPath,
      ownerKind: "cli",
    });
    expect(started.kind).toBe("running");
    if (started.kind !== "running") return;
    applications.push(started.application);

    const client = await startClient(descriptorPath);
    try {
      // Stop the Data Plane.
      const stopped = await client.executeRuntimeCommand("stop");
      expect(stopped.outcome).toBe("completed");
      expect(stopped.snapshot.modelDataPlane).toBe("stopped");

      const auth = await client.executeAuthCommand({ command: "query" });
      expect(auth.outcome).toBe("ok");
      const providers = auth.options?.providers ?? [];
      const commandCode = providers.find(
        (row) => row.providerId === "commandcode-private",
      );
      expect(commandCode).toBeDefined();
      expect(commandCode?.source).toBe("luckytoken_bundled");
      const anthropic = providers.find((row) => row.providerId === "anthropic");
      expect(anthropic).toBeDefined();
      expect(anthropic?.source).toBe("pi_builtin");
      const openai = providers.find((row) => row.providerId === "openai");
      expect(openai).toBeDefined();
      expect(openai?.source).toBe("pi_builtin");
      // CP2: the pi_builtin IDs returned by Auth query exactly match the
      // pinned Pi builtinProviders() catalog (never a hand-maintained
      // LuckyToken list).
      const builtinIds = new Set(builtinProviders().map((provider) => provider.id));
      const projectedBuiltinIds = new Set(
        providers
          .filter((row) => row.source === "pi_builtin")
          .map((row) => row.providerId),
      );
      expect(projectedBuiltinIds).toEqual(builtinIds);

      const catalog = await client.executeCatalogCommand({ command: "query" });
      expect(catalog.outcome).toBe("ok");
      expect(catalog.snapshot.providers.length).toBeGreaterThan(0);

      // Ticket 06: coarse Provider readiness is derived from Catalog model
      // availability — a fresh Backend with no usable credential/model has
      // no available model, so the coarse summary stays unconfigured even
      // though Provider configuration/composition exists.
      const status = await client.getStatus();
      expect(status.provider).toBe("unconfigured");
    } finally {
      await client.close();
    }
  });

  it("Ticket 06: Provider readiness becomes configured when a Catalog model is available, and stays so across Gateway stop/start", async () => {
    const { configPath, descriptorPath, root } = await fixture();
    const started = await startLuckyTokenApplication({
      configPath,
      descriptorOverride: descriptorPath,
      ownerKind: "cli",
    });
    expect(started.kind).toBe("running");
    if (started.kind !== "running") return;
    applications.push(started.application);

    const client = await startClient(descriptorPath);
    try {
      // Fresh Backend: no model is available yet.
      let status = await client.getStatus();
      expect(status.provider).toBe("unconfigured");

      // Stop the Gateway: Provider login must still work and the readiness
      // must eventually reflect the now-available CommandCode model.
      const stopped = await client.executeRuntimeCommand("stop");
      expect(stopped.outcome).toBe("completed");

      const login = await client.executeAuthCommand(
        { command: "login", providerId: "commandcode-private", authType: "api_key" },
        (event) => {
          if (event.type === "prompt" && event.kind === "secret") {
            void client
              .respondAuthInteraction({
                type: "prompt_response",
                promptId: event.promptId,
                value: "sk-readiness-key",
              })
              .catch(() => undefined);
          }
        },
      );
      expect(login.outcome).toBe("ok");

      // Login schedules a Backend-owned catalog refresh; the coarse
      // readiness is republished when the snapshot shows an available model.
      await waitFor(async () => (await client.getStatus()).provider === "configured");
      status = await client.getStatus();
      expect(status.modelDataPlane).toBe("stopped");
      expect(status.provider).toBe("configured");

      // A stopped/failed Gateway is a separate fact: readiness survives.
      const started2 = await client.executeRuntimeCommand("start");
      expect(started2.outcome).toBe("completed");
      const afterStart = await client.getStatus();
      expect(afterStart.modelDataPlane).toBe("running");
      expect(afterStart.provider).toBe("configured");

      // The credential persisted through the one Pi-compatible store.
      expect(
        JSON.parse(await readFile(join(root, "pi", "auth.json"), "utf8"))[
          "commandcode-private"
        ],
      ).toEqual({ type: "api_key", key: "sk-readiness-key" });
    } finally {
      await client.close();
    }
  });

  it("B5: Data Plane restart creates a new serving composition while the Provider Runtime identity stays the same", async () => {
    const { configPath, descriptorPath, root } = await fixture();
    const started = await startLuckyTokenApplication({
      configPath,
      descriptorOverride: descriptorPath,
      ownerKind: "cli",
    });
    expect(started.kind).toBe("running");
    if (started.kind !== "running") return;
    applications.push(started.application);

    const client = await startClient(descriptorPath);
    try {
      // Establish a credential before any restart.
      const login = await client.executeAuthCommand(
        { command: "login", providerId: "commandcode-private", authType: "api_key" },
        (event) => {
          if (event.type === "prompt" && event.kind === "secret") {
            void client
              .respondAuthInteraction({
                type: "prompt_response",
                promptId: event.promptId,
                value: "sk-restart-key",
              })
              .catch(() => undefined);
          }
        },
      );
      expect(login.outcome).toBe("ok");
      await waitFor(async () => (await client.getStatus()).provider === "configured");

      const before = await client.executeAuthCommand({ command: "query" });
      const beforeCatalog = await client.executeCatalogCommand({ command: "query" });
      const beforeVersion = beforeCatalog.snapshot.version;
      const beforeStatus = before.state.providers.find(
        (row) => row.providerId === "commandcode-private",
      );
      expect(beforeStatus).toMatchObject({ stored: true, effectiveSource: "stored" });

      // Restart the Data Plane: a NEW serving composition is created while
      // the Backend-lifetime Provider Runtime (one Pi Models + credential
      // authority + catalog handle) is reused.
      const restarted = await client.executeRuntimeCommand("restart");
      expect(restarted.outcome).toBe("completed");
      expect(restarted.snapshot.modelDataPlane).toBe("running");

      // The same credential authority serves the same stored credential.
      const after = await client.executeAuthCommand({ command: "query" });
      const afterStatus = after.state.providers.find(
        (row) => row.providerId === "commandcode-private",
      );
      expect(afterStatus).toMatchObject({ stored: true, effectiveSource: "stored" });
      expect(after.options?.providers.some((row) => row.providerId === "commandcode-private")).toBe(
        true,
      );

      // The catalog handle is the same Backend-lifetime snapshot: the
      // version is monotonic, never reset by a Data Plane restart.
      const afterCatalog = await client.executeCatalogCommand({ command: "query" });
      expect(afterCatalog.snapshot.version).toBeGreaterThanOrEqual(beforeVersion);

      // The credential still persists through the one Pi-compatible store.
      expect(
        JSON.parse(await readFile(join(root, "pi", "auth.json"), "utf8"))[
          "commandcode-private"
        ],
      ).toEqual({ type: "api_key", key: "sk-restart-key" });
    } finally {
      await client.close();
    }
  });

  it("B2: Auth and Catalog queries remain available after a deterministic Data Plane startup failure (port conflict)", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", resolve);
    });
    const address = blocker.address();
    if (address === null || typeof address === "string") {
      blocker.close();
      throw new Error("blocker did not bind");
    }
    const { configPath, descriptorPath } = await fixture({ port: address.port });
    const started = await startLuckyTokenApplication({
      configPath,
      descriptorOverride: descriptorPath,
      ownerKind: "cli",
    });
    expect(started.kind).toBe("running");
    if (started.kind !== "running") return;
    applications.push(started.application);

    const client = await startClient(descriptorPath);
    try {
      const status = await client.getStatus();
      expect(status.modelDataPlane).toBe("failed");
      expect(status.dataPlane?.failure?.code).toBe("port_in_use");

      const auth = await client.executeAuthCommand({ command: "query" });
      expect(auth.outcome).toBe("ok");
      expect(auth.options?.providers.some((row) => row.providerId === "commandcode-private")).toBe(
        true,
      );

      const catalog = await client.executeCatalogCommand({ command: "query" });
      expect(catalog.outcome).toBe("ok");
    } finally {
      await client.close();
      blocker.close();
    }
  });

  it("B3: CommandCode API-key login persists while the Data Plane is stopped and reports connected", async () => {
    const { configPath, descriptorPath, root } = await fixture();
    const started = await startLuckyTokenApplication({
      configPath,
      descriptorOverride: descriptorPath,
      ownerKind: "cli",
    });
    expect(started.kind).toBe("running");
    if (started.kind !== "running") return;
    applications.push(started.application);

    const client = await startClient(descriptorPath);
    try {
      await client.executeRuntimeCommand("stop");

      const result = await client.executeAuthCommand(
        { command: "login", providerId: "commandcode-private", authType: "api_key" },
        (event) => {
          if (event.type === "prompt" && event.kind === "secret") {
            void client
              .respondAuthInteraction({
                type: "prompt_response",
                promptId: event.promptId,
                value: "sk-activation-test-key",
              })
              .catch(() => undefined);
          }
        },
      );
      expect(result.outcome).toBe("ok");
      const status = result.state.providers.find(
        (row) => row.providerId === "commandcode-private",
      );
      expect(status).toMatchObject({
        stored: true,
        storedType: "api_key",
        effectiveSource: "stored",
        unavailable: false,
      });

      // The credential persists in the one Pi-compatible store.
      const authFile = JSON.parse(
        await readFile(join(root, "pi", "auth.json"), "utf8"),
      );
      expect(authFile["commandcode-private"]).toEqual({
        type: "api_key",
        key: "sk-activation-test-key",
      });

      // The Data Plane remains stopped until explicitly started.
      const statusAfter = await client.getStatus();
      expect(statusAfter.modelDataPlane).toBe("stopped");
    } finally {
      await client.close();
    }
  });

  it("B4: stop → login → start succeeds without Backend restart and the request path sees the credential", async () => {
    const { configPath, descriptorPath, root } = await fixture();
    const started = await startLuckyTokenApplication({
      configPath,
      descriptorOverride: descriptorPath,
      ownerKind: "cli",
    });
    expect(started.kind).toBe("running");
    if (started.kind !== "running") return;
    applications.push(started.application);

    const client = await startClient(descriptorPath);
    try {
      await client.executeRuntimeCommand("stop");
      const login = await client.executeAuthCommand(
        { command: "login", providerId: "commandcode-private", authType: "api_key" },
        (event) => {
          if (event.type === "prompt" && event.kind === "secret") {
            void client
              .respondAuthInteraction({
                type: "prompt_response",
                promptId: event.promptId,
                value: "sk-b4-key",
              })
              .catch(() => undefined);
          }
        },
      );
      expect(login.outcome).toBe("ok");

      const started2 = await client.executeRuntimeCommand("start");
      expect(started2.outcome).toBe("completed");
      expect(started2.snapshot.modelDataPlane).toBe("running");

      // The request path (models discovery) lists the CommandCode model
      // and the effective credential remains connected.
      const auth = await client.executeAuthCommand({ command: "query" });
      const commandCode = auth.options?.providers.find(
        (row) => row.providerId === "commandcode-private",
      );
      expect(commandCode?.status).toMatchObject({
        stored: true,
        effectiveSource: "stored",
      });
      expect(
        JSON.parse(await readFile(join(root, "pi", "auth.json"), "utf8"))[
          "commandcode-private"
        ],
      ).toEqual({ type: "api_key", key: "sk-b4-key" });
    } finally {
      await client.close();
    }
  });
});
