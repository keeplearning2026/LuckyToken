import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  connectControlPlane,
  createNodePipeTransport,
  nodePipeFallbackAccess,
  startControlPlane,
  type PersistenceProjection,
  type RunningControlPlane,
} from "@luckytoken/application-control-plane/control-plane";
import {
  createRuntimeDiagnosticsStoreFactory,
  type RuntimeDiagnosticsStore,
} from "../../src/runtime-diagnostics/index.js";
import { createPersistenceDegradationAuthority } from "../../src/persistence-degradation/index.js";
import {
  createUnavailableDiagnosticsStore,
  createUnavailableRequestLedgerStore,
  observeDiagnosticsStore,
} from "../../src/persistence-degradation/index.js";

/**
 * Ticket 23 persistence-degradation state machine through its public seams:
 * fixed sanitized Criticals to stderr and the bounded in-memory ring, no
 * recursive diagnostics writes, acknowledgment that never claims recovery,
 * recovery demonstrated only by a successful store write, the projection on
 * every status snapshot, and the fail-open fallback stores.
 */

function fixedText(authority: string): string {
  return `LuckyToken Critical: ${authority} persistence unavailable; audit guarantee unavailable until recovery.`;
}

const REQUEST_ONE = "11111111-1111-4111-8111-111111111111";
const REQUEST_THREE = "33333333-3333-4333-8333-333333333333";
const DIAGNOSTICS_REQUEST = "44444444-4444-4444-8444-444444444444";
const LEDGER_REQUEST = "55555555-5555-4555-8555-555555555555";
const CORRELATION_REQUEST = "66666666-6666-4666-8666-666666666666";
const MESSAGE_HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("Persistence degradation authority (Ticket 23)", () => {
  it("contains failures from stderr and state observers so fallback reporting cannot escape into serving", () => {
    const authority = createPersistenceDegradationAuthority({
      stderr: () => {
        throw new Error("stderr sink failed secret-canary-121212");
      },
      onStateChange: () => {
        throw new Error("state observer failed secret-canary-343434");
      },
      now: () => 1_700_000_000_000,
    });
    authority.subscribe(() => {
      throw new Error("subscriber failed secret-canary-565656");
    });

    expect(() => authority.reportFailure("capture")).not.toThrow();
    expect(authority.state().auditUnavailable).toBe(true);
    expect(authority.ring()).toHaveLength(1);
    expect(JSON.stringify(authority.ring())).not.toMatch(
      /secret-canary|sink failed|observer failed|subscriber failed/u,
    );
    expect(() => authority.acknowledge()).not.toThrow();
    expect(() => authority.reportRecovery("capture")).not.toThrow();
    expect(authority.state().auditUnavailable).toBe(false);
  });

  it("drops a non-authoritative request correlation value from every fallback sink", () => {
    const secretCanary = "lt_bare_secret_canary_998877665544";
    const stderrLines: string[] = [];
    const authority = createPersistenceDegradationAuthority({
      stderr: (line) => stderrLines.push(line),
      now: () => 1_700_000_000_000,
    });

    authority.reportFailure("requestLedger", { requestId: secretCanary });

    expect(stderrLines.join(" ")).not.toContain(secretCanary);
    expect(JSON.stringify(authority.ring())).not.toContain(secretCanary);
  });

  it("writes fixed sanitized Criticals to stderr and the bounded ring, never fault text", () => {
    const stderrLines: string[] = [];
    const authority = createPersistenceDegradationAuthority({
      stderr: (line) => stderrLines.push(line),
      now: () => 1_700_000_000_000,
      capacity: 3,
    });
    // Inject a fault whose message is a secret canary: it must never reach
    // stderr, the ring, or the state.
    authority.reportFailure("requestLedger", {
      requestId: REQUEST_ONE,
      messageHash: "hash-canary-002",
    });
    authority.reportFailure("capture", { requestId: REQUEST_THREE });
    authority.reportFailure("requestLedger");
    expect(stderrLines).toEqual([
      `${fixedText("request-ledger")} (request: ${REQUEST_ONE})\n`,
      `${fixedText("deep-capture")} (request: ${REQUEST_THREE})\n`,
      `${fixedText("request-ledger")}\n`,
    ]);
    const ring = authority.ring();
    expect(ring).toHaveLength(3);
    expect(ring[0]?.level).toBe("critical");
    expect(ring[0]?.text).toBe(fixedText("request-ledger"));
    const joined = ring.map((record) => JSON.stringify(record)).join(" ");
    // Fault text and unkeyed hashes never reach the fallback surfaces.
    expect(joined).not.toContain("hash-canary-002");
    expect(joined).not.toContain("fault");
    expect(authority.state()).toMatchObject({
      auditUnavailable: true,
      acknowledged: false,
      authorities: [
        { authority: "requestLedger", since: 1_700_000_000_000 },
        { authority: "capture", since: 1_700_000_000_000 },
      ],
    });
  });

  it("bounds the in-memory ring at capacity, newest first", () => {
    const authority = createPersistenceDegradationAuthority({
      capacity: 3,
      stderr: () => undefined,
      now: () => 1,
    });
    for (let index = 0; index < 6; index += 1) {
      authority.reportFailure("diagnostics");
    }
    expect(authority.ring()).toHaveLength(3);
    const ids = authority.ring().map((record) => record.id);
    // The newest records survive; ids increase monotonically.
    expect(ids).toEqual([6, 5, 4]);
  });

  it("never re-enters a failed store: a diagnostics failure appends nothing, a ledger failure appends exactly one fixed Critical", () => {
    const appended: unknown[] = [];
    const diagnosticsStore = {
      append: (draft: unknown) => {
        appended.push(draft);
        return { id: appended.length, ...(draft as object) };
      },
    } as unknown as RuntimeDiagnosticsStore;
    const authority = createPersistenceDegradationAuthority({
      stderr: () => undefined,
      now: () => 1,
      diagnosticsStore,
    });
    authority.reportFailure("diagnostics", { requestId: DIAGNOSTICS_REQUEST });
    // The diagnostics failure is terminal at stderr + ring: no recursive
    // append into the (failed) diagnostics store.
    expect(appended).toHaveLength(0);
    authority.reportFailure("requestLedger", {
      requestId: LEDGER_REQUEST,
      messageHash: MESSAGE_HASH,
    });
    expect(appended).toHaveLength(1);
    const record = appended[0] as {
      level: string;
      text: string;
      requestId: string;
      details: { messageHash: string };
    };
    expect(record.level).toBe("critical");
    expect(record.text).toBe(
      `${fixedText("request-ledger")} (request: ${LEDGER_REQUEST})`,
    );
    expect(record.requestId).toBe(LEDGER_REQUEST);
    expect(record.details).toEqual({ messageHash: MESSAGE_HASH });
  });

  it("acknowledgment suppresses urgency but never claims recovery; only a successful write recovers", () => {
    const authority = createPersistenceDegradationAuthority({
      stderr: () => undefined,
      now: () => 1,
    });
    authority.reportFailure("capture");
    expect(authority.acknowledge()).toBe("ok");
    const state = authority.state();
    expect(state.auditUnavailable).toBe(true);
    expect(state.acknowledged).toBe(true);
    // The projection is still present after acknowledgment.
    expect(authority.projection()).toMatchObject({
      auditUnavailable: true,
      acknowledged: true,
      authorities: [{ authority: "capture", since: 1 }],
    });
    // Acknowledgment never clears a failing authority.
    authority.reportFailure("capture");
    expect(authority.state().auditUnavailable).toBe(true);
    // Recovery is demonstrated by a successful write.
    authority.reportRecovery("capture");
    expect(authority.state().auditUnavailable).toBe(false);
    expect(authority.projection()).toBeUndefined();
    expect(authority.acknowledge()).toBe("unchanged");
    // Recovery for an authority that never failed is a no-op (no phantom
    // transition).
    authority.reportRecovery("requestLedger");
    expect(authority.state().auditUnavailable).toBe(false);
  });

  it("notifies subscribers on every transition", () => {
    const states: Array<{ auditUnavailable: boolean; acknowledged: boolean }> =
      [];
    const authority = createPersistenceDegradationAuthority({
      stderr: () => undefined,
      now: () => 1,
      onStateChange: (state) =>
        states.push({
          auditUnavailable: state.auditUnavailable,
          acknowledged: state.acknowledged,
        }),
    });
    authority.reportFailure("requestLedger");
    authority.acknowledge();
    authority.reportRecovery("requestLedger");
    expect(states).toEqual([
      { auditUnavailable: true, acknowledged: false },
      { auditUnavailable: true, acknowledged: true },
      { auditUnavailable: false, acknowledged: false },
    ]);
  });
});

