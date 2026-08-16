import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDeepCaptureStoreFactory,
  parseDeepDiagnosticsConfiguration,
  type DeepCaptureStore,
} from "../../src/deep-diagnostics/index.js";
import {
  createCredentialScrubber,
} from "../../src/runtime-diagnostics/index.js";
import {
  createRequestLedgerStoreFactory,
  parseRequestLedgerConfiguration,
} from "../../src/request-ledger/index.js";
import {
  createRuntimeDiagnosticsStoreFactory,
  parseRuntimeDiagnosticsConfiguration,
} from "../../src/runtime-diagnostics/index.js";

/**
 * Ticket 22 store public seam: bounded age + capacity retention with
 * truthful expired-state tombstones, restart recovery, structured-history
 * independence, failed-state observability, size caps, and the one
 * universal redaction choke point (pattern + known-value scrub) verified
 * over every persisted byte.
 */

const CANARIES = [
  "canary-known-secret-3e0a7b22",
  "canary-body-password-9f8e7d6c",
  "canary-header-token-7d3f9c21",
  "canary-query-token-5b2d8e71",
] as const;

const IDS = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
  "10000000-0000-4000-8000-000000000004",
] as const;

function allPersistedBytes(root: string): Promise<string> {
  return readdir(root, { recursive: true }).then((entries) =>
    Promise.all(
      entries
        .filter((entry) => typeof entry === "string")
        .map((entry) => join(root, entry))
        .map(async (path) => {
          try {
            return await readFile(path, "utf8");
          } catch {
            return "";
          }
        }),
    ).then((chunks) => chunks.join("\n")),
  );
}

function fullDraft(id: string, acceptedAt: number): Parameters<DeepCaptureStore["append"]>[0] {
  return {
    requestId: id,
    protocolId: "anthropic-messages",
    acceptedAt,
    clientHttpStatus: 200,
    requestBody: JSON.stringify({
      messages: [{ role: "user", content: "safe request text" }],
      api_key: "canary-body-password-9f8e7d6c",
      query: "token=canary-query-token-5b2d8e71",
      note: "safe-note-1",
    }),
    responseBody: JSON.stringify({
      content: [{ type: "text", text: "safe response text" }],
    }),
    requestHeaders: {
      authorization: "Bearer canary-header-token-7d3f9c21",
      "content-type": "application/json",
    },
    responseHeaders: { "content-type": "application/json" },
    timing: [
      { stage: "accepted", time: acceptedAt },
      { stage: "request-body", time: acceptedAt + 1 },
      { stage: "response", time: acceptedAt + 2 },
      { stage: "finalize", time: acceptedAt + 3 },
    ],
    complete: true,
  };
}

