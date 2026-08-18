import type { FetchFunction } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  connectControlPlane,
  createNodePipeTransport,
  nodePipeFallbackAccess,
  startControlPlane,
  type ControlPlaneEndpoint,
  type ControlPlaneClient,
} from "@luckytoken/application-control-plane/control-plane";

import {
  createClientTokenControlPlaneHandler,
  createProtocolEnablementSettingsHandler,
} from "../../src/client-auth/control-plane.js";
import { createFileClientTokenStore } from "../../src/client-auth/file-token-store.js";
import { loadLuckyTokenCliConfig } from "../../src/cli-config.js";
import { createConfiguredLuckyTokenDataPlane } from "../../src/composition.js";
import { createEmptyServerConfig } from "../../packages/provider-commandcode-private/src/project.js";
import {
  COMMANDCODE_PROVIDER_PACKAGE,
  commandCodeProviderImportModule,
} from "../support/commandcode-provider-package.js";
import {
  createRuntimeDiagnosticsStoreFactory,
  parseRuntimeDiagnosticsConfiguration,
  type RuntimeDiagnosticsStore,
} from "../../src/runtime-diagnostics/index.js";
import { createSettingsRegistry } from "../../src/settings/catalog.js";
import { createSettingsControlPlaneHandler } from "../../src/settings/control-plane.js";
import { startLuckyTokenHttpServer } from "../../src/server.js";

function commandCodeText(text: string): Response {
  return new Response(
    [
      JSON.stringify({ type: "text-start", id: "0" }),
      JSON.stringify({ type: "text-delta", id: "0", text }),
      JSON.stringify({ type: "text-end", id: "0" }),
      JSON.stringify({
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }),
    ].join("\n"),
  );
}

const ANTHROPIC = "anthropic-messages";
const RESPONSES = "openai-responses";

interface ServingFixture {
  readonly client: ControlPlaneClient;
  readonly origin: string;
  readonly diagnostics: RuntimeDiagnosticsStore;
  readonly anthropicAuthFile: string;
  readonly responsesAuthFile: string;
  /** Rebuilds the Data Plane composition (authorities + HTTP listener) with
   *  the same shared stores; returns the new origin. */
  restart(): Promise<string>;
  close(): Promise<void>;
}

/**
 * Ticket 16 acceptance seams: versioned Control Plane Client Token commands
 * plus real Anthropic Messages and OpenAI Responses HTTP authorization after
 * each live mutation. No test inspects an in-memory token map: every
 * assertion observes the Control Plane commands, the diagnostics channel, or
 * real HTTP behavior.
 */
