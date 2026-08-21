import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  connectControlPlane,
  createNodePipeTransport,
  nodePipeFallbackAccess,
  startControlPlane,
  type ControlPlaneClient,
  type ControlPlaneEndpoint,
  type HistoryRange,
  type RunningControlPlane,
} from "@luckytoken/application-control-plane/control-plane";
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
import { createHistoryAuthority } from "../../src/history/index.js";
import { createPersistenceDegradationAuthority } from "../../src/persistence-degradation/index.js";

/**
 * Ticket 23 public seam: irreversible range/all deletion through the real
 * Control Plane. Every deletion requires the confirmation gate with a count
 * preview; previews equal actual deletions; partial failure is reported per
 * authority (three SQLite files cannot delete atomically and no blanket
 * claim is made); and deletion provably cannot touch settings.json,
 * models.json, model-aliases.json, auth.json, Client Token files, or
 * failure journals (byte-compare).
 */

let requestIdCounter = 0;
function requestId(): string {
  requestIdCounter += 1;
  return `10000000-0000-4000-8000-${String(requestIdCounter).padStart(12, "0")}`;
}

function advancingClock(start = 1_700_000_000_000, step = 1_000) {
  let current = start;
  return () => {
    const value = current;
    current += step;
    return value;
  };
}

interface Fixture {
  readonly root: string;
  readonly ledger: RequestLedgerStore;
  readonly diagnostics: RuntimeDiagnosticsStore;
  readonly capture: DeepCaptureStore;
  readonly client: () => Promise<ControlPlaneClient>;
}

