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
import type { NormalizedTerminalUsage } from "@luckytoken/provider-contract/usage";

import {
  createRequestLedgerStoreFactory,
  parseRequestLedgerConfiguration,
  type RequestLedgerStore,
} from "../../src/request-ledger/index.js";

/**
 * Ticket 21 additive Control Plane seam: bounded versioned analytics
 * queries (summary and options) round-trip through the node-pipe host and
 * client over the request ledger store's query-time aggregation; malformed
 * queries get `invalid_request`, a host without an analytics handler
 * answers `unknown_command`, and no cost/pricing field can cross the wire.
 */

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;
const SESSION_ALPHA = "20000000-0000-4000-8000-000000000041";
const SESSION_BETA = "20000000-0000-4000-8000-000000000042";

let requestIdCounter = 0;
function requestId(): string {
  requestIdCounter += 1;
  return `10000000-0000-4000-8000-0000000002${String(requestIdCounter).padStart(2, "0")}`;
}

function completeUsage(
  input: number,
  cacheRead: number,
  cacheWrite: number,
  output: number,
): NormalizedTerminalUsage {
  const denominator = input + cacheRead + cacheWrite;
  return Object.freeze({
    api: "anthropic",
    input,
    cacheRead,
    cacheWrite,
    output,
    normalizedTotal: input + cacheRead + cacheWrite + output,
    ...(denominator > 0 ? { cacheHitRate: cacheRead / denominator } : {}),
    completeness: "complete",
  });
}

