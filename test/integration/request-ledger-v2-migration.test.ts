import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
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
import type { NormalizedTerminalUsage } from "@luckytoken/provider-contract/usage";

/**
 * Ticket 20 store seams: the v1 -> v2 schema migration (atomic, preserves
 * v1 rows, refuses unknown/future schemas, history stays truthful) and the
 * restart persistence of terminal-usage snapshots through the public query.
 */

const V1_SCHEMA_VERSION = 1;
const V2_SCHEMA_VERSION = 2;

/**
 * Independent v1 fixture: the exact Ticket 18 (base commit) schema, built
 * here from the pre-migration definition so the migration is exercised
 * against a genuine v1 file.
 */
const V1_SCHEMA_SQL = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value NOT NULL);
  CREATE TABLE requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL UNIQUE,
    protocol_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    outcome TEXT NOT NULL,
    accepted_at INTEGER NOT NULL,
    execution_started_at INTEGER,
    terminal_at INTEGER,
    completed_at INTEGER,
    client_http_status INTEGER,
    external_alias TEXT,
    provider_id TEXT,
    real_model_id TEXT,
    client_session_id TEXT,
    effective_session_id TEXT,
    project_dir TEXT,
    facts TEXT
  );
  CREATE INDEX requests_id_desc ON requests (id DESC);
  CREATE INDEX requests_accepted ON requests (accepted_at, id);
  CREATE INDEX requests_outcome ON requests (outcome, id);
  CREATE INDEX requests_provider_model ON requests (provider_id, real_model_id, id);
  CREATE INDEX requests_project ON requests (project_dir, id);
  INSERT INTO meta (key, value) VALUES ('schema_name', 'luckytoken_request_ledger');
  INSERT INTO meta (key, value) VALUES ('schema_version', ${V1_SCHEMA_VERSION});
