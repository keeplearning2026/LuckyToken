import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  AnalyticsQuery,
  AnalyticsResult,
} from "@luckytoken/application-control-plane/control-plane";
import type { NormalizedTerminalUsage } from "@luckytoken/provider-contract/usage";

import {
  createRequestLedgerStoreFactory,
  parseRequestLedgerConfiguration,
  type RequestLedgerStore,
} from "../../src/request-ledger/index.js";

/**
 * Ticket 21 analytics aggregation (Slice 2): the store's `analyze` is the
 * public seam. A fixed Request Ledger fixture (committed through the public
 * `begin`/transition API, never private tables) is aggregated over explicit
 * half-open acceptedAt ranges, and every expected table is computed by
 * hand — never from the production formula.
 *
 * Fixture (epoch-ms = T0 + offset; terminalUsage snapshots follow the
 * Ticket 20 canonical contract; `-` = fact absent at request time):
 *
 *   r1 10:00 anthropic claude-x anthropic-messages success complete  (5,3,2,2,reason1,norm12,rate0.3)  terminal 18:30 — AFTER every range below
 *   r2 11:30 anthropic claude-x anthropic-messages failed   partial  (7,1,0,0, reason failed)
 *   r3 12:00 commandcode-private cc-mini anthropic-messages success complete (4,0,0,3,reason0,norm7,rate0)
 *   r4 13:00 openai gpt-r openai-responses aborted  partial  (2,1,0,0, reason aborted)
 *   r5 14:00 openai gpt-r openai-responses success complete  (4,4,2,3,reason1,norm13,rate0.4)
 *   r6 15:00 –      –      openai-responses unknown-alias unavailable (no usage; no provider/model snapshot)
 *   r7 16:00 –      –      anthropic-messages rejected-auth unavailable (no usage; no provider/model snapshot)
 */

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;
const at = (hours: number, minutes = 0): number =>
  T0 + hours * HOUR + minutes * MINUTE;

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
  reasoning: number,
  api = "anthropic",
): NormalizedTerminalUsage {
  const denominator = input + cacheRead + cacheWrite;
  return Object.freeze({
    api,
    input,
    cacheRead,
    cacheWrite,
    output,
    reasoning,
    normalizedTotal: input + cacheRead + cacheWrite + output,
    ...(denominator > 0 ? { cacheHitRate: cacheRead / denominator } : {}),
    completeness: "complete",
  });
}

function partialUsage(
  input: number,
  cacheRead: number,
  cacheWrite: number,
  output: number,
  reason: "failed" | "aborted",
): NormalizedTerminalUsage {
  return Object.freeze({
    api: "anthropic",
    input,
    cacheRead,
    cacheWrite,
    output,
    completeness: "partial",
    reason,
  });
}

interface FixtureRow {
  readonly acceptedAt: number;
  readonly protocolId: string;
  readonly providerId?: string;
  readonly realModelId?: string;
  readonly profile?: { readonly profileId: string; readonly displayName: string };
  readonly outcome: "success" | "failed" | "aborted" | "unknown-alias" | "rejected-auth";
  readonly usage?: NormalizedTerminalUsage;
}

const FIXTURE: readonly FixtureRow[] = Object.freeze([
  {
    acceptedAt: at(10),
    protocolId: "anthropic-messages",
    providerId: "anthropic",
    realModelId: "claude-x",
    profile: { profileId: "profile-anthropic", displayName: "Anthropic Old" },
    outcome: "success",
    usage: completeUsage(5, 3, 2, 2, 1),
  },
  {
    acceptedAt: at(11, 30),
    protocolId: "anthropic-messages",
    providerId: "anthropic",
    realModelId: "claude-x",
    profile: { profileId: "profile-anthropic", displayName: "Anthropic Current" },
    outcome: "failed",
    usage: partialUsage(7, 1, 0, 0, "failed"),
  },
  {
    acceptedAt: at(12),
    protocolId: "anthropic-messages",
    providerId: "commandcode-private",
    realModelId: "cc-mini",
    outcome: "success",
    usage: completeUsage(4, 0, 0, 3, 0, "commandcode-private"),
  },
  {
    acceptedAt: at(13),
    protocolId: "openai-responses",
    providerId: "openai",
    realModelId: "gpt-r",
    profile: { profileId: "profile-openai", displayName: "OpenAI Production" },
    outcome: "aborted",
    usage: partialUsage(2, 1, 0, 0, "aborted"),
  },
  {
    acceptedAt: at(14),
    protocolId: "openai-responses",
    providerId: "openai",
    realModelId: "gpt-r",
    outcome: "success",
    usage: completeUsage(4, 4, 2, 3, 1, "openai"),
  },
  {
    acceptedAt: at(15),
    protocolId: "openai-responses",
    outcome: "unknown-alias",
  },
  {
    acceptedAt: at(16),
    protocolId: "anthropic-messages",
    outcome: "rejected-auth",
  },
]);

