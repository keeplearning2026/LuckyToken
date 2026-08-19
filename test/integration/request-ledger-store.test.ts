import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  createRequestLedgerStoreFactory,
  parseRequestLedgerConfiguration,
  type RequestLedgerRecord,
  type RequestLedgerStore,
} from "../../src/request-ledger/index.js";

/**
 * Ticket 18 public seam: the permanent SQLite/WAL Request Ledger store.
 * No storage SQL or observer internals are asserted; every expectation is
 * on the store's public record/query surface and persisted bytes.
 */

const clientSessionId = "20000000-0000-4000-8000-000000000031";
const effectiveSessionId = "30000000-0000-4000-8000-000000000032";
const projectDir = "C:\\Users\\fixture\\projects\\beta";

let requestIdCounter = 0;
function requestId(): string {
  requestIdCounter += 1;
  return `10000000-0000-4000-8000-0000000001${String(requestIdCounter).padStart(2, "0")}`;
}

function runSuccessRequest(store: RequestLedgerStore): RequestLedgerRecord {
  const entry = store.begin("anthropic-messages");
  entry.authorized({
    effectiveSessionId,
    clientSessionId,
    projectDir,
  });
  entry.modelResolved({
    externalAlias: "alpha",
    providerId: "commandcode-private",
    realModelId: "claude-fixture",
  });
  entry.executing();
  entry.terminal("success", { piStopReason: "stop" });
  entry.rendering();
  entry.completed(200);
  const records = store.query(undefined).records;
  return records.find((record) => record.requestId === entry.requestId)!;
}

