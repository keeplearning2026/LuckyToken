import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  connectControlPlane,
  createNodePipeTransport,
  nodePipeFallbackAccess,
  startControlPlane,
  type ControlPlaneEndpoint,
  type HistoryRange,
  type RunningControlPlane,
} from "@token/application-control-plane/control-plane";
import { createHistoryAuthority } from "../../src/history/index.js";

interface UnifiedHistoryFake {
  countHistory(
    range: HistoryRange,
  ): Promise<{ readonly requestJourneys: number; readonly runtimeEvents: number }>;
  deleteHistory(range: HistoryRange): Promise<{
    readonly deleted: {
      readonly requestJourneys: number;
      readonly runtimeEvents: number;
    };
  }>;
  createBackupSnapshot(signal: AbortSignal): Promise<Uint8Array>;
}

describe("unified history authority", () => {
  const roots: string[] = [];
  const hosts: RunningControlPlane[] = [];
  let endpointSequence = 0;

  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((host) => host.close()));
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  function endpoint(): ControlPlaneEndpoint {
    endpointSequence += 1;
    return {
      address: `\\\\.\\pipe\\unified-history-${process.pid}-${endpointSequence}`,
      capability: `unified-history-${String(endpointSequence).padStart(32, "0")}`,
    };
  }

  async function start(diagnostics: UnifiedHistoryFake) {
    const root = await mkdtemp(join(tmpdir(), "Token-unified-history-"));
    roots.push(root);
    const authority = createHistoryAuthority({
      diagnostics,
      applicationVersion: "0.0.0-test",
      ownedRoots: [join(root, "owned")],
      createActionId: () => "history-action-1",
      createExportId: () => "history-export-1",
      now: () => 1_700_000_000_000,
    });
    const host = await startControlPlane({
      endpoint: endpoint(),
      application: { id: "Token", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      pipeServerFactory: createNodePipeTransport(),
      access: nodePipeFallbackAccess,
      historyCommandHandler: (command, signal) => authority.handle(command, signal),
    });
    hosts.push(host);
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `history-request-${endpointSequence}`,
      pipeConnector: createNodePipeTransport(),
    });
    await client.hello(4);
    return { root, client };
  }

  function fake(overrides: Partial<UnifiedHistoryFake> = {}): UnifiedHistoryFake {
    return {
      countHistory: async () => ({ requestJourneys: 2, runtimeEvents: 3 }),
      deleteHistory: async () => ({
        deleted: { requestJourneys: 2, runtimeEvents: 3 },
      }),
      createBackupSnapshot: async () => Uint8Array.from([0x53, 0x51, 0x4c]),
      ...overrides,
    };
  }

  it("counts and atomically deletes Request Journeys and Runtime Events through one authority", async () => {
    const counted: HistoryRange[] = [];
    const deleted: HistoryRange[] = [];
    const range = Object.freeze({
      fromMs: 1_700_000_000_000,
      toMs: 1_700_000_100_000,
    });
    const { client } = await start(
      fake({
        countHistory: async (input) => {
          counted.push(input);
          return { requestJourneys: 2, runtimeEvents: 3 };
        },
        deleteHistory: async (input) => {
          deleted.push(input);
          return {
            deleted: { requestJourneys: 2, runtimeEvents: 3 },
          };
        },
      }),
    );

    await expect(client.queryHistory(range)).resolves.toEqual({
      range,
      counts: { requestJourneys: 2, runtimeEvents: 3 },
    });
    const gate = await client.executeHistoryDelete({ range });
    expect(gate).toEqual({
      outcome: "confirmation_required",
      actionId: "history-action-1",
      confirmationMessage:
        "Deleting history is irreversible. 2 Request Journeys and 3 Runtime Events will be permanently deleted.",
      preview: {
        range,
        counts: { requestJourneys: 2, runtimeEvents: 3 },
      },
    });
    const result = await client.confirmHistoryDelete("history-action-1");
    expect(result).toEqual({
      outcome: "completed",
      deleted: { requestJourneys: 2, runtimeEvents: 3 },
    });
    expect(counted).toEqual([range, range]);
    expect(deleted).toEqual([range]);
    await client.close();
  });

  it("reports one atomic deletion failure and never a per-store partial result", async () => {
    const { client } = await start(
      fake({
        deleteHistory: async () => {
          throw new Error("sqlite fault canary-5500");
        },
      }),
    );
    const gate = await client.executeHistoryDelete({ range: "all" });
    expect(gate.outcome).toBe("confirmation_required");
    if (gate.outcome !== "confirmation_required") return;
    const result = await client.confirmHistoryDelete(gate.actionId!);
    expect(result).toEqual({
      outcome: "failed",
      failure: {
        code: "storage_failure",
        message: "History could not be deleted.",
      },
    });
    expect(JSON.stringify(result)).not.toContain("canary-5500");
    expect(JSON.stringify(result)).not.toContain("partial");
    await client.close();
  });

  it("exports only a consistent SQLite snapshot from the same authority", async () => {
    const snapshot = Uint8Array.from([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);
    const snapshotSignals: AbortSignal[] = [];
    const { root, client } = await start(
      fake({
        createBackupSnapshot: async (signal) => {
          snapshotSignals.push(signal);
          return snapshot;
        },
      }),
    );
    const destinationPath = join(root, "history-export.json");
    const gate = await client.executeHistoryExport({
      destinationPath,
      overwrite: false,
    });
    expect(gate).toEqual({
      outcome: "confirmation_required",
      actionId: "history-action-1",
      confirmationMessage:
        "This export contains redacted Request Journey artifacts. Confirm this sensitive history export.",
    });
    expect(snapshotSignals).toHaveLength(0);

    const result = await client.confirmHistoryExport("history-action-1");
    expect(result).toEqual({
      outcome: "ok",
      exportId: "history-export-1",
      destinationPath,
      manifest: {
        manifestVersion: 2,
        exportedAt: 1_700_000_000_000,
        sensitive: true,
        snapshot: {
          contract: "token-diagnostics-sqlite",
          schemaVersion: 2,
          bytes: snapshot.byteLength,
        },
      },
    });
    expect(snapshotSignals).toHaveLength(1);
    const artifact = JSON.parse(await readFile(destinationPath, "utf8")) as {
      readonly snapshot: { readonly content: string };
    };
    expect(Buffer.from(artifact.snapshot.content, "base64")).toEqual(
      Buffer.from(snapshot),
    );
    const serialized = JSON.stringify(artifact);
    expect(serialized).not.toContain("requestLedger");
    expect(serialized).not.toContain("capture");
    await client.close();
  });
});
