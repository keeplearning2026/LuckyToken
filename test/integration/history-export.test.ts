import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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
import {
  createPersistenceDegradationAuthority,
} from "../../src/persistence-degradation/index.js";
import type { PersistenceDegradationAuthority } from "../../src/persistence-degradation/index.js";
import { SENSITIVE_MARKER_LINE } from "../../src/history/index.js";

/**
 * Ticket 23 public seam: the versioned export workflow through the real
 * Control Plane. Default exports exclude raw capture and report the
 * exclusion; sensitive capture needs a second explicit confirmation and
 * marks the artifact; universal redaction keeps every canary out of every
 * artifact byte; publication is atomic (never partial), path safety and
 * overwrite consent are enforced, and source faults/cancellation never
 * publish.
 */

const CLIENT_SESSION = "20000000-0000-4000-8000-000000000031";
const EFFECTIVE_SESSION = "30000000-0000-4000-8000-000000000032";
/** Known-value canary: the attached scrubber must remove it everywhere. */
const KNOWN_CANARY = "known-secret-value-42";
const HEADER_CANARY = "capture-header-canary-5555";
const BODY_KEY_CANARY = "body-key-canary-1111";
const BODY_TEXT_CANARY = "sk-body-canary-2222";
const BENIGN_TEXT = "plain diagnostic text survives";

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
  readonly ownedRoot: string;
  readonly exportRoot: string;
  readonly ledger: RequestLedgerStore;
  readonly diagnostics: RuntimeDiagnosticsStore;
  readonly capture: DeepCaptureStore;
  readonly persistence: PersistenceDegradationAuthority;
  readonly destination: (name: string) => string;
  readonly artifactText: (name: string) => Promise<string>;
}

let nextId = 0;

