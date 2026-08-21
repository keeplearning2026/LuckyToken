import { mkdtemp, rm } from "node:fs/promises";
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
  createRequestLedgerStoreFactory,
  parseRequestLedgerConfiguration,
  type RequestLedgerRecord,
  type RequestLedgerStore,
} from "../../src/request-ledger/index.js";

/**
 * Ticket 18 additive Control Plane seam: bounded ledger queries, opt-in
 * typed events, reconnect catch-up by sequence, malformed-command rejection,
 * and no effect on the legacy status stream or hosts without a ledger.
 */

const clientSessionId = "20000000-0000-4000-8000-000000000031";
const effectiveSessionId = "30000000-0000-4000-8000-000000000032";

let requestIdCounter = 0;
function requestId(): string {
  requestIdCounter += 1;
  return `10000000-0000-4000-8000-0000000002${String(requestIdCounter).padStart(2, "0")}`;
}

function runRequest(store: RequestLedgerStore, protocolId: string): void {
  const entry = store.begin(protocolId);
  entry.authorized({
    effectiveSessionId,
    ...(protocolId === "anthropic-messages" ? { clientSessionId } : {}),
  });
  entry.modelResolved({
    externalAlias: protocolId === "anthropic-messages" ? "alpha" : "beta",
    providerId: "commandcode-private",
    realModelId: "claude-fixture",
  });
  entry.executing();
  entry.terminal("success", { piStopReason: "stop" });
  entry.rendering();
  entry.completed(200);
}

