import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDiagnosticsAuthority,
  parseDiagnosticsConfiguration,
  type DiagnosticsAuthority,
  type DiagnosticsManagementAuthority,
  type RequestJourneyLocation,
} from "../../src/diagnostics/index.js";

function historyCountManagement(
  authority: DiagnosticsAuthority,
): DiagnosticsManagementAuthority {
  return authority as DiagnosticsManagementAuthority;
}

const FAILURE_LOCATION: RequestJourneyLocation = Object.freeze({
  phase: "protocol_ingress",
  step: "validate_client_wire",
  subject: "envelope",
});

function recordFailedJourney(
  authority: DiagnosticsAuthority,
  requestId: string,
  acceptedAt: number,
  marker: string,
): void {
  const failureId = `${requestId}:failure`;
  const artifactBytes = Buffer.from(JSON.stringify({ marker }), "utf8");
  const journey = authority.begin({
    requestId,
    operationCandidate: "unmatched_request",
    transport: "in_process",
    method: "POST",
    path: "/diagnostics-history-count-probe",
    acceptedAt,
    cancellation: { caller: "active", shutdown: "not_bound" },
  });
  journey.observe({
    kind: "step_entered",
    stepInstanceId: `${requestId}:step`,
    location: FAILURE_LOCATION,
  });
  journey.observe({
    kind: "artifact_observed",
    artifactId: "client_request_wire",
    artifactKind: "client_request_wire",
    state: "captured",
    mediaType: "application/json",
    bytes: artifactBytes,
    originalBytes: artifactBytes.byteLength,
    capturedBytes: artifactBytes.byteLength,
    redaction: "not_required",
    truncated: false,
    location: FAILURE_LOCATION,
  });
  journey.observe({
    kind: "failure_detected",
    failureId,
    role: "primary",
    classification: "invalid_client_wire",
    origin: "client",
    originPrecision: "exact",
    safeMessage: "Client wire is invalid",
    location: FAILURE_LOCATION,
  });
  journey.close({
    outcome: "failed",
    primaryFailureId: failureId,
    lastKnownLocation: FAILURE_LOCATION,
  });
}

describe("unified Diagnostics history count", () => {
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

  it("counts the half-open Journey and Runtime range without changing records or artifacts", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "luckytoken-diagnostics-history-count-"),
    );
    roots.push(root);
    let diagnosticsTime = 10_000;
    const authority = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration(
        { directory: root },
        root,
      ),
      runtimeId: "56000000-0000-4000-8000-000000000001",
      now: () => diagnosticsTime,
    });
    authorities.push(authority);

    const includedRequestId = "56000000-0000-4000-8000-000000000002";
    const boundaryRequestId = "56000000-0000-4000-8000-000000000003";
    recordFailedJourney(authority, includedRequestId, 100, "included");
    diagnosticsTime = 100;
    authority.observeRuntime({
      level: "warning",
      classification: "included_runtime_event",
      safeMessage: "Runtime event inside the count range",
    });
    diagnosticsTime = 20_000;
    recordFailedJourney(authority, boundaryRequestId, 200, "boundary");
    diagnosticsTime = 200;
    authority.observeRuntime({
      level: "info",
      classification: "boundary_runtime_event",
      safeMessage: "Runtime event at the exclusive boundary",
    });

    await authority.queryRequestJourneys({ limit: 10 });
    await authority.queryRuntimeEvents({ limit: 10 });
    const counts = await historyCountManagement(authority).countHistory({
      fromMs: 100,
      toMs: 200,
    });
    expect(counts).toEqual({ requestJourneys: 1, runtimeEvents: 1 });

    const journeys = await authority.queryRequestJourneys({ limit: 10 });
    expect(journeys.records.map((record) => record.requestId)).toEqual([
      includedRequestId,
      boundaryRequestId,
    ]);
    const runtimeEvents = await authority.queryRuntimeEvents({ limit: 10 });
    expect(runtimeEvents.records.map((record) => record.classification)).toEqual([
      "included_runtime_event",
      "boundary_runtime_event",
    ]);
    for (const requestId of [includedRequestId, boundaryRequestId]) {
      const detail = await authority.getRequestJourney({ requestId });
      expect(detail.timeline.length).toBeGreaterThan(0);
      await expect(
        authority.getRequestArtifact({
          requestId,
          artifactId: "client_request_wire",
          offset: 0,
          limit: 256,
        }),
      ).resolves.toMatchObject({ complete: true });
    }
  });
});
