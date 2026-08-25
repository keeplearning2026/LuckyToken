import { describe, expect, it } from "vitest";

import {
  MAX_REQUEST_ARTIFACT_CHUNK_BYTES,
  MAX_REQUEST_DIAGNOSTICS_QUERY_LIMIT,
  controlPlaneVersion,
  decodeRequestArtifactGetInput,
  decodeRequestArtifactReadResult,
  decodeRequestJourneyGetInput,
  decodeRequestJourneyQuery,
  decodeRequestJourneyQueryReadResult,
  decodeRequestJourneyQueryResult,
  decodeRequestJourneyRecord,
  decodeRequestJourneySummary,
  decodeRuntimeEventQuery,
  decodeRuntimeEventQueryResult,
  decodeRuntimeEventRecord,
  decodeUnifiedDiagnosticsSubscriptionEvent,
  type DiagnosticsReadResult,
  type RequestJourneyPersistedObservation,
  type RequestJourneyRecord,
  type RequestJourneySummary,
  type RuntimeEventRecord,
} from "@luckytoken/application-control-plane/control-plane";

const JOURNEY_SUMMARY: RequestJourneySummary = Object.freeze({
  id: 1,
  runtimeId: "52000000-0000-4000-8000-000000000001",
  requestId: "52000000-0000-4000-8000-000000000002",
  operation: "model_generation",
  protocol: "anthropic-messages",
  lane: "semantic_conversion",
  requestedModel: "anthropic/sonnet",
  providerId: "anthropic",
  realModelId: "claude-sonnet",
  clientSessionId: "client-session",
  effectiveSessionId: "effective-session",
  profileId: "profile-1",
  profileDisplayName: "Production",
  httpStatus: 502,
  outcome: "failed",
  completeness: "complete",
  createdAt: 1_787_558_400_000,
  closedAt: 1_787_558_400_100,
  primaryFailureLocation: Object.freeze({
    phase: "upstream_execution",
    lane: "semantic_conversion",
    direction: "provider_to_pi",
    step: "decode_provider_events",
    subject: "tool_call",
    sourcePath: "event[37]",
    attempt: 2,
  }),
});

const JOURNEY_RECORD: RequestJourneyRecord = Object.freeze({
  ...JOURNEY_SUMMARY,
  admission: Object.freeze({
    operationCandidate: "model_generation",
    transport: "http",
    method: "POST",
    path: "/v1/messages",
    acceptedAt: 1_787_558_400_000,
    cancellation: Object.freeze({ caller: "active", shutdown: "not_bound" }),
  }),
  timeline: Object.freeze([
    Object.freeze({
      runtimeId: JOURNEY_SUMMARY.runtimeId,
      requestId: JOURNEY_SUMMARY.requestId,
      sequence: 0,
      time: 1_787_558_400_010,
      observation: Object.freeze({
        kind: "step_entered",
        stepInstanceId: "provider-read-2",
        location: JOURNEY_SUMMARY.primaryFailureLocation!,
      }),
    }),
  ]),
  artifacts: Object.freeze([
    Object.freeze({
      artifactId: "client-response-wire",
      artifactKind: "client_response_wire",
      state: "captured",
      mediaType: "application/json",
      capturedBytes: 4,
      originalBytes: 4,
      redaction: "not_required",
      truncated: false,
    }),
  ]),
  incident: Object.freeze({
    primaryFailureId: "failure-1",
    failures: Object.freeze([
      Object.freeze({
        kind: "failure_detected",
        failureId: "failure-1",
        role: "primary",
        classification: "provider_stream_decode_failed",
        origin: "provider",
        originPrecision: "external_boundary",
        safeMessage: "Provider stream ended with malformed tool input",
        location: JOURNEY_SUMMARY.primaryFailureLocation!,
      }),
    ]),
  }),
  workOutcome: Object.freeze({
    outcome: "failed",
    requestOutcome: "failed",
    terminalAuthority: "pi_execution",
    location: JOURNEY_SUMMARY.primaryFailureLocation!,
  }),
  clientPresentation: Object.freeze({
    status: 502,
    mediaType: "application/json",
    location: Object.freeze({
      phase: "client_response_preparation",
      step: "render_client_error",
    }),
  }),
  handoffOutcome: Object.freeze({
    outcome: "finished",
    transport: "http",
    writableFinished: true,
    location: Object.freeze({
      phase: "http_handoff",
      step: "write_http_response",
    }),
  }),
});