describe("Control Plane analytics surface (Ticket 21)", () => {
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
      address: `\\\\.\\pipe\\ticket-21-cp-${process.pid}-${nextId}`,
      capability: `ticket-21-cp-capability-${String(nextId).padStart(20, "0")}`,
    };
  }

  /** One deterministic ledger fixture: two rows, one Complete with cache
   *  usage, one Partial (never contributes tokens). */
  async function analyticsFixture(): Promise<{
    store: RequestLedgerStore;
    directory: string;
  }> {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-cp-analytics-"));
    roots.push(root);
    const configuration = parseRequestLedgerConfiguration(
      { directory: root },
      root,
    );
    let clock = T0;
    const store = await createRequestLedgerStoreFactory({
      configuration,
      scrub: (value) => value,
      createRequestId: requestId,
      now: () => clock,
    }).open();
    stores.push(store);

    clock = T0 + 10 * HOUR;
    let entry = store.begin("anthropic-messages");
    entry.authorized({
      effectiveSessionId: "30000000-0000-4000-8000-000000000032",
      clientSessionId: SESSION_ALPHA,
    });
    entry.modelResolved({
      externalAlias: "alpha",
      providerId: "anthropic",
      realModelId: "claude-x",
    });
    clock = T0 + 10 * HOUR + 1_000;
    entry.executing();
    clock = T0 + 10 * HOUR + 3_000;
    entry.terminal("success");
    entry.terminalUsage(
      completeUsage(5, 3, 2, 2), // normalizedTotal 12, cacheHitRate 0.3
    );
    entry.completed(200);

    clock = T0 + 11 * HOUR;
    entry = store.begin("anthropic-messages");
    entry.authorized({
      effectiveSessionId: "30000000-0000-4000-8000-000000000032",
      clientSessionId: SESSION_BETA,
    });
    entry.modelResolved({
      externalAlias: "alpha",
      providerId: "anthropic",
      realModelId: "claude-x",
    });
    clock = T0 + 11 * HOUR + 1_000;
    entry.executing();
    clock = T0 + 11 * HOUR + 2_000;
    entry.terminal("failed");
    entry.terminalUsage(
      Object.freeze({
        api: "anthropic",
        input: 7,
        cacheRead: 1,
        cacheWrite: 0,
        output: 0,
        completeness: "partial",
        reason: "failed",
      }),
    );
    entry.completed(400);
    return { store, directory: root };
  }

  it("serves summary analytics through the additive frame over the ledger store", async () => {
    const { store } = await analyticsFixture();
    const transport = createNodePipeTransport();
    const host = await startControlPlane({
      endpoint: endpoint(),
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
      requestLedger: store,
      analyticsHandler: (query) => store.analyze(query),
    });
    hosts.push(host);
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `cp-analytics-${++nextId}`,
      pipeConnector: transport,
    });
    await client.hello(1);

    const result = await client.getAnalytics({
      version: 1,
      command: "summary",
      from: T0 + 10 * HOUR,
      to: T0 + 12 * HOUR,
    });
    expect(result.command).toBe("summary");
    if (result.command !== "summary") return;
    expect(result.totals).toMatchObject({
      total: 2,
      success: 1,
      failed: 1,
      participating: 1,
      excluded: 1,
      inputTokens: 5,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      outputTokens: 2,
      outputTokensPerSecond: 1,
      normalizedTokenTotal: 12,
      cacheHitNumerator: 3,
      cacheHitDenominator: 8,
    });
    expect(result.totals.cacheHitRate).toBeCloseTo(3 / 8, 12);
    // Counts include the Partial row; token sums do not.
    expect(result.totals.total).toBe(2);

    const grouped = await client.getAnalytics({
      version: 1,
      command: "summary",
      from: T0 + 10 * HOUR,
      to: T0 + 12 * HOUR,
      groupBy: "outcome",
      series: { granularity: "hour" },
    });
    if (grouped.command !== "summary") return;
    expect(grouped.rows?.map((row) => row.value)).toEqual(["failed", "success"]);
    expect(grouped.buckets?.length).toBe(2);
    await client.close();
  });

  it("serves the options command from ledger facts, never the catalog", async () => {
    const { store } = await analyticsFixture();
    const transport = createNodePipeTransport();
    const host = await startControlPlane({
      endpoint: endpoint(),
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
      analyticsHandler: (query) => store.analyze(query),
    });
    hosts.push(host);
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `cp-analytics-options-${++nextId}`,
      pipeConnector: transport,
    });
    await client.hello(1);

    const result = await client.getAnalytics({
      version: 1,
      command: "options",
      from: T0 + 10 * HOUR,
      to: T0 + 12 * HOUR,
    });
    expect(result).toEqual({
      version: 1,
      command: "options",
      providers: ["anthropic"],
      models: ["claude-x"],
      protocols: ["anthropic-messages"],
      sessions: [SESSION_ALPHA, SESSION_BETA],
      outcomes: ["failed", "success"],
    });
    await client.close();
  });

  it("filters summary analytics by client session snapshot", async () => {
    const { store } = await analyticsFixture();
    const transport = createNodePipeTransport();
    const host = await startControlPlane({
      endpoint: endpoint(),
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
      analyticsHandler: (query) => store.analyze(query),
    });
    hosts.push(host);
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `cp-analytics-session-${++nextId}`,
      pipeConnector: transport,
    });
    await client.hello(1);

    const result = await client.getAnalytics({
      version: 1,
      command: "summary",
      from: T0 + 10 * HOUR,
      to: T0 + 12 * HOUR,
      filters: { sessions: [SESSION_ALPHA] },
    });
    expect(result.command).toBe("summary");
    if (result.command !== "summary") return;
    expect(result.totals).toMatchObject({
      total: 1,
      success: 1,
      failed: 0,
      outputTokens: 2,
      outputTokensPerSecond: 1,
    });
    await client.close();
  });

  it("answers invalid_request for a malformed analytics query", async () => {
    const { store } = await analyticsFixture();
    const transport = createNodePipeTransport();
    const host = await startControlPlane({
      endpoint: endpoint(),
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
      analyticsHandler: (query) => store.analyze(query),
    });
    hosts.push(host);
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `cp-analytics-bad-${++nextId}`,
      pipeConnector: transport,
    });
    await client.hello(1);

    // Unknown top-level key, version !== 1, empty range.
    const analytics = client as unknown as {
      getAnalytics(query: unknown): Promise<unknown>;
    };
    await expect(
      analytics.getAnalytics({
        version: 1,
        command: "summary",
        from: 0,
        to: 1,
        cost: 5,
      }),
    ).rejects.toThrow("invalid_request");
    await expect(
      analytics.getAnalytics({ version: 2, command: "summary", from: 0, to: 1 }),
    ).rejects.toThrow("invalid_request");
    await expect(
      analytics.getAnalytics({ version: 1, command: "summary", from: 10, to: 10 }),
    ).rejects.toThrow("invalid_request");
    await client.close();
  });

  it("answers unknown_command when the host has no analytics handler", async () => {
    const { store } = await analyticsFixture();
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
      createRequestId: () => `cp-analytics-none-${++nextId}`,
      pipeConnector: transport,
    });
    await client.hello(1);
    await expect(
      client.getAnalytics({ version: 1, command: "summary", from: 0, to: 1 }),
    ).rejects.toThrow("unknown_command");
    // The legacy ledger surface is unaffected.
    const ledger = await client.getRequestLedger(undefined);
    expect(ledger.records.length).toBe(2);
    await client.close();
  });

  it("never lets a monetary field cross the analytics wire", async () => {
    const { store } = await analyticsFixture();
    const transport = createNodePipeTransport();
    const host = await startControlPlane({
      endpoint: endpoint(),
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
      // A hostile handler that fabricates a cost field on the result.
      analyticsHandler: (query) => {
        const result = store.analyze(query);
        if (result.command !== "summary") return result;
        return {
          ...result,
          totals: { ...result.totals, cost: 5 },
        } as unknown as ReturnType<typeof store.analyze>;
      },
    });
    hosts.push(host);
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `cp-analytics-cost-${++nextId}`,
      pipeConnector: transport,
    });
    await client.hello(1);
    // The strict wire decoder rejects the frame before the client ever sees
    // it: the response is malformed/absent, never a cost-bearing result.
    await expect(
      client.getAnalytics({ version: 1, command: "summary", from: T0 + 10 * HOUR, to: T0 + 12 * HOUR }),
    ).rejects.toThrow(/malformed|request failed/u);
    await client.close();
  });
});