describe("Persistence degradation store watchers and fallbacks (Ticket 23)", () => {
  it("observeDiagnosticsStore reports genuine faults and demonstrates recovery on the next successful append", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-t23-watch-"));
    const inner = await createRuntimeDiagnosticsStoreFactory({
      configuration: { directory: join(root, "diag") },
      now: () => 1,
      scrub: (value) => value,
    }).open();
    inner.attachScrub((value) => value);
    try {
      const authority = createPersistenceDegradationAuthority({
        stderr: () => undefined,
        now: () => 1,
      });
      let faulted = false;
      const faulting: RuntimeDiagnosticsStore = {
        ...inner,
        append(draft) {
          if (faulted) throw new Error("diag write denied canary-909090");
          return inner.append(draft);
        },
      };
      const observed = observeDiagnosticsStore(faulting, authority);
      // The composition attaches the credential-owner scrubber through the
      // observed store; until then appends fail closed without reporting.
      observed.attachScrub((value) => value);
      observed.append({ level: "info", text: "first" });
      expect(authority.state().auditUnavailable).toBe(false);
      faulted = true;
      expect(() => observed.append({ level: "info", text: "second" })).toThrow();
      expect(authority.state().auditUnavailable).toBe(true);
      // The ring carries only the fixed Critical; never the fault text.
      expect(
        authority.ring().map((record) => record.text).join(" "),
      ).not.toContain("canary-909090");
      expect(
        authority.ring().map((record) => record.text).join(" "),
      ).toContain("audit guarantee unavailable");
      faulted = false;
      observed.append({ level: "info", text: "third" });
      expect(authority.state().auditUnavailable).toBe(false);
    } finally {
      inner.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("the fallback diagnostics store serves the bounded ring and drops non-critical appends truthfully", () => {
    const authority = createPersistenceDegradationAuthority({
      stderr: () => undefined,
      now: () => 1_700_000_000_000,
      capacity: 2,
    });
    const fallback = createUnavailableDiagnosticsStore(authority);
    expect(() => fallback.append({ level: "info", text: "too early" })).toThrow(
      /not ready/,
    );
    fallback.attachScrub((value) => value);
    fallback.append({ level: "info", text: "dropped warning" });
    fallback.append({ level: "warning", text: "dropped warning 2" });
    // Only Criticals enter the bounded in-memory authority.
    expect(authority.ring()).toHaveLength(0);
    const critical = fallback.append({
      level: "critical",
      text: "something failed",
      requestId: CORRELATION_REQUEST,
    });
    expect(critical.level).toBe("critical");
    expect(critical.requestId).toBe(CORRELATION_REQUEST);
    // The fixed text is the truthful record; the original text is not
    // persisted, delivered, or queried in this mode.
    expect(critical.text).toContain("audit guarantee unavailable");
    expect(authority.ring()).toHaveLength(1);
    const query = fallback.query({ limit: 10 });
    expect(query.records).toHaveLength(1);
    expect(query.records[0]?.id).toBe(critical.id);
    expect(fallback.countRange()).toBe(0);
    expect(fallback.deleteRange()).toEqual({ deleted: 0 });
    expect(fallback.schemaVersion).toBe(0);
  });

  it("the fallback ledger store keeps minting safe request ids and reports schemaVersion 0", () => {
    const fallback = createUnavailableRequestLedgerStore();
    const entry = fallback.begin("anthropic-messages");
    expect(entry.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    expect(() => entry.terminal("success")).not.toThrow();
    expect(fallback.query(undefined)).toEqual({
      records: [],
      hasMore: false,
    });
    expect(
      fallback.analyze({
        version: 2,
        command: "summary",
        from: 0,
        to: 1,
      }),
    ).toMatchObject({
      version: 2,
      command: "summary",
      totals: { total: 0, totalRequests: 0, participating: 0, excluded: 0 },
    });
    expect(fallback.countRange()).toBe(0);
    expect(fallback.deleteRange()).toEqual({ deleted: 0 });
    expect(fallback.schemaVersion).toBe(0);
  });
});

describe("Audit-unavailable projection on the Control Plane seam (Ticket 23)", () => {
  const hosts: RunningControlPlane[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((host) => host.close()));
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("rides on status snapshots, acknowledges without recovering, and clears on demonstrated recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-t23-proj-"));
    roots.push(root);
    const authority = createPersistenceDegradationAuthority({
      stderr: () => undefined,
      now: () => 1_700_000_000_000,
    });
    authority.reportFailure("requestLedger");
    const host = await startControlPlane({
      endpoint: {
        address: `\\\\.\\pipe\\ticket-23-proj-${process.pid}`,
        capability: `ticket-23-proj-capability-${String(1).padStart(20, "0")}`,
      },
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      pipeServerFactory: createNodePipeTransport(),
      access: nodePipeFallbackAccess,
      persistenceProjection: () => authority.projection(),
      historyCommandHandler: async (command) => {
        if (command.command === "acknowledge") {
          const outcome = authority.acknowledge();
          return { kind: "acknowledge", result: { outcome } };
        }
        throw new Error("unexpected history command");
      },
    });
    hosts.push(host);
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `t23-proj-${Date.now()}`,
      pipeConnector: createNodePipeTransport(),
    });
    await client.hello(2);
    await host.publishStatus({
      modelDataPlane: "stopped",
      provider: "unconfigured",
    });
    const snapshot = await client.getStatus();
    const projection = snapshot.persistence as PersistenceProjection | undefined;
    expect(projection).toBeDefined();
    expect(projection?.auditUnavailable).toBe(true);
    expect(projection?.acknowledged).toBe(false);
    expect(projection?.authorities).toEqual([
      { authority: "requestLedger", since: 1_700_000_000_000 },
    ]);
    // Acknowledgment: the projection stays present and truthful.
    const acknowledged = await client.acknowledgePersistence();
    expect(acknowledged.outcome).toBe("ok");
    await host.publishStatus({
      modelDataPlane: "stopped",
      provider: "unconfigured",
    });
    const afterAck = await client.getStatus();
    expect(afterAck.persistence?.acknowledged).toBe(true);
    expect(afterAck.persistence?.auditUnavailable).toBe(true);
    // Demonstrated recovery removes the projection.
    authority.reportRecovery("requestLedger");
    await host.publishStatus({
      modelDataPlane: "stopped",
      provider: "unconfigured",
    });
    const recovered = await client.getStatus();
    expect(recovered.persistence).toBeUndefined();
    const unchanged = await client.acknowledgePersistence();
    expect(unchanged.outcome).toBe("unchanged");
    await client.close();
  });

  it("strict wire decoding rejects a malformed persistence projection", async () => {
    const host = await startControlPlane({
      endpoint: {
        address: `\\\\.\\pipe\\ticket-23-badproj-${process.pid}`,
        capability: `ticket-23-badproj-capability-${String(1).padStart(20, "0")}`,
      },
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      pipeServerFactory: createNodePipeTransport(),
      access: nodePipeFallbackAccess,
      // Malformed: auditUnavailable false with authorities present.
      persistenceProjection: () =>
        ({
          auditUnavailable: false,
          acknowledged: false,
          authorities: [],
        }) as never,
    });
    hosts.push(host);
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `t23-badproj-${Date.now()}`,
      pipeConnector: createNodePipeTransport(),
    });
    await client.hello(2);
    await host.publishStatus({
      modelDataPlane: "stopped",
      provider: "unconfigured",
    });
    // The malformed projection fails the whole snapshot decode: the client
    // sees a protocol error instead of a lie.
    await expect(client.getStatus()).rejects.toThrow();
    await client.close();
  });
});