describe("Request Ledger store public seam", () => {
  const roots: string[] = [];
  const stores: RequestLedgerStore[] = [];

  afterEach(async () => {
    stores.splice(0).forEach((store) => store.close());
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-ledger-store-"));
    roots.push(root);
    const configuration = parseRequestLedgerConfiguration(
      { directory: "state/request-ledger" },
      root,
    );
    return { root, configuration };
  }

  function factory(
    configuration: { directory: string },
    overrides: {
      now?: () => number;
      scrub?: (value: string) => string;
      onPersistenceFailure?: (fact: { requestId: string; messageHash: string }) => void;
    } = {},
  ) {
    return createRequestLedgerStoreFactory({
      configuration,
      now: overrides.now ?? (() => 1_700_000_000_000),
      scrub: overrides.scrub ?? ((value) => value),
      createRequestId: requestId,
      ...(overrides.onPersistenceFailure === undefined
        ? {}
        : { onPersistenceFailure: overrides.onPersistenceFailure }),
    });
  }

  it("persists ordered terminal records across a simulated restart without aging", async () => {
    const { configuration } = await fixture();
    const first = await factory(configuration).open();
    stores.push(first);
    const record = runSuccessRequest(first);
    first.close();

    const second = await factory(configuration).open();
    stores.push(second);
    const query = second.query(undefined);
    expect(query.records).toHaveLength(1);
    expect(query.records[0]).toEqual(record);
    expect(query.hasMore).toBe(false);
    expect(query.records[0]).toMatchObject({
      requestId: record.requestId,
      protocolId: "anthropic-messages",
      phase: "terminal-preparation",
      outcome: "success",
      clientHttpStatus: 200,
      externalAlias: "alpha",
      providerId: "commandcode-private",
      realModelId: "claude-fixture",
      clientSessionId,
      effectiveSessionId,
      projectDir,
    });
    expect(query.records[0]!.facts).toMatchObject({
      piStopReason: "stop",
    });
  });

  it("creates a consistent self-contained backup snapshot through the store seam", async () => {
    const { root, configuration } = await fixture();
    const store = await factory(configuration).open();
    stores.push(store);
    runSuccessRequest(store);

    const bytes = await store.createBackupSnapshot(new AbortController().signal);
    const snapshotPath = join(root, "snapshot.sqlite3");
    await writeFile(snapshotPath, bytes);
    const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
    try {
      const count = snapshot.prepare("SELECT COUNT(*) AS count FROM requests").get() as {
        count: number;
      };
      expect(count.count).toBeGreaterThan(0);
      const version = snapshot
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: number };
      expect(version.value).toBe(2);
    } finally {
      snapshot.close();
    }
    expect(
      (await readdir(configuration.directory)).some((name) =>
        name.includes(".backup."),
      ),
    ).toBe(false);
  });

  it("recovers rows left running by a crash into a truthful interrupted outcome, idempotently", async () => {
    const { configuration } = await fixture();
    const first = await factory(configuration).open();
    stores.push(first);
    // Simulated crash: the entry reaches execution but never terminates and
    // the store is never closed.
    const entry = first.begin("anthropic-messages");
    entry.authorized({ effectiveSessionId });
    entry.modelResolved({
      externalAlias: "alpha",
      providerId: "commandcode-private",
      realModelId: "claude-fixture",
    });
    entry.executing();
    const acceptedAt = first.query(undefined).records[0]!.acceptedAt;

    const second = await factory(configuration).open();
    stores.push(second);
    const query = second.query(undefined);
    expect(query.records).toHaveLength(1);
    const recovered = query.records[0]!;
    expect(recovered).toMatchObject({
      requestId: entry.requestId,
      outcome: "interrupted",
      phase: "execution",
      externalAlias: "alpha",
      providerId: "commandcode-private",
      realModelId: "claude-fixture",
      effectiveSessionId,
    });
    expect(recovered.acceptedAt).toBe(acceptedAt);
    expect(recovered.terminalAt).toBeDefined();
    expect(recovered.completedAt).toBeDefined();

    // Idempotent: a third open sees the same single recovered terminal row.
    const third = await factory(configuration).open();
    stores.push(third);
    expect(third.query(undefined).records).toHaveLength(1);
    expect(third.query(undefined).records[0]!.outcome).toBe("interrupted");
  });

  it("refuses foreign or unknown schema without mutating the original file", async () => {
    const { root } = await fixture();
    const foreign = join(root, "foreign.sqlite3");
    const db = new DatabaseSync(foreign);
    db.exec("CREATE TABLE other (a TEXT)");
    db.close();
    const before = await readFile(foreign, "utf8");
    const factory = createRequestLedgerStoreFactory({
      configuration: { directory: join(root, "foreign") },
      databaseFactory: { open: () => new DatabaseSync(foreign) },
    });
    await expect(factory.open()).rejects.toThrow();
    const after = await readFile(foreign, "utf8");
    expect(after).toBe(before);
    expect(await readdir(join(root, "foreign"))).toEqual([]);

    // A future ledger schema version is refused without mutation too.
    const future = join(root, "future.sqlite3");
    const futureDb = new DatabaseSync(future);
    futureDb.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value NOT NULL);
      INSERT INTO meta (key, value) VALUES ('schema_name', 'luckytoken_request_ledger');
      INSERT INTO meta (key, value) VALUES ('schema_version', 99);
    `);
    futureDb.close();
    const futureBefore = await readFile(future, "utf8");
    const futureFactory = createRequestLedgerStoreFactory({
      configuration: { directory: join(root, "future") },
      databaseFactory: { open: () => new DatabaseSync(future) },
    });
    await expect(futureFactory.open()).rejects.toThrow(/not supported/iu);
    expect(await readFile(future, "utf8")).toBe(futureBefore);
  });

  it("queries newest-first with bounded pages, filters, and empty pages that never claim hasMore", async () => {
    const { configuration } = await fixture();
    const store = await factory(configuration).open();
    stores.push(store);
    for (let index = 1; index <= 12; index += 1) {
      const entry = store.begin(
        index % 2 === 0 ? "openai-responses" : "anthropic-messages",
      );
      entry.authorized({
        effectiveSessionId,
        ...(index % 2 === 0 ? {} : { clientSessionId }),
      });
      if (index % 3 === 0) {
        entry.modelResolved({
          externalAlias: `alias-${index}`,
          providerId: "commandcode-private",
          realModelId: "model-b",
        });
      } else {
        entry.modelResolved({
          externalAlias: `alias-${index}`,
          providerId: "commandcode-private",
          realModelId: "model-a",
        });
      }
      entry.executing();
      entry.terminal(index % 2 === 0 ? "failed" : "success", {
        clientHttpStatus: index % 2 === 0 ? 500 : 200,
      });
      entry.completed(index % 2 === 0 ? 500 : 200);
    }

    const firstPage = store.query({ limit: 5 });
    expect(firstPage.records.map((record) => record.id)).toEqual([
      12, 11, 10, 9, 8,
    ]);
    expect(firstPage.hasMore).toBe(true);
    const secondPage = store.query({ afterId: firstPage.records[4]!.id, limit: 5 });
    expect(secondPage.records.map((record) => record.id)).toEqual([7, 6, 5, 4, 3]);
    expect(secondPage.hasMore).toBe(true);
    const thirdPage = store.query({ afterId: secondPage.records[4]!.id, limit: 5 });
    expect(thirdPage.records.map((record) => record.id)).toEqual([2, 1]);
    expect(thirdPage.hasMore).toBe(false);
    // A cursor strictly beyond the oldest row: empty page, no hasMore.
    const exhausted = store.query({ afterId: 1, limit: 5 });
    expect(exhausted.records).toEqual([]);
    expect(exhausted.hasMore).toBe(false);

    const failures = store.query({ outcome: "failed" });
    expect(failures.records.map((record) => record.id)).toEqual([
      12, 10, 8, 6, 4, 2,
    ]);
    expect(failures.hasMore).toBe(false);
    const modelB = store.query({ realModelId: "model-b", limit: 2 });
    expect(modelB.records.map((record) => record.id)).toEqual([12, 9]);
    expect(modelB.hasMore).toBe(true);
    const protocol = store.query({ protocolId: "anthropic-messages" });
    expect(protocol.records.map((record) => record.id)).toEqual([
      11, 9, 7, 5, 3, 1,
    ]);
    const session = store.query({ clientSessionId });
    expect(session.records.map((record) => record.id)).toEqual([
      11, 9, 7, 5, 3, 1,
    ]);
    const range = store.query({ from: 1_700_000_000_000, to: 1_700_000_000_000 });
    expect(range.records).toHaveLength(12);
    const outOfRange = store.query({ from: 1_800_000_000_000 });
    expect(outOfRange.records).toEqual([]);
    expect(outOfRange.hasMore).toBe(false);
  });

  it("serializes interleaved transitions from concurrent entries and reaches exactly one terminal record per request", async () => {
    const { configuration } = await fixture();
    const store = await factory(configuration).open();
    stores.push(store);

    const left = store.begin("anthropic-messages");
    const right = store.begin("openai-responses");
    left.authorized({ effectiveSessionId });
    right.authorized({ effectiveSessionId: "30000000-0000-4000-8000-000000000099" });
    left.modelResolved({
      externalAlias: "left",
      providerId: "commandcode-private",
      realModelId: "model-a",
    });
    right.modelResolved({
      externalAlias: "right",
      providerId: "commandcode-private",
      realModelId: "model-b",
    });
    left.executing();
    right.executing();
    left.terminal("success");
    right.terminal("failed", { clientHttpStatus: 502 });
    left.completed(200);
    right.completed(502);

    const query = store.query(undefined);
    expect(query.records).toHaveLength(2);
    expect(new Set(query.records.map((record) => record.requestId))).toEqual(
      new Set([left.requestId, right.requestId]),
    );
    for (const record of query.records) {
      const expectedOutcome =
        record.externalAlias === "left" ? "success" : "failed";
      expect(record.outcome).toBe(expectedOutcome);
      expect(record.phase).toBe("terminal-preparation");
      // Every committed transition is visible: accepted/authorized/resolved/
      // execution/terminal/completed ordering is monotonic on the clock.
      expect(record.acceptedAt).toBeLessThanOrEqual(record.executionStartedAt!);
      expect(record.executionStartedAt!).toBeLessThanOrEqual(record.terminalAt!);
      expect(record.terminalAt!).toBeLessThanOrEqual(record.completedAt!);
      expect(record.completedAt).toBeDefined();
    }
  });

  it("records bounded notices, attempts, a safe failure summary, and the Pi stop reason without raw payloads", async () => {
    const { configuration } = await fixture();
    const store = await factory(configuration).open();
    stores.push(store);
    const entry = store.begin("anthropic-messages");
    entry.modelResolved({
      externalAlias: "alpha",
      providerId: "commandcode-private",
      realModelId: "claude-fixture",
    });
    entry.executing();
    entry.notice({
      adapter: "anthropic-messages",
      direction: "request",
      code: "field_ignored",
      jsonPath: "$.metadata",
      action: "ignore",
    });
    entry.attempt({
      attempt: 1,
      classification: "retryable",
      stage: "transport",
      status: 429,
      retryable: true,
      safeIds: { requestId: "upstream-req-42" },
    });
    entry.terminal("failed", { clientHttpStatus: 502, piStopReason: "error" });
    entry.fail({
      classification: "runtime-failure",
      stage: "pi-execution",
      error: new Error("upstream exploded canary-raw-error-7766"),
    });
    entry.completed(502);

    const record = store.query(undefined).records[0]!;
    expect(record.facts).toMatchObject({
      piStopReason: "error",
      notices: [
        {
          adapter: "anthropic-messages",
          direction: "request",
          code: "field_ignored",
          jsonPath: "$.metadata",
          action: "ignore",
        },
      ],
      attempts: [
        {
          attempt: 1,
          classification: "retryable",
          stage: "transport",
          status: 429,
          retryable: true,
          safeIds: { requestId: "upstream-req-42" },
        },
      ],
    });
    // The failure summary is a hash, never the raw error text.
    expect(record.facts!.failure).toMatchObject({
      classification: "runtime-failure",
      stage: "pi-execution",
    });
    expect(record.facts!.failure!.messageHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(record)).not.toContain("canary-raw-error-7766");
    expect(JSON.stringify(record)).not.toContain("upstream exploded");
  });

  it("scrubs credential-owner known values from every stored string", async () => {
    const { configuration } = await fixture();
    const canary = "canary-ledger-credential-1122334455";
    const store = await factory(configuration, {
      scrub: (value) => value.replaceAll(canary, "[REDACTED]"),
    }).open();
    stores.push(store);
    const entry = store.begin("anthropic-messages");
    entry.modelResolved({
      externalAlias: `alias-with-${canary}`,
      providerId: "commandcode-private",
      realModelId: "claude-fixture",
    });
    entry.notice({
      adapter: "anthropic-messages",
      direction: "request",
      code: "field_ignored",
      jsonPath: `$.${canary}`,
      action: "ignore",
    });
    entry.terminal("failed", { piStopReason: `stop ${canary}` });
    entry.completed(400);

    const record = store.query(undefined).records[0]!;
    expect(JSON.stringify(record)).not.toContain(canary);
    expect(record.externalAlias).toContain("[REDACTED]");

    store.close();
    const persisted = await allPersistedBytes(configuration.directory);
    expect(persisted).not.toContain(canary);
    expect(persisted).toContain("alias-with-");
  });

  it("counts persistence warnings and reports the narrow sanitized seam when writes fail", async () => {
    const { configuration } = await fixture();
    const failures: Array<{ requestId: string; messageHash: string }> = [];
    const store = await factory(configuration, {
      onPersistenceFailure: (fact) => failures.push(fact),
    }).open();
    stores.push(store);
    store.close();
    const entry = store.begin("anthropic-messages");
    entry.executing();
    entry.terminal("success");
    // The store is closed: writes fail open, never throwing into the caller.
    expect(failures.length).toBeGreaterThan(0);
    for (const failure of failures) {
      expect(failure.requestId).toBe(entry.requestId);
      expect(failure.messageHash).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it("is fail-open when every injected seam throws and reports the narrow seam exactly once per entry", async () => {
    const { configuration } = await fixture();
    const reported: Array<{ requestId: string; messageHash: string }> = [];
    const store = await createRequestLedgerStoreFactory({
      configuration,
      createRequestId: () => {
        throw new Error("idgen exploded canary-idgen-9012");
      },
      now: () => {
        throw new Error("clock exploded canary-clock-5678");
      },
      scrub: (value) => value,
      onPersistenceFailure: (fact) => {
        reported.push(fact);
        // The fallback callback itself throws: it must never escape into
        // the caller and must never recursively steer the request.
        throw new Error("callback exploded canary-callback-3456");
      },
    }).open();
    stores.push(store);

    // begin() with a throwing protocol-id validation, id generator, clock,
    // and callback: never throws, always yields a safe request id.
    const entry = store.begin("not a safe name!");
    expect(entry.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    // Transitions never throw either; the accepted row persisted with the
    // safe local clock fallback and the safe protocol-id fallback.
    expect(() => {
      entry.executing();
      entry.terminal("success");
      entry.completed(200);
    }).not.toThrow();
    const records = store.query(undefined).records;
    expect(records).toHaveLength(1);
    expect(records[0]!.requestId).toBe(entry.requestId);
    expect(records[0]!.protocolId).toBe("unknown");
    expect(records[0]!.acceptedAt).toBeGreaterThan(0);
    // Exactly one sanitized report for the whole entry, carrying only the
    // request id and a hash — never the fault text or callback text.
    expect(reported).toHaveLength(1);
    expect(reported[0]!.requestId).toBe(entry.requestId);
    expect(JSON.stringify(reported)).not.toContain("canary-idgen-9012");
    expect(JSON.stringify(reported)).not.toContain("canary-clock-5678");
    expect(JSON.stringify(reported)).not.toContain("canary-callback-3456");
    expect(JSON.stringify(reported)).not.toContain("exploded");
  });

  it("returns only committed records after close and refuses further queries", async () => {
    const { configuration } = await fixture();
    const store = await factory(configuration).open();
    stores.push(store);
    runSuccessRequest(store);
    store.close();
    expect(() => store.query(undefined)).toThrow(/closed/iu);
    expect(() => store.begin("anthropic-messages")).not.toThrow();
  });
});

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
