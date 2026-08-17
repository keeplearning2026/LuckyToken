import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  connectControlPlane,
  createNodePipeTransport,
  nodePipeFallbackAccess,
  startControlPlane,
  type CatalogStatusProjection,
  type ControlPlaneEndpoint,
  type RunningControlPlane,
} from "@luckytoken/application-control-plane/control-plane";

import { createModels, createProvider } from "@earendil-works/pi-ai";

import { createCatalogCacheStore } from "../../src/providers/catalog-cache.js";
import {
  createCatalogRefreshController,
  createCatalogSnapshotModels,
  type CatalogRefreshController,
} from "../../src/providers/catalog-refresh.js";
import { createModelsJsonAuthority } from "../../src/models-config/authority.js";
import { composeEffectiveCatalog } from "../../src/providers/effective-composition.js";
import {
  createRuntimeDiagnosticsStoreFactory,
} from "../../src/runtime-diagnostics/index.js";

/**
 * Ticket 11 Control Plane seam: versioned catalog commands and the
 * sanitized catalog status projection. Every case drives the real refresh
 * controller through the versioned pipe client, so the UI/CLI can observe
 * catalog queries, background/manual refresh commands and the resulting
 * status events without any implementation internals.
 */

interface CatalogPlaneFixture {
  readonly host: RunningControlPlane;
  readonly client: Awaited<ReturnType<typeof connectControlPlane>>;
  readonly controller: CatalogRefreshController;
  readonly diagnostics: Awaited<
    ReturnType<ReturnType<typeof createRuntimeDiagnosticsStoreFactory>["open"]>
  >;
  readonly close: () => Promise<void>;
}

const fixtures: CatalogPlaneFixture[] = [];
let nextPipe = 0;
let nextRequest = 0;

