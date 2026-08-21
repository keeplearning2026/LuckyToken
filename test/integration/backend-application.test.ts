import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import {
  connectControlPlane,
  controlPlaneVersion,
  createNodePipeTransport,
} from "@luckytoken/application-control-plane/control-plane";

import {
  startLuckyTokenApplication as startProductionLuckyTokenApplication,
  type RunningLuckyTokenApplication,
  type StartLuckyTokenApplicationOptions,
} from "../../src/application.js";
import {
  createInstanceAuthority,
  InstanceAuthorityOwnedError,
} from "../../src/instance-authority.js";
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
  await Promise.allSettled(applications.splice(0).map((application) => application.close()));
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

async function fixture(): Promise<{ configPath: string; descriptorPath: string; port: number }> {
  const root = await mkdtemp(join(tmpdir(), "luckytoken-application-"));
  const port = await freePort();
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
  return { configPath, descriptorPath, port };
}

describe("Backend Application public lifecycle seam", () => {
  it("ignores obsolete client-auth files and exposes no token-management surface", async () => {
    const { configPath, descriptorPath } = await fixture();
    const authPath = join(dirname(configPath), "client-auth", "anthropic-messages.json");
    const legacy = JSON.stringify({
      schemaVersion: "luckytoken-client-auth-v1",
      global: "legacy-v1-token-canary",
      projects: {},
    });
    await mkdir(dirname(authPath), { recursive: true });
    await writeFile(authPath, legacy, "utf8");

    const started = await startLuckyTokenApplication({
      configPath,
      descriptorOverride: descriptorPath,
      ownerKind: "cli",
    });
    expect(started.kind).toBe("running");
    if (started.kind !== "running") return;
    applications.push(started.application);

    const endpoint = await readControlPlaneDescriptor(descriptorPath);
    const client = await connectControlPlane(endpoint, {
      createRequestId: randomUUID,
      pipeConnector: createNodePipeTransport(),
    });
    try {
      await client.hello(controlPlaneVersion);
      const stopped = await client.executeRuntimeCommand("stop");
      expect(stopped.snapshot.modelDataPlane).toBe("stopped");
      expect("executeClientTokenCommand" in client).toBe(false);
      expect(await readFile(authPath, "utf8")).toBe(legacy);
    } finally {
      await client.close();
    }
  });

  it("starts normal serving, exposes the Control Plane, and closes idempotently", async () => {
    const { configPath, descriptorPath, port } = await fixture();

    const started = await startLuckyTokenApplication({
      configPath,
      descriptorOverride: descriptorPath,
      ownerKind: "cli",
    });
    expect(started.kind).toBe("running");
    if (started.kind !== "running") return;
    applications.push(started.application);

    const endpoint = await readControlPlaneDescriptor(descriptorPath);
    const client = await connectControlPlane(endpoint, {
      createRequestId: randomUUID,
      pipeConnector: createNodePipeTransport(),
    });
    try {
      await expect(client.hello(controlPlaneVersion)).resolves.toMatchObject({
        type: "compatible",
      });
      await expect(client.getStatus()).resolves.toMatchObject({
        modelDataPlane: "running",
        dataPlane: {
          configuredOrigin: `http://127.0.0.1:${port}`,
        },
      });
    } finally {
      await client.close();
    }

    await started.application.close();
    await expect(started.application.close()).resolves.toBeUndefined();
    await expect(started.application.exited).resolves.toMatchObject({
      reason: "closed",
    });
  });

  it("releases the Backend InstanceLease only after discovery and the Data Plane are gone", async () => {
    const { configPath, descriptorPath, port } = await fixture();
    let releaseObservation:
      | { readonly discoveryAbsent: boolean; readonly dataPlanePortAvailable: boolean }
      | undefined;

    const started = await startProductionLuckyTokenApplication({
      configPath,
      descriptorOverride: descriptorPath,
      ownerKind: "cli",
      instanceAuthority: {
        async acquire() {
          return {
            async close() {
              const discoveryAbsent =
                (await createControlPlaneDiscovery({ path: descriptorPath }).read()) ===
                undefined;
              const server = createServer();
              let dataPlanePortAvailable = false;
              try {
                await new Promise<void>((resolve, reject) => {
                  server.once("error", reject);
                  server.listen(port, "127.0.0.1", resolve);
                });
                dataPlanePortAvailable = true;
              } finally {
                if (server.listening) {
                  await new Promise<void>((resolve, reject) => {
                    server.close((error) =>
                      error === undefined ? resolve() : reject(error),
                    );
                  });
                }
              }
              releaseObservation = { discoveryAbsent, dataPlanePortAvailable };
            },
          };
        },
      },
    });
    expect(started.kind).toBe("running");
    if (started.kind !== "running") return;

    await started.application.close();

    expect(releaseObservation).toEqual({
      discoveryAbsent: true,
      dataPlanePortAvailable: true,
    });
  });

  it("does not let a desktop lease take ownership of a CLI-owned Backend", async () => {
    const { configPath, descriptorPath } = await fixture();
    const started = await startLuckyTokenApplication({
      configPath,
      descriptorOverride: descriptorPath,
      ownerKind: "cli",
    });
    expect(started.kind).toBe("running");
    if (started.kind !== "running") return;
    applications.push(started.application);

    const endpoint = await readControlPlaneDescriptor(descriptorPath);
    const client = await connectControlPlane(endpoint, {
      createRequestId: randomUUID,
      pipeConnector: createNodePipeTransport(),
    });
    try {
      await client.hello(controlPlaneVersion);
      await expect(
        client.executeApplicationCommand({
          command: "desktop_owner",
          action: "claim",
          leaseId: "desktop-must-not-own-cli",
        }),
      ).resolves.toMatchObject({
        command: "desktop_owner",
        outcome: "unsupported",
        snapshot: { ownership: { owner: { kind: "cli" } } },
      });
    } finally {
      await client.close();
    }
  });

  it("starts incompatible configuration in recovery-only mode", async () => {
    const { configPath, descriptorPath } = await fixture();
    await writeFile(configPath, "{ invalid json", "utf8");

    const started = await startLuckyTokenApplication({
      configPath,
      descriptorOverride: descriptorPath,
      ownerKind: "cli",
    });
    expect(started.kind).toBe("running");
    if (started.kind !== "running") return;
    applications.push(started.application);

    const endpoint = await readControlPlaneDescriptor(descriptorPath);
    const client = await connectControlPlane(endpoint, {
      createRequestId: randomUUID,
      pipeConnector: createNodePipeTransport(),
    });
    try {
      await client.hello(controlPlaneVersion);
      await expect(client.getStatus()).resolves.toMatchObject({
        modelDataPlane: "stopped",
        recovery: { mode: "incompatible_configuration" },
      });
    } finally {
      await client.close();
    }
  });

  it("retries InstanceAuthority when a previous owner disappears before publishing discovery", async () => {
    const { configPath, descriptorPath } = await fixture();
    const realAuthority = createInstanceAuthority({
      path: join(dirname(configPath), "instance-retry.sqlite"),
    });
    let attempts = 0;

    const started = await startProductionLuckyTokenApplication({
      configPath,
      descriptorOverride: descriptorPath,
      ownerKind: "cli",
      instanceAuthority: {
        async acquire() {
          attempts += 1;
          if (attempts === 1) throw new InstanceAuthorityOwnedError();
          return realAuthority.acquire();
        },
      },
    });

    expect(started.kind).toBe("running");
    expect(attempts).toBeGreaterThanOrEqual(2);
    if (started.kind !== "running") return;
    applications.push(started.application);
  });

  it("attaches a second start attempt to the active application", async () => {
    const { configPath, descriptorPath } = await fixture();
    const first = await startLuckyTokenApplication({
      configPath,
      descriptorOverride: descriptorPath,
      ownerKind: "cli",
    });
    expect(first.kind).toBe("running");
    if (first.kind !== "running") return;
    applications.push(first.application);

    const second = await startLuckyTokenApplication({
      configPath,
      descriptorOverride: descriptorPath,
      ownerKind: "desktop",
    });

    expect(second.kind).toBe("attached");
    if (second.kind === "attached") {
      expect(second.ownership?.owner.pid).toBe(process.pid);
      expect(second.ownership?.owner.kind).toBe("cli");
    }
  });

  it("owns Codex integration across Enable, application exit restore, and the next startup", async () => {
    const { configPath, descriptorPath } = await fixture();
    const codexHome = join(dirname(configPath), "codex-home");
    await mkdir(codexHome, { recursive: true });
    const originalCodexConfig = [
      'model_provider = "before"',
      'openai_base_url = "https://before.example/v1"',
      'model = "before-model"',
      "",
    ].join("\n");
    await writeFile(join(codexHome, "config.toml"), originalCodexConfig, "utf8");
    await writeFile(
      join(codexHome, "models_cache.json"),
      `${JSON.stringify({ models: [{ slug: "gpt-native", display_name: "GPT Native" }] })}\n`,
      "utf8",
    );
    const previousCodexHome = process.env.CODEX_HOME;
    const previousCodexCliPath = process.env.CODEX_CLI_PATH;
    process.env.CODEX_HOME = codexHome;
    process.env.CODEX_CLI_PATH = "luckytoken-test-missing-codex";

    try {
      const first = await startLuckyTokenApplication({
        configPath,
        descriptorOverride: descriptorPath,
        ownerKind: "cli",
      });
      expect(first.kind).toBe("running");
      if (first.kind !== "running") return;
      applications.push(first.application);

      const endpoint = await readControlPlaneDescriptor(descriptorPath);
      const client = await connectControlPlane(endpoint, {
        createRequestId: randomUUID,
        pipeConnector: createNodePipeTransport(),
      });
      try {
        await client.hello(controlPlaneVersion);
        const enabled = await client.executeCodexIntegrationCommand({
          command: "set_enabled",
          enabled: true,
        });
        expect(enabled.state).toMatchObject({
          desiredEnabled: true,
          observedState: "managed",
        });
      } finally {
        await client.close();
      }

      const injected = await readFile(join(codexHome, "config.toml"), "utf8");
      expect(injected).toContain('model_provider = "openai"');
      expect(injected).toContain("openai_base_url = ");
      expect(injected).toContain("model_catalog_json = ");

      await first.application.close();
      expect(await readFile(join(codexHome, "config.toml"), "utf8")).toBe(originalCodexConfig);

      const second = await startLuckyTokenApplication({
        configPath,
        descriptorOverride: descriptorPath,
        ownerKind: "cli",
      });
      expect(second.kind).toBe("running");
      if (second.kind !== "running") return;
      applications.push(second.application);

      const reinjected = await readFile(join(codexHome, "config.toml"), "utf8");
      expect(reinjected).toContain('model_provider = "openai"');
      expect(reinjected).toContain("openai_base_url = ");
      expect(reinjected).toContain("model_catalog_json = ");

      await second.application.close();
      expect(await readFile(join(codexHome, "config.toml"), "utf8")).toBe(originalCodexConfig);
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (previousCodexCliPath === undefined) delete process.env.CODEX_CLI_PATH;
      else process.env.CODEX_CLI_PATH = previousCodexCliPath;
    }
  });

  it("refuses application quit when an active Codex projection cannot be restored", async () => {
    const { configPath, descriptorPath } = await fixture();
    const codexHome = join(dirname(configPath), "codex-home-restore-failure");
    await mkdir(codexHome, { recursive: true });
    const originalCodexConfig = 'openai_base_url = "https://before.example/v1"\n';
    await writeFile(join(codexHome, "config.toml"), originalCodexConfig, "utf8");
    await writeFile(
      join(codexHome, "models_cache.json"),
      `${JSON.stringify({ models: [{ slug: "gpt-native" }] })}\n`,
      "utf8",
    );
    const previousCodexHome = process.env.CODEX_HOME;
    const previousCodexCliPath = process.env.CODEX_CLI_PATH;
    process.env.CODEX_HOME = codexHome;
    process.env.CODEX_CLI_PATH = "luckytoken-test-missing-codex";

    try {
      const started = await startLuckyTokenApplication({
        configPath,
        descriptorOverride: descriptorPath,
        ownerKind: "cli",
      });
      expect(started.kind).toBe("running");
      if (started.kind !== "running") return;
      applications.push(started.application);

      const endpoint = await readControlPlaneDescriptor(descriptorPath);
      const client = await connectControlPlane(endpoint, {
        createRequestId: randomUUID,
        pipeConnector: createNodePipeTransport(),
      });
      try {
        await client.hello(controlPlaneVersion);
        await client.executeCodexIntegrationCommand({ command: "set_enabled", enabled: true });
        await rm(join(codexHome, "config.toml"), { force: true });

        const quit = await client.executeApplicationCommand({
          command: "quit",
          acknowledged: true,
        });

        expect(quit.outcome).toBe("failed");
        expect(quit.error).toContain("Codex integration");
        await expect(client.getStatus()).resolves.toMatchObject({ modelDataPlane: "running" });
      } finally {
        await client.close();
      }

      await writeFile(join(codexHome, "config.toml"), "", "utf8");
      await started.application.close();
      expect(await readFile(join(codexHome, "config.toml"), "utf8")).toBe(originalCodexConfig);
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (previousCodexCliPath === undefined) delete process.env.CODEX_CLI_PATH;
      else process.env.CODEX_CLI_PATH = previousCodexCliPath;
    }
  });

  it("delivers an ownership-aware quit result before the application exits", async () => {
    const { configPath, descriptorPath } = await fixture();
    const started = await startLuckyTokenApplication({
      configPath,
      descriptorOverride: descriptorPath,
      ownerKind: "cli",
    });
    expect(started.kind).toBe("running");
    if (started.kind !== "running") return;
    applications.push(started.application);

    const endpoint = await readControlPlaneDescriptor(descriptorPath);
    const client = await connectControlPlane(endpoint, {
      createRequestId: randomUUID,
      pipeConnector: createNodePipeTransport(),
    });
    try {
      await client.hello(controlPlaneVersion);
      const result = await client.executeApplicationCommand({
        command: "quit",
        acknowledged: true,
      });
      expect(result.outcome).toBe("drained");
    } finally {
      await client.close().catch(() => undefined);
    }

    await expect(started.application.exited).resolves.toEqual({
      reason: "drained",
    });
  });
});