`;

let requestIdCounter = 0;
function requestId(): string {
  requestIdCounter += 1;
  return `10000000-0000-4000-8000-0000000003${String(requestIdCounter).padStart(2, "0")}`;
}

function v1Snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    api: "commandcode-private",
    input: 3,
    cacheRead: 0,
    cacheWrite: 0,
    output: 4,
    normalizedTotal: 7,
    cacheHitRate: 0,
    completeness: "complete",
    evidence: "packages/provider-commandcode-private/src/semantic.ts:150-270",
    ...overrides,
  };
}

describe("Request Ledger v1 -> v2 schema migration", () => {
  const roots: string[] = [];
  const stores: RequestLedgerStore[] = [];

  afterEach(async () => {
    stores.splice(0).forEach((store) => store.close());
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-ledger-v2-"));
    roots.push(root);
    const configuration = parseRequestLedgerConfiguration(
      { directory: "state/request-ledger" },
      root,
    );
    const factory = (overrides: { now?: () => number } = {}) =>
      createRequestLedgerStoreFactory({
        configuration,
        now: overrides.now ?? (() => 1_700_000_000_000),
        scrub: (value) => value,
        createRequestId: requestId,
      });
    return { root, configuration, factory };
  }

  async function createV1Database(
    directory: string,
    rows: Array<Record<string, number | string | null | undefined>>,
    schemaVersion = V1_SCHEMA_VERSION,
  ): Promise<string> {
    await mkdir(directory, { recursive: true });
    const path = join(directory, "ledger.sqlite3");
    const database = new DatabaseSync(path);
    try {
      database.exec(V1_SCHEMA_SQL);
      database
        .prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'")
        .run(schemaVersion);
      for (const row of rows) {
        const params: Array<string | number | null> = [
          row.requestId as string,
          row.protocolId as string,
          row.phase as string,
          row.outcome as string,
          row.acceptedAt as number,
          (row.executionStartedAt ?? null) as number | null,
          (row.terminalAt ?? null) as number | null,
          (row.completedAt ?? null) as number | null,
          (row.clientHttpStatus ?? null) as number | null,
          (row.externalAlias ?? null) as string | null,
          (row.providerId ?? null) as string | null,
          (row.realModelId ?? null) as string | null,
          (row.clientSessionId ?? null) as string | null,
          (row.effectiveSessionId ?? null) as string | null,
          (row.projectDir ?? null) as string | null,
          (row.facts ?? null) as string | null,
        ];
        database
          .prepare(
            `INSERT INTO requests (
               request_id, protocol_id, phase, outcome, accepted_at,
               execution_started_at, terminal_at, completed_at, client_http_status,
               external_alias, provider_id, real_model_id, client_session_id,
               effective_session_id, project_dir, facts
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(...params);
      }
    } finally {
      database.close();
    }
    return path;
  }

  function v1Row(id: number): Record<string, number | string | null> {
    return {
      requestId: `10000000-0000-4000-8000-0000000003${String(id).padStart(2, "0")}`,
      protocolId: "anthropic-messages",
      phase: "terminal-preparation",
      outcome: "success",
      acceptedAt: 1_700_000_000_000,
      executionStartedAt: 1_700_000_000_001,
      terminalAt: 1_700_000_000_002,
      completedAt: 1_700_000_000_003,
      clientHttpStatus: 200,
      externalAlias: "alpha",
      providerId: "commandcode-private",
      realModelId: "claude-fixture",
      clientSessionId: "20000000-0000-4000-8000-000000000031",
      effectiveSessionId: "30000000-0000-4000-8000-000000000032",
      projectDir: "C:\\Users\\fixture\\projects\\alpha",
      facts: JSON.stringify({
        piStopReason: "stop",
        notices: [
          {
            adapter: "commandcode-private",
            direction: "request",
            code: "missing_tool_result_xrepair",
            jsonPath: "$.messages",
            action: "xrepair",
          },
        ],
      }),
    };
  }

  it("migrates a v1 database atomically, preserving every v1 row verbatim", async () => {
    const { configuration, factory } = await fixture();
    const v1 = v1Row(1);
    await createV1Database(configuration.directory, [v1]);

    const store = await factory().open();
    stores.push(store);

    const query = store.query(undefined);
    expect(query.records).toHaveLength(1);
    // The v1 row survives byte-identical: same lifecycle, same facts, and no
    // fabricated terminal usage for history it never had.
    expect(query.records[0]).toMatchObject({
      requestId: v1.requestId,
      protocolId: "anthropic-messages",
      phase: "terminal-preparation",
      outcome: "success",
      acceptedAt: 1_700_000_000_000,
      executionStartedAt: 1_700_000_000_001,
      terminalAt: 1_700_000_000_002,
      completedAt: 1_700_000_000_003,
      clientHttpStatus: 200,
      externalAlias: "alpha",
      providerId: "commandcode-private",
      realModelId: "claude-fixture",
      clientSessionId: "20000000-0000-4000-8000-000000000031",
      effectiveSessionId: "30000000-0000-4000-8000-000000000032",
      projectDir: "C:\\Users\\fixture\\projects\\alpha",
    });
    expect(query.records[0]!.facts).toEqual({
      piStopReason: "stop",
      notices: [
        {
          adapter: "commandcode-private",
          direction: "request",
          code: "missing_tool_result_xrepair",
          jsonPath: "$.messages",
          action: "xrepair",
        },
      ],
    });
    expect(query.records[0]!.terminalUsage).toBeUndefined();

    // The migrated file is v2 and accepts new terminal-usage rows.
    const database = new DatabaseSync(
      join(configuration.directory, "ledger.sqlite3"),
    );
    try {
      const version = database
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: number };
      expect(version.value).toBe(V2_SCHEMA_VERSION);
      const columns = database
        .prepare("PRAGMA table_info(requests)")
        .all() as Array<{ name: string }>;
      expect(columns.some((column) => column.name === "terminal_usage")).toBe(true);
    } finally {
      database.close();
    }
  });

  it("accepts v1 rows that were interrupted mid-flight and recovers them truthfully", async () => {
    const { configuration, factory } = await fixture();
    const running = v1Row(1);
    running.phase = "execution";
    running.outcome = "running";
    running.terminalAt = null;
    running.completedAt = null;
    await createV1Database(configuration.directory, [running]);

    const store = await factory().open();
    stores.push(store);

    const query = store.query(undefined);
    expect(query.records).toHaveLength(1);
    // History stays truthful: the v1 row was running when the process died,
    // so the v2 open recovers it into interrupted (never fabricated).
    expect(query.records[0]).toMatchObject({
      phase: "execution",
      outcome: "interrupted",
    });
    expect(query.records[0]!.terminalUsage).toBeUndefined();
  });

  it("refuses unknown future schema versions without mutating the file", async () => {
    const { configuration, factory } = await fixture();
    const path = await createV1Database(
      configuration.directory,
      [v1Row(1)],
      99,
    );

    await expect(factory().open()).rejects.toThrow(
      /schema 99 is not supported/,
    );

    // The file is untouched: still version 99, still the v1 table shape.
    const database = new DatabaseSync(path);
    try {
      const version = database
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: number };
      expect(version.value).toBe(99);
    } finally {
      database.close();
    }
  });

  it("refuses a foreign schema without mutating the file", async () => {
    const { configuration, factory } = await fixture();
    const directory = join(configuration.directory);
    await mkdir(directory, { recursive: true });
    const path = join(directory, "ledger.sqlite3");
    const database = new DatabaseSync(path);
    try {
      database.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value NOT NULL);
        INSERT INTO meta (key, value) VALUES ('schema_name', 'someone_elses_schema');
        INSERT INTO meta (key, value) VALUES ('schema_version', 1);
        CREATE TABLE other (id INTEGER PRIMARY KEY);
      `);
    } finally {
      database.close();
    }

    await expect(factory().open()).rejects.toThrow(/different schema/);
    const probe = new DatabaseSync(path);
    try {
      const name = probe
        .prepare("SELECT value FROM meta WHERE key = 'schema_name'")
        .get() as { value: string };
      expect(name.value).toBe("someone_elses_schema");
    } finally {
      probe.close();
    }
  });

  it("persists terminal-usage snapshots across a restart through the public query", async () => {
    const { factory } = await fixture();
    const first = await factory().open();
    stores.push(first);
    const entry = first.begin("anthropic-messages");
    entry.modelResolved({
      externalAlias: "alpha",
      providerId: "commandcode-private",
      realModelId: "claude-fixture",
    });
    entry.executing();
    entry.terminalUsage({
      api: "commandcode-private",
      input: 5,
      cacheRead: 4,
      cacheWrite: 3,
      output: 2,
      normalizedTotal: 14,
      cacheHitRate: 4 / 12,
      completeness: "complete",
      evidence: "packages/provider-commandcode-private/src/semantic.ts:150-270",
    } as NormalizedTerminalUsage);
    entry.terminal("success", { piStopReason: "stop" });
    entry.completed(200);
    const committed = first
      .query(undefined)
      .records.find((record) => record.requestId === entry.requestId)!;
    first.close();

    const second = await factory().open();
    stores.push(second);
    const reloaded = second
      .query(undefined)
      .records.find((record) => record.requestId === entry.requestId)!;

    expect(reloaded.terminalUsage).toEqual(committed.terminalUsage);
    expect(reloaded.terminalUsage).toMatchObject({
      api: "commandcode-private",
      completeness: "complete",
      input: 5,
      cacheRead: 4,
      cacheWrite: 3,
      output: 2,
      normalizedTotal: 14,
    });
    expect(reloaded.terminalUsage!.cacheHitRate).toBeCloseTo(4 / 12, 10);
  });

  it("persists partial snapshots (failed/aborted) across a restart unchanged", async () => {
    const { factory } = await fixture();
    const first = await factory().open();
    stores.push(first);
    const entry = first.begin("anthropic-messages");
    entry.executing();
    entry.terminalUsage({
      api: "anthropic-messages",
      input: 7,
      cacheRead: 1,
      cacheWrite: 0,
      output: 0,
      completeness: "partial",
      reason: "aborted",
      evidence: "pi-agent/packages/ai/src/api/anthropic-messages.ts:574-586",
    } as NormalizedTerminalUsage);
    entry.terminal("aborted");
    first.close();

    const second = await factory().open();
    stores.push(second);
    const reloaded = second
      .query(undefined)
      .records.find((record) => record.requestId === entry.requestId)!;

    expect(reloaded.outcome).toBe("aborted");
    expect(reloaded.terminalUsage).toMatchObject({
      api: "anthropic-messages",
      completeness: "partial",
      reason: "aborted",
      input: 7,
      cacheRead: 1,
      output: 0,
    });
    expect(reloaded.terminalUsage!.normalizedTotal).toBeUndefined();
  });

  it("refuses an invalid snapshot fail-open and never fabricates one", async () => {
    const { factory } = await fixture();
    const store = await factory().open();
    stores.push(store);
    const entry = store.begin("anthropic-messages");
    entry.executing();
    // A complete snapshot whose total contradicts its own partition.
    entry.terminalUsage({
      api: "anthropic-messages",
      input: 5,
      cacheRead: 0,
      cacheWrite: 0,
      output: 2,
      normalizedTotal: 99,
      cacheHitRate: 0,
      completeness: "complete",
    } as NormalizedTerminalUsage);
    entry.terminal("success");
    entry.completed(200);

    const record = store
      .query(undefined)
      .records.find((candidate) => candidate.requestId === entry.requestId)!;
    expect(record.terminalUsage).toBeUndefined();
    expect(record.facts).toMatchObject({ persistenceWarnings: 1 });
  });

  it("delivers snapshots through ledger events and the wire decoder", async () => {
    const { factory } = await fixture();
    const store = await factory().open();
    stores.push(store);
    const events: RequestLedgerRecord[] = [];
    const subscription = store.subscribe((event) => {
      if (event.type === "request_ledger") events.push(event.record);
    });
    const entry = store.begin("anthropic-messages");
    entry.executing();
    entry.terminalUsage(v1Snapshot() as unknown as NormalizedTerminalUsage);
    entry.terminal("success");
    entry.completed(200);
    subscription.unsubscribe();

    const terminalEvent = events.find(
      (record) => record.requestId === entry.requestId && record.outcome === "success",
    );
    expect(terminalEvent?.terminalUsage).toMatchObject({
      api: "commandcode-private",
      completeness: "complete",
      input: 3,
      output: 4,
      normalizedTotal: 7,
    });

    // The wire decoder accepts the snapshot under its own strict grammar.
    const { decodeRequestLedgerRecord } = await import(
      "../../packages/application-control-plane/src/wire-ledger.js"
    );
    const decoded = decodeRequestLedgerRecord(
      JSON.parse(JSON.stringify(terminalEvent)),
    );
    expect(decoded?.terminalUsage).toEqual(terminalEvent?.terminalUsage);
  });
});

describe("Request Ledger v2 fresh store", () => {
  const roots: string[] = [];
  const stores: RequestLedgerStore[] = [];

  afterEach(async () => {
    stores.splice(0).forEach((store) => store.close());
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("creates a v2 schema without any v1 step", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-ledger-v2-"));
    roots.push(root);
    const configuration = parseRequestLedgerConfiguration(
      { directory: "state/request-ledger" },
      root,
    );
    const store = await createRequestLedgerStoreFactory({
      configuration,
      now: () => 1_700_000_000_000,
      scrub: (value) => value,
      createRequestId: requestId,
    }).open();
    stores.push(store);

    const database = new DatabaseSync(
      join(configuration.directory, "ledger.sqlite3"),
    );
    try {
      const version = database
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: number };
      expect(version.value).toBe(V2_SCHEMA_VERSION);
    } finally {
      database.close();
    }
  });

  it("leaves no stray -wal or -shm files after close", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-ledger-v2-"));
    roots.push(root);
    const configuration = parseRequestLedgerConfiguration(
      { directory: "state/request-ledger" },
      root,
    );
    const store = await createRequestLedgerStoreFactory({
      configuration,
      now: () => 1_700_000_000_000,
      scrub: (value) => value,
      createRequestId: requestId,
    }).open();
    store.close();
    stores.push(store);

    const files = await readdir(join(configuration.directory));
    expect(files).toEqual(["ledger.sqlite3"]);
  });
});