describe("live protocol-global Client Token Authority over real HTTP", () => {
  const directories: string[] = [];
  const fixtures: ServingFixture[] = [];
  let nextPipe = 0;
  let nextRequest = 0;

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  async function startServing(options: {
    readonly tokenValues?: Readonly<Record<string, string>>;
    /** Runs after config/auth files exist but before the composition boots. */
    readonly beforeComposition?: (paths: {
      readonly anthropicAuthFile: string;
      readonly responsesAuthFile: string;
    }) => Promise<void>;
  } = {}): Promise<ServingFixture> {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-token-http-"));
    directories.push(root);
    const stateDirectory = join(root, ".luckytoken");
    const piDirectory = join(stateDirectory, "pi");
    const stateDir = join(stateDirectory, "state");
    await mkdir(piDirectory, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    const anthropicAuthFile = join(
      stateDirectory,
      "client-auth",
      "anthropic-messages.json",
    );
    const responsesAuthFile = join(
      stateDirectory,
      "client-auth",
      "openai-responses.json",
    );
    const configPath = join(stateDirectory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "luckytoken-config-v1",
        server: { host: "127.0.0.1", port: 0 },
        clientProtocols: {
          [ANTHROPIC]: {
            authFile: "client-auth/anthropic-messages.json",
          },
          [RESPONSES]: {
            authFile: "client-auth/openai-responses.json",
            stateFile: "state/openai-responses.json",
          },
        },
        providerPackages: { [COMMANDCODE_PROVIDER_PACKAGE]: {} },
        pi: { directory: "pi" },
      }),
      "utf8",
    );
    if (options.tokenValues !== undefined) {
      for (const [protocolId, token] of Object.entries(options.tokenValues)) {
        const path =
          protocolId === ANTHROPIC ? anthropicAuthFile : responsesAuthFile;
        await createFileClientTokenStore({ path }).create(
          { type: "global" },
          token,
        );
      }
    }
    await options.beforeComposition?.({
      anthropicAuthFile,
      responsesAuthFile,
    });
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("commandcode-private", async () => ({
      type: "api_key",
      key: "provider-secret",
    }));
    const projectSnapshot = async (input: {
      readonly projectDir: string;
      readonly signal: AbortSignal;
    }) => {
      input.signal.throwIfAborted();
      return createEmptyServerConfig();
    };
    const config = await loadLuckyTokenCliConfig(configPath);
    const diagnosticsStore = await createRuntimeDiagnosticsStoreFactory({
      configuration: parseRuntimeDiagnosticsConfiguration(
        { directory: join(stateDirectory, "diagnostics") },
        stateDirectory,
      ),
      now: () => 1_700_000_000_000,
    }).open();
    const registry = createSettingsRegistry(
      {
        async load() {
          return {};
        },
        async save() {},
      },
      {
        initial: {
          "server.port": 0,
          "server.bindHost": "127.0.0.1",
        },
      },
    );
    await registry.load();
    const fetchImpl: FetchFunction = async () => commandCodeText("authorized");
    const buildComposition = () =>
      createConfiguredLuckyTokenDataPlane({
        config,
        credentials,
        fetch: fetchImpl,
        importModule: commandCodeProviderImportModule({
          projectSnapshot: { snapshot: projectSnapshot },
        }),
        diagnosticsStore,
        settingsRegistry: registry,
      });
    let composition = await buildComposition();
    const authorities = () => composition.clientTokenAuthorities;
    const protocolNames = {
      [ANTHROPIC]: "Anthropic Messages",
      [RESPONSES]: "OpenAI Responses",
    };
    const endpoint: ControlPlaneEndpoint = {
      address: `\\\\.\\pipe\\luckytoken-token-http-${process.pid}-${++nextPipe}`,
      capability: "client-token-http-capability-012345678901234",
    };
    const host = await startControlPlane({
      endpoint,
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "running", provider: "configured" },
      settingsCommandHandler: createProtocolEnablementSettingsHandler({
        settingsHandler: createSettingsControlPlaneHandler(registry),
        authorities,
        protocolNames,
        diagnostics: diagnosticsStore,
      }),
      clientTokenCommandHandler: createClientTokenControlPlaneHandler({
        authorities,
        protocolNames,
        diagnostics: diagnosticsStore,
      }),
      settingsProjection: () => registry.snapshot(),
      diagnostics: diagnosticsStore,
      pipeServerFactory: createNodePipeTransport(),
      access: nodePipeFallbackAccess,
    });
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `token-http-request-${++nextRequest}`,
      pipeConnector: createNodePipeTransport(),
    });
    await client.hello(1);
    let server = await startLuckyTokenHttpServer({
      runtime: composition.runtime,
      host: "127.0.0.1",
      port: 0,
    });
    const fixture: ServingFixture = {
      client,
      origin: server.origin,
      diagnostics: diagnosticsStore,
      anthropicAuthFile,
      responsesAuthFile,
      async restart() {
        // Mirrors the runServe Data Plane restart: the composition is
        // rebuilt (fresh authorities from the persisted files) against the
        // same shared diagnostics store and settings registry.
        await server.close();
        // The previous composition's ledger store closes with its data
        // plane; the shared diagnostics store and settings registry stay.
        composition.requestLedger.close();
        composition.deepCaptureStore.close();
        composition = await buildComposition();
        server = await startLuckyTokenHttpServer({
          runtime: composition.runtime,
          host: "127.0.0.1",
          port: 0,
        });
        return server.origin;
      },
      async close() {
        await server.close();
        await client.close();
        await host.close();
        composition.diagnosticsStore.close();
        composition.requestLedger.close();
        composition.deepCaptureStore.close();
      },
    };
    fixtures.push(fixture);
    return fixture;
  }

  const anthropicBody = {
    model: "commandcode-private/deepseek/deepseek-v4-flash",
    max_tokens: 32,
    messages: [{ role: "user", content: "hello" }],
  };
  const responsesBody = {
    model: "commandcode-private/deepseek/deepseek-v4-flash",
    input: "hello",
  };

  async function post(
    origin: string,
    pathname: "/v1/messages" | "/v1/responses",
    token: string,
  ): Promise<Response> {
    return fetch(`${origin}${pathname}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        // The Anthropic Messages protocol requires the date-version header.
        ...(pathname === "/v1/messages"
          ? { "anthropic-version": "2023-06-01" }
          : {}),
      },
      body: JSON.stringify(pathname === "/v1/messages" ? anthropicBody : responsesBody),
    });
  }

  it("creates exactly one protocol-global token per enabled protocol on first enabling", async () => {
    const fixture = await startServing();
    // Fresh install: empty token files; boot with both protocols enabled.
    const anthropic = await fixture.client.executeClientTokenCommand({
      command: "list",
      protocolId: ANTHROPIC,
    });
    const responses = await fixture.client.executeClientTokenCommand({
      command: "list",
      protocolId: RESPONSES,
    });
    expect(anthropic.outcome).toBe("ok");
    expect(anthropic.scopes).toHaveLength(1);
    expect(anthropic.scopes?.[0]).toMatchObject({ type: "global" });
    expect(responses.outcome).toBe("ok");
    expect(responses.scopes).toHaveLength(1);
    expect(responses.scopes?.[0]).toMatchObject({ type: "global" });
    // Masked results carry the mask marker, never a full token.
    expect(JSON.stringify(anthropic)).not.toMatch(/lt_[A-Za-z0-9_-]{43}/u);
    expect(JSON.stringify(anthropic)).toContain("…");

    // The created tokens authorize real protocol HTTP immediately.
    const anthropicToken = (
      await fixture.client.executeClientTokenCommand({
        command: "reveal",
        protocolId: ANTHROPIC,
      })
    ).token as string;
    const responsesToken = (
      await fixture.client.executeClientTokenCommand({
        command: "reveal",
        protocolId: RESPONSES,
      })
    ).token as string;
    await expect(
      post(fixture.origin, "/v1/messages", anthropicToken),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      post(fixture.origin, "/v1/responses", responsesToken),
    ).resolves.toMatchObject({ status: 200 });

    // Re-enabling must never create or replace the token.
    await fixture.client.executeSettingsCommand({
      command: "set",
      key: `protocols.${ANTHROPIC}.enabled`,
      value: true,
    });
    const again = await fixture.client.executeClientTokenCommand({
      command: "list",
      protocolId: ANTHROPIC,
    });
    expect(again.scopes).toHaveLength(1);
    await expect(
      fixture.client.executeClientTokenCommand({
        command: "reveal",
        protocolId: ANTHROPIC,
      }),
    ).resolves.toMatchObject({ token: anthropicToken });
  });

  it("keeps authorities protocol-independent; cross-protocol tokens always fail", async () => {
    const fixture = await startServing();
    const anthropicToken = (
      await fixture.client.executeClientTokenCommand({
        command: "reveal",
        protocolId: ANTHROPIC,
      })
    ).token as string;
    const responsesToken = (
      await fixture.client.executeClientTokenCommand({
        command: "reveal",
        protocolId: RESPONSES,
      })
    ).token as string;
    expect(anthropicToken).not.toBe(responsesToken);

    await expect(
      post(fixture.origin, "/v1/responses", anthropicToken),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      post(fixture.origin, "/v1/messages", responsesToken),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      post(fixture.origin, "/v1/messages", "canary-unknown-token-99"),
    ).resolves.toMatchObject({ status: 401 });
  });

  it("rotates atomically with a locked revision and immediately invalidates the prior token", async () => {
    const fixture = await startServing();
    const before = await fixture.client.executeClientTokenCommand({
      command: "list",
      protocolId: ANTHROPIC,
    });
    const prior = (
      await fixture.client.executeClientTokenCommand({
        command: "reveal",
        protocolId: ANTHROPIC,
      })
    ).token as string;
    expect(before.revision).toBe(1);

    // A stale revision can never replace the active token.
    const stale = await fixture.client.executeClientTokenCommand({
      command: "rotate",
      protocolId: ANTHROPIC,
      expectedRevision: 0,
      token: "canary-stale-rotate-token-1",
    });
    expect(stale.outcome).toBe("conflict");
    await expect(
      post(fixture.origin, "/v1/messages", prior),
    ).resolves.toMatchObject({ status: 200 });

    const rotated = await fixture.client.executeClientTokenCommand({
      command: "rotate",
      protocolId: ANTHROPIC,
      expectedRevision: 1,
      token: "canary-rotated-http-token-2",
    });
    expect(rotated.outcome).toBe("ok");
    expect(rotated.revision).toBe(2);
    expect(JSON.stringify(rotated)).not.toContain("canary-rotated-http-token-2");

    // Hot-applied: the prior token is rejected and the new one serves.
    await expect(
      post(fixture.origin, "/v1/messages", prior),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      post(fixture.origin, "/v1/messages", "canary-rotated-http-token-2"),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("deletes hot-applies without disabling the protocol; an empty scope returns 401 and a sanitized warning", async () => {
    const fixture = await startServing();
    const listed = await fixture.client.executeClientTokenCommand({
      command: "list",
      protocolId: ANTHROPIC,
    });
    const token = (
      await fixture.client.executeClientTokenCommand({
        command: "reveal",
        protocolId: ANTHROPIC,
      })
    ).token as string;

    const removed = await fixture.client.executeClientTokenCommand({
      command: "remove",
      protocolId: ANTHROPIC,
      expectedRevision: listed.revision as number,
    });
    expect(removed.outcome).toBe("ok");
    expect(removed.scopes).toEqual([]);

    // The protocol stays enabled: the route serves (401, not 404) and the
    // registered setting is unchanged.
    const settings = await fixture.client.executeSettingsCommand({
      command: "query",
      keys: [`protocols.${ANTHROPIC}.enabled`],
    });
    expect(settings.settings[`protocols.${ANTHROPIC}.enabled`]).toMatchObject({
      value: true,
    });
    await expect(
      post(fixture.origin, "/v1/messages", token),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      post(fixture.origin, "/v1/messages", "canary-another-token-3"),
    ).resolves.toMatchObject({ status: 401 });

    // A sanitized warning is visible through the Diagnostics channel and
    // never contains the removed token.
    const diagnostics = await fixture.client.getDiagnostics({
      minimumLevel: "warning",
      limit: 10,
    });
    expect(diagnostics.records.length).toBeGreaterThan(0);
    const warning = diagnostics.records.find((record) =>
      record.text.includes("no active client token"),
    );
    expect(warning).toBeDefined();
    expect(JSON.stringify(diagnostics.records)).not.toContain(token);
    expect(JSON.stringify(diagnostics.records)).not.toContain(
      "canary-another-token-3",
    );
  });

  it("re-creates exactly one token when a token-less enabled protocol is disabled and re-enabled", async () => {
    const fixture = await startServing();
    const listed = await fixture.client.executeClientTokenCommand({
      command: "list",
      protocolId: RESPONSES,
    });
    await fixture.client.executeClientTokenCommand({
      command: "remove",
      protocolId: RESPONSES,
      expectedRevision: listed.revision as number,
    });
    await expect(
      fixture.client.executeClientTokenCommand({
        command: "list",
        protocolId: RESPONSES,
      }),
    ).resolves.toMatchObject({ outcome: "ok", scopes: [] });

    await fixture.client.executeSettingsCommand({
      command: "set",
      key: `protocols.${RESPONSES}.enabled`,
      value: false,
    });
    await fixture.client.executeSettingsCommand({
      command: "set",
      key: `protocols.${RESPONSES}.enabled`,
      value: true,
    });

    const reenabled = await fixture.client.executeClientTokenCommand({
      command: "list",
      protocolId: RESPONSES,
    });
    expect(reenabled.scopes).toHaveLength(1);
    const fresh = (
      await fixture.client.executeClientTokenCommand({
        command: "reveal",
        protocolId: RESPONSES,
      })
    ).token as string;
    await expect(
      post(fixture.origin, "/v1/responses", fresh),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("serializes concurrent mutations: one wins, the loser conflicts, and no old token is resurrected", async () => {
    const fixture = await startServing();
    const listed = await fixture.client.executeClientTokenCommand({
      command: "list",
      protocolId: ANTHROPIC,
    });
    const prior = (
      await fixture.client.executeClientTokenCommand({
        command: "reveal",
        protocolId: ANTHROPIC,
      })
    ).token as string;

    const [first, second] = await Promise.allSettled([
      fixture.client.executeClientTokenCommand({
        command: "rotate",
        protocolId: ANTHROPIC,
        expectedRevision: listed.revision as number,
        token: "canary-concurrent-winner-4",
      }),
      fixture.client.executeClientTokenCommand({
        command: "rotate",
        protocolId: ANTHROPIC,
        expectedRevision: listed.revision as number,
        token: "canary-concurrent-loser-5",
      }),
    ]);
    // Through the versioned wire a stale revision is a fulfilled conflict
    // result, never a transport failure: exactly one rotate wins and the
    // other reports the conflict outcome.
    const outcomes = [first, second].map((result) =>
      result.status === "fulfilled"
        ? (result.value as { readonly outcome: string }).outcome
        : "transport-failure",
    );
    expect(outcomes.filter((outcome) => outcome === "ok")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "conflict")).toHaveLength(1);

    // The prior token can never come back: HTTP still rejects it, and the
    // active token is exactly one of the two candidates.
    await expect(
      post(fixture.origin, "/v1/messages", prior),
    ).resolves.toMatchObject({ status: 401 });
    const active = (
      await fixture.client.executeClientTokenCommand({
        command: "reveal",
        protocolId: ANTHROPIC,
      })
    ).token as string;
    expect(["canary-concurrent-winner-4", "canary-concurrent-loser-5"]).toContain(
      active,
    );
    await expect(
      post(fixture.origin, "/v1/messages", active),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("never leaks rotated secrets into diagnostics, status, or events", async () => {
    const fixture = await startServing();
    const listed = await fixture.client.executeClientTokenCommand({
      command: "list",
      protocolId: ANTHROPIC,
    });
    await fixture.client.executeClientTokenCommand({
      command: "rotate",
      protocolId: ANTHROPIC,
      expectedRevision: listed.revision as number,
      token: "canary-secret-never-leaks-6",
    });

    // A diagnostic draft containing the live token passes through the single
    // Ticket 07 redaction boundary and is scrubbed before persistence.
    fixture.diagnostics.append({
      level: "warning",
      text: "request bearer canary-secret-never-leaks-6 observed",
      details: { headers: [["authorization", "Bearer canary-secret-never-leaks-6"]] },
    });
    const diagnostics = await fixture.client.getDiagnostics({
      minimumLevel: "warning",
      limit: 10,
    });
    expect(JSON.stringify(diagnostics.records)).not.toContain(
      "canary-secret-never-leaks-6",
    );

    // Status snapshots, settings projections, and events stay secret-free.
    const status = await fixture.client.getStatus();
    expect(JSON.stringify(status)).not.toContain("canary-secret-never-leaks-6");
    const events: unknown[] = [];
    await fixture.client.subscribe((event) => events.push(event));
    await fixture.client.executeSettingsCommand({
      command: "set",
      key: `protocols.${RESPONSES}.enabled`,
      value: false,
    });
    expect(JSON.stringify(events)).not.toContain("canary-secret-never-leaks-6");
  });

  it("keeps the rotated token authoritative and diagnostics scrubbing current across a Data Plane restart", async () => {
    const fixture = await startServing();
    const listed = await fixture.client.executeClientTokenCommand({
      command: "list",
      protocolId: ANTHROPIC,
    });
    const prior = (
      await fixture.client.executeClientTokenCommand({
        command: "reveal",
        protocolId: ANTHROPIC,
      })
    ).token as string;
    await fixture.client.executeClientTokenCommand({
      command: "rotate",
      protocolId: ANTHROPIC,
      expectedRevision: listed.revision as number,
      token: "canary-restart-token-8",
    });

    const newOrigin = await fixture.restart();
    // The rotated token is the persisted authority after restart; the prior
    // token stays rejected.
    await expect(
      post(newOrigin, "/v1/messages", "canary-restart-token-8"),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      post(newOrigin, "/v1/messages", prior),
    ).resolves.toMatchObject({ status: 401 });

    // The restarted composition re-attached its scrubber: the current token
    // is scrubbed by the single Ticket 07 boundary even after the restart.
    fixture.diagnostics.append({
      level: "warning",
      text: "bearer canary-restart-token-8 observed",
    });
    const diagnostics = await fixture.client.getDiagnostics({
      minimumLevel: "warning",
      limit: 10,
    });
    expect(JSON.stringify(diagnostics.records)).not.toContain(
      "canary-restart-token-8",
    );
  });

  it("preserves project-token authorization while the global scope is managed live", async () => {
    const projectDir = join(tmpdir(), "luckytoken-preserved-project");
    const fixture = await startServing({
      beforeComposition: async ({ anthropicAuthFile }) => {
        const store = createFileClientTokenStore({ path: anthropicAuthFile });
        await store.create(
          { type: "project", projectDir },
          "canary-project-http-7",
        );
      },
    });
    const globalToken = (
      await fixture.client.executeClientTokenCommand({
        command: "reveal",
        protocolId: ANTHROPIC,
      })
    ).token as string;
    expect(globalToken).not.toBe("canary-project-http-7");

    // Project tokens still authorize requests (Ticket 17 preserves this).
    await expect(
      post(fixture.origin, "/v1/messages", "canary-project-http-7"),
    ).resolves.toMatchObject({ status: 200 });
    // The masked list shows the project scope without its secret.
    const listed = await fixture.client.executeClientTokenCommand({
      command: "list",
      protocolId: ANTHROPIC,
    });
    expect(listed.scopes).toEqual([
      { type: "global", maskedToken: expect.stringContaining("…") as unknown as string },
      { type: "project", projectDir, maskedToken: "canary-p…tp-7" },
    ]);
    expect(JSON.stringify(listed)).not.toContain("canary-project-http-7");
  });
});

describe("repair findings 1-2: persisted authority state across restarts", () => {
  const directories: string[] = [];
  const fixtures: ServingFixture[] = [];
  let nextPipe = 0;
  let nextRequest = 0;

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  async function startServing(): Promise<ServingFixture> {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-token-restart-"));
    directories.push(root);
    const stateDirectory = join(root, ".luckytoken");
    const piDirectory = join(stateDirectory, "pi");
    const stateDir = join(stateDirectory, "state");
    await mkdir(piDirectory, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    const anthropicAuthFile = join(
      stateDirectory,
      "client-auth",
      "anthropic-messages.json",
    );
    const responsesAuthFile = join(
      stateDirectory,
      "client-auth",
      "openai-responses.json",
    );
    const configPath = join(stateDirectory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "luckytoken-config-v1",
        server: { host: "127.0.0.1", port: 0 },
        clientProtocols: {
          [ANTHROPIC]: { authFile: "client-auth/anthropic-messages.json" },
          [RESPONSES]: {
            authFile: "client-auth/openai-responses.json",
            stateFile: "state/openai-responses.json",
          },
        },
        providerPackages: { [COMMANDCODE_PROVIDER_PACKAGE]: {} },
        pi: { directory: "pi" },
      }),
      "utf8",
    );
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("commandcode-private", async () => ({
      type: "api_key",
      key: "provider-secret",
    }));
    const config = await loadLuckyTokenCliConfig(configPath);
    const diagnosticsStore = await createRuntimeDiagnosticsStoreFactory({
      configuration: parseRuntimeDiagnosticsConfiguration(
        { directory: join(stateDirectory, "diagnostics") },
        stateDirectory,
      ),
      now: () => 1_700_000_000_000,
    }).open();
    const registry = createSettingsRegistry(
      {
        async load() {
          return {};
        },
        async save() {},
      },
      {
        initial: { "server.port": 0, "server.bindHost": "127.0.0.1" },
      },
    );
    await registry.load();
    const fetchImpl: FetchFunction = async () => commandCodeText("authorized");
    const buildComposition = () =>
      createConfiguredLuckyTokenDataPlane({
        config,
        credentials,
        fetch: fetchImpl,
        importModule: commandCodeProviderImportModule({
          projectSnapshot: {
            snapshot: async () => createEmptyServerConfig(),
          },
        }),
        diagnosticsStore,
        settingsRegistry: registry,
      });
    let composition = await buildComposition();
    const authorities = () => composition.clientTokenAuthorities;
    const protocolNames = {
      [ANTHROPIC]: "Anthropic Messages",
      [RESPONSES]: "OpenAI Responses",
    };
    const endpoint: ControlPlaneEndpoint = {
      address: `\\\\.\\pipe\\luckytoken-token-restart-${process.pid}-${++nextPipe}`,
      capability: "client-token-restart-capability-0123456789",
    };
    const host = await startControlPlane({
      endpoint,
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "running", provider: "configured" },
      settingsCommandHandler: createProtocolEnablementSettingsHandler({
        settingsHandler: createSettingsControlPlaneHandler(registry),
        authorities,
        protocolNames,
        diagnostics: diagnosticsStore,
      }),
      clientTokenCommandHandler: createClientTokenControlPlaneHandler({
        authorities,
        protocolNames,
        diagnostics: diagnosticsStore,
      }),
      settingsProjection: () => registry.snapshot(),
      diagnostics: diagnosticsStore,
      pipeServerFactory: createNodePipeTransport(),
      access: nodePipeFallbackAccess,
    });
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `token-restart-request-${++nextRequest}`,
      pipeConnector: createNodePipeTransport(),
    });
    await client.hello(1);
    let server = await startLuckyTokenHttpServer({
      runtime: composition.runtime,
      host: "127.0.0.1",
      port: 0,
    });
    const fixture: ServingFixture = {
      client,
      origin: server.origin,
      diagnostics: diagnosticsStore,
      anthropicAuthFile,
      responsesAuthFile,
      async restart() {
        await server.close();
        // The previous composition's ledger store closes with its data
        // plane; the shared diagnostics store and settings registry stay.
        composition.requestLedger.close();
        composition.deepCaptureStore.close();
        composition = await buildComposition();
        server = await startLuckyTokenHttpServer({
          runtime: composition.runtime,
          host: "127.0.0.1",
          port: 0,
        });
        return server.origin;
      },
      async close() {
        await server.close();
        await client.close();
        await host.close();
        composition.diagnosticsStore.close();
        composition.requestLedger.close();
        composition.deepCaptureStore.close();
      },
    };
    fixtures.push(fixture);
    return fixture;
  }

  const anthropicBody = {
    model: "commandcode-private/deepseek/deepseek-v4-flash",
    max_tokens: 32,
    messages: [{ role: "user", content: "hello" }],
  };

  async function post(origin: string, token: string): Promise<Response> {
    return fetch(`${origin}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(anthropicBody),
    });
  }

  it("keeps an enabled protocol token-less across a Data Plane restart after delete", async () => {
    const fixture = await startServing();
    const listed = await fixture.client.executeClientTokenCommand({
      command: "list",
      protocolId: ANTHROPIC,
    });
    const token = (
      await fixture.client.executeClientTokenCommand({
        command: "reveal",
        protocolId: ANTHROPIC,
      })
    ).token as string;
    const removed = await fixture.client.executeClientTokenCommand({
      command: "remove",
      protocolId: ANTHROPIC,
      expectedRevision: listed.revision as number,
    });
    expect(removed.outcome).toBe("ok");

    const newOrigin = await fixture.restart();

    // The deliberate deletion survives the restart: no replacement secret
    // is created and the scope stays empty.
    await expect(
      fixture.client.executeClientTokenCommand({
        command: "reveal",
        protocolId: ANTHROPIC,
      }),
    ).resolves.toMatchObject({ outcome: "not_found" });
    await expect(
      fixture.client.executeClientTokenCommand({
        command: "list",
        protocolId: ANTHROPIC,
      }),
    ).resolves.toMatchObject({ outcome: "ok", scopes: [] });

    // All model requests return 401 and the protocol remains enabled.
    await expect(post(newOrigin, token)).resolves.toMatchObject({ status: 401 });
    await expect(
      post(newOrigin, "canary-post-restart-token-9"),
    ).resolves.toMatchObject({ status: 401 });
    const settings = await fixture.client.executeSettingsCommand({
      command: "query",
      keys: [`protocols.${ANTHROPIC}.enabled`],
    });
    expect(settings.settings[`protocols.${ANTHROPIC}.enabled`]).toMatchObject({
      value: true,
    });

    // The sanitized warning stays visible through the Diagnostics channel.
    const diagnostics = await fixture.client.getDiagnostics({
      minimumLevel: "warning",
      limit: 10,
    });
    expect(
      diagnostics.records.some((record) =>
        record.text.includes("no active client token"),
      ),
    ).toBe(true);
    expect(JSON.stringify(diagnostics.records)).not.toContain(token);
  });

  it("keeps the mutation revision authoritative across a Data Plane restart", async () => {
    const fixture = await startServing();
    const listed = await fixture.client.executeClientTokenCommand({
      command: "list",
      protocolId: ANTHROPIC,
    });
    const prior = (
      await fixture.client.executeClientTokenCommand({
        command: "reveal",
        protocolId: ANTHROPIC,
      })
    ).token as string;

    const newOrigin = await fixture.restart();

    // A pre-restart stale revision conflicts instead of matching a reset.
    await expect(
      fixture.client.executeClientTokenCommand({
        command: "rotate",
        protocolId: ANTHROPIC,
        expectedRevision: (listed.revision as number) - 1,
        token: "canary-stale-restart-token-1",
      }),
    ).resolves.toMatchObject({ outcome: "conflict" });
    await expect(
      fixture.client.executeClientTokenCommand({
        command: "remove",
        protocolId: ANTHROPIC,
        expectedRevision: (listed.revision as number) - 1,
      }),
    ).resolves.toMatchObject({ outcome: "conflict" });
    await expect(post(newOrigin, prior)).resolves.toMatchObject({ status: 200 });

    // The persisted revision rotates the live token and the now-stale
    // pre-restart revision can never rotate or remove again.
    const rotated = await fixture.client.executeClientTokenCommand({
      command: "rotate",
      protocolId: ANTHROPIC,
      expectedRevision: listed.revision as number,
      token: "canary-restart-rev-token-2",
    });
    expect(rotated.outcome).toBe("ok");
    await expect(post(newOrigin, prior)).resolves.toMatchObject({ status: 401 });
    await expect(
      post(newOrigin, "canary-restart-rev-token-2"),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      fixture.client.executeClientTokenCommand({
        command: "rotate",
        protocolId: ANTHROPIC,
        expectedRevision: listed.revision as number,
        token: "canary-resurrect-token-3",
      }),
    ).resolves.toMatchObject({ outcome: "conflict" });
    await expect(
      fixture.client.executeClientTokenCommand({
        command: "remove",
        protocolId: ANTHROPIC,
        expectedRevision: listed.revision as number,
      }),
    ).resolves.toMatchObject({ outcome: "conflict" });
  });
});