const RUNTIME_EVENT: RuntimeEventRecord = Object.freeze({
  kind: "runtime_event",
  id: 2,
  runtimeId: JOURNEY_SUMMARY.runtimeId,
  recordId: "52000000-0000-4000-8000-000000000003",
  sequence: 0,
  time: 1_787_558_400_200,
  level: "warning",
  classification: "catalog_refresh_degraded",
  safeMessage: "One provider catalog could not be refreshed",
});

const PERSISTED_OBSERVATIONS: readonly RequestJourneyPersistedObservation[] =
  Object.freeze([
    {
      kind: "step_entered",
      stepInstanceId: "step-1",
      location: { phase: "protocol_ingress", step: "read_and_decode_body" },
    },
    {
      kind: "step_completed",
      stepInstanceId: "step-1",
      completion: "success",
      operation: "model_generation",
      protocol: "anthropic-messages",
      summary: "Client request decoded",
      location: { phase: "protocol_ingress", step: "read_and_decode_body" },
    },
    {
      kind: "lane_committed",
      lane: "semantic_conversion",
      location: { phase: "request_resolution", step: "commit_lane" },
    },
    {
      kind: "model_resolved",
      requestedModel: "anthropic/sonnet",
      providerId: "anthropic",
      modelId: "claude-sonnet",
      location: { phase: "request_resolution", step: "resolve_public_model" },
    },
    {
      kind: "request_identity_established",
      effectiveSessionId: "effective-session",
      clientSessionId: "client-session",
      location: { phase: "protocol_ingress", step: "establish_request_identity" },
    },
    {
      kind: "profile_attributed",
      profileId: "profile-1",
      displayName: "Production",
      location: {
        phase: "lane_request_preparation",
        lane: "semantic_conversion",
        step: "capture_semantic_profile",
      },
    },
    {
      kind: "attempt_observed",
      attempt: 1,
      profileId: "profile-1",
      status: 429,
      transition: "retry",
      location: {
        phase: "upstream_execution",
        lane: "semantic_conversion",
        step: "advance_semantic_profile",
        attempt: 1,
      },
    },
    {
      kind: "conversion_notice_observed",
      code: "optional_field_omitted",
      severity: "warning",
      location: {
        phase: "lane_request_preparation",
        lane: "semantic_conversion",
        direction: "client_to_pi",
        step: "convert_request_envelope",
      },
    },
    {
      kind: "artifact_observed",
      artifactId: "client-request-wire",
      artifactKind: "client_request_wire",
      state: "captured",
      mediaType: "application/json",
      originalBytes: 4,
      capturedBytes: 4,
      redaction: "applied",
      truncated: false,
      integrityHash: "sha256:fixture",
      location: { phase: "protocol_ingress", step: "capture_client_request_wire" },
    },
    {
      kind: "failure_detected",
      failureId: "failure-1",
      role: "primary",
      classification: "provider_stream_decode_failed",
      origin: "provider",
      originPrecision: "external_boundary",
      safeMessage: "Provider stream ended with malformed tool input",
      exceptionFingerprint: "sha256:failure",
      location: JOURNEY_SUMMARY.primaryFailureLocation!,
    },
    {
      kind: "work_outcome_committed",
      outcome: "failed",
      requestOutcome: "failed",
      terminalAuthority: "pi_execution",
      location: { phase: "outcome_commit", step: "commit_failed_outcome" },
    },
    {
      kind: "terminal_usage_observed",
      usage: {
        api: "anthropic-messages",
        input: 5,
        cacheRead: 0,
        cacheWrite: 0,
        output: 2,
        normalizedTotal: 7,
        cacheHitRate: 0,
        completeness: "complete",
      },
      location: { phase: "upstream_execution", step: "normalize_terminal_usage" },
    },
    {
      kind: "client_response_prepared",
      status: 502,
      mediaType: "application/json",
      location: { phase: "client_response_preparation", step: "render_client_error" },
    },
    {
      kind: "handoff_observed",
      outcome: "finished",
      transport: "http",
      writableFinished: true,
      location: { phase: "http_handoff", step: "write_http_response" },
    },
  ]);

