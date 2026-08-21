import { afterEach, describe, expect, it } from "vitest";

import {
  connectControlPlane,
  createNodePipeTransport,
  nodePipeFallbackAccess,
  startControlPlane,
  type ControlPlaneEndpoint,
  type ControlPlaneRequestLedger,
  type RequestLedgerEvent,
  type RequestLedgerQuery,
  type RequestLedgerRecord,
  type RunningControlPlane,
} from "@luckytoken/application-control-plane/control-plane";

/**
 * Ticket 19 page seam through the Control Plane: the renderer-facing
 * surface serves records with the canonical-usage reservation, forwards
 * bounded filter queries, delivers typed events to opted-in connections
 * only, and degrades cleanly on hosts without a ledger. The ledger behind
 * the seam is a deterministic stub; record semantics are Ticket 18's.
 */

const clientSessionId = "20000000-0000-4000-8000-000000000031";
const effectiveSessionId = "30000000-0000-4000-8000-000000000032";

function usageRecord(
  id: number,
  overrides: Partial<RequestLedgerRecord> = {},
): RequestLedgerRecord {
  return {
    id,
    requestId: `10000000-0000-4000-8000-000000000${String(id).padStart(3, "0")}`,
    protocolId: "anthropic-messages",
    phase: "terminal-preparation",
    outcome: "success",
    acceptedAt: 1_700_000_000_000 + id,
    executionStartedAt: 1_700_000_001_000 + id,
    terminalAt: 1_700_000_003_000 + id,
    completedAt: 1_700_000_003_010 + id,
    clientHttpStatus: 200,
    externalAlias: "alpha",
    providerId: "commandcode-private",
    realModelId: "claude-fixture",
    clientSessionId,
    effectiveSessionId,
    terminalUsage: {
      api: "commandcode-private",
      input: 5,
      cacheRead: 3,
      cacheWrite: 2,
      output: 100,
      reasoning: 10,
      normalizedTotal: 110,
      cacheHitRate: 0.3,
      completeness: "complete",
    },
    ...overrides,
  };
}

function stubLedger(records: readonly RequestLedgerRecord[]): {
  readonly queries: RequestLedgerQuery[];
  readonly emit: (record: RequestLedgerRecord) => void;
  readonly ledger: ControlPlaneRequestLedger;
} {
  const queries: RequestLedgerQuery[] = [];
  const subscribers = new Set<(event: RequestLedgerEvent) => void>();
  return {
    queries,
    emit(record) {
      for (const listener of subscribers) {
        listener({ type: "request_ledger", record });
      }
    },
    ledger: {
      query(query) {
        queries.push(query ?? {});
        return { records, hasMore: false };
      },
      subscribe(listener) {
        subscribers.add(listener);
        return { unsubscribe: () => subscribers.delete(listener) };
      },
    },
  };
}