describe("Control Plane Request Ledger surface (Ticket 18)", () => {
  const roots: string[] = [];
  const hosts: RunningControlPlane[] = [];
  const stores: RequestLedgerStore[] = [];

  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((host) => host.close()));
    stores.splice(0).forEach((store) => store.close());
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  let nextId = 0;
  function endpoint(): ControlPlaneEndpoint {
    nextId += 1;
    return {
      address: `\\\\.\\pipe\\ticket-18-cp-${process.pid}-${nextId}`,
      capability: `ticket-18-cp-capability-${String(nextId).padStart(20, "0")}`,
    };
  }

  async function ledgerFixture(): Promise<{
    store: RequestLedgerStore;
    directory: string;
  }> {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-cp-ledger-"));
    roots.push(root);
    const configuration = parseRequestLedgerConfiguration(
      { directory: root },
      root,
    );
    const store = await createRequestLedgerStoreFactory({
      configuration,
      now: () => 1_700_000_000_000,
      scrub: (value) => value,
      createRequestId: requestId,
    }).open();
    stores.push(store);
    return { store, directory: root };
  }

  it("serves committed records through bounded queries and typed events to opted-in connections only", async () => {
    const { store } = await ledgerFixture();
    const transport = createNodePipeTransport();
    const host = await startControlPlane({
      endpoint: endpoint(),
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
      requestLedger: store,
    });
    hosts.push(host);
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `cp-ledger-${++nextId}`,
      pipeConnector: transport,
    });
    await client.hello(2);

    // A status subscriber must never receive ledger events.
    const statusEvents: unknown[] = [];
    await client.subscribe((event) => statusEvents.push(event));
    const ledgerEvents: RequestLedgerRecord[] = [];
    const unsubscribe = await client.subscribeRequestLedger((event) =>
      ledgerEvents.push(event.record),
    );

    runRequest(store, "anthropic-messages");
    await expect.poll(() => ledgerEvents).toHaveLength(7);
    const terminal = ledgerEvents.at(-1)!;
    expect(terminal).toMatchObject({
      protocolId: "anthropic-messages",
      phase: "terminal-preparation",
      outcome: "success",
      clientSessionId,
      effectiveSessionId,
      externalAlias: "alpha",
    });
    expect(statusEvents).toHaveLength(0);

    const query = await client.getRequestLedger(undefined);
    expect(query.records).toHaveLength(1);
    expect(query.hasMore).toBe(false);
    expect(query.records[0]!.id).toBe(terminal.id);
    expect(JSON.stringify(query.records)).not.toContain("fixture-commandcode-key");

    await unsubscribe();
    runRequest(store, "openai-responses");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(ledgerEvents).toHaveLength(7);
    await client.close();
  });

  it("keeps the effective session identity under its own field through the wire", async () => {
    const { store } = await ledgerFixture();
    const transport = createNodePipeTransport();
    const host = await startControlPlane({
      endpoint: endpoint(),
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
      requestLedger: store,
    });
    hosts.push(host);
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `cp-ledger-${++nextId}`,
      pipeConnector: transport,
    });
    await client.hello(2);

    runRequest(store, "openai-responses");
    const query = await client.getRequestLedger(undefined);
    const record = query.records[0]!;
    // The Responses request carries no client session id: the wire delivers
    // the effective identity only under its own field and never synthesizes
    // a client id from it.
    expect(record.effectiveSessionId).toBe(effectiveSessionId);
    expect(record.clientSessionId).toBeUndefined();
    expect("clientSessionId" in record).toBe(false);
    await client.close();
  });

  it("serves bounded reconnect catch-up by sequence without replaying in-memory state", async () => {
    const { store } = await ledgerFixture();
    const transport = createNodePipeTransport();
    const host = await startControlPlane({
      endpoint: endpoint(),
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
      requestLedger: store,
    });
    hosts.push(host);
    for (let index = 0; index < 4; index += 1) {
      runRequest(store, "anthropic-messages");
    }

    // First connection reads the newest page and disconnects.
    const first = await connectControlPlane(host.endpoint, {
      createRequestId: () => `cp-first-${++nextId}`,
      pipeConnector: transport,
    });
    await first.hello(2);
    const page = await first.getRequestLedger({ limit: 2 });
    expect(page.records.map((record) => record.id)).toEqual([4, 3]);
    expect(page.hasMore).toBe(true);
    const oldestSeen = page.records[1]!.id;
    await first.close();

    // A reconnect continues from the sequence cursor: strictly older rows
    // only, bounded, with no in-memory event replay.
    const second = await connectControlPlane(host.endpoint, {
      createRequestId: () => `cp-second-${++nextId}`,
      pipeConnector: transport,
    });
    await second.hello(2);
    const rest = await second.getRequestLedger({ afterId: oldestSeen, limit: 10 });
    expect(rest.records.map((record) => record.id)).toEqual([
      oldestSeen - 1,
      oldestSeen - 2,
    ]);
    expect(rest.hasMore).toBe(false);
    await second.close();
  });

  it("rejects malformed ledger commands and serves unknown_command when the host has no ledger", async () => {
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
      createRequestId: () => `cp-unowned-${++nextId}`,
      pipeConnector: transport,
    });
    await client.hello(2);
    await expect(client.getRequestLedger(undefined)).rejects.toThrow(
      "unknown_command",
    );
    await expect(client.subscribeRequestLedger(() => undefined)).rejects.toThrow(
      "unknown_command",
    );
    await client.close();

    // With a ledger owned, a malformed query is rejected as invalid_request
    // (the ownership check precedes query validation, as with diagnostics).
    const { store } = await ledgerFixture();
    const ledgerHost = await startControlPlane({
      endpoint: endpoint(),
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
      requestLedger: store,
    });
    hosts.push(ledgerHost);
    const ledgerClient = await connectControlPlane(ledgerHost.endpoint, {
      createRequestId: () => `cp-owned-${++nextId}`,
      pipeConnector: transport,
    });
    await ledgerClient.hello(2);
    await expect(
      ledgerClient.getRequestLedger({ afterId: -5 } as never),
    ).rejects.toThrow("invalid_request");
    await expect(
      ledgerClient.getRequestLedger({ limit: 2_000 } as never),
    ).rejects.toThrow("invalid_request");
    await ledgerClient.close();
  });

  it("never delivers ledger events to a host without a ledger and keeps the legacy status stream intact", async () => {
    const { store } = await ledgerFixture();
    const transport = createNodePipeTransport();
    const host = await startControlPlane({
      endpoint: endpoint(),
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
      diagnostics: {
        query: () => ({ records: [], hasMore: false }),
        subscribe: () => ({ unsubscribe: () => undefined }),
      },
      requestLedger: store,
    });
    hosts.push(host);
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `cp-mixed-${++nextId}`,
      pipeConnector: transport,
    });
    await client.hello(2);
    const statusEvents: unknown[] = [];
    await client.subscribe((event) => statusEvents.push(event));
    await host.publishStatus({
      modelDataPlane: "running",
      provider: "unconfigured",
    });
    await expect.poll(() => statusEvents).toHaveLength(1);
    expect(statusEvents[0]).toMatchObject({ type: "status_changed" });

    // Ledger events never leak into the legacy status stream.
    runRequest(store, "anthropic-messages");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(statusEvents).toHaveLength(1);
    expect(JSON.stringify(statusEvents)).not.toContain("request_ledger");
    await client.close();
  });
});