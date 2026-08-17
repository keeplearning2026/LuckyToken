import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  connectControlPlane,
  createNodePipeTransport,
  nodePipeFallbackAccess,
  startControlPlane,
  type ControlPlaneEndpoint,
  type RunningControlPlane,
} from "@luckytoken/application-control-plane/control-plane";
import {
  createRuntimeDiagnosticsStoreFactory,
  parseRuntimeDiagnosticsConfiguration,
} from "../../src/runtime-diagnostics/index.js";
import {
  createFileClientTokenStore,
  loadFileClientTokenAuthority,
} from "../../src/client-auth/file-token-store.js";

async function allPersistedBytes(root: string): Promise<string> {
  const entries = await readdir(root, { recursive: true });
  const chunks = await Promise.all(
    entries
      .filter((entry) => typeof entry === "string")
      .map(async (entry) => {
        try {
          return await readFile(join(root, entry), "utf8");
        } catch {
          return "";
        }
      }),
  );
  return chunks.join("\n");
}

let nextId = 0;
function endpoint(): ControlPlaneEndpoint {
  nextId += 1;
  return {
    pipeName: `\\\\.\\pipe\\ticket-07-cp-${process.pid}-${nextId}`,
    capability: "ticket-07-capability-012345678901234567890123456789",
  };
}