describe("Request Ledger page seam (Ticket 19)", () => {
  const hosts: RunningControlPlane[] = [];

  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((host) => host.close()));
  });

  let nextId = 0;
  function endpoint(): ControlPlaneEndpoint {
    nextId += 1;
    return {
      address: `\\\\.\\pipe\\ticket-19-seam-${process.pid}-${nextId}`,
      capability: `ticket-19-seam-capability-${String(nextId).padStart(20, "0")}`,
    };
  }

  async function startHostWithLedger(
    ledger: ControlPlaneRequestLedger,
  ): Promise<Awaited<ReturnType<typeof connectControlPlane>>> {
    const transport = createNodePipeTransport();
    const host = await startControlPlane({
      endpoint: endpoint(),
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
      requestLedger: ledger,
    });
    hosts.push(host);
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `ticket-19-client-${++nextId}`,
      pipeConnector: transport,
    });
    await client.hello(2);
    return client;
  }

  it("round-trips records with canonical usage facts and bounded filter queries", async () => {
    const records = [
      usageRecord(1),
      usageRecord(2, {
        terminalUsage: {
          api: "anthropic-messages",
          input: 7,
          cacheRead: 1,
          cacheWrite: 0,
          output: 0,
          completeness: "partial",
          reason: "aborted",
        },
      }),
    ];
    const fixture = stubLedger(records);
    const client = await startHostWithLedger(fixture.ledger);
    const result = await client.getRequestLedger({
      outcome: "success",
      providerId: "commandcode-private",
      realModelId: "claude-fixture",
      protocolId: "anthropic-messages",
      clientSessionId,
      from: 1_700_000_000_000,
      to: 1_700_000_100_000,
      afterId: 42,
      limit: 20,
    });
    // The host decodes the query strictly and forwards it to the ledger.
    expect(fixture.queries).toHaveLength(1);
    expect(fixture.queries[0]).toEqual({
      outcome: "success",
      providerId: "commandcode-private",
      realModelId: "claude-fixture",
      protocolId: "anthropic-messages",
      clientSessionId,
      from: 1_700_000_000_000,
      to: 1_700_000_100_000,
      afterId: 42,
      limit: 20,
    });
    expect(result.hasMore).toBe(false);
    expect(result.records).toHaveLength(2);
    expect(result.records[0]!.terminalUsage?.completeness).toBe("complete");
    expect(result.records[1]!.terminalUsage).toMatchObject({
      completeness: "partial",
      reason: "aborted",
    });
    await client.close();
  });

  it("rejects queries with unknown filter keys as invalid_request", async () => {
    const fixture = stubLedger([]);
    const client = await startHostWithLedger(fixture.ledger);
    await expect(
      client.getRequestLedger({ invented: 1 } as never),
    ).rejects.toThrow("invalid_request");
    await expect(
      client.getRequestLedger({ outcome: "success", extra: true } as never),
    ).rejects.toThrow("invalid_request");
    // The ledger is never consulted for a malformed query.
    expect(fixture.queries).toHaveLength(0);
    await client.close();
  });

  it("delivers typed ledger events to opted-in subscribers only", async () => {
    const fixture = stubLedger([]);
    const client = await startHostWithLedger(fixture.ledger);
    const received: RequestLedgerRecord[] = [];
    const unsubscribe = await client.subscribeRequestLedger((event) =>
      received.push(event.record),
    );
    fixture.emit(usageRecord(7));
    await expect.poll(() => received).toHaveLength(1);
    expect(received[0]!.terminalUsage?.completeness).toBe("complete");
    // Unsubscribed connections receive nothing further.
    await unsubscribe();
    fixture.emit(usageRecord(8));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(received).toHaveLength(1);
    await client.close();
  });

  it("serves unknown_command on hosts without a ledger", async () => {
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
      createRequestId: () => `ticket-19-client-${++nextId}`,
      pipeConnector: transport,
    });
    await client.hello(2);
    await expect(client.getRequestLedger(undefined)).rejects.toThrow(
      "unknown_command",
    );
    await expect(
      client.subscribeRequestLedger(() => undefined),
    ).rejects.toThrow("unknown_command");
    await client.close();
  });

  it("rejects malformed records at the wire boundary instead of projecting them", async () => {
    // A record with an unknown key must never reach the client.
    const malformed = usageRecord(1) as unknown as Record<string, unknown>;
    malformed.invented = true;
    const fixture = stubLedger([malformed as unknown as RequestLedgerRecord]);
    const client = await startHostWithLedger(fixture.ledger);
    await expect(client.getRequestLedger(undefined)).rejects.toThrow(
      "invalid_request",
    );
    await client.close();

    // A record carrying a non-UUID value under clientSessionId is rejected:
    // the internal effective identity can never be smuggled in that field.
    const smuggled = usageRecord(2, {
      clientSessionId: "not-a-uuid",
    } as Partial<RequestLedgerRecord>);
    const fixtureSmuggled = stubLedger([smuggled]);
    const clientSmuggled = await startHostWithLedger(fixtureSmuggled.ledger);
    await expect(clientSmuggled.getRequestLedger(undefined)).rejects.toThrow(
      "invalid_request",
    );
    await clientSmuggled.close();
  });

  it("keeps empty pages honest about hasMore", async () => {
    const fixture = stubLedger([]);
    const client = await startHostWithLedger(fixture.ledger);
    const result = await client.getRequestLedger(undefined);
    expect(result.records).toHaveLength(0);
    expect(result.hasMore).toBe(false);
    await client.close();
  });
});
