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

function historyManagement(
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
  artifactBody: string,
): void {
  const failureId = `${requestId}:failure`;
  const artifactBytes = Buffer.from(artifactBody, "utf8");
  const journey = authority.begin({
    requestId,
    operationCandidate: "unmatched_request",
    transport: "in_process",
    method: "POST",
    path: "/diagnostics-history-delete-probe",
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

describe("unified Diagnostics history deletion", () => {
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

  it("deletes Journey children and Runtime records in one half-open range while reporting record counts", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "luckytoken-diagnostics-history-delete-"),
    );
    roots.push(root);
    let diagnosticsTime = 10_000;
    const authority = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration(
        { directory: root },
        root,
      ),
      runtimeId: "55000000-0000-4000-8000-000000000001",
      now: () => diagnosticsTime,
    });
    authorities.push(authority);

    const deletedRequestId = "55000000-0000-4000-8000-000000000002";
    const retainedRequestId = "55000000-0000-4000-8000-000000000003";
    recordFailedJourney(
      authority,
      deletedRequestId,
      100,
      '{"marker":"delete this body"}',
    );
    diagnosticsTime = 150;
    authority.observeRuntime({
      level: "warning",
      classification: "delete_this_runtime_event",
      safeMessage: "Runtime event inside the deletion range",
    });
    diagnosticsTime = 20_000;
    recordFailedJourney(
      authority,
      retainedRequestId,
      200,
      '{"marker":"retain this body"}',
    );
    diagnosticsTime = 200;
    authority.observeRuntime({
      level: "info",
      classification: "retain_this_runtime_event",
      safeMessage: "Runtime event at the exclusive boundary",
    });

    await expect(authority.queryRequestJourneys({ limit: 10 })).resolves.toMatchObject({
      records: [{ requestId: deletedRequestId }, { requestId: retainedRequestId }],
    });
    await expect(authority.queryRuntimeEvents({ limit: 10 })).resolves.toMatchObject({
      records: [
        { classification: "delete_this_runtime_event" },
        { classification: "retain_this_runtime_event" },
      ],
    });
    await expect(
      authority.getRequestArtifact({
        requestId: deletedRequestId,
        artifactId: "client_request_wire",
        offset: 0,
        limit: 256,
      }),
    ).resolves.toMatchObject({ complete: true });

    const result = await historyManagement(authority).deleteHistory({
      fromMs: 100,
      toMs: 200,
    });
    expect(result).toEqual({
      deleted: { requestJourneys: 1, runtimeEvents: 1 },
    });

    const journeys = await authority.queryRequestJourneys({ limit: 10 });
    expect(journeys.records.map((record) => record.requestId)).toEqual([
      retainedRequestId,
    ]);
    const runtimeEvents = await authority.queryRuntimeEvents({ limit: 10 });
    expect(runtimeEvents.records.map((record) => record.classification)).toEqual([
      "retain_this_runtime_event",
    ]);
    await expect(
      authority.getRequestJourney({ requestId: deletedRequestId }),
    ).rejects.toThrow("not found");
    await expect(
      authority.getRequestArtifact({
        requestId: deletedRequestId,
        artifactId: "client_request_wire",
        offset: 0,
        limit: 256,
      }),
    ).rejects.toThrow("unavailable");

    const retained = await authority.getRequestJourney({
      requestId: retainedRequestId,
    });
    expect(retained.timeline.length).toBeGreaterThan(0);
    await expect(
      authority.getRequestArtifact({
        requestId: retainedRequestId,
        artifactId: "client_request_wire",
        offset: 0,
        limit: 256,
      }),
    ).resolves.toMatchObject({ complete: true });
  });

  it("does not count or delete an active Journey before its close seal commits", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "luckytoken-diagnostics-history-active-"),
    );
    roots.push(root);
    const authority = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration(
        { directory: root },
        root,
      ),
      runtimeId: "55000000-0000-4000-8000-000000000011",
      now: () => 30_000,
    });
    authorities.push(authority);

    const requestId = "55000000-0000-4000-8000-000000000012";
    const journey = authority.begin({
      requestId,
      operationCandidate: "unmatched_request",
      transport: "in_process",
      method: "POST",
      path: "/diagnostics-history-active-probe",
      acceptedAt: 300,
      cancellation: { caller: "active", shutdown: "not_bound" },
    });
    journey.observe({
      kind: "step_entered",
      stepInstanceId: `${requestId}:step`,
      location: FAILURE_LOCATION,
    });

    const activePage = await authority.queryRequestJourneys({ limit: 10 });
    expect(activePage).toMatchObject({ records: [{ requestId }] });
    expect(activePage.records[0]).not.toHaveProperty("closedAt");
    await expect(
      historyManagement(authority).countHistory({ fromMs: 300, toMs: 301 }),
    ).resolves.toEqual({ requestJourneys: 0, runtimeEvents: 0 });
    await expect(
      historyManagement(authority).deleteHistory({ fromMs: 300, toMs: 301 }),
    ).resolves.toEqual({
      deleted: { requestJourneys: 0, runtimeEvents: 0 },
    });

    const failureId = `${requestId}:failure`;
    journey.observe({
      kind: "failure_detected",
      failureId,
      role: "primary",
      classification: "active_journey_probe",
      origin: "luckytoken",
      originPrecision: "exact",
      safeMessage: "The active Journey remained writable",
      location: FAILURE_LOCATION,
    });
    journey.close({
      outcome: "failed",
      primaryFailureId: failureId,
      lastKnownLocation: FAILURE_LOCATION,
    });

    const record = await authority.getRequestJourney({ requestId });
    expect(record.closedAt).toBe(30_000);
    expect(record.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          observation: expect.objectContaining({
            kind: "failure_detected",
            classification: "active_journey_probe",
          }),
        }),
      ]),
    );
    await expect(
      historyManagement(authority).countHistory({ fromMs: 300, toMs: 301 }),
    ).resolves.toEqual({ requestJourneys: 1, runtimeEvents: 0 });
  });
});