describe("unified request diagnostics Control Plane contract", () => {
  it("publishes the unified diagnostics contract through Control Plane v4", () => {
    expect(controlPlaneVersion).toBe(4);
  });

  it("strictly decodes the bounded Request Journey query", () => {
    expect(decodeRequestJourneyQuery(undefined)).toBeUndefined();
    expect(
      decodeRequestJourneyQuery({ afterId: 7, limit: 25 }),
    ).toEqual({ afterId: 7, limit: 25 });

    expect(decodeRequestJourneyQuery({ limit: 0 })).toBeUndefined();
    expect(
      decodeRequestJourneyQuery({
        limit: MAX_REQUEST_DIAGNOSTICS_QUERY_LIMIT + 1,
      }),
    ).toBeUndefined();
    expect(
      decodeRequestJourneyQuery({ afterId: 7, limit: 25, unknown: true }),
    ).toBeUndefined();
  });

  it("strictly decodes one bounded Request Journey summary", () => {
    expect(decodeRequestJourneySummary(JOURNEY_SUMMARY)).toEqual(JOURNEY_SUMMARY);
    expect(
      decodeRequestJourneySummary({ ...JOURNEY_SUMMARY, unknown: true }),
    ).toBeUndefined();
    expect(
      decodeRequestJourneySummary({
        ...JOURNEY_SUMMARY,
        primaryFailureLocation: {
          ...JOURNEY_SUMMARY.primaryFailureLocation,
          credential: "secret",
        },
      }),
    ).toBeUndefined();
    expect(
      decodeRequestJourneySummary({ ...JOURNEY_SUMMARY, closedAt: 1 }),
    ).toBeUndefined();
    expect(
      decodeRequestJourneySummary({ ...JOURNEY_SUMMARY, protocol: "x".repeat(129) }),
    ).toBeUndefined();
    expect(
      decodeRequestJourneySummary({ ...JOURNEY_SUMMARY, httpStatus: 99 }),
    ).toBeUndefined();
    expect(
      decodeRequestJourneySummary({ ...JOURNEY_SUMMARY, outcome: "running" }),
    ).toBeUndefined();
    expect(
      decodeRequestJourneySummary({ ...JOURNEY_SUMMARY, closedAt: undefined }),
    ).toBeUndefined();
    expect(
      decodeRequestJourneySummary({
        ...JOURNEY_SUMMARY,
        outcome: "running",
        closedAt: undefined,
      }),
    ).toMatchObject({ outcome: "running" });
  });

  it("strictly decodes trustworthy row-level usage projections", () => {
    const complete = {
      ...JOURNEY_SUMMARY,
      usage: {
        completeness: "complete",
        inputTokens: 11,
        cacheReadTokens: 3,
        outputTokens: 7,
        cacheHitRate: 3 / 14,
        outputTokensPerSecond: 7,
      },
    } as const;
    expect(decodeRequestJourneySummary(complete)).toEqual(complete);

    const partial = {
      ...JOURNEY_SUMMARY,
      usage: { completeness: "partial", reason: "component_unreported" },
    } as const;
    const unavailable = {
      ...JOURNEY_SUMMARY,
      usage: { completeness: "unavailable", reason: "unsupported_terminal" },
    } as const;
    expect(decodeRequestJourneySummary(partial)).toEqual(partial);
    expect(decodeRequestJourneySummary(unavailable)).toEqual(unavailable);

    expect(
      decodeRequestJourneySummary({
        ...complete,
        usage: { ...complete.usage, cacheHitRate: 1.1 },
      }),
    ).toBeUndefined();
    expect(
      decodeRequestJourneySummary({
        ...complete,
        usage: { ...complete.usage, outputTokensPerSecond: Number.POSITIVE_INFINITY },
      }),
    ).toBeUndefined();
    expect(
      decodeRequestJourneySummary({
        ...complete,
        usage: { ...complete.usage, inputTokens: -1 },
      }),
    ).toBeUndefined();
    expect(
      decodeRequestJourneySummary({
        ...complete,
        usage: { ...complete.usage, reason: "failed" },
      }),
    ).toBeUndefined();
    expect(
      decodeRequestJourneySummary({
        ...partial,
        usage: { ...partial.usage, inputTokens: 11 },
      }),
    ).toBeUndefined();
    expect(
      decodeRequestJourneySummary({
        ...partial,
        usage: { completeness: "partial", reason: "not-a-reason" },
      }),
    ).toBeUndefined();
  });

  it("round-trips the Codex Direct Mode web_search operation", () => {
    const searchJourney: RequestJourneySummary = Object.freeze({
      ...JOURNEY_SUMMARY,
      operation: "web_search",
      protocol: "codex-alpha-search",
      lane: "direct",
    });

    expect(decodeRequestJourneySummary(searchJourney)).toEqual(searchJourney);
  });

  it("round-trips Codex Images and Realtime WebSocket diagnostics", () => {
    const imagesJourney: RequestJourneySummary = Object.freeze({
      ...JOURNEY_SUMMARY,
      operation: "image_generation",
      protocol: "codex-images",
      lane: "direct",
    });
    const realtimeJourney: RequestJourneySummary = Object.freeze({
      ...JOURNEY_SUMMARY,
      operation: "realtime_session",
      protocol: "codex-realtime",
      lane: "direct",
    });
    const realtimeRecord = {
      ...JOURNEY_RECORD,
      operation: "realtime_session",
      protocol: "codex-realtime",
      lane: "direct",
      admission: { ...JOURNEY_RECORD.admission, transport: "websocket" },
      handoffOutcome: {
        outcome: "finished",
        transport: "websocket",
        location: { phase: "http_handoff", step: "close_websocket_session" },
      },
    } as const;

    expect(decodeRequestJourneySummary(imagesJourney)).toEqual(imagesJourney);
    expect(decodeRequestJourneySummary(realtimeJourney)).toEqual(realtimeJourney);
    expect(decodeRequestJourneyRecord(realtimeRecord)).toEqual(realtimeRecord);
  });

  it("strictly decodes a bounded Request Journey query result", () => {
    expect(
      decodeRequestJourneyQueryResult({ records: [JOURNEY_SUMMARY], hasMore: false }),
    ).toEqual({ records: [JOURNEY_SUMMARY], hasMore: false });
    expect(
      decodeRequestJourneyQueryResult({
        records: [JOURNEY_SUMMARY],
        hasMore: false,
        secret: "must-not-cross",
      }),
    ).toBeUndefined();
    expect(
      decodeRequestJourneyQueryResult({
        records: Array.from(
          { length: MAX_REQUEST_DIAGNOSTICS_QUERY_LIMIT + 1 },
          () => JOURNEY_SUMMARY,
        ),
        hasMore: false,
      }),
    ).toBeUndefined();
  });

  it("strictly decodes the bounded Request Journey detail", () => {
    expect(decodeRequestJourneyRecord(JOURNEY_RECORD)).toEqual(JOURNEY_RECORD);
    expect(
      decodeRequestJourneyRecord({
        ...JOURNEY_RECORD,
        admission: { ...JOURNEY_RECORD.admission, auth: "secret" },
      }),
    ).toBeUndefined();
    expect(
      decodeRequestJourneyRecord({
        ...JOURNEY_RECORD,
        artifacts: [{ ...JOURNEY_RECORD.artifacts[0], body: "secret" }],
      }),
    ).toBeUndefined();
    expect(
      decodeRequestJourneyRecord({
        ...JOURNEY_RECORD,
        artifacts: Array.from({ length: 513 }, () => JOURNEY_RECORD.artifacts[0]),
      }),
    ).toBeUndefined();
    expect(
      decodeRequestJourneyRecord({
        ...JOURNEY_RECORD,
        incident: {
          primaryFailureId: "failure-supporting",
          failures: [
            JOURNEY_RECORD.incident!.failures[0],
            {
              ...JOURNEY_RECORD.incident!.failures[0],
              failureId: "failure-supporting",
              role: "supporting",
            },
          ],
        },
      }),
    ).toBeUndefined();
  });

  it("strictly decodes Journey and bounded artifact read DTOs", () => {
    expect(
      decodeRequestJourneyGetInput({ requestId: JOURNEY_SUMMARY.requestId }),
    ).toEqual({ requestId: JOURNEY_SUMMARY.requestId });
    expect(
      decodeRequestJourneyGetInput({
        requestId: JOURNEY_SUMMARY.requestId,
        unknown: true,
      }),
    ).toBeUndefined();

    const artifactInput = {
      requestId: JOURNEY_SUMMARY.requestId,
      artifactId: "client-response-wire",
      offset: 0,
      limit: MAX_REQUEST_ARTIFACT_CHUNK_BYTES,
    } as const;
    expect(decodeRequestArtifactGetInput(artifactInput)).toEqual(artifactInput);
    expect(
      decodeRequestArtifactGetInput({ ...artifactInput, limit: 0 }),
    ).toBeUndefined();
    expect(
      decodeRequestArtifactGetInput({
        ...artifactInput,
        limit: MAX_REQUEST_ARTIFACT_CHUNK_BYTES + 1,
      }),
    ).toBeUndefined();

    const artifactResult = {
      requestId: JOURNEY_SUMMARY.requestId,
      artifactId: "client-response-wire",
      offset: 0,
      nextOffset: 4,
      complete: true,
      dataBase64: "c2FmZQ==",
    } as const;
    expect(decodeRequestArtifactReadResult(artifactResult)).toEqual(artifactResult);
    expect(
      decodeRequestArtifactReadResult({ ...artifactResult, dataBase64: "not-base64" }),
    ).toBeUndefined();
    expect(
      decodeRequestArtifactReadResult({ ...artifactResult, nextOffset: 3 }),
    ).toBeUndefined();
    expect(
      decodeRequestArtifactReadResult({ ...artifactResult, token: "secret" }),
    ).toBeUndefined();
  });

  it("strictly decodes bounded Runtime Event query and record DTOs", () => {
    expect(decodeRuntimeEventQuery(undefined)).toBeUndefined();
    expect(decodeRuntimeEventQuery({ afterId: 1, limit: 10 })).toEqual({
      afterId: 1,
      limit: 10,
    });
    expect(
      decodeRuntimeEventQuery({ afterId: 1, limit: 10, unknown: true }),
    ).toBeUndefined();
    expect(decodeRuntimeEventRecord(RUNTIME_EVENT)).toEqual(RUNTIME_EVENT);
    expect(
      decodeRuntimeEventRecord({ ...RUNTIME_EVENT, details: { token: "secret" } }),
    ).toBeUndefined();
    expect(
      decodeRuntimeEventRecord({ ...RUNTIME_EVENT, safeMessage: "x".repeat(4_097) }),
    ).toBeUndefined();
    expect(
      decodeRuntimeEventQueryResult({ records: [RUNTIME_EVENT], hasMore: false }),
    ).toEqual({ records: [RUNTIME_EVENT], hasMore: false });
    expect(
      decodeRuntimeEventQueryResult({
        records: Array.from(
          { length: MAX_REQUEST_DIAGNOSTICS_QUERY_LIMIT + 1 },
          () => RUNTIME_EVENT,
        ),
        hasMore: false,
      }),
    ).toBeUndefined();
  });

  it("strictly decodes the typed diagnostics-unavailable envelope", () => {
    const ok: DiagnosticsReadResult<{
      readonly records: readonly RequestJourneySummary[];
      readonly hasMore: boolean;
    }> = Object.freeze({
      outcome: "ok",
      result: Object.freeze({ records: Object.freeze([JOURNEY_SUMMARY]), hasMore: false }),
    });
    expect(decodeRequestJourneyQueryReadResult(ok)).toEqual(ok);

    const unavailable = Object.freeze({
      outcome: "unavailable",
      error: Object.freeze({
        code: "diagnostics_unavailable",
        classification: "diagnostics_storage_unavailable",
        message: "Diagnostics storage is unavailable",
      }),
    });
    expect(decodeRequestJourneyQueryReadResult(unavailable)).toEqual(unavailable);
    expect(
      decodeRequestJourneyQueryReadResult({ ...unavailable, retryAfterMs: 1 }),
    ).toBeUndefined();
    expect(
      decodeRequestJourneyQueryReadResult({
        ...unavailable,
        error: { ...unavailable.error, cause: "sqlite path" },
      }),
    ).toBeUndefined();
    expect(
      decodeRequestJourneyQueryReadResult({
        ...unavailable,
        error: { ...unavailable.error, message: "raw storage failure" },
      }),
    ).toBeUndefined();
  });

  it("strictly decodes both unified diagnostics subscription payloads", () => {
    const journey = Object.freeze({
      type: "request_journey",
      record: JOURNEY_SUMMARY,
    });
    const runtime = Object.freeze({ type: "runtime_event", record: RUNTIME_EVENT });
    expect(decodeUnifiedDiagnosticsSubscriptionEvent(journey)).toEqual(journey);
    expect(decodeUnifiedDiagnosticsSubscriptionEvent(runtime)).toEqual(runtime);
    expect(
      decodeUnifiedDiagnosticsSubscriptionEvent({ ...journey, sequence: 1 }),
    ).toBeUndefined();
    expect(
      decodeUnifiedDiagnosticsSubscriptionEvent({
        ...runtime,
        record: { ...RUNTIME_EVENT, rawError: "secret" },
      }),
    ).toBeUndefined();
  });

  it("round-trips every closed persisted observation and rejects extensions", () => {
    for (const [sequence, observation] of PERSISTED_OBSERVATIONS.entries()) {
      const candidate = {
        ...JOURNEY_RECORD,
        timeline: [
          {
            runtimeId: JOURNEY_SUMMARY.runtimeId,
            requestId: JOURNEY_SUMMARY.requestId,
            sequence,
            time: JOURNEY_SUMMARY.createdAt + sequence,
            observation,
          },
        ],
      };
      expect(decodeRequestJourneyRecord(candidate)?.timeline[0]?.observation).toEqual(
        observation,
      );
      expect(
        decodeRequestJourneyRecord({
          ...candidate,
          timeline: [
            {
              ...candidate.timeline[0],
              observation: { ...observation, unknown: true },
            },
          ],
        }),
      ).toBeUndefined();
    }
  });
});
