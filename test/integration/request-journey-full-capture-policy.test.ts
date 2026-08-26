import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDiagnosticsAuthority,
  parseDiagnosticsConfiguration,
  type DiagnosticsAuthority,
  type JourneyCapturePolicySource,
} from "../../src/diagnostics/index.js";

const LOCATION = Object.freeze({
  phase: "protocol_ingress",
  step: "capture_client_request_wire",
} as const);

describe("full-journey capture policy at the diagnostics seam", () => {
  const roots: string[] = [];
  const authorities: DiagnosticsAuthority[] = [];

  afterEach(async () => {
    await Promise.allSettled(
      authorities.splice(0).map((authority) => authority.close()),
    );
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function createHarness(policy: JourneyCapturePolicySource) {
    const root = await mkdtemp(join(tmpdir(), "Token-full-capture-policy-"));
    roots.push(root);
    const authority = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration(
        { directory: join(root, "diagnostics") },
        root,
      ),
      journeyCapturePolicy: policy,
    });
    authorities.push(authority);
    return { authority, root };
  }

  function recordJourney(
    authority: DiagnosticsAuthority,
    requestId: string,
    marker: string,
    outcome: "success" | "failed" = "success",
  ): void {
    const observer = authority.begin({
      requestId,
      operationCandidate: "model_generation",
      transport: "in_process",
      method: "POST",
      path: "/v1/responses",
      acceptedAt: Date.now(),
      cancellation: { caller: "active", shutdown: "not_bound" },
    });
    const bytes = Buffer.from(JSON.stringify({ marker }), "utf8");
    observer.observe({
      kind: "artifact_observed",
      artifactId: "client_request_wire",
      artifactKind: "client_request_wire",
      state: "captured",
      mediaType: "application/json",
      bytes,
      originalBytes: bytes.byteLength,
      capturedBytes: bytes.byteLength,
      truncated: false,
      location: LOCATION,
    });
    observer.close({ outcome });
  }

  it("snapshots the setting at P0 and contains a throwing policy source", async () => {
    let allRequestsEnabled = true;
    let failedRequestsEnabled = true;
    let throws = false;
    const { authority, root } = await createHarness({
      snapshot() {
        if (throws) throw new Error("settings authority unavailable");
        return Object.freeze({ allRequestsEnabled, failedRequestsEnabled });
      },
    });

    recordJourney(
      authority,
      "71000000-0000-4000-8000-000000000001",
      "enabled-at-admission",
    );

    const firstJourney = await authority.getRequestJourney({
      requestId: "71000000-0000-4000-8000-000000000001",
    });
    expect(firstJourney.artifacts).toContainEqual(
      expect.objectContaining({
        artifactId: "client_request_wire",
        state: "captured",
      }),
    );

    const first = await authority.getRequestArtifact({
      requestId: "71000000-0000-4000-8000-000000000001",
      artifactId: "client_request_wire",
      offset: 0,
      limit: 256 * 1_024,
    });
    expect(Buffer.from(first.dataBase64, "base64").toString("utf8")).toBe(
      '{\n  "marker": "enabled-at-admission"\n}',
    );

    allRequestsEnabled = false;
    recordJourney(
      authority,
      "71000000-0000-4000-8000-000000000002",
      "disabled-at-admission",
    );
    await expect(
      authority.getRequestArtifact({
        requestId: "71000000-0000-4000-8000-000000000002",
        artifactId: "client_request_wire",
        offset: 0,
        limit: 256 * 1_024,
      }),
    ).rejects.toThrow(/unavailable/iu);

    throws = true;
    expect(() =>
      recordJourney(
        authority,
        "71000000-0000-4000-8000-000000000003",
        "throwing-policy",
      ),
    ).not.toThrow();
    const third = await authority.getRequestJourney({
      requestId: "71000000-0000-4000-8000-000000000003",
    });
    expect(third.artifacts).toContainEqual(
      expect.objectContaining({
        artifactId: "client_request_wire",
        state: "unavailable",
        reason: "full_journey_capture_disabled",
      }),
    );

    recordJourney(
      authority,
      "71000000-0000-4000-8000-000000000007",
      "failure-policy-fallback",
      "failed",
    );
    const fallbackFailure = await authority.getRequestJourney({
      requestId: "71000000-0000-4000-8000-000000000007",
    });
    expect(fallbackFailure.artifacts).toContainEqual(
      expect.objectContaining({
        artifactId: "client_request_wire",
        state: "captured",
      }),
    );

    throws = false;
    failedRequestsEnabled = false;
    recordJourney(
      authority,
      "71000000-0000-4000-8000-000000000008",
      "failure-capture-disabled",
      "failed",
    );
    const disabledFailure = await authority.getRequestJourney({
      requestId: "71000000-0000-4000-8000-000000000008",
    });
    expect(disabledFailure.artifacts).toContainEqual(
      expect.objectContaining({
        artifactId: "client_request_wire",
        state: "unavailable",
        reason: "failed_journey_capture_disabled",
      }),
    );
    expect(
      await readdir(
        join(root, "diagnostics", "full-journeys", ".inflight"),
        { recursive: true },
      ),
    ).toEqual([]);
  });

  it("persists a closed journey as a manifest plus bounded JSON files", async () => {
    const { authority, root } = await createHarness({
      snapshot: () => Object.freeze({
        allRequestsEnabled: true,
        failedRequestsEnabled: true,
      }),
    });
    const requestId = "71000000-0000-4000-8000-000000000004";
    recordJourney(authority, requestId, "folder-artifact");

    await authority.getRequestJourney({ requestId });

    const fullJourneyRoot = join(root, "diagnostics", "full-journeys");
    const dates = (await readdir(fullJourneyRoot, { withFileTypes: true })).filter(
      (entry) => entry.isDirectory() && entry.name !== ".inflight",
    );
    expect(dates).toHaveLength(1);
    const journeyFolders = await readdir(
      join(fullJourneyRoot, dates[0]!.name),
      { withFileTypes: true },
    );
    expect(journeyFolders).toHaveLength(1);
    const journeyDirectory = join(
      fullJourneyRoot,
      dates[0]!.name,
      journeyFolders[0]!.name,
    );
    const manifest = JSON.parse(
      await readFile(join(journeyDirectory, "manifest.json"), "utf8"),
    ) as {
      readonly requestId: string;
      readonly artifacts: ReadonlyArray<{
        readonly artifactId: string;
        readonly file?: string;
      }>;
    };
    expect(manifest.requestId).toBe(requestId);
    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0]?.artifactId).toBe("client_request_wire");
    expect(manifest.artifacts[0]?.file).toMatch(
      /^artifacts\/client-request-wire-[a-f0-9]{8}\.json$/u,
    );
    await expect(authority.resolveRequestArtifactFile({
      requestId,
      artifactId: "client_request_wire",
    })).resolves.toEqual({
      requestId,
      artifactId: "client_request_wire",
      absolutePath: join(journeyDirectory, manifest.artifacts[0]!.file!),
    });
    expect(
      await readFile(join(journeyDirectory, manifest.artifacts[0]!.file!), "utf8"),
    ).toBe('{\n  "marker": "folder-artifact"\n}');
    expect(await readdir(join(root, "diagnostics"))).toContain(
      "diagnostics-v3.sqlite3",
    );
  });

  it("persists redacted JSON event streams in the isolated process", async () => {
    const { authority } = await createHarness({
      snapshot: () => Object.freeze({
        allRequestsEnabled: true,
        failedRequestsEnabled: true,
      }),
    });
    const requestId = "71000000-0000-4000-8000-000000000009";
    const observer = authority.begin({
      requestId,
      operationCandidate: "model_generation",
      transport: "in_process",
      method: "POST",
      path: "/v1/responses",
      acceptedAt: Date.now(),
      cancellation: { caller: "active", shutdown: "not_bound" },
    });
    const source = Buffer.from(
      'event: response.output_text.delta\ndata: {"delta":"safe","token":"ipc-sse-secret"}\n\ndata: [DONE]\n\n',
    );
    const recorder = observer.openArtifact!({
      artifactId: "provider_event_stream",
      artifactKind: "provider_native_upstream_response_wire",
      mediaType: "text/event-stream",
      originalBytes: source.byteLength,
      location: LOCATION,
    });
    recorder.append(source);
    recorder.finish({ originalBytes: source.byteLength, complete: true });
    observer.close({ outcome: "success" });

    const artifact = await authority.getRequestArtifact({
      requestId,
      artifactId: "provider_event_stream",
      offset: 0,
      limit: 256 * 1_024,
    });
    const persisted = Buffer.from(artifact.dataBase64, "base64").toString("utf8");
    expect(persisted).toContain('"delta":"safe"');
    expect(persisted).toContain('"token":"[REDACTED]"');
    expect(persisted).toContain("data: [DONE]");
    expect(persisted).not.toContain("ipc-sse-secret");
  });

  it("captures a naturally streamed 64 MiB JSON artifact without awaiting diagnostics acknowledgements", { timeout: 20_000 }, async () => {
    const { authority } = await createHarness({
      snapshot: () => Object.freeze({
        allRequestsEnabled: true,
        failedRequestsEnabled: true,
      }),
    });
    const requestId = "71000000-0000-4000-8000-000000000005";
    const observer = authority.begin({
      requestId,
      operationCandidate: "model_generation",
      transport: "in_process",
      method: "POST",
      path: "/v1/responses",
      acceptedAt: Date.now(),
      cancellation: { caller: "active", shutdown: "not_bound" },
    });
    const targetBytes = 64 * 1_024 * 1_024;
    const source = Buffer.from(
      JSON.stringify({ payload: "x".repeat(targetBytes - 14) }),
      "utf8",
    );
    expect(source.byteLength).toBe(targetBytes);
    const recorder = observer.openArtifact!({
      artifactId: "large_json",
      artifactKind: "client_request_wire",
      mediaType: "application/json",
      originalBytes: source.byteLength,
      location: LOCATION,
    });
    for (let offset = 0; offset < source.byteLength; offset += 256 * 1_024) {
      recorder.append(source.subarray(offset, offset + 256 * 1_024));
      // Model an already-owned network/body stream: serving yields for its
      // own I/O, never to await a diagnostics acknowledgement.
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    recorder.finish({ originalBytes: source.byteLength, complete: true });
    observer.close({ outcome: "success" });

    const detail = await authority.getRequestJourney({ requestId });
    expect(detail.artifacts).toContainEqual(
      expect.objectContaining({
        artifactId: "large_json",
        state: "captured",
        originalBytes: source.byteLength,
        capturedBytes: source.byteLength,
      }),
    );
    const tail = await authority.getRequestArtifact({
      requestId,
      artifactId: "large_json",
      offset: source.byteLength - 64,
      limit: 64,
    });
    expect(tail.complete).toBe(true);
    expect(Buffer.from(tail.dataBase64, "base64").toString("utf8")).toBe(
      `${"x".repeat(62)}"}`,
    );

    const overLimitRequestId = "71000000-0000-4000-8000-000000000010";
    const overLimitObserver = authority.begin({
      requestId: overLimitRequestId,
      operationCandidate: "model_generation",
      transport: "in_process",
      method: "POST",
      path: "/v1/responses",
      acceptedAt: Date.now(),
      cancellation: { caller: "active", shutdown: "not_bound" },
    });
    const overLimitRecorder = overLimitObserver.openArtifact!({
      artifactId: "large_json_plus_one",
      artifactKind: "client_request_wire",
      mediaType: "application/json",
      originalBytes: source.byteLength + 1,
      location: LOCATION,
    });
    for (let offset = 0; offset < source.byteLength; offset += 256 * 1_024) {
      overLimitRecorder.append(source.subarray(offset, offset + 256 * 1_024));
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    // JSON permits trailing whitespace, so this is a valid 64 MiB + 1 JSON
    // document rather than an invalid-syntax boundary probe.
    overLimitRecorder.append(Buffer.from(" "));
    overLimitRecorder.finish({
      originalBytes: source.byteLength + 1,
      complete: true,
    });
    overLimitObserver.close({ outcome: "success" });
    const overLimitDetail = await authority.getRequestJourney({
      requestId: overLimitRequestId,
    });
    expect(overLimitDetail.artifacts).toContainEqual(expect.objectContaining({
      artifactId: "large_json_plus_one",
      state: "unavailable",
      reason: "artifact_size_limit_exceeded",
      originalBytes: 67_108_865,
      capturedBytes: 0,
      truncated: true,
    }));
  });

  it("marks a one-shot JSON value beyond the nonblocking queue unavailable", async () => {
    const { authority } = await createHarness({
      snapshot: () => Object.freeze({
        allRequestsEnabled: true,
        failedRequestsEnabled: true,
      }),
    });
    const requestId = "71000000-0000-4000-8000-000000000011";
    const observer = authority.begin({
      requestId,
      operationCandidate: "model_generation",
      transport: "in_process",
      method: "POST",
      path: "/v1/responses",
      acceptedAt: Date.now(),
      cancellation: { caller: "active", shutdown: "not_bound" },
    });
    const source = Buffer.from(
      JSON.stringify({ payload: "x".repeat(17 * 1_024 * 1_024) }),
      "utf8",
    );
    const recorder = observer.openArtifact!({
      artifactId: "one_shot_large_json",
      artifactKind: "client_request_wire",
      mediaType: "application/json",
      originalBytes: source.byteLength,
      location: LOCATION,
    });

    recorder.append(source);
    recorder.finish({ originalBytes: source.byteLength, complete: true });
    observer.close({ outcome: "success" });

    const detail = await authority.getRequestJourney({ requestId });
    expect(detail.artifacts).toContainEqual(
      expect.objectContaining({
        artifactId: "one_shot_large_json",
        state: "unavailable",
        reason: "queue_capacity_exhausted",
        capturedBytes: 0,
        truncated: true,
      }),
    );
  });

  it("truthfully rejects one byte beyond the configured JSON boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-full-capture-limit-"));
    roots.push(root);
    const authority = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration(
        {
          directory: join(root, "diagnostics"),
          maxJsonArtifactBytes: 1_024,
          maxJourneyArtifactBytes: 2_048,
        },
        root,
      ),
      journeyCapturePolicy: {
        snapshot: () => Object.freeze({
          allRequestsEnabled: true,
          failedRequestsEnabled: true,
        }),
      },
    });
    authorities.push(authority);
    const requestId = "71000000-0000-4000-8000-000000000006";
    const observer = authority.begin({
      requestId,
      operationCandidate: "model_generation",
      transport: "in_process",
      method: "POST",
      path: "/v1/responses",
      acceptedAt: Date.now(),
      cancellation: { caller: "active", shutdown: "not_bound" },
    });
    const source = Buffer.from(
      JSON.stringify({ payload: "x".repeat(1_011) }),
      "utf8",
    );
    expect(source.byteLength).toBe(1_025);
    const recorder = observer.openArtifact!({
      artifactId: "one_byte_over",
      artifactKind: "client_request_wire",
      mediaType: "application/json",
      originalBytes: source.byteLength,
      location: LOCATION,
    });
    recorder.append(source);
    recorder.finish({ originalBytes: source.byteLength, complete: true });
    observer.close({ outcome: "success" });

    const detail = await authority.getRequestJourney({ requestId });
    expect(detail.artifacts).toContainEqual(
      expect.objectContaining({
        artifactId: "one_byte_over",
        state: "unavailable",
        reason: "artifact_size_limit_exceeded",
        originalBytes: 1_025,
        capturedBytes: 0,
        truncated: true,
      }),
    );
    await expect(authority.getRequestArtifact({
      requestId,
      artifactId: "one_byte_over",
      offset: 0,
      limit: 256 * 1_024,
    })).rejects.toThrow(/unavailable/iu);
  });
});