describe("Control Plane diagnostics surface (Ticket 07)", () => {
  const roots: string[] = [];
  const hosts: RunningControlPlane[] = [];
  const stores: Array<{ close(): void }> = [];

  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((host) => host.close()));
    stores.splice(0).forEach((store) => store.close());
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function diagnosticsFixture() {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-cp-diagnostics-"));
    roots.push(root);
    const configuration = parseRuntimeDiagnosticsConfiguration(
      { directory: root },
      root,
    );
    // Identity scrubber: pattern-only mode (no credential owners) for the
    // CP seam tests; known-value scrub coverage is dedicated.
    const store = await createRuntimeDiagnosticsStoreFactory({
      configuration,
      now: () => 1_700_000_000_000,
      scrub: (value: string) => value,
    }).open();
    stores.push(store);
    return { store, directory: root };
  }

  it("serves committed sanitized records through queries and typed events", async () => {
    const { store } = await diagnosticsFixture();
    const transport = createNodePipeTransport();
    const host = await startControlPlane({
      endpoint: endpoint(),
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
      diagnostics: store,
    });
    hosts.push(host);
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `diag-request-${++nextId}`,
      pipeConnector: transport,
    });
    await client.hello(1);

    store.append({
      level: "info",
      text: "ticket-07 canary authorization leaked?",
      details: {
        headers: { authorization: "Bearer canary-cp-bearer-aabbccdd" },
        credential: { api_key: "canary-cp-pi-key-11223344" },
      },
    });
    store.append({
      level: "critical",
      text: "ticket-07 canary cookie leaked?",
      details: { cookie: "canary-cp-cookie-55667788" },
    });

    const query = await client.getDiagnostics({ limit: 10 });
    expect(query.records).toHaveLength(2);
    const serialized = JSON.stringify(query.records);
    expect(serialized).not.toContain("canary-cp-bearer-aabbccdd");
    expect(serialized).not.toContain("canary-cp-pi-key-11223344");
    expect(serialized).not.toContain("canary-cp-cookie-55667788");
    expect(query.records[0]).toMatchObject({
      level: "info",
      text: "ticket-07 canary authorization leaked?",
    });
    expect(JSON.stringify(query.records[0]!.details)).toContain("[REDACTED]");
    expect(query.records[1]).toMatchObject({ level: "critical" });
    expect(query.hasMore).toBe(false);

    const events: unknown[] = [];
    const unsubscribe = await client.subscribeDiagnostics((event) => events.push(event));
    store.append({ level: "warning", text: "live canary error leaked?" });
    await expect.poll(() => events).toHaveLength(1);
    expect(JSON.stringify(events)).toContain("live canary error leaked?");
    await unsubscribe();
    store.append({ level: "info", text: "after unsubscribe" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(events).toHaveLength(1);
    await client.close();
  });

  it("never delivers diagnostics to status subscribers nor status to diagnostics subscribers", async () => {
    const { store } = await diagnosticsFixture();
    const transport = createNodePipeTransport();
    const host = await startControlPlane({
      endpoint: endpoint(),
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
      diagnostics: store,
    });
    hosts.push(host);
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `diag-mixed-request-${++nextId}`,
      pipeConnector: transport,
    });
    await client.hello(1);
    const statusEvents: unknown[] = [];
    const diagnosticsEvents: unknown[] = [];
    await client.subscribe((event) => statusEvents.push(event));
    await client.subscribeDiagnostics((event) => diagnosticsEvents.push(event));

    store.append({ level: "error", text: "cp-canary-status-isolation-9911" });
    await host.publishStatus({
      modelDataPlane: "running",
      provider: "unconfigured",
    });

    await expect.poll(() => diagnosticsEvents).toHaveLength(1);
    expect(statusEvents).toHaveLength(1);
    expect(statusEvents[0]).toMatchObject({ type: "status_changed" });
    expect(diagnosticsEvents[0]).toMatchObject({ type: "diagnostic" });
    expect(JSON.stringify(statusEvents)).not.toContain("cp-canary-status-isolation-9911");
    expect(JSON.stringify(diagnosticsEvents)).not.toContain("modelDataPlane");
    await client.close();
  });

  it("rejects diagnostics queries when the host has no diagnostics ownership", async () => {
    const transport = createNodePipeTransport();
    const host = await startControlPlane({
      endpoint: endpoint(),
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
    });
    hosts.push(host);
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `diag-unowned-request-${++nextId}`,
      pipeConnector: transport,
    });
    await client.hello(1);
    await expect(client.getDiagnostics(undefined)).rejects.toThrow(
      "unknown_command",
    );
    await client.close();
  });

  it("binds wire queries and refuses malformed diagnostics payloads", async () => {
    const { store } = await diagnosticsFixture();
    const transport = createNodePipeTransport();
    const host = await startControlPlane({
      endpoint: endpoint(),
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
      diagnostics: store,
    });
    hosts.push(host);
    for (let index = 0; index < 3; index += 1) {
      store.append({ level: "info", text: `wire-${index}` });
    }
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `diag-wire-request-${++nextId}`,
      pipeConnector: transport,
    });
    await client.hello(1);

    const bounded = await client.getDiagnostics({ limit: 2 });
    expect(bounded.records).toHaveLength(2);
    expect(bounded.hasMore).toBe(true);
    const rest = await client.getDiagnostics({ afterId: 2 });
    expect(rest.records).toHaveLength(1);

    const malformed = await client
      .getDiagnostics({ afterId: -1 } as never)
      .catch((error: unknown) => error);
    expect(malformed).toBeInstanceOf(Error);
    expect(String(malformed)).toContain("invalid_request");
    await client.close();
  });

  it("scrubs credential-owner known values from committed records, CP, and persisted bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-cp-scrub-"));
    roots.push(root);
    const diagnosticsDir = join(root, "diagnostics");
    const configuration = parseRuntimeDiagnosticsConfiguration(
      { directory: diagnosticsDir },
      root,
    );
    // Credential owners: an explicitly configured non-token-shaped Client
    // token and a Provider API key. The token file lives outside the
    // diagnostics directory so the byte scan only covers the store.
    const tokenFile = join(root, "auth", "tokens.json");
    const tokenStore = createFileClientTokenStore({
      path: tokenFile,
      generateToken: () => "hunter2",
    });
    await tokenStore.create({ type: "global" }, "hunter2");
    const clientAuthority = await loadFileClientTokenAuthority(tokenFile);
    const providerSecret = "mydogspot";
    const scrub = (value: string) => {
      let redacted = clientAuthority.scrub(value);
      redacted = redacted.replaceAll(providerSecret, "[REDACTED]");
      return redacted;
    };
    const store = await createRuntimeDiagnosticsStoreFactory({
      configuration,
      now: () => 1_700_000_000_000,
      scrub,
    }).open();
    stores.push(store);
    const transport = createNodePipeTransport();
    const host = await startControlPlane({
      endpoint: endpoint(),
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
      diagnostics: store,
    });
    hosts.push(host);
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `diag-scrub-request-${++nextId}`,
      pipeConnector: transport,
    });
    await client.hello(1);

    store.append({
      level: "warning",
      text: `token=${"hunter2"} provider=${providerSecret} in benign facts`,
      details: { benign: `value ${providerSecret}`, other: "keep-me" },
    });

    const query = await client.getDiagnostics(undefined);
    const serialized = JSON.stringify(query.records);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain(providerSecret);
    expect(serialized).toContain("keep-me");
    expect(serialized).toContain("[REDACTED]");

    store.close();
    const persisted = await allPersistedBytes(configuration.directory);
    expect(persisted).not.toContain("hunter2");
    expect(persisted).not.toContain(providerSecret);
    await client.close();
  });

  it("never delivers mixed header-array secrets through CP queries, events, or persisted bytes", async () => {
    const { store, directory } = await diagnosticsFixture();
    const transport = createNodePipeTransport();
    const host = await startControlPlane({
      endpoint: endpoint(),
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
      diagnostics: store,
    });
    hosts.push(host);
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `diag-mixed-request-${++nextId}`,
      pipeConnector: transport,
    });
    await client.hello(1);

    const secretCanaries = {
      cookieJunk: "canary-cp-mixed-cookie-a1b2",
      authzFirst: "canary-cp-mixed-authz-c3d4",
      setCookieObj: "canary-cp-mixed-setcookie-e5f6",
      nestedObj: "canary-cp-mixed-nested-g7h8",
      bareTuple: "canary-header-bare-55ee66ff",
    };
    const benign = "req-cp-mixed-benign-9999";
    store.append({
      level: "warning",
      text: "mixed header arrays via CP",
      details: {
        headers: [
          ["cookie", secretCanaries.cookieJunk],
          "junk",
        ],
        requestHeaders: [
          ["set-cookie", secretCanaries.setCookieObj],
          { name: "x" },
          ["Authorization", `Bearer ${secretCanaries.authzFirst}`],
        ],
        nested: {
          deep: [
            ["cookie", secretCanaries.nestedObj],
            null,
            ["x-request-id", benign],
          ],
        },
      },
    });

    const query = await client.getDiagnostics(undefined);
    const serialized = JSON.stringify(query.records);
    for (const canary of Object.values(secretCanaries)) {
      expect(serialized).not.toContain(canary);
    }
    expect(serialized).toContain("req-cp-mixed-benign-9999");

    const events: unknown[] = [];
    const unsubscribe = await client.subscribeDiagnostics((event) => events.push(event));
    store.append({
      level: "info",
      text: "live mixed header pair",
      details: {
        headers: [
          ["set-cookie", "canary-cp-mixed-live-1212"],
          ["x-request-id", "live-benign-3434"],
        ],
      },
    });
    await expect.poll(() => events).toHaveLength(1);
    const eventSerialized = JSON.stringify(events);
    expect(eventSerialized).not.toContain("canary-cp-mixed-live-1212");
    expect(eventSerialized).toContain("live-benign-3434");
    await unsubscribe();

    store.close();
    const persisted = await allPersistedBytes(directory);
    for (const canary of Object.values(secretCanaries)) {
      expect(persisted).not.toContain(canary);
    }
    expect(persisted).not.toContain("canary-cp-mixed-live-1212");
    expect(persisted).toContain("req-cp-mixed-benign-9999");
    await client.close();
  });
});
