import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDiagnosticsAuthority,
  parseDiagnosticsConfiguration,
  type DiagnosticsAuthority,
} from "../../src/diagnostics/index.js";

interface DiagnosticsBackupSnapshotManagement {
  createBackupSnapshot(signal: AbortSignal): Promise<Uint8Array>;
}

function backupSnapshotManagement(
  authority: DiagnosticsAuthority,
): DiagnosticsAuthority & DiagnosticsBackupSnapshotManagement {
  return authority as DiagnosticsAuthority & DiagnosticsBackupSnapshotManagement;
}

function recordSuccessfulJourney(
  authority: DiagnosticsAuthority,
  requestId: string,
): void {
  const journey = authority.begin({
    requestId,
    operationCandidate: "unmatched_request",
    transport: "in_process",
    method: "GET",
    path: "/diagnostics-backup-snapshot-probe",
    acceptedAt: 1_787_558_400_000,
    cancellation: { caller: "active", shutdown: "not_bound" },
  });
  journey.close({ outcome: "success" });
}

describe("unified Diagnostics backup snapshot", () => {
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

  it("creates one consistent point-in-time SQLite snapshot through the live Diagnostics Worker", async () => {
    const liveRoot = await mkdtemp(
      join(tmpdir(), "Token-diagnostics-backup-live-"),
    );
    const restoredRoot = await mkdtemp(
      join(tmpdir(), "Token-diagnostics-backup-restored-"),
    );
    roots.push(liveRoot, restoredRoot);

    const live = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration(
        { directory: liveRoot },
        liveRoot,
      ),
      runtimeId: "54000000-0000-4000-8000-000000000001",
    });
    authorities.push(live);

    const snapshottedRequestId =
      "54000000-0000-4000-8000-000000000002";
    recordSuccessfulJourney(live, snapshottedRequestId);
    await expect(live.queryRequestJourneys({ limit: 10 })).resolves.toMatchObject({
      records: [
        expect.objectContaining({
          requestId: snapshottedRequestId,
          outcome: "success",
        }),
      ],
      hasMore: false,
    });

    const snapshot = await backupSnapshotManagement(live).createBackupSnapshot(
      new AbortController().signal,
    );
    expect(
      (await readdir(liveRoot)).some((entry) => entry.includes(".backup.")),
    ).toBe(false);

    const postSnapshotRequestId =
      "54000000-0000-4000-8000-000000000003";
    recordSuccessfulJourney(live, postSnapshotRequestId);
    const liveRecords = await live.queryRequestJourneys({ limit: 10 });
    expect(liveRecords.records.map((record) => record.requestId)).toEqual([
      snapshottedRequestId,
      postSnapshotRequestId,
    ]);

    await writeFile(join(restoredRoot, "diagnostics-v2.sqlite3"), snapshot);
    const restored = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration(
        { directory: restoredRoot },
        restoredRoot,
      ),
      runtimeId: "54000000-0000-4000-8000-000000000004",
    });
    authorities.push(restored);

    const restoredRecords = await restored.queryRequestJourneys({ limit: 10 });
    expect(restoredRecords).toMatchObject({
      hasMore: false,
      records: [
        expect.objectContaining({
          requestId: snapshottedRequestId,
          outcome: "success",
        }),
      ],
    });
    expect(
      restoredRecords.records.some(
        (record) => record.requestId === postSnapshotRequestId,
      ),
    ).toBe(false);
  });
});