describe("History deletion through the Control Plane (Ticket 23)", () => {
  const roots: string[] = [];
  const hosts: RunningControlPlane[] = [];
  const stores: Array<{ close(): void }> = [];

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
      address: `\\\\.\\pipe\\ticket-23-delete-${process.pid}-${nextId}`,
      capability: `ticket-23-delete-capability-${String(nextId).padStart(20, "0")}`,
    };
  }

  async function fixture(): Promise<Fixture> {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-t23-delete-"));
    roots.push(root);
    const now = advancingClock();
    const scrub = (value: string) => value;
    const diagnostics = await createRuntimeDiagnosticsStoreFactory({
      configuration: { directory: join(root, "diagnostics") },
      now,
      scrub,
    }).open();
    stores.push(diagnostics);
    diagnostics.attachScrub(scrub);
    for (let index = 0; index < 3; index += 1) {
      diagnostics.append({ level: "info", text: `diag-${index}` });
    }
    const ledger = await createRequestLedgerStoreFactory({
      configuration: { directory: join(root, "ledger") },
      now,
      scrub,
      createRequestId: requestId,
    }).open();
    stores.push(ledger);
    ledger.attachScrub(scrub);
    for (let index = 0; index < 3; index += 1) {
      const entry = ledger.begin("anthropic-messages");
      entry.executing();
      entry.terminal("success");
      entry.rendering();
      entry.completed(200);
    }
    const capture = await createDeepCaptureStoreFactory({
      configuration: {
        directory: join(root, "capture"),
        maxCaptureBytes: 1024 * 1024,
        retentionAgeMs: 60 * 60 * 1000,
        maxCaptures: 1_000,
      },
      now,
      scrub,
    }).open();
    stores.push(capture);
    capture.attachScrub(scrub);
    for (let index = 0; index < 2; index += 1) {
      capture.append({
        requestId: requestId(),
        protocolId: "anthropic-messages",
        acceptedAt: 1_700_000_000_000 + index,
        requestBody: `body-${index}`,
        responseBody: `answer-${index}`,
        complete: true,
      });
    }
    const persistence = createPersistenceDegradationAuthority({ now });
    const authority = createHistoryAuthority({
      sources: { ledger, diagnostics, capture },
      persistence,
      ownedRoots: [root],
      applicationVersion: "0.0.0-test",
      now,
    });
    const host = await startControlPlane({
      endpoint: endpoint(),
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      pipeServerFactory: createNodePipeTransport(),
      access: nodePipeFallbackAccess,
      historyCommandHandler: (command, signal) => authority.handle(command, signal),
    });
    hosts.push(host);
    return {
      root,
      ledger,
      diagnostics,
      capture,
      client: async () => {
        const controlPlaneClient = await connectControlPlane(host.endpoint, {
          createRequestId: () => `t23-delete-${++nextId}`,
          pipeConnector: createNodePipeTransport(),
        });
        await controlPlaneClient.hello(2);
        return controlPlaneClient;
      },
    };
  }

  it("gates range and all deletion behind a confirmation with a truthful count preview", async () => {
    const fx = await fixture();
    const controlPlaneClient = await fx.client();
    const gate = await controlPlaneClient.executeHistoryDelete({ range: "all" });
    expect(gate.outcome).toBe("confirmation_required");
    if (gate.outcome !== "confirmation_required") return;
    expect(gate.actionId).toBeTruthy();
    expect(gate.confirmationMessage).toContain("irreversible");
    expect(gate.preview).toEqual({
      range: "all",
      counts: { requestLedger: 3, diagnostics: 3, capture: 2 },
    });
    // Nothing was deleted by the gate itself.
    expect(fx.ledger.countRange()).toBe(3);
    const result = await controlPlaneClient.confirmHistoryDelete(
      gate.actionId as string,
    );
    expect(result).toMatchObject({
      outcome: "completed",
      deleted: { requestLedger: 3, diagnostics: 3, capture: 2 },
    });
    expect(fx.ledger.countRange()).toBe(0);
    expect(fx.diagnostics.countRange()).toBe(0);
    expect(fx.capture.countRange()).toBe(0);
    // Preview counts equal actual deletions (no estimate, no re-query race).
    const second = await controlPlaneClient.executeHistoryDelete({
      range: "all",
    });
    expect(second.outcome).toBe("confirmation_required");
    if (second.outcome !== "confirmation_required") return;
    expect(second.preview?.counts).toEqual({
      requestLedger: 0,
      diagnostics: 0,
      capture: 0,
    });
  });

  it("deletes the half-open range: from included, to excluded, on every authority", async () => {
    const fx = await fixture();
    const controlPlaneClient = await fx.client();
    // AcceptedAt facts come from the store itself: three ledger requests at
    // ticks t4, t8, t12 (each request consumes four clock ticks).
    const times = fx.ledger
      .query(undefined)
      .records.map((record) => record.acceptedAt)
      .sort((left, right) => left - right);
    const fromMs = times[0]!;
    const toMs = times[1]!;
    const range: HistoryRange = Object.freeze({ fromMs, toMs });
    // Boundary pins before deletion: from-inclusive, to-exclusive.
    expect(fx.ledger.countRange(fromMs, fromMs + 1)).toBe(1);
    expect(fx.ledger.countRange(toMs, toMs + 1)).toBe(1);
    const preview = await controlPlaneClient.queryHistory(range);
    const gate = await controlPlaneClient.executeHistoryDelete({ range });
    expect(gate.outcome).toBe("confirmation_required");
    if (gate.outcome !== "confirmation_required") return;
    expect(gate.preview?.counts).toEqual(preview.counts);
    const result = await controlPlaneClient.confirmHistoryDelete(
      gate.actionId as string,
    );
    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") return;
    // The preview equals the actual deletion on every authority.
    expect(result.deleted).toEqual(preview.counts);
    expect(result.deleted?.requestLedger).toBe(1);
    expect(fx.ledger.countRange(fromMs, toMs)).toBe(0);
    // The boundary record at `to` survives (half-open), and everything at
    // or after it is untouched.
    expect(fx.ledger.countRange(toMs)).toBe(2);
    expect(fx.ledger.countRange()).toBe(2);
  });

  it("actionIds are single-use and a mismatched delete confirm is rejected", async () => {
    const fx = await fixture();
    const controlPlaneClient = await fx.client();
    await expect(
      controlPlaneClient.confirmHistoryDelete("no-such-action"),
    ).rejects.toThrow();
    const gate = await controlPlaneClient.executeHistoryDelete({ range: "all" });
    expect(gate.outcome).toBe("confirmation_required");
    if (gate.outcome !== "confirmation_required") return;
    const actionId = gate.actionId as string;
    const first = await controlPlaneClient.confirmHistoryDelete(actionId);
    expect(first.outcome).toBe("completed");
    await expect(
      controlPlaneClient.confirmHistoryDelete(actionId),
    ).rejects.toThrow();
  });

  it("reports partial failure per authority with exact counts and never claims cross-store atomicity", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-t23-partial-"));
    roots.push(root);
    const now = advancingClock();
    const diagnostics = await createRuntimeDiagnosticsStoreFactory({
      configuration: { directory: join(root, "diagnostics") },
      now,
      scrub: (value) => value,
    }).open();
    stores.push(diagnostics);
    diagnostics.attachScrub((value) => value);
    diagnostics.append({ level: "info", text: "diag-0" });
    const ledger = await createRequestLedgerStoreFactory({
      configuration: { directory: join(root, "ledger") },
      now,
      scrub: (value) => value,
      createRequestId: requestId,
    }).open();
    stores.push(ledger);
    ledger.attachScrub((value) => value);
    ledger.begin("anthropic-messages");
    const capture = await createDeepCaptureStoreFactory({
      configuration: {
        directory: join(root, "capture"),
        maxCaptureBytes: 1024 * 1024,
        retentionAgeMs: 60 * 60 * 1000,
        maxCaptures: 1_000,
      },
      now,
      scrub: (value) => value,
    }).open();
    stores.push(capture);
    capture.attachScrub((value) => value);
    capture.append({
      requestId: requestId(),
      protocolId: "anthropic-messages",
      acceptedAt: 1_700_000_003_000,
      requestBody: "body",
      complete: true,
    });
    // Fault the diagnostics delete only: the ledger commits first, the
    // capture commits last — a deterministic partial failure.
    const faultingDiagnostics: RuntimeDiagnosticsStore = {
      ...diagnostics,
      deleteRange() {
        throw new Error("diagnostics delete denied canary-554433");
      },
    };
    const persistence = createPersistenceDegradationAuthority({ now });
    const authority = createHistoryAuthority({
      sources: { ledger, diagnostics: faultingDiagnostics, capture },
      persistence,
      ownedRoots: [root],
      applicationVersion: "0.0.0-test",
      now,
      onSourceFailure: (authorityId, fact) =>
        persistence.reportFailure(authorityId, fact),
    });
    const host = await startControlPlane({
      endpoint: endpoint(),
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      pipeServerFactory: createNodePipeTransport(),
      access: nodePipeFallbackAccess,
      historyCommandHandler: (command, signal) => authority.handle(command, signal),
    });
    hosts.push(host);
    const controlPlaneClient = await connectControlPlane(host.endpoint, {
      createRequestId: () => `t23-partial-${++nextId}`,
      pipeConnector: createNodePipeTransport(),
    });
    await controlPlaneClient.hello(2);
    const gate = await controlPlaneClient.executeHistoryDelete({ range: "all" });
    expect(gate.outcome).toBe("confirmation_required");
    if (gate.outcome !== "confirmation_required") return;
    const result = await controlPlaneClient.confirmHistoryDelete(
      gate.actionId as string,
    );
    expect(result.outcome).toBe("partial_failure");
    if (result.outcome !== "partial_failure") return;
    // Truthful per-authority outcome: ledger and capture committed, the
    // faulted authority reports storage_failure with its own count.
    expect(result.deleted).toEqual({
      requestLedger: 1,
      diagnostics: 0,
      capture: 1,
    });
    expect(result.failures).toEqual([
      {
        authority: "diagnostics",
        code: "storage_failure",
        deleted: 0,
      },
    ]);
    // The committed authorities really deleted; the faulted one kept rows.
    expect(ledger.countRange()).toBe(0);
    expect(diagnostics.countRange()).toBe(1);
    expect(capture.countRange()).toBe(0);
    // The failure is degraded, visible only as fixed text (no fault canary).
    expect(persistence.state().auditUnavailable).toBe(true);
    expect(
      persistence.ring().map((record) => record.text).join(" "),
    ).not.toContain("canary-554433");
    // Re-running the same range is deterministic: the idempotent authorities
    // delete nothing more, the faulted one fails again (reproducible order).
    const again = await controlPlaneClient.executeHistoryDelete({ range: "all" });
    expect(again.outcome).toBe("confirmation_required");
    if (again.outcome !== "confirmation_required") return;
    const rerun = await controlPlaneClient.confirmHistoryDelete(
      again.actionId as string,
    );
    expect(rerun.outcome).toBe("partial_failure");
    await controlPlaneClient.close();
  });

  it("deletion cannot touch settings, models, aliases, credentials, tokens, or journals (byte-compare)", async () => {
    const fx = await fixture();
    // Unrelated LuckyToken-owned authorities, byte-snapshotted before and
    // after the deletion.
    const unrelated = [
      join(fx.root, "settings.json"),
      join(fx.root, "models.json"),
      join(fx.root, "model-aliases.json"),
      join(fx.root, "auth.json"),
      join(fx.root, "client-auth", "anthropic-messages.json"),
      join(fx.root, "state", "failure-journal.jsonl"),
    ];
    await mkdir(join(fx.root, "client-auth"), { recursive: true });
    await mkdir(join(fx.root, "state"), { recursive: true });
    const contents = new Map<string, string>();
    for (const [index, path] of unrelated.entries()) {
      await writeFile(path, `unrelated-content-${index}`, "utf8");
      contents.set(path, await readFile(path, "utf8"));
    }
    const controlPlaneClient = await fx.client();
    const gate = await controlPlaneClient.executeHistoryDelete({ range: "all" });
    expect(gate.outcome).toBe("confirmation_required");
    if (gate.outcome !== "confirmation_required") return;
    const result = await controlPlaneClient.confirmHistoryDelete(
      gate.actionId as string,
    );
    expect(result.outcome).toBe("completed");
    for (const path of unrelated) {
      expect(await readFile(path, "utf8")).toBe(contents.get(path));
    }
    // The three store authorities were the only thing deleted.
    expect(fx.ledger.countRange()).toBe(0);
    expect(fx.diagnostics.countRange()).toBe(0);
    expect(fx.capture.countRange()).toBe(0);
  });

  it("deleting all capture history keeps eviction tombstones (a deleted request stays distinguishable from no-capture)", async () => {
    const fx = await fixture();
    const now = Date.now;
    void now;
    const evicting = await createDeepCaptureStoreFactory({
      configuration: {
        directory: join(fx.root, "capture-evict"),
        maxCaptureBytes: 1024 * 1024,
        retentionAgeMs: 0,
        maxCaptures: 1_000,
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
    expect(evicting.query({ requestId: evictedId }).state).toBe("expired");
    // The meta table survives: the store reopens and stays queryable.
    evicting.close();
    stores.splice(stores.indexOf(evicting), 1);
    const reopened = await createDeepCaptureStoreFactory({
      configuration: {
        directory: join(fx.root, "capture-evict"),
        maxCaptureBytes: 1024 * 1024,
        retentionAgeMs: 0,
        maxCaptures: 1_000,
      },
      now: () => 1_700_000_100_000,
      scrub: (value) => value,
    }).open();
    stores.push(reopened);
    expect(reopened.schemaVersion).toBe(1);
  });
});
