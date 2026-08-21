import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  connectControlPlane,
  createNodePipeTransport,
  nodePipeFallbackAccess,
  startControlPlane,
  type ControlPlaneDiagnostics,
  type ControlPlaneEndpoint,
  type RunningControlPlane,
  type StatusEvent,
} from "@luckytoken/application-control-plane/control-plane";
import {
  createRuntimeDiagnosticsStoreFactory,
  parseRuntimeDiagnosticsConfiguration,
} from "../../../src/runtime-diagnostics/index.js";
import { createSettingsControlPlaneHandler } from "../../../src/settings/control-plane.js";
import { resolveEffectiveSettings } from "../../../src/settings/data-plane.js";

import { createDataPlaneRuntimeSupervisor } from "../../../src/runtime-supervisor.js";
import {
  startLuckyTokenHttpServer,
  type RunningLuckyTokenHttpServer,
} from "../../../src/server.js";
import {
  createSettingsRegistry,
  type SettingsStore,
} from "../../../src/settings/catalog.js";
import { createProtocolAwareRuntime } from "../../../src/settings/runtime.js";
import { createLuckyTokenRuntime } from "../../../src/runtime.js";
import type { ClientProtocolHandler } from "../../../src/http.js";

const anthropic: ClientProtocolHandler = {
  method: "POST",
  pathname: "/v1/messages",
  handle: async (request) => {
    if (request.headers.get("authorization") !== "Bearer settings-test-token") {
      return new Response(
        JSON.stringify({
          error: {
            type: "authentication_error",
            message: "Invalid authentication credentials",
          },
        }),
        {
          status: 401,
          headers: { "content-type": "application/json" },
        },
      );
    }
    return new Response("anthropic", {
      headers: { "content-type": "application/json" },
    });
  },
};
const responses: ClientProtocolHandler = {
  method: "POST",
  pathname: "/v1/responses",
  handle: async () => new Response("responses"),
};

function memoryStore(): SettingsStore {
  const values: Record<string, unknown> = {};
  return {
    async load() {
      return { ...values };
    },
    async save(next) {
      for (const [key, value] of Object.entries(next)) values[key] = value;
    },
  };
}

