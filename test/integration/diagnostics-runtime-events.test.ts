import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDiagnosticsAuthority,
  DiagnosticsUnavailableError,
  parseDiagnosticsConfiguration,
  type DiagnosticsAuthority,
  type RuntimeEventObservationInput,
} from "../../src/diagnostics/index.js";

interface RuntimeEventRecord {
  readonly kind: "runtime_event";
  readonly id: number;
  readonly runtimeId: string;
  readonly recordId: string;
  readonly sequence: number;
  readonly time: number;
  readonly level: RuntimeEventObservationInput["level"];
  readonly classification: string;
  readonly safeMessage: string;
}

interface RuntimeEventQuery {
  readonly afterId?: number;
  readonly limit?: number;
}

interface RuntimeEventQueryResult {
  readonly records: readonly RuntimeEventRecord[];
  readonly hasMore: boolean;
}

interface RuntimeEventManagement {
  queryRuntimeEvents(query?: RuntimeEventQuery): Promise<RuntimeEventQueryResult>;
}

function runtimeEventManagement(
  authority: DiagnosticsAuthority,
): DiagnosticsAuthority & RuntimeEventManagement {
  return authority as DiagnosticsAuthority & RuntimeEventManagement;
}

const RUNTIME_ID = "50000000-0000-4000-8000-000000000001";
const REQUEST_ID = "50000000-0000-4000-8000-000000000002";

const RUNTIME_EVENTS = Object.freeze([
  Object.freeze({
    level: "info" as const,
    classification: "application_started",
    safeMessage: "LuckyToken application started",
  }),
  Object.freeze({
    level: "warning" as const,
    classification: "catalog_refresh_degraded",
    safeMessage: "One provider catalog could not be refreshed",
  }),
  Object.freeze({
    level: "critical" as const,
    classification: "diagnostics_storage_attention",
    safeMessage: "Diagnostics storage needs operator attention",
  }),
]);

describe("Diagnostics runtime-event management", () => {
  const roots: string[] = [];
  const authorities: DiagnosticsAuthority[] = [];

  afterEach(async () => {
    await Promise.all(
      authorities.splice(0).map((authority) => authority.close()),
    );
    await Promise.all(
      roots.splice(0).map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
  });

  it("persists bounded typed Runtime Events beside Journeys and queries them by ordered records cursor", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-runtime-events-"));
    roots.push(root);
    let clock = 1_787_558_400_000;
    const authority = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration(
        { directory: root },
        root,
      ),
      runtimeId: RUNTIME_ID,
      now: () => clock++,
    });
    authorities.push(authority);

    const journey = authority.begin({
      requestId: REQUEST_ID,
      operationCandidate: "unmatched_request",
      transport: "in_process",
      method: "GET",
      path: "/runtime-event-records-authority-probe",
      acceptedAt: 1_787_558_400_000,
      cancellation: { caller: "active", shutdown: "not_bound" },
    });
    expect(() => journey.close({ outcome: "success" })).not.toThrow();

    for (const event of RUNTIME_EVENTS) {
      expect(() => authority.observeRuntime(event)).not.toThrow();
    }

    const management = runtimeEventManagement(authority);
    const firstPage = await management.queryRuntimeEvents({ limit: 2 });
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.records).toHaveLength(2);
    expect(firstPage.records.map((record) => record.id)).toEqual(
      [...firstPage.records.map((record) => record.id)].sort(
        (left, right) => left - right,
      ),
    );
    expect(firstPage.records.map((record) => record.classification)).toEqual(
      RUNTIME_EVENTS.slice(0, 2).map((event) => event.classification),
    );

    const secondPage = await management.queryRuntimeEvents({
      afterId: firstPage.records[1]!.id,
      limit: 2,
    });
    expect(secondPage).toMatchObject({
      hasMore: false,
      records: [
        {
          kind: "runtime_event",
          runtimeId: RUNTIME_ID,
          level: RUNTIME_EVENTS[2]!.level,
          classification: RUNTIME_EVENTS[2]!.classification,
          safeMessage: RUNTIME_EVENTS[2]!.safeMessage,
        },
      ],
    });
    const records = [...firstPage.records, ...secondPage.records];
    expect(new Set(records.map((record) => record.recordId))).toHaveProperty(
      "size",
      3,
    );
    for (const record of records) {
      expect(record).toMatchObject({
        kind: "runtime_event",
        id: expect.any(Number),
        runtimeId: RUNTIME_ID,
        recordId: expect.any(String),
        sequence: expect.any(Number),
        time: expect.any(Number),
        level: expect.stringMatching(/^(info|warning|error|critical)$/u),
        classification: expect.any(String),
        safeMessage: expect.any(String),
      });
      expect(Buffer.byteLength(JSON.stringify(record), "utf8")).toBeLessThanOrEqual(
        64 * 1_024,
      );
    }

    const journeys = await authority.queryRequestJourneys({ limit: 10 });
    expect(journeys.records).toHaveLength(1);
    expect(journeys.records[0]).toMatchObject({
      id: expect.any(Number),
      runtimeId: RUNTIME_ID,
      requestId: REQUEST_ID,
    });
    expect(journeys.records[0]!.id).toBeLessThan(records[0]!.id);

    await authority.close();
    authorities.splice(authorities.indexOf(authority), 1);

    const databasePath = join(root, "diagnostics.sqlite3");
    expect((await readFile(databasePath)).byteLength).toBeGreaterThan(0);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const recordKinds = database
        .prepare(
          `SELECT record_kind AS recordKind, COUNT(*) AS count
             FROM records
            GROUP BY record_kind
            ORDER BY record_kind`,
        )
        .all();
      expect(recordKinds).toEqual([
        { recordKind: "request_journey", count: 1 },
        { recordKind: "runtime_event", count: 3 },
      ]);
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM runtime_events").get(),
      ).toEqual({ count: 3 });
    } finally {
      database.close();
    }
  });

  it("fails open on observation and returns typed unavailability when runtime-event storage cannot start", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "luckytoken-runtime-events-unavailable-"),
    );
    roots.push(root);
    const databasePath = join(root, "diagnostics.sqlite3");
    const incompatible = new DatabaseSync(databasePath);
    incompatible.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value NOT NULL);
      INSERT INTO meta (key, value) VALUES ('schema_name', 'foreign_diagnostics');
      INSERT INTO meta (key, value) VALUES ('schema_version', 99);
    `);
    incompatible.close();

    const authority = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration(
        { directory: root },
        root,
      ),
      runtimeId: RUNTIME_ID,
    });
    authorities.push(authority);

    expect(() => authority.observeRuntime(RUNTIME_EVENTS[0]!)).not.toThrow();
    let failure: unknown;
    try {
      await runtimeEventManagement(authority).queryRuntimeEvents({ limit: 10 });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DiagnosticsUnavailableError);
    expect(failure).toMatchObject({
      name: "DiagnosticsUnavailableError",
      code: "diagnostics_unavailable",
      classification: "diagnostics_storage_unavailable",
    });
  });
});