describe("History export workflow through the Control Plane (Ticket 23)", () => {
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
  function endpoint(): ControlPlaneEndpoint {
    nextId += 1;
    return {
      address: `\\\\.\\pipe\\ticket-23-export-${process.pid}-${nextId}`,
      capability: `ticket-23-export-capability-${String(nextId).padStart(20, "0")}`,
    };
  }

  async function fixture(): Promise<Fixture> {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-t23-export-"));
    roots.push(root);
    const ownedRoot = join(root, "owned");
    const exportRoot = join(root, "exports");
    await mkdir(exportRoot, { recursive: true });
    const now = advancingClock();
    const scrub = (value: string) =>
      value.includes(KNOWN_CANARY) ? value.replaceAll(KNOWN_CANARY, "[REDACTED]") : value;
    const diagnostics = await createRuntimeDiagnosticsStoreFactory({
      configuration: { directory: join(ownedRoot, "diagnostics") },
      now,
      scrub,
    }).open();
    stores.push(diagnostics);
    diagnostics.attachScrub(scrub);
    diagnostics.append({
      level: "warning",
      text: `${BENIGN_TEXT} ${KNOWN_CANARY}`,
      requestId: "req-1",
      details: { note: "first" },
    });
    diagnostics.append({ level: "info", text: "second record" });
    const ledger = await createRequestLedgerStoreFactory({
      configuration: { directory: join(ownedRoot, "ledger") },
      now,
      scrub,
      createRequestId: requestId,
    }).open();
    stores.push(ledger);
    ledger.attachScrub(scrub);
    for (let index = 0; index < 3; index += 1) {
      const entry = ledger.begin("anthropic-messages");
      entry.authorized({
        effectiveSessionId: EFFECTIVE_SESSION,
        ...(index === 0 ? { clientSessionId: CLIENT_SESSION } : {}),
        ...(index === 0 ? { projectDir: "C:\\fixture\\project" } : {}),
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
    }
    const capture = await createDeepCaptureStoreFactory({
      configuration: {
        directory: join(ownedRoot, "capture"),
        maxCaptureBytes: 1024 * 1024,
        retentionAgeMs: 60 * 60 * 1000,
        maxCaptures: 1_000,
      },
      now,
      scrub,
    }).open();
    stores.push(capture);
    capture.attachScrub(scrub);
    capture.append({
      requestId: requestId(),
      protocolId: "anthropic-messages",
      acceptedAt: 1_700_000_000_000,
      requestBody: JSON.stringify({
        api_key: BODY_KEY_CANARY,
        prompt: "hello",
      }),
      responseBody: `${BODY_TEXT_CANARY} plain response text`,
      requestHeaders: Object.freeze({
        authorization: `Bearer ${HEADER_CANARY}`,
        "content-type": "application/json",
      }),
      responseHeaders: Object.freeze({ "content-type": "text/plain" }),
      timing: Object.freeze([Object.freeze({ stage: "accepted", time: 1 })]),
      complete: true,
    });
    const persistence = createPersistenceDegradationAuthority({
      now,
      stderr: () => undefined,
    });
    const authority = createHistoryAuthority({
      sources: { ledger, diagnostics, capture },
      persistence,
      ownedRoots: [ownedRoot],
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
      ownedRoot,
      exportRoot,
      ledger,
      diagnostics,
      capture,
      persistence,
      destination: (name) => join(exportRoot, name),
      artifactText: async (name) => {
        const text = await readFile(join(exportRoot, name), "utf8");
        return text.startsWith("#") ? text.slice(text.indexOf("\n") + 1) : text;
      },
    };
  }

  async function client(): Promise<ControlPlaneClient> {
    const host = hosts[hosts.length - 1]!;
    const controlPlaneClient = await connectControlPlane(host.endpoint, {
      createRequestId: () => `t23-export-${++nextId}`,
      pipeConnector: createNodePipeTransport(),
    });
    await controlPlaneClient.hello(1);
    return controlPlaneClient;
  }

  it("default export excludes capture with an explicit reason, streams both structured sections, and keeps every canary out of the artifact", async () => {
    const fx = await fixture();
    const controlPlaneClient = await client();
    const query = await controlPlaneClient.queryHistory();
    expect(query.counts).toEqual({
      requestLedger: 3,
      diagnostics: 2,
      capture: 1,
    });
    const result = await controlPlaneClient.executeHistoryExport({
      range: "all",
      capture: "excluded",
      destinationPath: fx.destination("default.json"),
      overwrite: false,
    });
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.destinationPath).toBe(fx.destination("default.json"));
    expect(result.manifest).toMatchObject({
      manifestVersion: 1,
      sensitive: false,
      auditUnavailable: false,
      sources: {
        requestLedger: { schemaVersion: 2, count: 3 },
        diagnostics: { schemaVersion: 1, count: 2 },
        capture: { included: false, reason: "excluded-by-default" },
      },
    });
    const raw = await readFile(fx.destination("default.json"), "utf8");
    // The default export carries no sensitivity marker.
    expect(raw.startsWith(SENSITIVE_MARKER_LINE)).toBe(false);
    const artifact = JSON.parse(
      raw.startsWith("#") ? raw.slice(raw.indexOf("\n") + 1) : raw,
    ) as {
      manifestVersion: number;
      sensitive: boolean;
      sections: { requestLedger: unknown[]; diagnostics: unknown[] };
      sources: { capture: { included: false; reason: string } };
    };
    expect(artifact.manifestVersion).toBe(1);
    expect(artifact.sensitive).toBe(false);
    expect(artifact.sections.requestLedger).toHaveLength(3);
    expect(artifact.sections.diagnostics).toHaveLength(2);
    expect(artifact.sources.capture).toEqual({
      included: false,
      reason: "excluded-by-default",
    });
    expect("capture" in artifact.sections).toBe(false);
    // Redaction canaries are absent from every artifact byte; benign text
    // survives.
    expect(raw).not.toContain(KNOWN_CANARY);
    expect(raw).not.toContain(HEADER_CANARY);
    expect(raw).not.toContain(BODY_KEY_CANARY);
    expect(raw).not.toContain(BODY_TEXT_CANARY);
    expect(raw).toContain(BENIGN_TEXT);
    expect(raw).toContain("alpha");
  });

  it("marks an otherwise readable export audit-unavailable from the live persistence authority", async () => {
    const fx = await fixture();
    fx.persistence.reportFailure("requestLedger");
    const controlPlaneClient = await client();

    const result = await controlPlaneClient.executeHistoryExport({
      range: "all",
      capture: "excluded",
      destinationPath: fx.destination("degraded.json"),
      overwrite: false,
    });

    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.manifest?.auditUnavailable).toBe(true);
    const artifact = JSON.parse(await fx.artifactText("degraded.json")) as {
      audit: { unavailable: boolean };
    };
    expect(artifact.audit.unavailable).toBe(true);
    await controlPlaneClient.close();
  });

  it("sensitive capture requires a second explicit confirmation, then marks the artifact sensitive and still redacts", async () => {
    const fx = await fixture();
    const controlPlaneClient = await client();
    const destinationPath = fx.destination("sensitive.json");
    const command = {
      range: "all" as const,
      capture: "included" as const,
      destinationPath,
      overwrite: false,
    };
    const gate = await controlPlaneClient.executeHistoryExport(command);
    expect(gate.outcome).toBe("confirmation_required");
    if (gate.outcome !== "confirmation_required") return;
    expect(gate.actionId).toBeTruthy();
    expect(gate.confirmationMessage).toContain("raw capture");
    // The gated export created nothing.
    await expect(readFile(destinationPath, "utf8")).rejects.toThrow();
    const executed = await controlPlaneClient.confirmHistoryExport(
      gate.actionId as string,
    );
    expect(executed.outcome).toBe("ok");
    if (executed.outcome !== "ok") return;
    expect(executed.manifest?.sensitive).toBe(true);
    expect(executed.manifest?.sources.capture).toMatchObject({
      included: true,
      count: 1,
    });
    const raw = await readFile(destinationPath, "utf8");
    expect(raw.startsWith(SENSITIVE_MARKER_LINE)).toBe(true);
    const artifact = JSON.parse(
      raw.slice(raw.indexOf("\n") + 1),
    ) as {
      sensitive: boolean;
      sections: { capture: Array<{ responseBody?: string; requestBody?: string }> };
    };
    expect(artifact.sensitive).toBe(true);
    expect(artifact.sections.capture).toHaveLength(1);
    expect(artifact.sections.capture[0]?.responseBody).toContain(
      "plain response text",
    );
    // Universal redaction still holds in the sensitive mode: no canary in
    // any byte, including body-embedded and header values.
    for (const canary of [
      KNOWN_CANARY,
      HEADER_CANARY,
      BODY_KEY_CANARY,
      BODY_TEXT_CANARY,
    ]) {
      expect(raw).not.toContain(canary);
    }
    expect(raw).not.toContain("capture-header-canary");
  });

  it("confirmation actionIds are single-use and a mismatched confirm is rejected", async () => {
    const fx = await fixture();
    const controlPlaneClient = await client();
    await expect(
      controlPlaneClient.confirmHistoryExport("no-such-action"),
    ).rejects.toThrow();
    const gate = await controlPlaneClient.executeHistoryExport({
      range: "all",
      capture: "included",
      destinationPath: fx.destination("single-use.json"),
      overwrite: false,
    });
    expect(gate.outcome).toBe("confirmation_required");
    if (gate.outcome !== "confirmation_required") return;
    const actionId = gate.actionId as string;
    const first = await controlPlaneClient.confirmHistoryExport(actionId);
    expect(first.outcome).toBe("ok");
    await expect(
      controlPlaneClient.confirmHistoryExport(actionId),
    ).rejects.toThrow();
  });

  it("executes a sensitive confirmation from a fresh one-shot connection after the gate connection closes", async () => {
    const fx = await fixture();
    const gateClient = await client();
    const gate = await gateClient.executeHistoryExport({
      range: "all",
      capture: "included",
      destinationPath: fx.destination("fresh-confirmation.json"),
      overwrite: false,
    });
    expect(gate.outcome).toBe("confirmation_required");
    if (gate.outcome !== "confirmation_required" || gate.actionId === undefined) return;
    await gateClient.close();

    const confirmationClient = await client();
    const completed = await confirmationClient.confirmHistoryExport(gate.actionId);

    expect(completed.outcome).toBe("ok");
    await expect(
      readFile(fx.destination("fresh-confirmation.json"), "utf8"),
    ).resolves.toContain("\"sensitive\": true");
  });

  it("enforces overwrite consent, path safety, and directory rejection without publishing", async () => {
    const fx = await fixture();
    const controlPlaneClient = await client();
    const existing = fx.destination("existing.json");
    await writeFile(existing, "keep me", "utf8");
    const refused = await controlPlaneClient.executeHistoryExport({
      range: "all",
      capture: "excluded",
      destinationPath: existing,
      overwrite: false,
    });
    expect(refused.outcome).toBe("failed");
    if (refused.outcome !== "failed") return;
    expect(refused.failure?.code).toBe("destination_exists");
    expect(await readFile(existing, "utf8")).toBe("keep me");
    const replaced = await controlPlaneClient.executeHistoryExport({
      range: "all",
      capture: "excluded",
      destinationPath: existing,
      overwrite: true,
    });
    expect(replaced.outcome).toBe("ok");
    const relative = await controlPlaneClient.executeHistoryExport({
      range: "all",
      capture: "excluded",
      destinationPath: "relative/path.json",
      overwrite: false,
    });
    expect(relative.outcome).toBe("failed");
    if (relative.outcome !== "failed") return;
    expect(relative.failure?.code).toBe("invalid_destination");
    const insideOwned = await controlPlaneClient.executeHistoryExport({
      range: "all",
      capture: "excluded",
      destinationPath: join(fx.ownedRoot, "nope.json"),
      overwrite: false,
    });
    expect(insideOwned.outcome).toBe("failed");
    if (insideOwned.outcome !== "failed") return;
    expect(insideOwned.failure?.code).toBe("invalid_destination");
    const deviceName = await controlPlaneClient.executeHistoryExport({
      range: "all",
      capture: "excluded",
      destinationPath: join(fx.exportRoot, "CON"),
      overwrite: false,
    });
    expect(deviceName.outcome).toBe("failed");
    if (deviceName.outcome !== "failed") return;
    expect(deviceName.failure?.code).toBe("invalid_destination");
    const asDirectory = await mkdir(fx.destination("adir"), { recursive: true });
    void asDirectory;
    const directoryResult = await controlPlaneClient.executeHistoryExport({
      range: "all",
      capture: "excluded",
      destinationPath: fx.destination("adir"),
      overwrite: true,
    });
    expect(directoryResult.outcome).toBe("failed");
    if (directoryResult.outcome !== "failed") return;
    expect(directoryResult.failure?.code).toBe("invalid_destination");
  });

  it("rejects a destination whose parent junction resolves into a LuckyToken-owned root", async () => {
    const fx = await fixture();
    const controlPlaneClient = await client();
    const junction = join(fx.root, "apparently-external");
    await symlink(fx.ownedRoot, junction, "junction");
    const escapedDestination = join(junction, "must-not-be-created.json");

    const result = await controlPlaneClient.executeHistoryExport({
      range: "all",
      capture: "excluded",
      destinationPath: escapedDestination,
      overwrite: false,
    });

    expect(result.outcome).toBe("failed");
    if (result.outcome !== "failed") return;
    expect(result.failure?.code).toBe("invalid_destination");
    await expect(
      readFile(join(fx.ownedRoot, "must-not-be-created.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("applies the half-open range to export, query, and manifest identically", async () => {
    const fx = await fixture();
    const controlPlaneClient = await client();
    // Each ledger request consumes four clock ticks (begin, executing,
    // terminal, completed), so acceptedAt values are ticks 3, 7, 11.
    const t3 = 1_700_000_003_000;
    const t11 = 1_700_000_011_000;
    const range: HistoryRange = Object.freeze({ fromMs: t3, toMs: t11 });
    const query = await controlPlaneClient.queryHistory(range);
    // Half-open [t3, t11): the tick-3 and tick-7 records are eligible, the
    // tick-11 record (to-exclusive) is not.
    expect(query.counts.requestLedger).toBe(2);
    const result = await controlPlaneClient.executeHistoryExport({
      range,
      capture: "excluded",
      destinationPath: fx.destination("range.json"),
      overwrite: false,
    });
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.manifest?.sources.requestLedger.count).toBe(2);
    const raw = await readFile(fx.destination("range.json"), "utf8");
    const artifact = JSON.parse(raw) as {
      range: { fromMs: number; toMs: number };
      sections: { requestLedger: Array<{ acceptedAt: number }> };
    };
    expect(artifact.range).toEqual({ fromMs: t3, toMs: t11 });
    const accepted = artifact.sections.requestLedger.map(
      (record) => record.acceptedAt,
    );
    expect(accepted).toContain(t3);
    expect(accepted).toContain(1_700_000_007_000);
    expect(accepted).not.toContain(t11);
  });

  it("exports no records for an empty half-open range and matches the zero-count preview", async () => {
    const fx = await fixture();
    const controlPlaneClient = await client();
    const emptyRange: HistoryRange = Object.freeze({
      fromMs: 1_700_000_003_000,
      toMs: 1_700_000_003_000,
    });

    const preview = await controlPlaneClient.queryHistory(emptyRange);
    expect(preview.counts).toEqual({
      requestLedger: 0,
      diagnostics: 0,
      capture: 0,
    });
    const result = await controlPlaneClient.executeHistoryExport({
      range: emptyRange,
      capture: "included",
      destinationPath: fx.destination("empty-range.json"),
      overwrite: false,
    });
    expect(result.outcome).toBe("confirmation_required");
    if (result.outcome !== "confirmation_required" || result.actionId === undefined) return;
    const completed = await controlPlaneClient.confirmHistoryExport(result.actionId);
    expect(completed.outcome).toBe("ok");
    if (completed.outcome !== "ok") return;
    expect(completed.manifest?.sources.requestLedger.count).toBe(0);
    expect(completed.manifest?.sources.diagnostics.count).toBe(0);
    expect(completed.manifest?.sources.capture).toMatchObject({
      included: true,
      count: 0,
    });
    const raw = await readFile(fx.destination("empty-range.json"), "utf8");
    const artifactText = raw.startsWith("#") ? raw.slice(raw.indexOf("\n") + 1) : raw;
    const artifact = JSON.parse(artifactText) as {
      sections: {
        requestLedger: unknown[];
        diagnostics: unknown[];
        capture: unknown[];
      };
    };
    expect(artifact.sections).toEqual({
      requestLedger: [],
      diagnostics: [],
      capture: [],
    });
  });

  it("a pre-aborted export is cancelled without publishing", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-t23-cancel-"));
    const now = advancingClock();
    const diagnostics = await createRuntimeDiagnosticsStoreFactory({
      configuration: { directory: join(root, "diagnostics") },
      now,
      scrub: (value) => value,
    }).open();
    diagnostics.attachScrub((value) => value);
    const ledger = await createRequestLedgerStoreFactory({
      configuration: { directory: join(root, "ledger") },
      now,
      scrub: (value) => value,
      createRequestId: requestId,
    }).open();
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
    try {
      const persistence = createPersistenceDegradationAuthority({ now });
      const authority = createHistoryAuthority({
        sources: { ledger, diagnostics, capture },
        persistence,
        ownedRoots: [join(root, "owned")],
        applicationVersion: "0.0.0-test",
        now,
      });
      const destinationPath = join(root, "exports", "cancelled.json");
      const controller = new AbortController();
      controller.abort();
      const result = await authority.handle(
        {
          command: "export",
          range: "all",
          capture: "excluded",
          destinationPath,
          overwrite: false,
        },
        controller.signal,
      );
      expect(result.kind).toBe("export");
      if (result.kind !== "export") return;
      expect(result.result.outcome).toBe("failed");
      if (result.result.outcome !== "failed") return;
      expect(result.result.failure?.code).toBe("cancelled");
      await expect(readFile(destinationPath, "utf8")).rejects.toThrow();
      const entries = await readdir(join(root, "exports"));
      expect(entries).toEqual([]);
    } finally {
      ledger.close();
      capture.close();
      diagnostics.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("History export authority-level fault and budget seams (Ticket 23)", () => {
  it("fails with export_too_large under a bounded budget and removes the temp file", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-t23-budget-"));
    const now = advancingClock();
    const diagnostics = await createRuntimeDiagnosticsStoreFactory({
      configuration: { directory: join(root, "diagnostics") },
      now,
      scrub: (value) => value,
    }).open();
    diagnostics.attachScrub((value) => value);
    diagnostics.append({
      level: "info",
      text: "x".repeat(500),
    });
    const ledger = await createRequestLedgerStoreFactory({
      configuration: { directory: join(root, "ledger") },
      now,
      scrub: (value) => value,
      createRequestId: requestId,
    }).open();
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
    try {
      const persistence = createPersistenceDegradationAuthority({ now });
      const authority = createHistoryAuthority({
        sources: { ledger, diagnostics, capture },
        persistence,
        ownedRoots: [join(root, "owned")],
        applicationVersion: "0.0.0-test",
        now,
        maxExportBytes: 200,
      });
      const destinationPath = join(root, "exports", "budget.json");
      const result = await authority.handle(
        {
          command: "export",
          range: "all",
          capture: "excluded",
          destinationPath,
          overwrite: false,
        },
        new AbortController().signal,
      );
      expect(result.kind).toBe("export");
      if (result.kind !== "export") return;
      expect(result.result.outcome).toBe("failed");
      if (result.result.outcome !== "failed") return;
      expect(result.result.failure?.code).toBe("export_too_large");
      await expect(readFile(destinationPath, "utf8")).rejects.toThrow();
      const entries = await readdir(join(root, "exports"));
      expect(entries).toEqual([]);
    } finally {
      ledger.close();
      capture.close();
      diagnostics.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports source_unavailable and degradation when a source store faults mid-export", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-t23-source-"));
    const now = advancingClock();
    const diagnostics = await createRuntimeDiagnosticsStoreFactory({
      configuration: { directory: join(root, "diagnostics") },
      now,
      scrub: (value) => value,
    }).open();
    diagnostics.attachScrub((value) => value);
    const ledger = await createRequestLedgerStoreFactory({
      configuration: { directory: join(root, "ledger") },
      now,
      scrub: (value) => value,
      createRequestId: requestId,
    }).open();
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
    try {
      const persistence = createPersistenceDegradationAuthority({ now });
      const faultingLedger: RequestLedgerStore = {
        ...ledger,
        query() {
          throw new Error("ledger read denied canary-fault-667788");
        },
      };
      const authority = createHistoryAuthority({
        sources: { ledger: faultingLedger, diagnostics, capture },
        persistence,
        ownedRoots: [join(root, "owned")],
        applicationVersion: "0.0.0-test",
        now,
        onSourceFailure: (authorityId, fact) =>
          persistence.reportFailure(authorityId, fact),
      });
      const destinationPath = join(root, "exports", "fault.json");
      const result = await authority.handle(
        {
          command: "export",
          range: "all",
          capture: "excluded",
          destinationPath,
          overwrite: false,
        },
        new AbortController().signal,
      );
      expect(result.kind).toBe("export");
      if (result.kind !== "export") return;
      expect(result.result.outcome).toBe("failed");
      if (result.result.outcome !== "failed") return;
      expect(result.result.failure?.code).toBe("source_unavailable");
      // The failure is visible as degraded state, never as fault text.
      expect(persistence.state().auditUnavailable).toBe(true);
      expect(persistence.state().authorities[0]?.authority).toBe(
        "requestLedger",
      );
      const ringText = persistence.ring().map((record) => record.text).join(" ");
      expect(ringText).not.toContain("canary-fault-667788");
      expect(ringText).not.toContain("ledger read denied");
      await expect(readFile(destinationPath, "utf8")).rejects.toThrow();
    } finally {
      ledger.close();
      capture.close();
      diagnostics.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("a count preview source fault returns a bounded zero count and marks audit unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-t23-count-fault-"));
    const now = () => 1_700_000_000_000;
    const diagnostics = await createRuntimeDiagnosticsStoreFactory({
      configuration: { directory: join(root, "diagnostics") },
      now,
      scrub: (value) => value,
    }).open();
    diagnostics.attachScrub((value) => value);
    const ledger = await createRequestLedgerStoreFactory({
      configuration: { directory: join(root, "ledger") },
      now,
      scrub: (value) => value,
      createRequestId: requestId,
    }).open();
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
    let host: RunningControlPlane | undefined;
    try {
      const persistence = createPersistenceDegradationAuthority({
        now,
        stderr: () => undefined,
      });
      const faultingLedger: RequestLedgerStore = {
        ...ledger,
        countRange() {
          throw new Error("ledger count failed secret-canary-778899");
        },
      };
      const authority = createHistoryAuthority({
        sources: { ledger: faultingLedger, diagnostics, capture },
        persistence,
        ownedRoots: [join(root, "owned")],
        applicationVersion: "0.0.0-test",
        now,
        onSourceFailure: (authorityId, fact) =>
          persistence.reportFailure(authorityId, fact),
      });
      host = await startControlPlane({
        endpoint: {
          address: `\\\\.\\pipe\\ticket-23-count-fault-${process.pid}-${++nextId}`,
          capability: `ticket-23-count-fault-capability-${String(nextId).padStart(20, "0")}`,
        },
        application: { id: "luckytoken", version: "test" },
        initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
        pipeServerFactory: createNodePipeTransport(),
        access: nodePipeFallbackAccess,
        historyCommandHandler: (command, signal) =>
          authority.handle(command, signal),
      });
      const controlPlaneClient = await connectControlPlane(host.endpoint, {
        createRequestId: () => `t23-count-fault-${++nextId}`,
        pipeConnector: createNodePipeTransport(),
      });
      await controlPlaneClient.hello(1);

      const query = await controlPlaneClient.queryHistory();

      expect(query.counts.requestLedger).toBe(0);
      expect(persistence.state()).toMatchObject({
        auditUnavailable: true,
        authorities: [{ authority: "requestLedger" }],
      });
      const fallbackText = JSON.stringify(persistence.ring());
      expect(fallbackText).not.toContain("secret-canary-778899");
      expect(fallbackText).not.toContain("ledger count failed");
      await controlPlaneClient.close();
    } finally {
      await host?.close();
      ledger.close();
      capture.close();
      diagnostics.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("a host without a history handler answers unknown_command (legacy clients unaffected)", async () => {
    const host = await startControlPlane({
      endpoint: {
        address: `\\\\.\\pipe\\ticket-23-legacy-${process.pid}`,
        capability: `ticket-23-legacy-capability-${String(1).padStart(20, "0")}`,
      },
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      pipeServerFactory: createNodePipeTransport(),
      access: nodePipeFallbackAccess,
    });
    try {
      const controlPlaneClient = await connectControlPlane(host.endpoint, {
        createRequestId: () => `t23-legacy-${++nextId}`,
        pipeConnector: createNodePipeTransport(),
      });
      await controlPlaneClient.hello(1);
      await expect(
        controlPlaneClient.queryHistory(),
      ).rejects.toThrow(/unknown_command/);
      const status = await controlPlaneClient.getStatus();
      expect(status.modelDataPlane).toBe("stopped");
      await controlPlaneClient.close();
    } finally {
      await host.close();
    }
  });
});
