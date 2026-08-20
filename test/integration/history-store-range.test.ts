import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createRequestLedgerStoreFactory,
  type RequestLedgerStore,
} from "../../src/request-ledger/index.js";
import {
  createRuntimeDiagnosticsStoreFactory,
  type RuntimeDiagnosticsStore,
} from "../../src/runtime-diagnostics/index.js";
import {
  createDeepCaptureStoreFactory,
  type DeepCaptureStore,
} from "../../src/deep-diagnostics/index.js";

/**
 * Ticket 23 store-owned range capabilities: every authority's deleteRange/
 * countRange follow the same half-open `[fromMs, toMs)` rule (from included,
 * to excluded), never touch `meta` or foreign tables, and stay queryable
 * with their versioned schema intact after an all-deletion. Capture range
 * queries page oldest-first with an explicit row-id cursor.
 */

let requestIdCounter = 0;
function requestId(): string {
  requestIdCounter += 1;
  return `10000000-0000-4000-8000-${String(requestIdCounter).padStart(12, "0")}`;
}

/** Deterministic clock: each call returns the next tick. */
function advancingClock(start = 1_700_000_000_000, step = 1_000) {
  let current = start;
  return () => {
    const value = current;
    current += step;
    return value;
  };
}

describe("Ticket 23 store-owned range delete/count", () => {
  const roots: string[] = [];
  const stores: Array<{ close(): void }> = [];

  afterEach(async () => {
    stores.splice(0).forEach((store) => store.close());
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function openDiagnostics(): Promise<{
    store: RuntimeDiagnosticsStore;
  }> {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-t23-diag-"));
    roots.push(root);
    const store = await createRuntimeDiagnosticsStoreFactory({
      configuration: { directory: root },
      now: advancingClock(),
      scrub: (value) => value,
    }).open();
    stores.push(store);
    return { store };
  }

  async function openLedger(): Promise<{ store: RequestLedgerStore }> {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-t23-ledger-"));
    roots.push(root);
    const store = await createRequestLedgerStoreFactory({
      configuration: { directory: root },
      now: advancingClock(),
      scrub: (value) => value,
      createRequestId: requestId,
    }).open();
    stores.push(store);
    return { store };
  }

  async function openCapture(): Promise<{ store: DeepCaptureStore }> {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-t23-cap-"));
    roots.push(root);
    const store = await createDeepCaptureStoreFactory({
      configuration: {
        directory: root,
        maxCaptureBytes: 1024 * 1024,
        retentionAgeMs: 60 * 60 * 1000,
        maxCaptures: 1_000,
      },
      now: advancingClock(),
      scrub: (value) => value,
    }).open();
    stores.push(store);
    return { store };
  }

  it("diagnostics deleteRange is half-open and countRange matches it exactly", async () => {
    const { store } = await openDiagnostics();
    store.attachScrub((value) => value);
    // Times 1_700_000_000_000 + 1000k.
    for (let index = 0; index < 5; index += 1) {
      store.append({ level: "info", text: `record-${index}` });
    }
    expect(store.countRange()).toBe(5);
    // [t1, t4): t1 and t2 are deleted (from included), t4 stays (to
    // excluded).
    const t1 = 1_700_000_001_000;
    const t4 = 1_700_000_004_000;
    expect(store.countRange(t1, t4)).toBe(3);
    expect(store.deleteRange(t1, t4)).toEqual({ deleted: 3 });
    expect(store.countRange(t1, t4)).toBe(0);
    expect(store.countRange()).toBe(2);
    const remaining = store.query(undefined).records;
    expect(remaining.map((record) => record.text)).toEqual([
      "record-0",
      "record-4",
    ]);
    // Boundary pinning: `from`-inclusive, `to`-exclusive.
    expect(store.countRange(1_700_000_000_000, 1_700_000_001_000)).toBe(1);
    expect(
      store.countRange(1_700_000_004_000, 1_700_000_005_000),
    ).toBe(1);
  });

  it("ledger deleteRange is half-open over acceptedAt and leaves meta intact", async () => {
    const { store } = await openLedger();
    store.attachScrub((value) => value);
    // begin() alone persists acceptedAt (ticks 001..004; terminal() would
    // consume extra clock ticks, so transitions are omitted here).
    for (let index = 0; index < 4; index += 1) {
      store.begin("anthropic-messages");
    }
    expect(store.countRange()).toBe(4);
    const t2 = 1_700_000_002_000;
    const t3 = 1_700_000_003_000;
    expect(store.deleteRange(t2, t3)).toEqual({ deleted: 1 });
    // `all` (no endpoints) deletes everything eligible.
    expect(store.deleteRange()).toEqual({ deleted: 3 });
    expect(store.countRange()).toBe(0);
    expect(store.schemaVersion).toBe(3);
    // The store stays usable after an all-deletion: schema name/version in
    // `meta` survive, appends work, and the schemaVersion fact is intact.
    store.begin("anthropic-messages");
    expect(store.countRange()).toBe(1);
  });

  it("capture deleteRange removes rows only, keeps eviction tombstones, and queryRange pages with lastRowId", async () => {
    const { store } = await openCapture();
    store.attachScrub((value) => value);
    const draft = (index: number) => ({
      requestId: requestId(),
      protocolId: "anthropic-messages",
      acceptedAt: 1_700_000_000_000 + index * 1_000,
      requestBody: `body-${index}`,
      responseBody: `answer-${index}`,
      requestHeaders: Object.freeze({ "content-type": "application/json" }),
      responseHeaders: Object.freeze({ "content-type": "text/plain" }),
      timing: Object.freeze([Object.freeze({ stage: "accepted", time: 1 })]),
      complete: true,
    });
    for (let index = 0; index < 3; index += 1) store.append(draft(index));
    expect(store.countRange()).toBe(3);
    // Half-open over capturedAt: the third record stays.
    const t1 = 1_700_000_001_000;
    const t2 = 1_700_000_002_000;
    expect(store.deleteRange(t1, t2)).toEqual({ deleted: 1 });
    expect(store.countRange(t1, t2)).toBe(0);
    expect(store.countRange()).toBe(2);

    // Paging: 120 records, cursor-driven, oldest-first, hasMore truthful.
    const pagedRoot = await mkdtemp(join(tmpdir(), "luckytoken-t23-paged-"));
    roots.push(pagedRoot);
    const paged = await createDeepCaptureStoreFactory({
      configuration: {
        directory: pagedRoot,
        maxCaptureBytes: 1024 * 1024,
        retentionAgeMs: 60 * 60 * 1000,
        maxCaptures: 10_000,
      },
      now: advancingClock(),
      scrub: (value) => value,
    }).open();
    stores.push(paged);
    paged.attachScrub((value) => value);
    const accepted = 1_700_000_000_000;
    for (let index = 0; index < 120; index += 1) {
      paged.append({
        requestId: requestId(),
        protocolId: "anthropic-messages",
        acceptedAt: accepted + index,
        requestBody: `body-${index}`,
        responseBody: `answer-${index}`,
        complete: true,
      });
    }
    const seen: string[] = [];
    let cursor: number | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = paged.queryRange({
        ...(cursor === undefined ? {} : { afterId: cursor }),
        limit: 50,
      });
      seen.push(...result.records.map((record) => record.requestBody ?? ""));
      expect(result.hasMore).toBe(page < 2);
      if (!result.hasMore) break;
      cursor = result.lastRowId;
    }
    expect(seen).toHaveLength(120);
    expect(seen[0]).toBe("body-0");
    expect(seen[119]).toBe("body-119");

    // Eviction tombstones are retention facts: deleting rows never removes
    // them, so an evicted request stays distinguishable from no-capture.
    const evicting = await createDeepCaptureStoreFactory({
      configuration: {
        directory: pagedRoot,
        maxCaptureBytes: 1024 * 1024,
        retentionAgeMs: 0,
        maxCaptures: 10_000,
      },
      now: () => 1_700_000_100_000,
      scrub: (value) => value,
    }).open();
    stores.push(evicting);
    evicting.attachScrub((value) => value);
    const evictedId = requestId();
    evicting.append({
      requestId: evictedId,
      protocolId: "anthropic-messages",
      acceptedAt: 1_000,
      requestBody: "old-body",
      complete: false,
    });
    expect(evicting.query({ requestId: evictedId }).state).toBe("expired");
    evicting.deleteRange();
    expect(evicting.countRange()).toBe(0);
    expect(evicting.query({ requestId: evictedId }).state).toBe("expired");
  });

  it("rejects invalid ranges and reports schema versions truthfully", async () => {
    const { store: diagnostics } = await openDiagnostics();
    diagnostics.attachScrub((value) => value);
    expect(() => diagnostics.deleteRange(200, 100)).toThrow();
    expect(() => diagnostics.deleteRange(-1)).toThrow();
    expect(() => diagnostics.countRange(200, 100)).toThrow();
    expect(diagnostics.schemaVersion).toBe(1);

    const { store: ledger } = await openLedger();
    expect(() => ledger.deleteRange(200, 100)).toThrow();
    expect(ledger.schemaVersion).toBe(3);

    const { store: capture } = await openCapture();
    expect(() => capture.deleteRange(200, 100)).toThrow();
    expect(capture.schemaVersion).toBe(1);
  });
});
