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
} from "@token/application-control-plane/control-plane";

import {
  startTokenApplication as startProductionTokenApplication,
  type RunningTokenApplication,
  type StartTokenApplicationOptions,
} from "../../src/application.js";
import {
  createInstanceAuthority,
  InstanceAuthorityOwnedError,
} from "../../src/instance-authority.js";
import { createControlPlaneDiscovery } from "../../src/control-plane-discovery.js";

const roots: string[] = [];
const applications: RunningTokenApplication[] = [];

async function readControlPlaneDescriptor(path: string) {
  const endpoint = await createControlPlaneDiscovery({ path }).read();
  if (endpoint === undefined) throw new Error("Expected Control Plane descriptor");
  return endpoint;
}

function startTokenApplication(
  options: Omit<StartTokenApplicationOptions, "instanceAuthority">,
) {
  return startProductionTokenApplication({
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
  const root = await mkdtemp(join(tmpdir(), "Token-application-"));
  const port = await freePort();
  roots.push(root);
  const configPath = join(root, "config.json");
  const descriptorPath = join(root, "control-plane.json");
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        schemaVersion: "token-config-v2",
        server: { port },
        clientProtocols: {
          "anthropic-messages": {
            conversion: {
              request: {
                unknownContent: "error",
              },
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

async function writeCommandCodeCatalog(
  configPath: string,
  endpoint: "/chat/completions" | "/responses",
): Promise<void> {
  await writeFile(
    join(dirname(configPath), "commandcode-models.json"),
    `${JSON.stringify({
      schema: "luckytoken-commandcode-models-v2",
      models: [
        {
          id: "deepseek/deepseek-v4.1-flash",
          name: "DeepSeek V4.1 Flash",
          description: "restart endpoint fixture",
          supportedEndpoints: ["/chat/completions", "/responses"],
          endpoint,
          input: ["text"],
          reasoning: false,
          contextWindow: 128_000,
          minimumPlan: "go",
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );
}

async function writeInjectableModel(
  configPath: string,
  contextWindow = 128_000,
): Promise<void> {
  await writeFile(
    join(dirname(configPath), "models.json"),
    `${JSON.stringify({
      providers: {
        fixture: {
          name: "Fixture",
          baseUrl: "http://127.0.0.1:65534",
          apiKey: "fixture-placeholder",
          api: "anthropic-messages",
          models: [{
            id: "fixture-model",
            reasoning: true,
            contextWindow,
            maxTokens: 64_000,
          }],
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
      schemaVersion: "Token-client-auth-v1",
      global: "legacy-v1-token-canary",
      projects: {},
    });
    await mkdir(dirname(authPath), { recursive: true });
    await writeFile(authPath, legacy, "utf8");

    const started = await startTokenApplication({
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

  it("removes the reserved Token provider while preserving other Pi providers", async () => {
    const { configPath, descriptorPath } = await fixture();
    const root = dirname(configPath);
    const piAgentDirectory = join(root, "pi-agent-user-owned");
    await mkdir(piAgentDirectory, { recursive: true });
    const userModels = `{
  "providers": {
    "Token": {
      "apiKey": "user-owned",
      "models": []
    },
    "other": {
      "apiKey": "preserve-me"
    }
  }
}\n`;
    const modelsPath = join(piAgentDirectory, "models.json");
    await writeFile(modelsPath, userModels, "utf8");

    const previousPiAgentDirectory = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = piAgentDirectory;
    try {
      const started = await startTokenApplication({
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
          client.executeAgentIntegrationsCommand({ command: "query" }),
        ).resolves.toMatchObject({
          state: {
            agents: expect.arrayContaining([
              expect.objectContaining({ agentId: "claude", enabled: false }),
              expect.objectContaining({ agentId: "pi", enabled: false }),
            ]),
          },
        });

        const quit = await client.executeApplicationCommand({
          command: "quit",
          acknowledged: true,
        });
        expect(quit.outcome).toBe("drained");
        const restored = JSON.parse(await readFile(modelsPath, "utf8")) as {
          providers: Record<string, Record<string, unknown>>;
        };
        expect(restored.providers.Token).toBeUndefined();
        expect(restored.providers.other?.apiKey).toBe("preserve-me");
      } finally {
        await client.close();
      }
    } finally {
      if (previousPiAgentDirectory === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousPiAgentDirectory;
      }
    }
  });

  it("injects and restores Claude Code model slots through the real Backend seams", async () => {
    const { configPath, descriptorPath } = await fixture();
    await writeInjectableModel(configPath, 1_000_000);
    const root = dirname(configPath);
    const claudeConfigDirectory = join(root, "claude-user");
    const claudeSettingsPath = join(claudeConfigDirectory, "settings.json");
    await mkdir(claudeConfigDirectory, { recursive: true });
    await writeFile(
      claudeSettingsPath,
      JSON.stringify({
        theme: "dark",
        env: {
          KEEP_ME: "yes",
          ANTHROPIC_BASE_URL: "https://user.example",
          ANTHROPIC_AUTH_TOKEN: "user-token",
        },
      }, null, 2),
      "utf8",
    );

    const previousClaudeConfigDirectory = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDirectory;
    try {
      const started = await startTokenApplication({
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
        const queried = await client.executePublicModelsCommand({ command: "query" });
        const fixtureProvider = queried.state.providers.find(
          (provider) => provider.providerId === "fixture",
        );
        const fixtureModel = fixtureProvider?.models.find(
          (model) => model.target === "fixture-model",
        );
        if (fixtureModel === undefined) throw new Error("fixture model missing");

        const favorited = await client.executePublicModelsCommand({
          command: "set_model_favorite",
          revision: queried.state.revision,
          providerId: "fixture",
          modelId: "fixture-model",
          favorite: true,
        });
        expect(favorited.outcome).toBe("ok");

        for (const key of [
          "integrations.claude.model",
          "integrations.claude.opusModel",
          "integrations.claude.sonnetModel",
          "integrations.claude.haikuModel",
          "integrations.claude.subagentModel",
        ]) {
          await expect(
            client.executeSettingsCommand({
              command: "set",
              key,
              value: fixtureModel.alias,
            }),
          ).resolves.toMatchObject({ outcome: "applied" });
        }

        const enabled = await client.executeAgentIntegrationsCommand({
          command: "set_enabled",
          agentId: "claude",
          enabled: true,
        });
        expect(enabled).toMatchObject({
          outcome: "ok",
          state: {
            agents: expect.arrayContaining([
              expect.objectContaining({ agentId: "claude", enabled: true }),
            ]),
          },
        });

        const active = JSON.parse(await readFile(claudeSettingsPath, "utf8")) as {
          theme?: string;
          env?: Record<string, string>;
        };
        const publicEndpoint = favorited.state.endpoint;
        expect(active.theme).toBe("dark");
        expect(active.env).toMatchObject({
          KEEP_ME: "yes",
          ANTHROPIC_BASE_URL: `http://${publicEndpoint.host}:${publicEndpoint.port}`,
          ANTHROPIC_MODEL: `${fixtureModel.alias}[1m]`,
          ANTHROPIC_DEFAULT_OPUS_MODEL: `${fixtureModel.alias}[1m]`,
          ANTHROPIC_DEFAULT_SONNET_MODEL: `${fixtureModel.alias}[1m]`,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: `${fixtureModel.alias}[1m]`,
          CLAUDE_CODE_SUBAGENT_MODEL: `${fixtureModel.alias}[1m]`,
        });
        expect(active.env?.ANTHROPIC_AUTH_TOKEN).toBe("token-local");

        const disabled = await client.executeAgentIntegrationsCommand({
          command: "set_enabled",
          agentId: "claude",
          enabled: false,
        });
        expect(disabled).toMatchObject({
          outcome: "ok",
          state: {
            agents: expect.arrayContaining([
              expect.objectContaining({ agentId: "claude", enabled: false }),
            ]),
          },
        });

        const restored = JSON.parse(await readFile(claudeSettingsPath, "utf8")) as {
          theme?: string;
          env?: Record<string, string>;
        };
        expect(restored.theme).toBe("dark");
        expect(restored.env).toEqual({
          KEEP_ME: "yes",
          ANTHROPIC_BASE_URL: "https://user.example",
          ANTHROPIC_AUTH_TOKEN: "user-token",
        });
      } finally {
        await client.close();
      }
    } finally {
      if (previousClaudeConfigDirectory === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDirectory;
      }
    }
  }, 30_000);

  it("reloads the CommandCode endpoint after a real Backend quit and restart", async () => {
    const { configPath, descriptorPath } = await fixture();
    await writeCommandCodeCatalog(configPath, "/responses");

    const first = await startTokenApplication({
      configPath,
      descriptorOverride: descriptorPath,
      ownerKind: "cli",
    });
    expect(first.kind).toBe("running");
    if (first.kind !== "running") return;
    applications.push(first.application);

    const firstEndpoint = await readControlPlaneDescriptor(descriptorPath);
    const firstClient = await connectControlPlane(firstEndpoint, {
      createRequestId: randomUUID,
      pipeConnector: createNodePipeTransport(),
    });
    try {
      await firstClient.hello(controlPlaneVersion);
      const before = await firstClient.executeCatalogCommand({ command: "query" });
      expect(
        before.snapshot.providers
          .find((provider) => provider.providerId === "commandcode-goat")
          ?.models.find((model) => model.id === "deepseek/deepseek-v4.1-flash")
          ?.api,
      ).toBe("openai-responses");

      const quit = await firstClient.executeApplicationCommand({
        command: "quit",
        acknowledged: true,
      });
      expect(quit.outcome).toBe("drained");
    } finally {
      await firstClient.close();
    }
    await expect(first.application.exited).resolves.toEqual({ reason: "drained" });

    await writeCommandCodeCatalog(configPath, "/chat/completions");

    const second = await startTokenApplication({
      configPath,
      descriptorOverride: descriptorPath,
      ownerKind: "cli",
    });
    expect(second.kind).toBe("running");
    if (second.kind !== "running") return;
    applications.push(second.application);

    const secondEndpoint = await readControlPlaneDescriptor(descriptorPath);
    const secondClient = await connectControlPlane(secondEndpoint, {
      createRequestId: randomUUID,
      pipeConnector: createNodePipeTransport(),
    });
    try {
      await secondClient.hello(controlPlaneVersion);
      const after = await secondClient.executeCatalogCommand({ command: "query" });
      expect(
        after.snapshot.providers
          .find((provider) => provider.providerId === "commandcode-goat")
          ?.models.find((model) => model.id === "deepseek/deepseek-v4.1-flash")
          ?.api,
      ).toBe("openai-completions");
    } finally {
      await secondClient.close();
    }
  });

  it("starts normal serving, exposes the Control Plane, and closes idempotently", async () => {
    const { configPath, descriptorPath, port } = await fixture();

    const started = await startTokenApplication({
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

    const started = await startProductionTokenApplication({
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
    const started = await startTokenApplication({
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

    const started = await startTokenApplication({
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

    const started = await startProductionTokenApplication({
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
    const first = await startTokenApplication({
      configPath,
      descriptorOverride: descriptorPath,
      ownerKind: "cli",
    });
    expect(first.kind).toBe("running");
    if (first.kind !== "running") return;
    applications.push(first.application);

    const second = await startTokenApplication({
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

  it("restores Codex to native defaults across application restarts", async () => {
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
    process.env.CODEX_CLI_PATH = "Token-test-missing-codex";

    try {
      const first = await startTokenApplication({
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
      expect(firstRestore).not.toContain("openai_base_url");
      expect(firstRestore).not.toContain("model_catalog_json");
      expect(firstRestore).toContain('model = "before-model"');

      const second = await startTokenApplication({
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
      expect(secondRestore).not.toContain("openai_base_url");
      expect(secondRestore).not.toContain("model_catalog_json");
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (previousCodexCliPath === undefined) delete process.env.CODEX_CLI_PATH;
      else process.env.CODEX_CLI_PATH = previousCodexCliPath;
    }
  }, 30_000);

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
    process.env.CODEX_CLI_PATH = "Token-test-missing-codex";

    try {
      const started = await startTokenApplication({
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
      expect(await readFile(join(codexHome, "config.toml"), "utf8")).toBe("");
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
    process.env.CODEX_CLI_PATH = "Token-test-missing-codex";

    try {
      const started = await startTokenApplication({
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
    const started = await startTokenApplication({
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
        schemaVersion: "Token-codex-integration-v4",
        desiredEnabled: true,
        scope: "favorite",
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
    process.env.CODEX_CLI_PATH = "Token-test-missing-codex";

    try {
      const started = await startTokenApplication({
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
        readFile(join(codexHome, "token-model-catalog.json"), "utf8"),
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
        `model_catalog_json = "${join(codexHome, "token-model-catalog.json").replaceAll("\\", "\\\\")}"`,
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
        schemaVersion: "Token-codex-integration-v4",
        desiredEnabled: true,
        scope: "favorite",
        managed: true,
        appliedGeneration: 0,
        appliedScope: "favorite",
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
    process.env.CODEX_CLI_PATH = "Token-test-missing-codex";

    try {
      const started = await startTokenApplication({
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
  }, 15_000);
});