describe("settings through the Control Plane and real HTTP seams", () => {
  const hosts: RunningControlPlane[] = [];
  const httpServers: RunningLuckyTokenHttpServer[] = [];
  const roots: string[] = [];
  const stores: Array<{ close(): void }> = [];
  let nextPipe = 0;
  let nextRequest = 0;

  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((host) => host.close()));
    await Promise.all(httpServers.splice(0).map((server) => server.close()));
    stores.splice(0).forEach((store) => store.close());
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function startSettingsControlPlane(options: {
    readonly port?: number;
    readonly onStart?: () => void;
    readonly diagnostics?: ControlPlaneDiagnostics;
    readonly settingsStore?: SettingsStore;
  }): Promise<{
    readonly host: RunningControlPlane;
    readonly registry: ReturnType<typeof createSettingsRegistry>;
    readonly client: Awaited<ReturnType<typeof connectControlPlane>>;
    readonly endpoint: ControlPlaneEndpoint;
  }> {
    const store = options.settingsStore ?? memoryStore();
    const registry = createSettingsRegistry(store);
    let activeServer: RunningLuckyTokenHttpServer | undefined;
    const runtime = createProtocolAwareRuntime({
      runtime: createLuckyTokenRuntime({
        clientProtocols: [anthropic, responses],
      }),
      isProtocolEnabled: (protocolId) =>
        registry.query([`protocols.${protocolId}.enabled`])[
          `protocols.${protocolId}.enabled`
        ]?.value !== false,
      protocolRoutes: [
        { id: "anthropic-messages", method: "POST", pathname: "/v1/messages" },
        { id: "openai-responses", method: "POST", pathname: "/v1/responses" },
      ],
    });
    const supervisor = createDataPlaneRuntimeSupervisor({
      host: "127.0.0.1",
      port: 3000,
      readProvider: () => "unconfigured",
      resolveAddress: () => resolveEffectiveSettings(registry.query([])),
      startListener: async (address) => {
        options.onStart?.();
        activeServer = await startLuckyTokenHttpServer({
          runtime,
          host: address.host,
          port: address.port,
        });
        httpServers.push(activeServer);
        return activeServer;
      },
    });
    const endpoint: ControlPlaneEndpoint = {
      address: `\\\\.\\pipe\\luckytoken-settings-${process.pid}-${++nextPipe}`,
      capability: "settings-test-capability-012345678901234567890",
    };
    const host = await startControlPlane({
      endpoint,
      application: { id: "luckytoken", version: "test" },
      initialStatus: supervisor.initialStatus,
      runtimeCommandHandler: supervisor.execute,
      settingsCommandHandler: createSettingsControlPlaneHandler(registry),
      settingsProjection: () => registry.snapshot(),
      ...(options.diagnostics === undefined
        ? {}
        : { diagnostics: options.diagnostics }),
      pipeServerFactory: createNodePipeTransport(),
      access: nodePipeFallbackAccess,
    });
    hosts.push(host);
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `settings-request-${++nextRequest}`,
      pipeConnector: createNodePipeTransport(),
    });
    await client.hello(2);
    return { host, registry, client, endpoint };
  }

  it("publishes the registered settings catalog in status snapshots and events", async () => {
    const { client } = await startSettingsControlPlane({});
    const status = await client.getStatus();
    const settings = status.settings;
    if (settings === undefined) throw new Error("settings missing from snapshot");

    expect(Object.keys(settings)).toEqual([
      "protocols.anthropic-messages.enabled",
      "protocols.openai-responses.enabled",
      "diagnostics.deepCapture.enabled",
      "application.quitDrainTimeoutMs",
      "integrations.codex.preimage.modelProvider",
      "integrations.codex.preimage.openaiBaseUrl",
      "integrations.codex.preimage.modelCatalogJson",
    ]);
    expect(settings["protocols.anthropic-messages.enabled"]).toMatchObject({
      type: "boolean",
      default: true,
      applyMode: "hot-apply",
      value: true,
    });
    expect(JSON.stringify(status)).not.toContain("capability");

    const events: StatusEvent[] = [];
    await client.subscribe((event) => events.push(event));
    await client.executeSettingsCommand({
      command: "set",
      key: "diagnostics.deepCapture.enabled",
      value: true,
    });
    expect(events.length).toBe(1);
    expect(events[0]?.snapshot.settings?.["diagnostics.deepCapture.enabled"]).toMatchObject({
      value: true,
      applyMode: "hot-apply",
    });
  });

  it("enables and disables protocols independently through the same settings commands", async () => {
    const { client } = await startSettingsControlPlane({ port: 0 });
    const setResult = await client.executeSettingsCommand({
      command: "set",
      key: "protocols.anthropic-messages.enabled",
      value: false,
    });
    expect(setResult).toMatchObject({ outcome: "applied" });

    const queried = await client.executeSettingsCommand({
      command: "query",
      keys: ["protocols.anthropic-messages.enabled"],
    });
    expect(queried.outcome).toBe("ok");
    expect(
      (queried as { readonly settings: Record<string, unknown> }).settings[
        "protocols.anthropic-messages.enabled"
      ],
    ).toMatchObject({ value: false });
  });

  it("publishes nullable Codex restore targets as null by default", async () => {
    const { client } = await startSettingsControlPlane({});

    const result = await client.executeSettingsCommand({
      command: "query",
      keys: [
        "integrations.codex.preimage.modelProvider",
        "integrations.codex.preimage.openaiBaseUrl",
        "integrations.codex.preimage.modelCatalogJson",
      ],
    });

    expect(result.settings).toEqual({
      "integrations.codex.preimage.modelProvider": {
        key: "integrations.codex.preimage.modelProvider",
        type: "nullable-string",
        default: null,
        validation: { type: "nullable-string" },
        sensitivity: "public",
        applyMode: "hot-apply",
        value: null,
      },
      "integrations.codex.preimage.openaiBaseUrl": {
        key: "integrations.codex.preimage.openaiBaseUrl",
        type: "nullable-string",
        default: null,
        validation: { type: "nullable-string" },
        sensitivity: "public",
        applyMode: "hot-apply",
        value: null,
      },
      "integrations.codex.preimage.modelCatalogJson": {
        key: "integrations.codex.preimage.modelCatalogJson",
        type: "nullable-string",
        default: null,
        validation: { type: "nullable-string" },
        sensitivity: "public",
        applyMode: "hot-apply",
        value: null,
      },
    });
  });

  it("returns a typed storage failure and keeps the old Control Plane projection", async () => {
    const { client } = await startSettingsControlPlane({
      settingsStore: {
        async load() {
          return { "protocols.anthropic-messages.enabled": true };
        },
        async save() {
          throw new Error("secret operating-system write failure");
        },
      },
    });

    const result = await client.executeSettingsCommand({
      command: "set",
      key: "protocols.anthropic-messages.enabled",
      value: false,
    });

    expect(result).toMatchObject({
      outcome: "storage_failure",
      error: "Settings could not be saved",
      settings: {
        "protocols.anthropic-messages.enabled": { value: true },
      },
    });
    expect(JSON.stringify(result)).not.toContain("operating-system");
    expect((await client.getStatus()).settings?.["protocols.anthropic-messages.enabled"]?.value).toBe(true);
  });

  it("rejects server.port because endpoint ownership moved to PublicModelAuthority", async () => {
    const { client } = await startSettingsControlPlane({ port: 0 });

    await expect(
      client.executeSettingsCommand({
        command: "set",
        key: "server.port",
        value: 3280,
      }),
    ).resolves.toMatchObject({ outcome: "unknown_key" });
    const snapshot = await client.getStatus();
    expect(snapshot.settings).not.toHaveProperty("server.port");
  });

  it("does not expose LAN bind configuration or a settings confirmation command", async () => {
    const { client } = await startSettingsControlPlane({ port: 0 });

    await expect(
      client.executeSettingsCommand({
        command: "set",
        key: "server.bindHost",
        value: "0.0.0.0",
      }),
    ).resolves.toMatchObject({ outcome: "unknown_key" });

    await expect(
      client.executeSettingsCommand({
        command: "confirm",
        actionId: "obsolete-lan-confirmation",
      } as never),
    ).rejects.toThrow(/invalid_request/iu);
  });

  it("always starts the real Data Plane listener on the fixed loopback host", async () => {
    const { client } = await startSettingsControlPlane({ port: 0 });

    await expect(
      client.executeSettingsCommand({
        command: "set",
        key: "server.bindHost",
        value: "0.0.0.0",
      }),
    ).resolves.toMatchObject({ outcome: "unknown_key" });

    await client.executeRuntimeCommand("start");
    const snapshot = await client.getStatus();
    expect(snapshot.settings).not.toHaveProperty("server.bindHost");
    expect(snapshot.dataPlane?.configuredOrigin).toBe("http://127.0.0.1:3000");
  });

  it("rejects unknown keys and unregistered values with closed outcomes", async () => {
    const { client } = await startSettingsControlPlane({ port: 0 });

    await expect(
      client.executeSettingsCommand({
        command: "set",
        key: "internal.experimental.flag",
        value: true,
      }),
    ).resolves.toMatchObject({ outcome: "unknown_key" });
    await expect(
      client.executeSettingsCommand({
        command: "set",
        key: "server.port",
        value: 99_999,
      }),
    ).resolves.toMatchObject({ outcome: "unknown_key" });
    const catalog = await client.executeSettingsCommand({ command: "query" });
    expect(JSON.stringify(catalog)).not.toContain("internal.experimental.flag");
  });

  it("keeps settings, status, and diagnostics subscriptions isolated on one host", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-settings-diag-"));
    roots.push(root);
    const configuration = parseRuntimeDiagnosticsConfiguration(
      { directory: root },
      root,
    );
    const store = await createRuntimeDiagnosticsStoreFactory({
      configuration,
      now: () => 1_700_000_000_000,
      scrub: (value: string) => value,
    }).open();
    stores.push(store);
    const { client } = await startSettingsControlPlane({
      diagnostics: store,
    });

    const statusEvents: unknown[] = [];
    const diagnosticsEvents: unknown[] = [];
    await client.subscribe((event) => statusEvents.push(event));
    await client.subscribeDiagnostics((event) => diagnosticsEvents.push(event));

    // A settings command publishes a status_changed event.
    await client.executeSettingsCommand({
      command: "set",
      key: "protocols.anthropic-messages.enabled",
      value: false,
    });
    await expect.poll(() => statusEvents).toHaveLength(1);
    expect(statusEvents[0]).toMatchObject({ type: "status_changed" });
    expect(JSON.stringify(statusEvents[0])).toContain("settings");

    // A diagnostic append publishes a typed diagnostic event only.
    store.append({
      level: "warning",
      text: "cross-feature canary diagnostic",
      details: { headers: [["cookie", "canary-cross-cookie-1234"]] },
    });
    await expect.poll(() => diagnosticsEvents).toHaveLength(1);
    expect(diagnosticsEvents[0]).toMatchObject({ type: "diagnostic" });
    expect(JSON.stringify(diagnosticsEvents[0])).not.toContain(
      "canary-cross-cookie-1234",
    );

    // Isolation: settings never reach diagnostics subscribers and vice versa.
    expect(JSON.stringify(diagnosticsEvents)).not.toContain("settings");
    expect(JSON.stringify(statusEvents)).not.toContain("cross-feature canary");
    await client.close();
    store.close();
  });
});