describe("Deep Diagnostics capture store public seam (Ticket 22)", () => {
  const roots: string[] = [];
  const stores: Array<{ close(): void }> = [];

  afterEach(async () => {
    stores.splice(0).forEach((store) => store.close());
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function openStore(options: {
    maxCaptures?: number;
    retentionAgeMs?: number;
    maxCaptureBytes?: number;
    now?: () => number;
    scrub?: (value: string) => string;
    databaseFactory?: { open(path: string): DatabaseSync };
  } = {}): Promise<{ store: DeepCaptureStore; root: string }> {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-capture-store-"));
    roots.push(root);
    const configuration = parseDeepDiagnosticsConfiguration(
      {
        directory: root,
        ...(options.maxCaptures === undefined
          ? {}
          : { maxCaptures: options.maxCaptures }),
        ...(options.retentionAgeMs === undefined
          ? {}
          : { retentionAgeMs: options.retentionAgeMs }),
        ...(options.maxCaptureBytes === undefined
          ? {}
          : { maxCaptureBytes: options.maxCaptureBytes }),
      },
      root,
    );
    const store = await createDeepCaptureStoreFactory({
      configuration,
      now: options.now ?? (() => 1_786_400_000_000),
      scrub: options.scrub ?? ((value) => value),
      ...(options.databaseFactory === undefined
        ? {}
        : { databaseFactory: options.databaseFactory }),
    }).open();
    stores.push(store);
    return { store, root };
  }

  it("evicts by age and capacity deterministically, marks evicted requests expired, and never touches other capture rows", async () => {
    // Capacity 2, age 1000ms; clock advances one ms per read.
    let now = 999;
    const clock = () => (now += 1);
    const { store } = await openStore({
      maxCaptures: 2,
      retentionAgeMs: 1_000,
      now: clock,
    });
    store.append(fullDraft(IDS[0]!, clock()));
    store.append(fullDraft(IDS[1]!, clock()));
    store.append(fullDraft(IDS[2]!, clock()));
    // Capacity 2: IDS[0] evicted by capacity at the third commit.
    expect(store.query({ requestId: IDS[0]! })).toMatchObject({
      state: "expired",
      evictionReason: "capacity",
    });
    expect(store.query({ requestId: IDS[0]! }).evictedAt).toBe(now);
    expect(store.query({ requestId: IDS[1]! }).state).toBe("captured");
    expect(store.query({ requestId: IDS[2]! }).state).toBe("captured");

    // Advance past the age retention of the remaining rows (measured from
    // the acceptance-time snapshot): the next write sweeps them by age.
    now = 2_100;
    store.append(fullDraft(IDS[3]!, clock()));
    // IDS[1] (accepted 1001) and IDS[2] (accepted 1002) are older than
    // now - 1000ms = 1100; IDS[3] is fresh.
    expect(store.query({ requestId: IDS[1]! })).toMatchObject({
      state: "expired",
      evictionReason: "age",
    });
    expect(store.query({ requestId: IDS[2]! })).toMatchObject({
      state: "expired",
      evictionReason: "age",
    });
    expect(store.query({ requestId: IDS[3]! }).state).toBe("captured");
  });

  it("persists committed captures across a simulated restart and enforces age retention at open", async () => {
    const now = () => 1_786_400_000_000;
    const { store, root } = await openStore({ retentionAgeMs: 1_000, now });
    store.append(fullDraft(IDS[0]!, 1_786_400_000_000));
    store.append(fullDraft(IDS[1]!, 1_786_400_000_001));
    store.close();

    // Reopen with the same directory: committed rows survive; the open-time
    // sweep enforces retention (nothing is stale yet here).
    const configuration = parseDeepDiagnosticsConfiguration(
      { directory: root, retentionAgeMs: 1_000 },
      root,
    );
    const reopened = await createDeepCaptureStoreFactory({
      configuration,
      now: () => 1_786_400_000_000,
      scrub: (value) => value,
    }).open();
    stores.push(reopened);
    expect(reopened.query({ requestId: IDS[0]! }).state).toBe("captured");
    expect(reopened.query({ requestId: IDS[1]! }).state).toBe("captured");
    reopened.close();

    // A later open with the clock advanced sweeps the stale row at open.
    const later = await createDeepCaptureStoreFactory({
      configuration,
      now: () => 1_786_400_001_001,
      scrub: (value) => value,
    }).open();
    stores.push(later);
    // IDS[0] (accepted 1786400000000) and IDS[1] (accepted 1786400000001)
    // are both older than 1786400001001 - 1000 = 1786400000001... the age
    // cutoff evicts accepted_at < 1786400001001 - 1000 = 1786400000001, so
    // IDS[0] is stale and IDS[1] (accepted 1786400000001, not strictly
    // below the cutoff) survives.
    expect(later.query({ requestId: IDS[0]! }).state).toBe("expired");
    expect(later.query({ requestId: IDS[1]! }).state).toBe("captured");
  });

  it("keeps the structured Request Ledger and diagnostics records untouched by capture eviction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-capture-indep-"));
    roots.push(directory);
    const ledgerConfiguration = parseRequestLedgerConfiguration(
      { directory: join(directory, "ledger") },
      directory,
    );
    const ledger = await createRequestLedgerStoreFactory({
      configuration: ledgerConfiguration,
      now: () => 1_786_400_000_000,
      scrub: (value) => value,
    }).open();
    stores.push(ledger);
    const diagnosticsConfiguration = parseRuntimeDiagnosticsConfiguration(
      { directory: join(directory, "diagnostics") },
      directory,
    );
    const diagnostics = await createRuntimeDiagnosticsStoreFactory({
      configuration: diagnosticsConfiguration,
      now: () => 1_786_400_000_000,
      scrub: (value) => value,
    }).open();
    stores.push(diagnostics);
    const captureConfiguration = parseDeepDiagnosticsConfiguration(
      { directory: join(directory, "capture"), maxCaptures: 1 },
      directory,
    );
    const capture = await createDeepCaptureStoreFactory({
      configuration: captureConfiguration,
      now: () => 1_786_400_000_000,
      scrub: (value) => value,
    }).open();
    stores.push(capture);

    // One ledger row + one diagnostics record + two captures (second
    // evicts the first).
    const ledgerEntry = ledger.begin("anthropic-messages");
    ledgerEntry.executing();
    ledgerEntry.terminal("success", { clientHttpStatus: 200 });
    ledgerEntry.completed(200);
    diagnostics.append({ level: "info", text: "independent record" });
    capture.append(fullDraft(IDS[0]!, 1_786_400_000_000));
    capture.append(fullDraft(IDS[1]!, 1_786_400_000_001));

    expect(capture.query({ requestId: IDS[0]! }).state).toBe("expired");
    expect(capture.query({ requestId: IDS[1]! }).state).toBe("captured");

    // The permanent structured surfaces are byte-for-byte intact.
    const ledgerRows = ledger.query(undefined);
    expect(ledgerRows.records).toHaveLength(1);
    expect(ledgerRows.records[0]).toMatchObject({
      requestId: ledgerEntry.requestId,
      outcome: "success",
      clientHttpStatus: 200,
    });
    const diagnosticRows = diagnostics.query(undefined);
    expect(diagnosticRows.records).toHaveLength(1);
    expect(diagnosticRows.records[0]!.text).toBe("independent record");
  });

  it("observes the failed state after a first write fault via the failed-state marker", async () => {
    // Poison exactly the first captures-table write after open; the
    // observer retry with the minimal failed-state marker then succeeds.
    let poisonFirstWrite = true;
    const databaseFactory = {
      open: (path: string) => {
        const inner = new DatabaseSync(path);
        return new Proxy(inner, {
          get(target, property) {
            if (property === "prepare") {
              return (sql: string) => {
                const statement = target.prepare(sql);
                return new Proxy(statement, {
                  get(statementTarget, statementProperty) {
                    if (
                      statementProperty === "run" &&
                      /^\s*INSERT INTO captures\b/i.test(sql)
                    ) {
                      return (...args: unknown[]) => {
                        if (poisonFirstWrite) {
                          poisonFirstWrite = false;
                          throw new Error(
                            "capture write denied canary-fault-445566",
                          );
                        }
                        return statementTarget.run(
                          ...(args as Parameters<typeof statementTarget.run>),
                        );
                      };
                    }
                    const value = Reflect.get(
                      statementTarget,
                      statementProperty,
                      statementTarget,
                    );
                    return typeof value === "function"
                      ? value.bind(statementTarget)
                      : value;
                  },
                });
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    };
    const { store } = await openStore({ databaseFactory });
    // The authority-level retry semantics are reproduced here directly:
    // first append faults, the failed-state marker row is committed.
    let fault: unknown;
    try {
      store.append(fullDraft(IDS[0]!, 1_786_400_000_000));
    } catch (error) {
      fault = error;
    }
    expect(fault).toBeDefined();
    expect(store.query({ requestId: IDS[0]! }).state).toBe("no-capture");
    store.appendFailed({
      requestId: IDS[0]!,
      protocolId: "anthropic-messages",
      acceptedAt: 1_786_400_000_000,
    });
    const failed = store.query({ requestId: IDS[0]! });
    expect(failed.state).toBe("failed");
    expect(failed.record!.requestBody).toBeUndefined();
    expect(failed.record!.responseBody).toBeUndefined();
    expect(failed.record!.state).toBe("failed");
    expect(failed.record!.acceptedAt).toBe(1_786_400_000_000);
    // The fault text never reaches the store or any query result.
    expect(JSON.stringify(failed)).not.toContain("canary-fault-445566");
  });

  it("removes every credential canary — including arbitrary known values — from persisted bytes while safe text survives", async () => {
    // The known-value scrubber is the credential owners' contribution; the
    // pattern redactor is the baseline even without it.
    const knownScrub = createCredentialScrubber([
      { value: "canary-known-secret-3e0a7b22" },
    ]).scrubText;
    const { store, root } = await openStore({ scrub: knownScrub });
    const draft = fullDraft(IDS[0]!, 1_786_400_000_000);
    store.append({
      ...draft,
      // An arbitrary user-chosen token embedded in benign text: only the
      // known-value scrubber can remove it.
      requestBody: JSON.stringify({
        messages: [{ role: "user", content: "canary-known-secret-3e0a7b22" }],
        note: "safe-note-1",
      }),
    });
    const persisted = await allPersistedBytes(root);
    for (const canary of CANARIES) {
      expect(persisted).not.toContain(canary);
    }
    expect(persisted).toContain("safe-note-1");
    expect(persisted).toContain("safe response text");
    // The structural redaction kept the benign structure and the header
    // names while removing the header value.
    const record = store.query({ requestId: IDS[0]! }).record!;
    expect(record.requestHeaders!["authorization"]).toBe("[REDACTED]");
    expect(record.requestHeaders!["content-type"]).toBe("application/json");
  });

  it("bounds oversized bodies with an explicit truncation marker", async () => {
    const { store } = await openStore({ maxCaptureBytes: 1_024 });
    // A non-JSON oversized body is truncated to the capture cap.
    const huge = "x".repeat(10_000) + "canary-oversize-tail-1f2e3d4c";
    store.append({
      requestId: IDS[0]!,
      protocolId: "anthropic-messages",
      acceptedAt: 1_786_400_000_000,
      requestBody: huge,
      complete: true,
    });
    const record = store.query({ requestId: IDS[0]! }).record!;
    // The COMPLETE serialized record (body + envelope) fits the budget in
    // UTF-8 bytes.
    expect(Buffer.byteLength(JSON.stringify(record), "utf8")).toBeLessThanOrEqual(
      1_024,
    );
    expect(record.requestBody!.endsWith("…")).toBe(true);
    // The tail beyond the cap is never persisted.
    expect(record.requestBody).not.toContain("canary-oversize-tail-1f2e3d4c");
  });

  it("budgets the complete record in UTF-8 bytes across multibyte, escaping, and both bodies", async () => {
    const { store } = await openStore({ maxCaptureBytes: 2_048 });
    // Multibyte input: 3 UTF-8 bytes per character — the budget is byte-
    // based, never UTF-16 length-based.
    const multibyte = "日本語安全ログ".repeat(200); // 1,200 chars ≈ 3,600 bytes
    const escaping = '"\\\u0001\u001f'.repeat(600);
    store.append({
      requestId: IDS[0]!,
      protocolId: "anthropic-messages",
      acceptedAt: 1_786_400_000_000,
      requestBody: multibyte,
      responseBody: escaping,
      requestHeaders: { "x-safe": multibyte.slice(0, 100) },
      responseHeaders: { "content-type": "application/json" },
      timing: [
        { stage: "accepted", time: 1_786_400_000_000 },
        { stage: "finalize", time: 1_786_400_000_001 },
      ],
      complete: true,
    });
    const record = store.query({ requestId: IDS[0]! }).record!;
    const serialized = Buffer.byteLength(JSON.stringify(record), "utf8");
    expect(serialized).toBeLessThanOrEqual(2_048);
    // Both oversized bodies carry the explicit marker and neither was
    // dropped entirely (fair alternating budget).
    expect(record.requestBody!.endsWith("…")).toBe(true);
    expect(record.responseBody!.endsWith("…")).toBe(true);
    expect(record.requestBody!.length).toBeGreaterThan(50);
    expect(record.responseBody!.length).toBeGreaterThan(50);
    // Multibyte truncation never splits a character mid-sequence: the
    // truncated body re-encodes cleanly (no lone surrogate pairs).
    for (const chunk of [record.requestBody!, record.responseBody!]) {
      const codePoints = Array.from(chunk);
      const hasLoneSurrogate = codePoints.some(
        (char) => char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdfff,
      );
      expect(hasLoneSurrogate).toBe(false);
    }
    // Exact-bound behavior: an artifact that fits exactly is stored
    // unchanged, without the marker.
    const { store: exactStore } = await openStore({ maxCaptureBytes: 4_096 });
    const fitting = "y".repeat(3_000);
    exactStore.append({
      requestId: IDS[1]!,
      protocolId: "anthropic-messages",
      acceptedAt: 1_786_400_000_000,
      requestBody: fitting,
      complete: true,
    });
    const exact = exactStore.query({ requestId: IDS[1]! }).record!;
    expect(Buffer.byteLength(JSON.stringify(exact), "utf8")).toBeLessThanOrEqual(
      4_096,
    );
    expect(exact.requestBody).toBe(fitting);
    expect(exact.requestBody!.endsWith("…")).toBe(false);
  });

  it("fails closed before the credential scrubber is attached", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-capture-ready-"));
    roots.push(root);
    const configuration = parseDeepDiagnosticsConfiguration(
      { directory: root },
      root,
    );
    const store = await createDeepCaptureStoreFactory({
      configuration,
      now: () => 1_786_400_000_000,
      // No scrub option: the store opens unready (serve-level path).
    }).open();
    stores.push(store);
    expect(() =>
      store.append(fullDraft(IDS[0]!, 1_786_400_000_000)),
    ).toThrow(/credential scrubber must be installed/u);
    expect(() =>
      store.appendFailed({
        requestId: IDS[0]!,
        protocolId: "anthropic-messages",
        acceptedAt: 1_786_400_000_000,
      }),
    ).toThrow(/credential scrubber must be installed/u);
    // After attach, appends are accepted.
    store.attachScrub((value) => value);
    const record = store.append(fullDraft(IDS[0]!, 1_786_400_000_000));
    expect(record.state).toBe("captured");
  });

  it("rejects malformed drafts without persisting anything", async () => {
    const { store, root } = await openStore();
    expect(() =>
      store.append({
        ...fullDraft("not-a-uuid", 1_786_400_000_000),
      }),
    ).toThrow(/UUID-shaped safe ID/u);
    expect(() =>
      store.append({
        ...fullDraft(IDS[0]!, 1_786_400_000_000),
        clientHttpStatus: 42,
      }),
    ).toThrow(/HTTP status/u);
    expect(store.query({ requestId: IDS[0]! }).state).toBe("no-capture");
    expect(await allPersistedBytes(root)).not.toContain("safe request text");
  });
});