describe("Request Ledger analytics aggregation (Ticket 21)", () => {
  const roots: string[] = [];
  const stores: RequestLedgerStore[] = [];

  afterEach(async () => {
    stores.splice(0).forEach((store) => store.close());
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  /** Opens a store whose injected clock the test controls, so fixture rows
   *  can be committed at deterministic acceptedAt/terminalAt instants. */
  async function openStore(): Promise<{
    store: RequestLedgerStore;
    setClock: (value: number) => void;
  }> {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-analytics-"));
    roots.push(root);
    const configuration = parseRequestLedgerConfiguration(
      { directory: root },
      root,
    );
    let clock = 0;
    const store = await createRequestLedgerStoreFactory({
      configuration,
      scrub: (value) => value,
      createRequestId: requestId,
      now: () => clock,
    }).open();
    stores.push(store);
    return { store, setClock: (value: number) => {
      clock = value;
    } };
  }

  /** Commits the fixed fixture through the public transition API of the
   *  store under test. r1's terminal/usage land at 18:30 (after every query
   *  range) so attribution stays pinned to its 10:00 acceptedAt (AC-7). */
  async function commitFixture(
    store: RequestLedgerStore,
    setClock: (value: number) => void,
  ): Promise<void> {
    for (const row of FIXTURE) {
      setClock(row.acceptedAt);
      const entry = store.begin(row.protocolId);
      if (row.providerId !== undefined) {
        entry.authorized({
          effectiveSessionId: "30000000-0000-4000-8000-000000000032",
        });
        entry.modelResolved({
          externalAlias: row.realModelId ?? "alias",
          providerId: row.providerId,
          realModelId: row.realModelId ?? "model",
        });
        if (row.profile !== undefined) entry.profileAttributed(row.profile);
      }
      setClock(row.acceptedAt + 5 * MINUTE);
      entry.executing();
      setClock(row === FIXTURE[0] ? at(18, 30) : row.acceptedAt + 10 * MINUTE);
      entry.terminal(row.outcome);
      if (row.usage !== undefined) entry.terminalUsage(row.usage);
      entry.rendering();
      setClock(row.acceptedAt + 11 * MINUTE);
      entry.completed(200);
    }
  }

  function summary(
    store: RequestLedgerStore,
    query: AnalyticsQuery,
  ): AnalyticsResult {
    const result = store.analyze(query);
    if (result.command !== "summary") {
      throw new Error("test misuse: expected a summary result");
    }
    return result;
  }

  it("totals over [10:00, 17:00) match the independent worked table", async () => {
    const { store, setClock } = await openStore();
    await commitFixture(store, setClock);
    const result = summary(store, {
      version: 2,
      command: "summary",
      from: at(10),
      to: at(17),
    });
    const totals = result.totals;
    // Counts include every matching request regardless of usage
    // completeness (AC-4); the outcome buckets partition total exactly.
    expect(totals.total).toBe(7);
    expect(totals.success).toBe(3); // r1, r3, r5
    expect(totals.failed).toBe(1); // r2
    expect(totals.aborted).toBe(1); // r4
    expect(totals.other).toBe(2); // r6, r7
    expect(totals.pending).toBe(0);
    expect(totals.total).toBe(
      totals.success + totals.failed + totals.aborted + totals.other + totals.pending,
    );
    expect(totals.successRate).toBeCloseTo(3 / 7, 12);
    expect(totals.failureRate).toBeCloseTo(1 / 7, 12);
    expect(totals.abortRate).toBeCloseTo(1 / 7, 12);
    // Token/cache aggregates include only Complete usage (AC-5/6).
    expect(totals.participating).toBe(3); // r1, r3, r5
    expect(totals.totalRequests).toBe(7);
    expect(totals.excluded).toBe(4); // r2, r4, r6, r7
    expect(totals.inputTokens).toBe(5 + 4 + 4); // 13
    expect(totals.cacheReadTokens).toBe(3 + 0 + 4); // 7
    expect(totals.cacheWriteTokens).toBe(2 + 0 + 2); // 4
    expect(totals.outputTokens).toBe(2 + 3 + 3); // 8
    expect(totals.reasoningTokens).toBe(1 + 0 + 1); // 2 (output subset)
    expect(totals.normalizedTokenTotal).toBe(12 + 7 + 13); // 32
    // Product Hit is the aggregate read-hit quotient:
    // ΣcacheRead / Σ(input + cacheRead). Cache writes do not enter it.
    expect(totals.cacheHitNumerator).toBe(7);
    expect(totals.cacheHitDenominator).toBe(13 + 7); // 20
    expect(totals.cacheHitRate).toBeCloseTo(7 / 20, 12);
    // Never an average of per-request Hit percentages.
    expect(totals.cacheHitRate).not.toBeCloseTo((3 / 8 + 0 + 4 / 8) / 3, 2);
    // No rows/buckets requested.
    expect(result.rows).toBeUndefined();
    expect(result.buckets).toBeUndefined();
  });

  it("counts every matching request but excludes Partial/Unavailable usage from token sums", async () => {
    const { store, setClock } = await openStore();
    await commitFixture(store, setClock);
    for (const outcomes of [["failed"], ["aborted"], ["unknown-alias", "rejected-auth"]]) {
      const totals = summary(store, {
        version: 2,
        command: "summary",
        from: at(10),
        to: at(17),
        filters: { outcomes },
      }).totals;
      const expectedTotal = outcomes.length === 1 ? 1 : 2;
      expect(totals.total).toBe(expectedTotal);
      expect(totals.participating).toBe(0);
      expect(totals.excluded).toBe(expectedTotal);
      expect(totals.inputTokens).toBe(0);
      expect(totals.cacheReadTokens).toBe(0);
      expect(totals.cacheWriteTokens).toBe(0);
      expect(totals.outputTokens).toBe(0);
      expect(totals.reasoningTokens).toBeUndefined();
      expect(totals.normalizedTokenTotal).toBeUndefined();
      expect(totals.cacheHitRate).toBeUndefined();
      expect(totals.cacheHitDenominator).toBe(0);
      if (outcomes.length === 1) {
        expect(totals[outcomes[0] === "failed" ? "failed" : "aborted"]).toBe(1);
      } else {
        expect(totals.other).toBe(2);
      }
    }
  });

  it("groupBy provider returns independent per-real-provider rows with the null group and stable order", async () => {
    const { store, setClock } = await openStore();
    await commitFixture(store, setClock);
    const result = summary(store, {
      version: 2,
      command: "summary",
      from: at(10),
      to: at(17),
      groupBy: "provider",
    });
    const rows = result.rows ?? [];
    // Stable order: totalRequests DESC, then null group last, then value
    // ASC — the null group's 2 requests sort before the 1-request provider.
    expect(rows.map((row) => row.value)).toEqual([
      "anthropic",
      "openai",
      null,
      "commandcode-private",
    ]);
    // anthropic: r1 + r2 (1 success complete, 1 failed partial).
    const anthropic = rows[0];
    if (anthropic === undefined) throw new Error("fixture misuse: missing anthropic row");
    expect(anthropic.dimension).toBe("provider");
    expect(anthropic.summary.total).toBe(2);
    expect(anthropic.summary.success).toBe(1);
    expect(anthropic.summary.failed).toBe(1);
    expect(anthropic.summary.participating).toBe(1);
    expect(anthropic.summary.excluded).toBe(1);
    expect(anthropic.summary.inputTokens).toBe(5);
    expect(anthropic.summary.cacheReadTokens).toBe(3);
    expect(anthropic.summary.cacheWriteTokens).toBe(2);
    expect(anthropic.summary.outputTokens).toBe(2);
    expect(anthropic.summary.reasoningTokens).toBe(1);
    expect(anthropic.summary.normalizedTokenTotal).toBe(12);
    expect(anthropic.summary.cacheHitNumerator).toBe(3);
    expect(anthropic.summary.cacheHitDenominator).toBe(8);
    expect(anthropic.summary.cacheHitRate).toBeCloseTo(3 / 8, 12);
    // openai: r4 + r5.
    const openai = rows[1];
    if (openai === undefined) throw new Error("fixture misuse: missing openai row");
    expect(openai.summary.total).toBe(2);
    expect(openai.summary.aborted).toBe(1);
    expect(openai.summary.success).toBe(1);
    expect(openai.summary.inputTokens).toBe(4);
    expect(openai.summary.cacheReadTokens).toBe(4);
    expect(openai.summary.cacheWriteTokens).toBe(2);
    expect(openai.summary.outputTokens).toBe(3);
    expect(openai.summary.cacheHitRate).toBeCloseTo(4 / 8, 12);
    // commandcode-private: r3 (one request — sorts after the 2-request
    // null group under totalRequests DESC).
    const commandcode = rows[3];
    if (commandcode === undefined) throw new Error("fixture misuse: missing commandcode row");
    expect(commandcode.summary.total).toBe(1);
    expect(commandcode.summary.success).toBe(1);
    expect(commandcode.summary.participating).toBe(1);
    expect(commandcode.summary.reasoningTokens).toBe(0); // reported 0, never fabricated
    expect(commandcode.summary.cacheHitNumerator).toBe(0);
    expect(commandcode.summary.cacheHitDenominator).toBe(4);
    expect(commandcode.summary.cacheHitRate).toBe(0);
    // The unresolved-provider group is null (never a synthesized label).
    const unresolved = rows[2];
    if (unresolved === undefined) throw new Error("fixture misuse: missing unresolved row");
    expect(unresolved.value).toBeNull();
    expect(unresolved.summary.total).toBe(2);
    expect(unresolved.summary.other).toBe(2);
    expect(unresolved.summary.participating).toBe(0);
    expect(unresolved.summary.cacheHitRate).toBeUndefined();
    // Rows partition the scope; totals stay independent of rows.
    const rowsTotal = rows.reduce((sum, row) => sum + row.summary.total, 0);
    expect(rowsTotal).toBe(7);
    expect(result.totals.total).toBe(7);
    expect(result.totals.inputTokens).toBe(13);
    expect(result.truncated).toBeUndefined();
  });

  it("groups by real model, client protocol, and outcome", async () => {
    const { store, setClock } = await openStore();
    await commitFixture(store, setClock);
    const byModel = summary(store, {
      version: 2,
      command: "summary",
      from: at(10),
      to: at(17),
      groupBy: "model",
    });
    expect(byModel.rows?.map((row) => row.value)).toEqual([
      "claude-x",
      "gpt-r",
      null,
      "cc-mini",
    ]);
    const byProtocol = summary(store, {
      version: 2,
      command: "summary",
      from: at(10),
      to: at(17),
      groupBy: "protocol",
    });
    expect(byProtocol.rows?.map((row) => row.value)).toEqual([
      "anthropic-messages",
      "openai-responses",
    ]);
    expect(byProtocol.rows?.[0]?.summary.total).toBe(4); // r1, r2, r3, r7
    expect(byProtocol.rows?.[1]?.summary.total).toBe(3); // r4, r5, r6
    const byOutcome = summary(store, {
      version: 2,
      command: "summary",
      from: at(10),
      to: at(17),
      groupBy: "outcome",
    });
    expect(byOutcome.rows?.map((row) => row.value)).toEqual([
      "success",
      "aborted",
      "failed",
      "rejected-auth",
      "unknown-alias",
    ]);
  });

  it("attributes requests to the acceptedAt bucket when completion crosses the boundary (AC-7)", async () => {
    const { store, setClock } = await openStore();
    await commitFixture(store, setClock);
    // Hour series over [10:00, 15:00): r6 (15:00) is excluded; r1's usage
    // landed at 18:30, after `to`, but r1 still fills its 10:00 bucket.
    const result = summary(store, {
      version: 2,
      command: "summary",
      from: at(10),
      to: at(15),
      series: { granularity: "hour" },
    });
    const buckets = result.buckets ?? [];
    expect(buckets.length).toBe(5);
    expect(buckets[0]?.start).toBe(at(10));
    expect(buckets[0]?.end).toBe(at(11));
    expect(buckets[0]?.summary.total).toBe(1);
    expect(buckets[0]?.summary.success).toBe(1);
    expect(buckets[0]?.summary.participating).toBe(1);
    expect(buckets[0]?.summary.inputTokens).toBe(5);
    expect(buckets[1]?.summary.total).toBe(1); // r2 11:30
    expect(buckets[1]?.summary.failed).toBe(1);
    expect(buckets[2]?.summary.total).toBe(1); // r3 12:00
    expect(buckets[3]?.summary.total).toBe(1); // r4 13:00
    expect(buckets[4]?.summary.total).toBe(1); // r5 14:00
    expect(result.totals.total).toBe(5);
  });

  it("zero-fills empty buckets and truncates the final bucket at `to`", async () => {
    const { store, setClock } = await openStore();
    await commitFixture(store, setClock);
    const result = summary(store, {
      version: 2,
      command: "summary",
      from: at(9),
      to: at(13),
      series: { granularity: "hour" },
    });
    const buckets = result.buckets ?? [];
    expect(buckets.length).toBe(4);
    expect(buckets[0]?.start).toBe(at(9)); // empty, zero-filled
    expect(buckets[0]?.summary.total).toBe(0);
    expect(buckets[0]?.summary.successRate).toBe(0);
    expect(buckets[0]?.summary.cacheHitRate).toBeUndefined();
    expect(buckets[0]?.summary.cacheHitDenominator).toBe(0);
    expect(buckets[1]?.summary.total).toBe(1); // r1 10:00
    expect(buckets[2]?.summary.total).toBe(1); // r2 11:30
    expect(buckets[3]?.summary.total).toBe(1); // r3 12:00
    expect(buckets[3]?.end).toBe(at(13)); // truncated at `to`
  });

  it("applies the half-open range: a request at `from` counts, at `to` does not", async () => {
    const { store, setClock } = await openStore();
    await commitFixture(store, setClock);
    const result = summary(store, {
      version: 2,
      command: "summary",
      from: at(10),
      to: at(12),
    });
    expect(result.totals.total).toBe(2); // r1, r2 — r3 at exactly 12:00 excluded
    expect(result.totals.failed).toBe(1);
  });

  it("filters by provider/model/protocol/outcome, combined", async () => {
    const { store, setClock } = await openStore();
    await commitFixture(store, setClock);
    const byProvider = summary(store, {
      version: 2,
      command: "summary",
      from: at(10),
      to: at(17),
      filters: { providers: ["anthropic"] },
    }).totals;
    expect(byProvider.total).toBe(2);
    expect(byProvider.participating).toBe(1);
    expect(byProvider.inputTokens).toBe(5);
    expect(byProvider.cacheHitRate).toBeCloseTo(3 / 8, 12);
    const byProtocol = summary(store, {
      version: 2,
      command: "summary",
      from: at(10),
      to: at(17),
      filters: { protocols: ["openai-responses"] },
    }).totals;
    expect(byProtocol.total).toBe(3); // r4, r5, r6
    expect(byProtocol.success).toBe(1);
    expect(byProtocol.aborted).toBe(1);
    expect(byProtocol.other).toBe(1);
    expect(byProtocol.participating).toBe(1);
    expect(byProtocol.inputTokens).toBe(4);
    const byModelAndOutcome = summary(store, {
      version: 2,
      command: "summary",
      from: at(10),
      to: at(17),
      filters: { models: ["claude-x"], outcomes: ["failed"] },
    }).totals;
    expect(byModelAndOutcome.total).toBe(1); // r2
    expect(byModelAndOutcome.participating).toBe(0);
  });

  it("filters token statistics by stable Profile id and returns the latest time-range label", async () => {
    const { store, setClock } = await openStore();
    await commitFixture(store, setClock);
    const filtered = store.analyze({
      version: 2,
      command: "summary",
      from: at(10),
      to: at(17),
      filters: { profiles: ["profile-anthropic"] },
    } as unknown as AnalyticsQuery);
    expect(filtered.command).toBe("summary");
    if (filtered.command !== "summary") return;
    expect(filtered.version).toBe(2);
    expect(filtered.totals).toMatchObject({
      totalRequests: 2,
      participating: 1,
      inputTokens: 5,
      cacheReadTokens: 3,
      outputTokens: 2,
    });

    const options = store.analyze({
      version: 2,
      command: "options",
      from: at(10),
      to: at(17),
    } as unknown as AnalyticsQuery);
    expect(options.command).toBe("options");
    if (options.command !== "options") return;
    expect(options.profiles).toEqual([
      {
        profileId: "profile-anthropic",
        displayName: "Anthropic Current",
        providerId: "anthropic",
      },
      {
        profileId: "profile-openai",
        displayName: "OpenAI Production",
        providerId: "openai",
      },
    ]);
  });

  it("returns zero totals for an empty range without invented rates", async () => {
    const { store, setClock } = await openStore();
    await commitFixture(store, setClock);
    const result = summary(store, {
      version: 2,
      command: "summary",
      from: at(17),
      to: at(18),
      groupBy: "provider",
      series: { granularity: "hour" },
    });
    expect(result.totals.total).toBe(0);
    expect(result.totals.success).toBe(0);
    expect(result.totals.successRate).toBe(0);
    expect(result.totals.participating).toBe(0);
    expect(result.totals.excluded).toBe(0);
    expect(result.totals.reasoningTokens).toBeUndefined();
    expect(result.totals.normalizedTokenTotal).toBeUndefined();
    expect(result.totals.cacheHitRate).toBeUndefined();
    expect(result.rows).toBeUndefined();
    expect(result.buckets?.length).toBe(1);
    expect(result.buckets?.[0]?.summary.total).toBe(0);
  });

  it("options return distinct ledger facts within the range, never the catalog", async () => {
    const { store, setClock } = await openStore();
    await commitFixture(store, setClock);
    const all = await store.analyze({
      version: 2,
      command: "options",
    });
    expect(all.command).toBe("options");
    if (all.command !== "options") return;
    expect(all.providers).toEqual(["anthropic", "commandcode-private", "openai"]);
    expect(all.models).toEqual(["cc-mini", "claude-x", "gpt-r"]);
    expect(all.protocols).toEqual(["anthropic-messages", "openai-responses"]);
    expect(all.outcomes).toEqual([
      "aborted",
      "failed",
      "rejected-auth",
      "success",
      "unknown-alias",
    ]);
    expect(all.truncated).toBeUndefined();
    const ranged = await store.analyze({
      version: 2,
      command: "options",
      from: at(12),
      to: at(17),
    });
    if (ranged.command !== "options") return;
    expect(ranged.providers).toEqual(["commandcode-private", "openai"]);
    expect(ranged.models).toEqual(["cc-mini", "gpt-r"]);
    expect(ranged.outcomes).toEqual([
      "aborted",
      "rejected-auth",
      "success",
      "unknown-alias",
    ]);
  });

  it("streams more than one page of committed rows through bounded reads", async () => {
    const { store, setClock } = await openStore();
    // 1,250 committed `running` rows across two scan pages.
    const base = 1_700_000_000_000;
    for (let i = 0; i < 1_250; i += 1) {
      setClock(base + i * MINUTE);
      const entry = store.begin("anthropic-messages");
      expect(entry.requestId).toMatch(/^[0-9a-f-]{36}$/u);
    }
    const totals = summary(store, {
      version: 2,
      command: "summary",
      from: base,
      to: base + 1_250 * MINUTE,
    }).totals;
    expect(totals.total).toBe(1_250);
    expect(totals.pending).toBe(1_250);
    expect(totals.participating).toBe(0);
  });
});
