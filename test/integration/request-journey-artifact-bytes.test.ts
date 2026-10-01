import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";
import {
  connectControlPlane, controlPlaneVersion, createNodePipeTransport, nodePipeFallbackAccess,
  startControlPlane,
} from "@token/application-control-plane/control-plane";
import { createDiagnosticsAuthority, parseDiagnosticsConfiguration } from "../../src/diagnostics/index.js";

const location = { phase: "protocol_ingress", step: "capture_client_request_wire" } as const;
const CANARY = "body-secret-canary-original-5b271";

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory()
    ? files(join(directory, entry.name)) : [join(directory, entry.name)]));
  return nested.flat();
}

async function fixture(maxBytes = 4096, all = true, failed = true) {
  const root = await mkdtemp(join(tmpdir(), "Token-artifact-bytes-"));
  const authority = await createDiagnosticsAuthority({
    configuration: parseDiagnosticsConfiguration({ directory: root, maxJsonArtifactBytes: maxBytes }, root),
    journeyCapturePolicy: { snapshot: () => ({ allRequestsEnabled: all, failedRequestsEnabled: failed }) },
  });
  return { root, authority, async close() {
    try { await authority.close(); } finally { await rm(root, { recursive: true, force: true }); }
  } };
}

function begin(authority: Awaited<ReturnType<typeof fixture>>["authority"], requestId: string = randomUUID()) {
  const journey = authority.begin({ requestId, operationCandidate: "model_generation", transport: "in_process",
    method: "POST", path: "/v1/responses", acceptedAt: Date.now(), cancellation: { caller: "active", shutdown: "not_bound" } });
  return { requestId, journey };
}

