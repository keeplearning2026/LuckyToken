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
    codexCatalogValidator: {
      validate: async () => undefined,
    },
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
        },
        providerPackages: {},
        diagnostics: { directory: "state/request-diagnostics" },
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

async function writeInjectableModel(configPath: string): Promise<void> {
  await writeFile(
    join(dirname(configPath), "models.json"),
    `${JSON.stringify({
      providers: {
        fixture: {
          name: "Fixture",
          baseUrl: "http://127.0.0.1:65534",
          apiKey: "fixture-placeholder",
          api: "anthropic-messages",
          models: [{ id: "fixture-model", reasoning: true }],
        },
      },
    }, null, 2)}\n`,
    "utf8",
  );
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

  it("restores Codex from persisted desktop settings across application restarts", async () => {
    const { configPath, descriptorPath } = await fixture();
    await writeInjectableModel(configPath);
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
        await client.executeSettingsCommand({
          command: "set",
          key: "integrations.codex.preimage.openaiBaseUrl",
          value: "https://restore.example/v1",
        });
        await client.executeSettingsCommand({
          command: "set",
          key: "integrations.codex.preimage.modelCatalogJson",
          value: "C:/restore/catalog.json",
        });
        await client.executeAgentIntegrationsCommand({
          command: "set_scope",
          agentId: "codex",
          scope: "full",
        });
        const enabled = await client.executeAgentIntegrationsCommand({
          command: "set_enabled",
          agentId: "codex",
          enabled: true,
        });
        expect(enabled.state.agents).toContainEqual(
          expect.objectContaining({ agentId: "codex", enabled: true }),
        );
        expect(enabled.results).toContainEqual(
          expect.objectContaining({
            agentId: "codex",
            effect: expect.objectContaining({ observedState: "managed" }),
          }),
        );
      } finally {
        await client.close();
      }

      const injected = await readFile(join(codexHome, "config.toml"), "utf8");
      expect(injected).toContain('model_provider = "openai"');
      expect(injected).toContain("openai_base_url = ");
      expect(injected).toContain("model_catalog_json = ");

      await first.application.close();
      const firstRestore = await readFile(join(codexHome, "config.toml"), "utf8");
      expect(firstRestore).not.toContain("model_provider");
      expect(firstRestore).toContain('openai_base_url = "https://restore.example/v1"');
      expect(firstRestore).toContain('model_catalog_json = "C:/restore/catalog.json"');
      expect(firstRestore).toContain('model = "before-model"');

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
      const secondRestore = await readFile(join(codexHome, "config.toml"), "utf8");
      expect(secondRestore).not.toContain("model_provider");
      expect(secondRestore).toContain('openai_base_url = "https://restore.example/v1"');
      expect(secondRestore).toContain('model_catalog_json = "C:/restore/catalog.json"');
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (previousCodexCliPath === undefined) delete process.env.CODEX_CLI_PATH;
      else process.env.CODEX_CLI_PATH = previousCodexCliPath;
    }
  }, 15_000);

  it("refuses application quit when an active Codex projection cannot be restored", async () => {
    const { configPath, descriptorPath } = await fixture();
    await writeInjectableModel(configPath);
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
        await client.executeSettingsCommand({
          command: "set",
          key: "integrations.codex.preimage.openaiBaseUrl",
          value: "https://before.example/v1",
        });
        await client.executeAgentIntegrationsCommand({
          command: "set_scope",
          agentId: "codex",
          scope: "full",
        });
        await client.executeAgentIntegrationsCommand({
          command: "set_enabled",
          agentId: "codex",
          enabled: true,
        });
        await rm(join(codexHome, "config.toml"), { force: true });

        const quit = await client.executeApplicationCommand({
          command: "quit",
          acknowledged: true,
        });

        expect(quit.outcome).toBe("failed");
        expect(quit.error).toContain("Agent integrations");
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
  }, 15_000);

  it("refuses manual Codex sync while the Data Plane is stopped", async () => {
    const { configPath, descriptorPath } = await fixture();
    const codexHome = join(dirname(configPath), "codex-home-stopped-sync");
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, "config.toml"), 'model = "before"\n', "utf8");
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
        await client.executeAgentIntegrationsCommand({
          command: "set_enabled",
          agentId: "codex",
          enabled: true,
        });
        await client.executeRuntimeCommand("stop");
        const external = 'model_provider = "external"\nmodel = "keep"\n';
        await writeFile(join(codexHome, "config.toml"), external, "utf8");

        const synced = await client.executeAgentIntegrationsCommand({ command: "sync" });

        expect(synced.outcome).toBe("failed");
        expect(synced.results).toContainEqual(
          expect.objectContaining({
            agentId: "codex",
            effect: expect.objectContaining({
              observedState: "unavailable",
              message:
                "Start the Data Plane before syncing Agent integrations. No Agent files were changed.",
            }),
          }),
        );
        expect(await readFile(join(codexHome, "config.toml"), "utf8")).toBe(external);
      } finally {
        await client.close();
      }
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (previousCodexCliPath === undefined) delete process.env.CODEX_CLI_PATH;
      else process.env.CODEX_CLI_PATH = previousCodexCliPath;
    }
  }, 15_000);

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

  it("does not auto-inject Codex when Data Plane startup fails", async () => {
    const { configPath, descriptorPath, port } = await fixture();
    const root = dirname(configPath);
    const codexHome = join(root, "codex-home-start-failure");
    const stateDirectory = join(root, "integrations", "codex");
    const originalCodexConfig = 'openai_base_url = "https://before.example/v1"\n';
    await mkdir(codexHome, { recursive: true });
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(join(codexHome, "config.toml"), originalCodexConfig, "utf8");
    await writeFile(
      join(codexHome, "models_cache.json"),
      `${JSON.stringify({ models: [{ slug: "gpt-native" }] })}\n`,
      "utf8",
    );
    await writeFile(
      join(stateDirectory, "integration-state.json"),
      `${JSON.stringify({
        schemaVersion: "luckytoken-codex-integration-v3",
        desiredEnabled: true,
        managed: false,
      })}\n`,
      "utf8",
    );

    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(port, "127.0.0.1", resolve);
    });
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
        await expect(client.getStatus()).resolves.toMatchObject({ modelDataPlane: "failed" });
      } finally {
        await client.close();
      }

      expect(await readFile(join(codexHome, "config.toml"), "utf8")).toBe(
        originalCodexConfig,
      );
      await expect(
        readFile(join(codexHome, "luckytoken-model-catalog.json"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await new Promise<void>((resolve, reject) => {
        blocker.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (previousCodexCliPath === undefined) delete process.env.CODEX_CLI_PATH;
      else process.env.CODEX_CLI_PATH = previousCodexCliPath;
    }
  });

  it("restores managed Codex residue when Data Plane startup fails", async () => {
    const { configPath, descriptorPath, port } = await fixture();
    const root = dirname(configPath);
    const codexHome = join(root, "codex-home-managed-start-failure");
    const stateDirectory = join(root, "integrations", "codex");
    await mkdir(codexHome, { recursive: true });
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(
      join(codexHome, "config.toml"),
      [
        'model_provider = "openai"',
        `openai_base_url = "http://127.0.0.1:${port}/v1"`,
        `model_catalog_json = "${join(codexHome, "luckytoken-model-catalog.json").replaceAll("\\", "\\\\")}"`,
        'model = "keep-me"',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(codexHome, "models_cache.json"),
      `${JSON.stringify({ models: [{ slug: "gpt-native" }] })}\n`,
      "utf8",
    );
    await writeFile(
      join(stateDirectory, "integration-state.json"),
      `${JSON.stringify({
        schemaVersion: "luckytoken-codex-integration-v3",
        desiredEnabled: true,
        managed: true,
        appliedGeneration: 0,
      })}\n`,
      "utf8",
    );

    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(port, "127.0.0.1", resolve);
    });
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

      expect(await readFile(join(codexHome, "config.toml"), "utf8")).toBe(
        'model = "keep-me"\n',
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        blocker.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (previousCodexCliPath === undefined) delete process.env.CODEX_CLI_PATH;
      else process.env.CODEX_CLI_PATH = previousCodexCliPath;
    }
  });
});