async function createCatalogPlane(options?: {
  readonly onSnapshot?: (snapshot: unknown) => void;
  /** Skip binding the controller: the runtime is not started. */
  readonly bind?: false;
}): Promise<CatalogPlaneFixture> {
  const root = await mkdtemp(join(tmpdir(), "luckytoken-catalog-plane-"));
  const files = new Map<string, string>();
  const fileSystem = {
    readFile: async (path: string) => {
      const content = files.get(path);
      if (content === undefined) {
        throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      }
      return content;
    },
    writeFile: async (path: string, content: string) => {
      files.set(path, content);
    },
    rename: async (from: string, to: string) => {
      const content = files.get(from);
      if (content === undefined) {
        throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      }
      files.delete(from);
      files.set(to, content);
    },
    mkdir: async () => undefined,
    rm: async (path: string) => {
      files.delete(path);
    },
  };
  const modelsJsonPath = join(root, "models.json");
  files.set(modelsJsonPath, `${JSON.stringify({ providers: {} }, null, 2)}\n`);
  const authority = createModelsJsonAuthority({
    path: modelsJsonPath,
    fileSystem,
    lock: { acquire: async () => async () => undefined },
    compose: (providers) => composeEffectiveCatalog(providers),
  });
  const store = createCatalogCacheStore({
    path: join(root, "models-catalog-cache.json"),
    fileSystem,
  });
  const diagnostics = await createRuntimeDiagnosticsStoreFactory({
    configuration: { directory: root },
    now: () => 1_700_000_000_000,
    scrub: (value: string) => value,
  }).open();
  let statusProjection: CatalogStatusProjection = {
    version: 0,
    refreshing: false,
    failedProviderIds: [],
  };
  // A controlled dynamic Provider exercises the refresh lifecycle through
  // the same seams the data plane serves.
  const controlled = createProvider({
    id: "catalog-plane-dynamic",
    name: "catalog-plane-dynamic",
    baseUrl: "https://controlled.example.com/v1",
    models: [],
    auth: {
      apiKey: {
        name: "Controlled API key",
        login: async () => ({ type: "api_key", key: "test-key" }),
        check: async () => ({ type: "api_key", source: "configured" }),
        resolve: async () => ({ auth: { apiKey: "test-key" }, source: "configured" }),
      },
    },
    api: {
      stream: () => {
        throw new Error("no streaming in catalog tests");
      },
      streamSimple: () => {
        throw new Error("no streaming in catalog tests");
      },
    },
  });
  const mutable = createModels({
    authContext: { env: async () => undefined, fileExists: async () => false },
    modelsStore: store,
  });
  mutable.setProvider(controlled);
  const wrapped = createCatalogSnapshotModels(mutable);
  const controller = createCatalogRefreshController({
    store,
    authority,
    diagnostics,
    now: () => 1_700_000_000_000,
    scheduler: {
      schedule: (task) => {
        void task();
      },
    },
    onSnapshot: (snapshot) => {
      statusProjection = {
        version: snapshot.version,
        refreshing: snapshot.providers.some(
          (provider) => provider.state === "refreshing",
        ),
        ...(snapshot.refreshedAt === undefined
          ? {}
          : { refreshedAt: snapshot.refreshedAt }),
        failedProviderIds: snapshot.providers
          .filter((provider) => provider.state === "failed")
          .map((provider) => provider.providerId),
      };
      // The host publishes the sanitized projection on every swap.
      void hostRef.current?.publishStatus({
        modelDataPlane: "stopped",
        provider: "unconfigured",
      });
      options?.onSnapshot?.(snapshot);
    },
  });
  const hostRef: { current: RunningControlPlane | undefined } = { current: undefined };
  const endpoint: ControlPlaneEndpoint = {
    address: `\\\\.\\pipe\\luckytoken-catalog-plane-${process.pid}-${++nextPipe}`,
    capability: "catalog-plane-capability-012345678901234567",
  };
  const host = await startControlPlane({
    endpoint,
    application: { id: "luckytoken", version: "test" },
    initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
    // The exact catalog command contract runServe wires (cli.ts): a
    // background refresh before the controller is bound is unavailable.
    catalogCommandHandler: async (command) => {
      if (command.command === "query") {
        return { outcome: "ok", snapshot: controller.snapshot() };
      }
      if (command.mode === "background") {
        if (!controller.isBound()) {
          return { outcome: "unavailable", snapshot: controller.snapshot() };
        }
        controller.scheduleBackground("page_open");
        return { outcome: "scheduled", snapshot: controller.snapshot() };
      }
      const refresh = await controller.refreshManual();
      return {
        outcome: "ok",
        snapshot: controller.snapshot(),
        refresh,
      };
    },
    catalogProjection: () => statusProjection,
    pipeServerFactory: createNodePipeTransport(),
    access: nodePipeFallbackAccess,
  });
  hostRef.current = host;
  if (options?.bind === false) {
    // The controller exists but the runtime is not bound (gateway not
    // started): refresh commands must report unavailable, never a no-op
    // "scheduled".
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `catalog-plane-request-${++nextRequest}`,
      pipeConnector: createNodePipeTransport(),
    });
    const hello = await client.hello(1);
    if (hello.type !== "compatible") {
      throw new Error("Control Plane hello failed");
    }
    const fixture: CatalogPlaneFixture = {
      host,
      client,
      controller,
      diagnostics,
      close: async () => {
        diagnostics.close();
        await rm(root, { recursive: true, force: true });
      },
    };
    fixtures.push(fixture);
    return fixture;
  }
  await controller.bind({
    models: wrapped,
    recompose: () => undefined,
    capture: () => wrapped.capture(),
  });
  // Settle the non-blocking startup background refresh so the snapshot is
  // deterministic for the command assertions.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const client = await connectControlPlane(host.endpoint, {
    createRequestId: () => `catalog-plane-request-${++nextRequest}`,
    pipeConnector: createNodePipeTransport(),
  });
  const hello = await client.hello(1);
  if (hello.type !== "compatible") {
    throw new Error("Control Plane hello failed");
  }
  const fixture: CatalogPlaneFixture = {
    host,
    client,
    controller,
    diagnostics,
    close: async () => {
      diagnostics.close();
      await rm(root, { recursive: true, force: true });
    },
  };
  fixtures.push(fixture);
  return fixture;
}