describe("unredacted complete-byte artifact evidence", () => {
  it.each([
    ["application/json", Buffer.from(`{  "token" : "${CANARY}", "a":1, "a":2 }\r\n`)],
    ["application/problem+json; charset=utf-8", Buffer.from(`{"secret":"${CANARY}",broken`)],
    ["application/x-ndjson", Buffer.from(`{"secret":"${CANARY}"}\r\nnot-json\n`)],
    ["text/event-stream", Buffer.from(`: comment\r\nevent: delta\r\ndata: {"token":\r\ndata: "${CANARY}"}\r\n\r\ndata: incomplete`) ],
    ["application/json", Buffer.from([0x7b, 0xff, 0xfe, 0x7d])],
    ["application/json", Buffer.alloc(0)],
  ])("preserves %s bytes without parsing or UTF-8 normalization", async (mediaType, source) => {
    const f = await fixture();
    try {
      const { requestId, journey } = begin(f.authority);
      const recorder = journey.openArtifact!({ artifactId: "wire", artifactKind: "client_request_wire", mediaType, location });
      for (let offset = 0; offset < source.length; offset += 7) recorder.append(source.subarray(offset, offset + 7));
      recorder.finish({ originalBytes: source.length, complete: true });
      journey.close({ outcome: "success" });
      const detail = await f.authority.getRequestJourney({ requestId });
      expect(detail.artifacts[0]).toMatchObject({ state: "captured", originalBytes: source.length, capturedBytes: source.length, truncated: false });
      expect(detail.artifacts[0]).not.toHaveProperty("redaction");
      const ref = await f.authority.resolveRequestArtifactFile({ requestId, artifactId: "wire" });
      expect(ref.absolutePath.split(/[\\/]/u).at(-3)).toBe(requestId);
      expect(await readFile(ref.absolutePath)).toEqual(source);
      const read = await f.authority.getRequestArtifact({ requestId, artifactId: "wire", offset: 0, limit: 1024 });
      expect(Buffer.from(read.dataBase64, "base64")).toEqual(source);
    } finally { await f.close(); }
  });

  it.each([
    ["image/png", "binary_body_not_persisted"], ["application/pdf", "binary_body_not_persisted"],
    ["text/plain", "unsupported_media_type"], [undefined, "unsupported_media_type"],
  ])("does not persist unsupported %s bodies", async (mediaType, reason) => {
    const f = await fixture();
    try {
      const { requestId, journey } = begin(f.authority);
      const recorder = journey.openArtifact!({ artifactId: "wire", artifactKind: "client_request_wire", ...(mediaType === undefined ? {} : { mediaType }), location });
      recorder.append(Buffer.from(CANARY));
      recorder.finish({ originalBytes: CANARY.length, complete: true });
      journey.close({ outcome: "success" });
      const detail = await f.authority.getRequestJourney({ requestId });
      expect(detail.artifacts[0]).toMatchObject({ state: "unavailable", reason, capturedBytes: 0, truncated: false });
      expect((await files(f.root)).filter((file) => file.endsWith(".part") || file.endsWith(".json"))).toHaveLength(0);
    } finally { await f.close(); }
  });

  it.each(["..", "CON", ".hidden", "request:name"])("rejects unsafe admitted request directory %s without changing its identity", async (requestId) => {
    const f = await fixture();
    try {
      const { journey } = begin(f.authority, requestId);
      journey.observe({ kind: "artifact_observed", artifactId: "wire", artifactKind: "client_request_wire", mediaType: "application/json", state: "captured", bytes: Buffer.from("{}"), location });
      journey.close({ outcome: "success" });
      const detail = await f.authority.getRequestJourney({ requestId });
      expect(detail.requestId).toBe(requestId);
      expect(detail.artifacts[0]).toMatchObject({ state: "unavailable", reason: "invalid_request_id_directory", capturedBytes: 0 });
    } finally { await f.close(); }
  });

  it.each(["abandon", "missing_finish", "count_mismatch", "size_limit"])("does not save a prefix after %s", async (failure) => {
    const f = await fixture(32);
    try {
      const { requestId, journey } = begin(f.authority);
      const recorder = journey.openArtifact!({ artifactId: "wire", artifactKind: "client_request_wire", mediaType: "application/json", location });
      const source = Buffer.from(CANARY + "x".repeat(failure === "size_limit" ? 33 : 0));
      recorder.append(source);
      if (failure === "abandon") recorder.abandon("source_aborted");
      else if (failure !== "missing_finish") recorder.finish({ originalBytes: source.length + (failure === "count_mismatch" ? 1 : 0), complete: true });
      journey.close({ outcome: "failed" });
      const detail = await f.authority.getRequestJourney({ requestId });
      expect(detail.artifacts[0]).toMatchObject({ state: "unavailable", capturedBytes: 0 });
      await expect(f.authority.getRequestArtifact({ requestId, artifactId: "wire", offset: 0, limit: 32 })).rejects.toThrow(/unavailable/u);
      expect((await files(f.root)).some((file) => file.endsWith(".part"))).toBe(false);
    } finally { await f.close(); }
  });

  it.each([false, true])("writes a provisional raw file with all=false, failed=%s, then removes it on successful close", async (failed) => {
    const f = await fixture(4096, false, failed);
    try {
      const { requestId, journey } = begin(f.authority);
      const source = Buffer.from(`{"secret":"${CANARY}"}`);
      const recorder = journey.openArtifact!({ artifactId: "wire", artifactKind: "client_request_wire", mediaType: "application/json", location });
      recorder.append(source);
      recorder.finish({ originalBytes: source.length, complete: true });
      await f.authority.queryRequestJourneys(); // Actor barrier; request is still active.
      const provisional = (await files(f.root)).filter((file) => file.endsWith(".part"));
      expect(provisional).toHaveLength(1);
      expect(await readFile(provisional[0]!)).toEqual(source);
      journey.close({ outcome: "success" });
      const detail = await f.authority.getRequestJourney({ requestId });
      expect(detail.artifacts[0]).toMatchObject({ state: "unavailable", reason: "full_journey_capture_disabled", capturedBytes: 0 });
      expect((await files(f.root)).some((file) => file.endsWith(".part"))).toBe(false);
    } finally { await f.close(); }
  });

  it("round-trips raw canaries through the real Control Plane without putting them in facts or backup", async () => {
    const f = await fixture();
    const transport = createNodePipeTransport();
    const host = await startControlPlane({ endpoint: { address: `\\\\.\\pipe\\Token-raw-${randomUUID()}`, capability: randomUUID().repeat(2) },
      application: { id: "Token", version: "test" }, initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      pipeServerFactory: transport, access: nodePipeFallbackAccess, diagnostics: f.authority });
    const client = await connectControlPlane(host.endpoint, { createRequestId: randomUUID, pipeConnector: transport });
    try {
      await client.hello(controlPlaneVersion);
      const { requestId, journey } = begin(f.authority);
      const bytes = Buffer.from(`{"secret":"${CANARY}"}`);
      journey.observe({ kind: "artifact_observed", artifactId: "wire", artifactKind: "client_request_wire", mediaType: "application/json", state: "captured", bytes, location });
      journey.close({ outcome: "success" });
      const detail = await client.getRequestJourney({ requestId });
      expect(JSON.stringify(detail)).not.toContain(CANARY);
      const read = await client.getRequestArtifact({ requestId, artifactId: "wire", offset: 0, limit: 1024 });
      expect(read.outcome).toBe("ok");
      if (read.outcome !== "ok") throw new Error("artifact read failed");
      expect(Buffer.from(read.result.dataBase64, "base64")).toEqual(bytes);
      const snapshot = await f.authority.createBackupSnapshot(new AbortController().signal);
      expect(Buffer.from(snapshot).includes(Buffer.from(CANARY))).toBe(false);
      for (const file of await files(f.root)) if (file.includes(".sqlite3") || file.endsWith("manifest.json")) {
        expect((await readFile(file)).includes(Buffer.from(CANARY))).toBe(false);
      }
    } finally { await client.close(); await host.close(); await f.close(); }
  });

  it("never reads or mutates v4 while managing v5 and cleaning v5 orphans", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-v5-exclusion-"));
    const oldIndex = join(root, "diagnostics-v4.sqlite3");
    const oldPart = join(root, "full-journeys-v4", ".inflight", "old.part");
    const newPart = join(root, "full-journeys-v5", ".inflight", "orphan.part");
    const sentinel = Buffer.from("opaque old data must never be opened by production");
    await mkdir(join(root, "full-journeys-v4", ".inflight"), { recursive: true });
    await mkdir(join(root, "full-journeys-v5", ".inflight"), { recursive: true });
    await Promise.all([writeFile(oldIndex, sentinel), writeFile(oldPart, sentinel), writeFile(newPart, CANARY)]);
    const authority = await createDiagnosticsAuthority({ configuration: parseDiagnosticsConfiguration({ directory: root, maxArtifactJourneys: 1 }, root),
      journeyCapturePolicy: { snapshot: () => ({ allRequestsEnabled: true, failedRequestsEnabled: true }) } });
    try {
      expect((await authority.queryRequestJourneys()).records).toEqual([]);
      await expect(readFile(newPart)).rejects.toMatchObject({ code: "ENOENT" });
      for (let n = 0; n < 2; n += 1) {
        const { requestId, journey } = begin(authority);
        journey.observe({ kind: "artifact_observed", artifactId: "wire", artifactKind: "client_request_wire", mediaType: "application/json", state: "captured", bytes: Buffer.from("{}"), location });
        journey.close({ outcome: "success" });
        await authority.getRequestJourney({ requestId });
      }
      const snapshot = await authority.createBackupSnapshot(new AbortController().signal);
      expect(Buffer.from(snapshot).includes(sentinel)).toBe(false);
      const snapshotPath = join(root, "inspect.sqlite3");
      await writeFile(snapshotPath, snapshot);
      const db = new DatabaseSync(snapshotPath, { readOnly: true });
      try { expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toMatchObject({ value: 5 }); }
      finally { db.close(); }
      await authority.deleteHistory("all");
      expect(await authority.countHistory("all")).toEqual({ requestJourneys: 0, runtimeEvents: 0 });
      expect(await readFile(oldIndex)).toEqual(sentinel);
      expect(await readFile(oldPart)).toEqual(sentinel);
    } finally { await authority.close(); await rm(root, { recursive: true, force: true }); }
  });
});
