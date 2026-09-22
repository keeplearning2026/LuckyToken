import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDiagnosticsAuthority,
  parseDiagnosticsConfiguration,
  type DiagnosticsAuthority,
  type DiagnosticsSubscription,
  type RequestJourneySummary,
} from "../../src/diagnostics/index.js";
import { handleHttpRequest } from "../../src/http.js";

const REQUEST_ID = "77000000-0000-4000-8000-000000000001";

function beginFixtureJourney(authority: DiagnosticsAuthority, requestId: string) {
  return authority.begin({
    requestId,
    operationCandidate: "model_generation",
    transport: "in_process",
    method: "POST",
    path: "/probe",
    acceptedAt: 1_790_000_000_000,
    cancellation: { caller: "active", shutdown: "not_bound" },
  });
}

describe("Request Journey failure diagnosis invariant", () => {
  const roots: string[] = [];
  const authorities: DiagnosticsAuthority[] = [];
  const subscriptions: DiagnosticsSubscription[] = [];

  afterEach(async () => {
    for (const subscription of subscriptions.splice(0)) {
      subscription.unsubscribe();
    }
    await Promise.all(
      authorities.splice(0).map((authority) => authority.close()),
    );
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("records a degraded primary diagnosis when a handler returns 500 without reporting a cause", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-failure-diagnosis-"));
    roots.push(root);
    const authority = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration({ directory: root }, root),
    });
    authorities.push(authority);

    let publish!: (record: RequestJourneySummary) => void;
    const published = new Promise<RequestJourneySummary>((resolve) => {
      publish = resolve;
    });
    subscriptions.push(
      authority.subscribeRequestJourneys((record) => {
        if (record.requestId === REQUEST_ID) publish(record);
      }),
    );

    const response = await handleHttpRequest(
      {
        clientProtocols: [
          {
            method: "POST",
            pathname: "/probe",
            handle: async () => new Response("failed", { status: 500 }),
          },
        ],
        requestTimeoutMs: undefined,
        shutdownSignal: undefined,
        diagnostics: authority,
        createRequestId: () => REQUEST_ID,
      },
      new Request("http://token.local/probe", { method: "POST" }),
    );
    const summary = await published;
    const detail = await authority.getRequestJourney({ requestId: REQUEST_ID });

    expect(response.status).toBe(500);
    expect(summary).toMatchObject({
      requestId: REQUEST_ID,
      outcome: "failed",
      completeness: "degraded",
      diagnosis: {
        evidence: "fallback",
        classification: "request_failed_without_specific_cause",
        safeMessage:
          "The request failed, but no more specific cause was recorded.",
        origin: "unknown",
        originPrecision: "boundary",
        location: {
          phase: "protocol_ingress",
          step: "invoke_protocol_handler",
        },
      },
    });
    expect(detail.incident).toMatchObject({
      primaryFailureId: `${REQUEST_ID}:request_failed_without_specific_cause`,
      failures: [
        {
          kind: "failure_detected",
          role: "primary",
          classification: "request_failed_without_specific_cause",
          origin: "unknown",
          originPrecision: "boundary",
          safeMessage:
            "The request failed, but no more specific cause was recorded.",
          location: {
            phase: "protocol_ingress",
            step: "invoke_protocol_handler",
          },
        },
      ],
    });
  });

  it("keeps the first observed primary cause authoritative", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-failure-primary-"));
    roots.push(root);
    const authority = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration({ directory: root }, root),
    });
    authorities.push(authority);
    const requestId = "77000000-0000-4000-8000-000000000002";
    const journey = beginFixtureJourney(authority, requestId);

    journey.observe({
      kind: "failure_detected",
      failureId: "supporting-429",
      role: "supporting",
      classification: "provider_http_429",
      origin: "provider",
      originPrecision: "external_boundary",
      safeMessage: "The provider rate-limited the first attempt.",
      location: {
        phase: "upstream_execution",
        lane: "provider_native",
        step: "classify_provider_response",
        attempt: 1,
      },
    });
    journey.observe({
      kind: "failure_detected",
      failureId: "first-primary",
      role: "primary",
      classification: "provider_transport_failed",
      origin: "network_os",
      originPrecision: "boundary",
      safeMessage: "Token could not connect to the provider.",
      location: {
        phase: "upstream_execution",
        lane: "provider_native",
        step: "dispatch_provider_native",
        attempt: 2,
      },
    });
    journey.close({
      outcome: "failed",
      primaryFailureId: "wrong-primary-id",
      lastKnownLocation: {
        phase: "http_handoff",
        step: "return_in_process_response",
      },
    });

    const detail = await authority.getRequestJourney({ requestId });
    expect(detail.completeness).toBe("complete");
    expect(detail.diagnosis).toEqual({
      evidence: "observed",
      classification: "provider_transport_failed",
      safeMessage: "Token could not connect to the provider.",
      origin: "network_os",
      originPrecision: "boundary",
      location: {
        phase: "upstream_execution",
        lane: "provider_native",
        step: "dispatch_provider_native",
        attempt: 2,
      },
    });
    expect(detail.incident?.primaryFailureId).toBe("first-primary");
  });

  it("does not let a supporting failure satisfy the primary diagnosis invariant", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-failure-supporting-"));
    roots.push(root);
    const authority = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration({ directory: root }, root),
    });
    authorities.push(authority);
    const requestId = "77000000-0000-4000-8000-000000000003";
    const journey = beginFixtureJourney(authority, requestId);
    journey.observe({
      kind: "failure_detected",
      failureId: "supporting-only",
      role: "supporting",
      classification: "provider_http_429",
      origin: "provider",
      originPrecision: "external_boundary",
      safeMessage: "The provider rate-limited one attempt.",
      location: {
        phase: "upstream_execution",
        lane: "provider_native",
        step: "classify_provider_response",
        attempt: 1,
      },
    });
    journey.close({
      outcome: "failed",
      primaryFailureId: "supporting-only",
      lastKnownLocation: {
        phase: "outcome_commit",
        step: "commit_request_outcome",
      },
    });

    const detail = await authority.getRequestJourney({ requestId });
    expect(detail.completeness).toBe("degraded");
    expect(detail.diagnosis).toMatchObject({
      evidence: "fallback",
      classification: "request_failed_without_specific_cause",
      origin: "unknown",
      location: {
        phase: "outcome_commit",
        step: "commit_request_outcome",
      },
    });
    expect(detail.incident?.primaryFailureId).not.toBe("supporting-only");
  });

  it("does not create a diagnosis or Incident for a successful request", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-success-diagnosis-"));
    roots.push(root);
    const authority = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration({ directory: root }, root),
    });
    authorities.push(authority);
    const requestId = "77000000-0000-4000-8000-000000000004";
    const journey = beginFixtureJourney(authority, requestId);
    journey.close({
      outcome: "success",
      lastKnownLocation: {
        phase: "http_handoff",
        step: "return_in_process_response",
      },
    });

    const detail = await authority.getRequestJourney({ requestId });
    expect(detail.outcome).toBe("success");
    expect(detail.diagnosis).toBeUndefined();
    expect(detail.incident).toBeUndefined();
  });
});