describe("catalog commands through the Control Plane", () => {
  afterEach(async () => {
    await Promise.all(
      fixtures.splice(0).map(async (fixture) => {
        await fixture.client.close().catch(() => undefined);
        await fixture.host.close();
        await fixture.close();
      }),
    );
  });

  it("serves catalog queries with the authoritative snapshot", async () => {
    const fixture = await createCatalogPlane();
    const result = await fixture.client.executeCatalogCommand({
      command: "query",
    });
    expect(result.outcome).toBe("ok");
    expect(result.snapshot.version).toBeGreaterThan(0);
    expect(result.snapshot.modelsJsonValid).toBe(true);
    expect(result.snapshot.providers.length).toBeGreaterThan(0);
    expect(result.snapshot.refreshedAt).toBeGreaterThan(0);
    expect(result.refresh).toBeUndefined();
  });

  it("schedules a non-blocking background refresh command", async () => {
    const fixture = await createCatalogPlane();
    const result = await fixture.client.executeCatalogCommand({
      command: "refresh",
      mode: "background",
    });
    expect(result.outcome).toBe("scheduled");
    // The command does not wait for the refresh to finish.
    expect(result.refresh).toBeUndefined();
    expect(result.snapshot.version).toBeGreaterThan(0);
  });

  it("completes a manual refresh command with bounded per-Provider results", async () => {
    const fixture = await createCatalogPlane();
    const result = await fixture.client.executeCatalogCommand({
      command: "refresh",
      mode: "manual",
    });
    expect(result.outcome).toBe("ok");
    expect(result.refresh?.trigger).toBe("manual");
    expect(Array.isArray(result.refresh?.providers)).toBe(true);
    expect(
      (result.refresh?.providers ?? []).every(
        (entry) =>
          entry.outcome === "succeeded" ||
          entry.outcome === "failed" ||
          entry.outcome === "skipped",
      ),
    ).toBe(true);
    // A manual refresh advanced the active snapshot.
    expect(result.snapshot.version).toBeGreaterThan(0);
    expect(result.snapshot.refreshedAt).toBeGreaterThan(0);
  });

  it("merges the sanitized catalog status projection into status snapshots", async () => {
    const fixture = await createCatalogPlane();
    const before = await fixture.client.getStatus();
    expect(before.catalog).toBeDefined();
    expect((before.catalog?.version ?? 0)).toBeGreaterThan(0);
    await fixture.client.executeCatalogCommand({
      command: "refresh",
      mode: "manual",
    });
    const after = await fixture.client.getStatus();
    expect(after.catalog?.version ?? 0).toBeGreaterThan(
      before.catalog?.version ?? 0,
    );
    expect(after.catalog?.refreshing).toBe(false);
    expect(after.catalog?.failedProviderIds).toEqual([]);
  });

  it("reports refresh-background unavailable before the controller is bound", async () => {
    const fixture = await createCatalogPlane({ bind: false });
    const result = await fixture.client.executeCatalogCommand({
      command: "refresh",
      mode: "background",
    });
    // Never a no-op "scheduled": the gateway has not started, so nothing
    // was (or could be) scheduled.
    expect(result.outcome).toBe("unavailable");
    expect(result.refresh).toBeUndefined();
    // Queries still serve the initial snapshot.
    const query = await fixture.client.executeCatalogCommand({
      command: "query",
    });
    expect(query.outcome).toBe("ok");
    expect(query.snapshot.version).toBe(0);
  });

  it("rejects malformed catalog commands through the wire", async () => {
    const fixture = await createCatalogPlane();
    const transport = createNodePipeTransport();
    const raw = await transport.connect(fixture.host.endpoint.address);
    await raw.write(
      encodeRawFrame({
        type: "hello",
        requestId: "raw-catalog-hello",
        contractVersion: 1,
        capability: fixture.host.endpoint.capability,
      }),
    );
    expect(await readRawFrame(raw)).toMatchObject({
      type: "hello_result",
      result: { type: "compatible" },
    });
    // Unknown refresh mode is rejected before reaching the handler.
    await raw.write(
      encodeRawFrame({
        type: "catalog_command",
        requestId: "bad-mode",
        command: { command: "refresh", mode: "turbo" },
      }),
    );
    expect(await readRawFrame(raw)).toEqual({
      type: "error",
      requestId: "bad-mode",
      code: "invalid_request",
    });
    // A non-object command is rejected.
    await raw.write(
      encodeRawFrame({
        type: "catalog_command",
        requestId: "bad-shape",
        command: "garbage",
      }),
    );
    expect(await readRawFrame(raw)).toEqual({
      type: "error",
      requestId: "bad-shape",
      code: "invalid_request",
    });
    // A valid background refresh command succeeds on the same connection.
    await raw.write(
      encodeRawFrame({
        type: "catalog_command",
        requestId: "good-refresh",
        command: { command: "refresh", mode: "background" },
      }),
    );
    const result = await readRawFrame(raw);
    expect(result).toMatchObject({
      type: "catalog_command_result",
      requestId: "good-refresh",
      result: { outcome: "scheduled" },
    });
    await raw.close();
  });
});

function encodeRawFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

async function readExact(
  connection: Awaited<ReturnType<ReturnType<typeof createNodePipeTransport>["connect"]>>,
  byteLength: number,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let received = 0;
  while (received < byteLength) {
    const chunk = await connection.read(byteLength - received);
    if (chunk === null) return null;
    chunks.push(chunk);
    received += chunk.length;
  }
  return Buffer.concat(chunks);
}

async function readRawFrame(
  connection: Awaited<ReturnType<ReturnType<typeof createNodePipeTransport>["connect"]>>,
): Promise<unknown> {
  const header = await readExact(connection, 4);
  if (header === null) return undefined;
  const body = await readExact(connection, header.readUInt32BE(0));
  return body === null ? undefined : JSON.parse(body.toString("utf8"));
}
