import {
  decodeTerminalUsageFact,
  type TerminalUsageClass,
} from "@token/provider-contract/usage";

import {
  MAX_REQUEST_DIAGNOSTICS_DETAIL_ITEMS,
  MAX_REQUEST_DIAGNOSTICS_QUERY_LIMIT,
  MAX_REQUEST_ARTIFACT_CHUNK_BYTES,
  type ArtifactPersistedObservation,
  type AttemptObservedPersistedObservation,
  type ClientResponsePresentation,
  type ClientResponsePreparedPersistedObservation,
  type ConversionNoticePersistedObservation,
  type DataPlaneLane,
  type DiagnosticsReadResult,
  type UnifiedDiagnosticsSubscriptionEvent,
  type DiagnosticsUnavailableProjection,
  type DiagnosticsUnavailableResult,
  type FailureDetectedPersistedObservation,
  type HandoffPersistedObservation,
  type LaneCommittedPersistedObservation,
  type ModelResolvedPersistedObservation,
  type ProfileAttributedPersistedObservation,
  type RequestAnalyticsOutcome,
  type RequestArtifactDescriptor,
  type RequestArtifactChunkReadResult,
  type RequestArtifactGetInput,
  type RequestArtifactReadResult,
  type RequestArtifactState,
  type RequestCancellationSnapshot,
  type RequestHandoffOutcome,
  type RequestIdentityEstablishedPersistedObservation,
  type RequestIncident,
  type RequestJourneyDirection,
  type RequestJourneyDetailReadResult,
  type RequestJourneyGetInput,
  type RequestJourneyAdmission,
  type RequestJourneyLocation,
  type RequestJourneyOperation,
  type RequestJourneyOperationCandidate,
  type RequestJourneyOutcome,
  type RequestJourneyPhase,
  type RequestJourneyPersistedObservation,
  type RequestJourneyQuery,
  type RequestJourneyQueryReadResult,
  type RequestJourneyQueryResult,
  type RequestJourneyRecord,
  type RequestJourneySubject,
  type RequestJourneySummary,
  type RequestJourneyUsageSummary,
  type RequestJourneyTimelineEvent,
  type RequestWorkOutcome,
  type RuntimeEventQuery,
  type RuntimeEventQueryReadResult,
  type RuntimeEventQueryResult,
  type RuntimeEventRecord,
  type StepCompletedPersistedObservation,
  type StepEnteredPersistedObservation,
  type TerminalUsagePersistedObservation,
  type WorkOutcomeCommittedPersistedObservation,
} from "./request-diagnostics-contract.js";

const MAX_ID_TEXT = 128;
const MAX_PROTOCOL_TEXT = 128;
const MAX_STEP_TEXT = 128;
const MAX_SOURCE_PATH_TEXT = 1_024;
const MAX_SAFE_TEXT = 4_096;
const MAX_MEDIA_TYPE_TEXT = 256;

const PHASES = new Set<RequestJourneyPhase>([
  "http_admission",
  "protocol_ingress",
  "request_resolution",
  "lane_request_preparation",
  "upstream_execution",
  "lane_response_processing",
  "client_response_preparation",
  "outcome_commit",
  "http_handoff",
]);
const LANES = new Set<DataPlaneLane>([
  "direct",
  "provider_native",
  "semantic_conversion",
]);
const DIRECTIONS = new Set<RequestJourneyDirection>([
  "client_to_pi",
  "pi_to_provider",
  "provider_to_pi",
  "pi_to_client",
]);
const SUBJECTS = new Set<RequestJourneySubject>([
  "envelope",
  "system",
  "message",
  "content",
  "tool",
  "tool_call",
  "tool_result",
  "reasoning",
  "metadata",
  "usage",
  "stop_reason",
]);
const OPERATIONS = new Set<RequestJourneyOperationCandidate>([
  "pending",
  "model_generation",
  "conversation_compaction",
  "model_discovery",
  "web_search",
  "image_generation",
  "realtime_session",
  "unmatched_request",
  "unsupported_transport",
]);
const OUTCOMES = new Set<RequestJourneyOutcome | "running">([
  "running",
  "success",
  "failed",
  "aborted",
  "interrupted",
]);
const ARTIFACT_STATES = new Set<RequestArtifactState>([
  "captured",
  "partial",
  "unavailable",
  "not_applicable",
]);
const TERMINAL_USAGE_CLASSES = new Set<TerminalUsageClass>([
  "done",
  "failed",
  "aborted",
  "unsupported",
]);
const ANALYTICS_OUTCOMES = new Set<RequestAnalyticsOutcome>([
  "success",
  "failed",
  "aborted",
  "rejected-auth",
  "unknown-alias",
  "unavailable-alias",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function decodeRequestJourneyUsageSummary(
  value: unknown,
): RequestJourneyUsageSummary | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "terminalClass",
      "inputTokens",
      "cacheReadTokens",
      "outputTokens",
      "cacheHitRate",
      "outputTokensPerSecond",
    ]) ||
    !TERMINAL_USAGE_CLASSES.has(value.terminalClass as TerminalUsageClass) ||
    !isNonNegativeSafeInteger(value.inputTokens) ||
    !isNonNegativeSafeInteger(value.cacheReadTokens) ||
    !isNonNegativeSafeInteger(value.outputTokens) ||
    (value.cacheHitRate !== undefined && !isRate(value.cacheHitRate)) ||
    (value.outputTokensPerSecond !== undefined &&
      !isNonNegativeFiniteNumber(value.outputTokensPerSecond))
  ) {
    return undefined;
  }
  return Object.freeze({
    terminalClass: value.terminalClass as TerminalUsageClass,
    inputTokens: value.inputTokens,
    cacheReadTokens: value.cacheReadTokens,
    outputTokens: value.outputTokens,
    ...(value.cacheHitRate === undefined ? {} : { cacheHitRate: value.cacheHitRate }),
    ...(value.outputTokensPerSecond === undefined
      ? {}
      : { outputTokensPerSecond: value.outputTokensPerSecond }),
  });
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function decodedBase64ByteLength(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length % 4 !== 0) return undefined;
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  ) {
    return undefined;
  }
  if (value.length === 0) return 0;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function decodeUnavailable(
  value: unknown,
): DiagnosticsUnavailableProjection | undefined {
  return isRecord(value) &&
    hasOnlyKeys(value, ["code", "classification", "message"]) &&
    value.code === "diagnostics_unavailable" &&
    value.classification === "diagnostics_storage_unavailable" &&
    value.message === "Diagnostics storage is unavailable"
    ? Object.freeze({
        code: "diagnostics_unavailable",
        classification: "diagnostics_storage_unavailable",
        message: "Diagnostics storage is unavailable",
      })
    : undefined;
}

export function decodeDiagnosticsUnavailableResult(
  value: unknown,
): DiagnosticsUnavailableResult | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["outcome", "error"]) ||
    value.outcome !== "unavailable"
  ) {
    return undefined;
  }
  const error = decodeUnavailable(value.error);
  return error === undefined
    ? undefined
    : Object.freeze({ outcome: "unavailable", error });
}

function decodeReadResult<T>(
  value: unknown,
  decode: (input: unknown) => T | undefined,
): DiagnosticsReadResult<T> | undefined {
  if (!isRecord(value)) return undefined;
  if (value.outcome === "ok") {
    if (!hasOnlyKeys(value, ["outcome", "result"])) return undefined;
    const result = decode(value.result);
    return result === undefined
      ? undefined
      : Object.freeze({ outcome: "ok", result });
  }
  if (value.outcome === "unavailable") {
    return decodeDiagnosticsUnavailableResult(value);
  }
  return undefined;
}

function decodeRequestJourneyLocation(
  value: unknown,
): RequestJourneyLocation | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "phase",
      "lane",
      "direction",
      "step",
      "subject",
      "sourcePath",
      "attempt",
    ]) ||
    !PHASES.has(value.phase as RequestJourneyPhase) ||
    !boundedText(value.step, MAX_STEP_TEXT) ||
    (value.lane !== undefined && !LANES.has(value.lane as DataPlaneLane)) ||
    (value.direction !== undefined &&
      !DIRECTIONS.has(value.direction as RequestJourneyDirection)) ||
    (value.subject !== undefined &&
      !SUBJECTS.has(value.subject as RequestJourneySubject)) ||
    (value.sourcePath !== undefined &&
      !boundedText(value.sourcePath, MAX_SOURCE_PATH_TEXT)) ||
    (value.attempt !== undefined &&
      (!Number.isSafeInteger(value.attempt) || (value.attempt as number) < 1))
  ) {
    return undefined;
  }
  return Object.freeze({
    phase: value.phase as RequestJourneyPhase,
    ...(value.lane === undefined ? {} : { lane: value.lane as DataPlaneLane }),
    ...(value.direction === undefined
      ? {}
      : { direction: value.direction as RequestJourneyDirection }),
    step: value.step,
    ...(value.subject === undefined
      ? {}
      : { subject: value.subject as RequestJourneySubject }),
    ...(value.sourcePath === undefined ? {} : { sourcePath: value.sourcePath }),
    ...(value.attempt === undefined ? {} : { attempt: value.attempt as number }),
  });
}

function decodeCancellation(
  value: unknown,
): RequestCancellationSnapshot | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["caller", "shutdown", "timeoutMs"]) ||
    (value.caller !== "active" && value.caller !== "aborted") ||
    (value.shutdown !== "not_bound" &&
      value.shutdown !== "active" &&
      value.shutdown !== "aborted") ||
    (value.timeoutMs !== undefined &&
      (!Number.isSafeInteger(value.timeoutMs) || (value.timeoutMs as number) < 0))
  ) {
    return undefined;
  }
  return Object.freeze({
    caller: value.caller,
    shutdown: value.shutdown,
    ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs as number }),
  });
}

function decodeAdmission(value: unknown): RequestJourneyAdmission | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "operationCandidate",
      "transport",
      "method",
      "path",
      "acceptedAt",
      "cancellation",
    ]) ||
    !OPERATIONS.has(value.operationCandidate as RequestJourneyOperationCandidate) ||
    (value.transport !== "http" &&
      value.transport !== "websocket" &&
      value.transport !== "in_process") ||
    !boundedText(value.method, 32) ||
    !boundedText(value.path, 2_048) ||
    !isNonNegativeSafeInteger(value.acceptedAt)
  ) {
    return undefined;
  }
  const cancellation = decodeCancellation(value.cancellation);
  if (cancellation === undefined) return undefined;
  return Object.freeze({
    operationCandidate: value.operationCandidate as RequestJourneyOperationCandidate,
    transport: value.transport,
    method: value.method,
    path: value.path,
    acceptedAt: value.acceptedAt,
    cancellation,
  });
}

function decodeArtifactFields(
  value: Readonly<Record<string, unknown>>,
): Omit<ArtifactPersistedObservation, "kind" | "location"> | undefined {
  if (
    !boundedText(value.artifactId, MAX_ID_TEXT) ||
    !boundedText(value.artifactKind, MAX_ID_TEXT) ||
    !ARTIFACT_STATES.has(value.state as RequestArtifactState) ||
    (value.mediaType !== undefined &&
      !boundedText(value.mediaType, MAX_MEDIA_TYPE_TEXT)) ||
    (value.originalBytes !== undefined &&
      !isNonNegativeSafeInteger(value.originalBytes)) ||
    (value.capturedBytes !== undefined &&
      !isNonNegativeSafeInteger(value.capturedBytes)) ||
    (value.originalBytes !== undefined &&
      value.capturedBytes !== undefined &&
      (value.capturedBytes as number) > (value.originalBytes as number)) ||
    (value.redaction !== undefined &&
      value.redaction !== "not_required" &&
      value.redaction !== "applied" &&
      value.redaction !== "failed") ||
    (value.truncated !== undefined && typeof value.truncated !== "boolean") ||
    (value.integrityHash !== undefined &&
      !boundedText(value.integrityHash, 256)) ||
    (value.reason !== undefined && !boundedText(value.reason, 256))
  ) {
    return undefined;
  }
  return Object.freeze({
    artifactId: value.artifactId,
    artifactKind: value.artifactKind,
    state: value.state as RequestArtifactState,
    ...(value.mediaType === undefined ? {} : { mediaType: value.mediaType }),
    ...(value.originalBytes === undefined
      ? {}
      : { originalBytes: value.originalBytes as number }),
    ...(value.capturedBytes === undefined
      ? {}
      : { capturedBytes: value.capturedBytes as number }),
    ...(value.redaction === undefined
      ? {}
      : { redaction: value.redaction as "not_required" | "applied" | "failed" }),
    ...(value.truncated === undefined ? {} : { truncated: value.truncated }),
    ...(value.integrityHash === undefined
      ? {}
      : { integrityHash: value.integrityHash }),
    ...(value.reason === undefined ? {} : { reason: value.reason }),
  });
}

function decodeFailureObservation(
  value: Readonly<Record<string, unknown>>,
  location: RequestJourneyLocation,
): FailureDetectedPersistedObservation | undefined {
  if (
    !hasOnlyKeys(value, [
      "kind",
      "location",
      "failureId",
      "role",
      "classification",
      "origin",
      "originPrecision",
      "safeMessage",
      "exceptionFingerprint",
    ]) ||
    !boundedText(value.failureId, MAX_ID_TEXT) ||
    (value.role !== "primary" && value.role !== "supporting") ||
    !boundedText(value.classification, 256) ||
    (value.origin !== "client" &&
      value.origin !== "Token" &&
      value.origin !== "provider" &&
      value.origin !== "network_os") ||
    (value.originPrecision !== "exact" &&
      value.originPrecision !== "boundary" &&
      value.originPrecision !== "external_boundary") ||
    (value.safeMessage !== undefined &&
      !boundedText(value.safeMessage, MAX_SAFE_TEXT)) ||
    (value.exceptionFingerprint !== undefined &&
      !boundedText(value.exceptionFingerprint, 256))
  ) {
    return undefined;
  }
  return Object.freeze({
    kind: "failure_detected",
    failureId: value.failureId,
    role: value.role,
    classification: value.classification,
    origin: value.origin,
    originPrecision: value.originPrecision,
    ...(value.safeMessage === undefined ? {} : { safeMessage: value.safeMessage }),
    ...(value.exceptionFingerprint === undefined
      ? {}
      : { exceptionFingerprint: value.exceptionFingerprint }),
    location,
  });
}

function decodePersistedObservation(
  value: unknown,
): RequestJourneyPersistedObservation | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;
  const location = decodeRequestJourneyLocation(value.location);
  if (location === undefined) return undefined;
  if (value.kind === "step_entered") {
    if (
      !hasOnlyKeys(value, ["kind", "location", "stepInstanceId"]) ||
      !boundedText(value.stepInstanceId, MAX_ID_TEXT)
    ) {
      return undefined;
    }
    return Object.freeze({
      kind: "step_entered",
      stepInstanceId: value.stepInstanceId,
      location,
    }) satisfies StepEnteredPersistedObservation;
  }
  if (value.kind === "step_completed") {
    if (
      !hasOnlyKeys(value, [
        "kind",
        "location",
        "stepInstanceId",
        "completion",
        "operation",
        "protocol",
        "summary",
      ]) ||
      !boundedText(value.stepInstanceId, MAX_ID_TEXT) ||
      (value.completion !== "success" &&
        value.completion !== "failed" &&
        value.completion !== "aborted") ||
      (value.operation !== undefined &&
        !OPERATIONS.has(value.operation as RequestJourneyOperationCandidate)) ||
      value.operation === "pending" ||
      (value.protocol !== undefined &&
        !boundedText(value.protocol, MAX_PROTOCOL_TEXT)) ||
      (value.summary !== undefined && !boundedText(value.summary, MAX_SAFE_TEXT))
    ) {
      return undefined;
    }
    return Object.freeze({
      kind: "step_completed",
      stepInstanceId: value.stepInstanceId,
      completion: value.completion,
      ...(value.operation === undefined
        ? {}
        : { operation: value.operation as RequestJourneyOperation }),
      ...(value.protocol === undefined ? {} : { protocol: value.protocol }),
      ...(value.summary === undefined ? {} : { summary: value.summary }),
      location,
    }) satisfies StepCompletedPersistedObservation;
  }
  if (value.kind === "lane_committed") {
    if (
      !hasOnlyKeys(value, ["kind", "location", "lane"]) ||
      !LANES.has(value.lane as DataPlaneLane)
    ) {
      return undefined;
    }
    return Object.freeze({ kind: "lane_committed", lane: value.lane as DataPlaneLane, location }) satisfies LaneCommittedPersistedObservation;
  }
  if (value.kind === "model_resolved") {
    if (
      !hasOnlyKeys(value, [
        "kind",
        "location",
        "requestedModel",
        "providerId",
        "modelId",
      ]) ||
      !boundedText(value.requestedModel, MAX_ID_TEXT) ||
      !boundedText(value.providerId, MAX_ID_TEXT) ||
      !boundedText(value.modelId, MAX_ID_TEXT)
    ) {
      return undefined;
    }
    return Object.freeze({
      kind: "model_resolved",
      requestedModel: value.requestedModel,
      providerId: value.providerId,
      modelId: value.modelId,
      location,
    }) satisfies ModelResolvedPersistedObservation;
  }
  if (value.kind === "request_identity_established") {
    if (
      !hasOnlyKeys(value, [
        "kind",
        "location",
        "effectiveSessionId",
        "clientSessionId",
      ]) ||
      !boundedText(value.effectiveSessionId, MAX_ID_TEXT) ||
      (value.clientSessionId !== undefined &&
        !boundedText(value.clientSessionId, MAX_ID_TEXT))
    ) {
      return undefined;
    }
    return Object.freeze({
      kind: "request_identity_established",
      effectiveSessionId: value.effectiveSessionId,
      ...(value.clientSessionId === undefined
        ? {}
        : { clientSessionId: value.clientSessionId }),
      location,
    }) satisfies RequestIdentityEstablishedPersistedObservation;
  }
  if (value.kind === "profile_attributed") {
    if (
      !hasOnlyKeys(value, ["kind", "location", "profileId", "displayName"]) ||
      !boundedText(value.profileId, MAX_ID_TEXT) ||
      !boundedText(value.displayName, 256)
    ) {
      return undefined;
    }
    return Object.freeze({ kind: "profile_attributed", profileId: value.profileId, displayName: value.displayName, location }) satisfies ProfileAttributedPersistedObservation;
  }
  if (value.kind === "attempt_observed") {
    if (
      !hasOnlyKeys(value, [
        "kind",
        "location",
        "attempt",
        "profileId",
        "status",
        "transition",
      ]) ||
      !Number.isSafeInteger(value.attempt) ||
      (value.attempt as number) < 1 ||
      (value.profileId !== undefined &&
        !boundedText(value.profileId, MAX_ID_TEXT)) ||
      (value.status !== undefined &&
        (!Number.isSafeInteger(value.status) ||
          (value.status as number) < 100 ||
          (value.status as number) > 599)) ||
      (value.transition !== undefined &&
        value.transition !== "started" &&
        value.transition !== "response" &&
        value.transition !== "retry" &&
        value.transition !== "terminal")
    ) {
      return undefined;
    }
    return Object.freeze({
      kind: "attempt_observed",
      attempt: value.attempt as number,
      ...(value.profileId === undefined ? {} : { profileId: value.profileId }),
      ...(value.status === undefined ? {} : { status: value.status as number }),
      ...(value.transition === undefined
        ? {}
        : {
            transition: value.transition as NonNullable<
              AttemptObservedPersistedObservation["transition"]
            >,
          }),
      location,
    }) satisfies AttemptObservedPersistedObservation;
  }
  if (value.kind === "conversion_notice_observed") {
    if (
      !hasOnlyKeys(value, ["kind", "location", "code", "severity"]) ||
      !boundedText(value.code, 256) ||
      (value.severity !== "info" &&
        value.severity !== "warning" &&
        value.severity !== "error")
    ) {
      return undefined;
    }
    return Object.freeze({ kind: "conversion_notice_observed", code: value.code, severity: value.severity, location }) satisfies ConversionNoticePersistedObservation;
  }
  if (value.kind === "artifact_observed") {
    if (
      !hasOnlyKeys(value, [
        "kind",
        "location",
        "artifactId",
        "artifactKind",
        "state",
        "mediaType",
        "originalBytes",
        "capturedBytes",
        "redaction",
        "truncated",
        "integrityHash",
        "reason",
      ])
    ) {
      return undefined;
    }
    const fields = decodeArtifactFields(value);
    return fields === undefined
      ? undefined
      : Object.freeze({ kind: "artifact_observed", ...fields, location });
  }
  if (value.kind === "failure_detected") {
    return decodeFailureObservation(value, location);
  }
  if (value.kind === "work_outcome_committed") {
    if (
      !hasOnlyKeys(value, [
        "kind",
        "location",
        "outcome",
        "requestOutcome",
        "terminalAuthority",
      ]) ||
      (value.outcome !== "success" &&
        value.outcome !== "failed" &&
        value.outcome !== "aborted") ||
      (value.requestOutcome !== undefined &&
        !ANALYTICS_OUTCOMES.has(value.requestOutcome as RequestAnalyticsOutcome)) ||
      !boundedText(value.terminalAuthority, 256)
    ) {
      return undefined;
    }
    return Object.freeze({
      kind: "work_outcome_committed",
      outcome: value.outcome,
      ...(value.requestOutcome === undefined
        ? {}
        : { requestOutcome: value.requestOutcome as RequestAnalyticsOutcome }),
      terminalAuthority: value.terminalAuthority,
      location,
    }) satisfies WorkOutcomeCommittedPersistedObservation;
  }
  if (value.kind === "terminal_usage_observed") {
    if (!hasOnlyKeys(value, ["kind", "location", "usage"])) return undefined;
    const usage = decodeTerminalUsageFact(value.usage);
    return usage === undefined
      ? undefined
      : Object.freeze({ kind: "terminal_usage_observed", usage, location }) satisfies TerminalUsagePersistedObservation;
  }
  if (value.kind === "client_response_prepared") {
    if (
      !hasOnlyKeys(value, ["kind", "location", "status", "mediaType"]) ||
      !Number.isSafeInteger(value.status) ||
      (value.status as number) < 100 ||
      (value.status as number) > 599 ||
      (value.mediaType !== undefined &&
        !boundedText(value.mediaType, MAX_MEDIA_TYPE_TEXT))
    ) {
      return undefined;
    }
    return Object.freeze({
      kind: "client_response_prepared",
      status: value.status as number,
      ...(value.mediaType === undefined ? {} : { mediaType: value.mediaType }),
      location,
    }) satisfies ClientResponsePreparedPersistedObservation;
  }
  if (value.kind === "handoff_observed") {
    if (
      !hasOnlyKeys(value, [
        "kind",
        "location",
        "outcome",
        "transport",
        "writableFinished",
      ]) ||
      (value.outcome !== "prepared" &&
        value.outcome !== "finished" &&
        value.outcome !== "closed" &&
        value.outcome !== "failed") ||
      (value.transport !== "http" &&
        value.transport !== "websocket" &&
        value.transport !== "in_process") ||
      (value.writableFinished !== undefined &&
        typeof value.writableFinished !== "boolean")
    ) {
      return undefined;
    }
    return Object.freeze({
      kind: "handoff_observed",
      outcome: value.outcome,
      transport: value.transport,
      ...(value.writableFinished === undefined
        ? {}
        : { writableFinished: value.writableFinished }),
      location,
    }) satisfies HandoffPersistedObservation;
  }
  return undefined;
}

function decodeTimelineEvent(value: unknown): RequestJourneyTimelineEvent | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["runtimeId", "requestId", "sequence", "time", "observation"]) ||
    !boundedText(value.runtimeId, MAX_ID_TEXT) ||
    !boundedText(value.requestId, MAX_ID_TEXT) ||
    !isNonNegativeSafeInteger(value.sequence) ||
    !isNonNegativeSafeInteger(value.time)
  ) {
    return undefined;
  }
  const observation = decodePersistedObservation(value.observation);
  return observation === undefined
    ? undefined
    : Object.freeze({
        runtimeId: value.runtimeId,
        requestId: value.requestId,
        sequence: value.sequence,
        time: value.time,
        observation,
      });
}

function decodeArtifactDescriptor(value: unknown): RequestArtifactDescriptor | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "artifactId",
      "artifactKind",
      "state",
      "mediaType",
      "originalBytes",
      "capturedBytes",
      "redaction",
      "truncated",
      "integrityHash",
      "reason",
    ]) ||
    (value.redaction !== "not_required" &&
      value.redaction !== "applied" &&
      value.redaction !== "failed") ||
    typeof value.truncated !== "boolean"
  ) {
    return undefined;
  }
  const fields = decodeArtifactFields(value);
  return fields === undefined
    ? undefined
    : Object.freeze({ ...fields, redaction: value.redaction, truncated: value.truncated });
}

function decodeIncident(value: unknown): RequestIncident | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["primaryFailureId", "failures"]) ||
    !boundedText(value.primaryFailureId, MAX_ID_TEXT) ||
    !Array.isArray(value.failures) ||
    value.failures.length < 1 ||
    value.failures.length > MAX_REQUEST_DIAGNOSTICS_DETAIL_ITEMS
  ) {
    return undefined;
  }
  const failures: FailureDetectedPersistedObservation[] = [];
  for (const raw of value.failures) {
    const failure = decodePersistedObservation(raw);
    if (failure?.kind !== "failure_detected") return undefined;
    failures.push(failure);
  }
  if (
    !failures.some(
      (failure) =>
        failure.failureId === value.primaryFailureId && failure.role === "primary",
    )
  ) {
    return undefined;
  }
  return Object.freeze({ primaryFailureId: value.primaryFailureId, failures: Object.freeze(failures) });
}

function decodeWorkOutcome(value: unknown): RequestWorkOutcome | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["outcome", "requestOutcome", "terminalAuthority", "location"]) ||
    (value.outcome !== "success" && value.outcome !== "failed" && value.outcome !== "aborted") ||
    (value.requestOutcome !== undefined &&
      !ANALYTICS_OUTCOMES.has(value.requestOutcome as RequestAnalyticsOutcome)) ||
    !boundedText(value.terminalAuthority, 256)
  ) {
    return undefined;
  }
  const location = decodeRequestJourneyLocation(value.location);
  return location === undefined
    ? undefined
    : Object.freeze({
        outcome: value.outcome,
        ...(value.requestOutcome === undefined
          ? {}
          : { requestOutcome: value.requestOutcome as RequestAnalyticsOutcome }),
        terminalAuthority: value.terminalAuthority,
        location,
      });
}

function decodeClientPresentation(value: unknown): ClientResponsePresentation | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["status", "mediaType", "location"]) ||
    !Number.isSafeInteger(value.status) ||
    (value.status as number) < 100 ||
    (value.status as number) > 599 ||
    (value.mediaType !== undefined &&
      !boundedText(value.mediaType, MAX_MEDIA_TYPE_TEXT))
  ) {
    return undefined;
  }
  const location = decodeRequestJourneyLocation(value.location);
  return location === undefined
    ? undefined
    : Object.freeze({
        status: value.status as number,
        ...(value.mediaType === undefined ? {} : { mediaType: value.mediaType }),
        location,
      });
}

function decodeHandoffOutcome(value: unknown): RequestHandoffOutcome | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["outcome", "transport", "writableFinished", "location"]) ||
    (value.outcome !== "prepared" &&
      value.outcome !== "finished" &&
      value.outcome !== "closed" &&
      value.outcome !== "failed") ||
    (value.transport !== "http" &&
      value.transport !== "websocket" &&
      value.transport !== "in_process") ||
    (value.writableFinished !== undefined && typeof value.writableFinished !== "boolean")
  ) {
    return undefined;
  }
  const location = decodeRequestJourneyLocation(value.location);
  return location === undefined
    ? undefined
    : Object.freeze({
        outcome: value.outcome,
        transport: value.transport,
        ...(value.writableFinished === undefined
          ? {}
          : { writableFinished: value.writableFinished }),
        location,
      });
}

export function decodeRequestJourneySummary(
  value: unknown,
): RequestJourneySummary | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "id",
      "runtimeId",
      "requestId",
      "operation",
      "protocol",
      "lane",
      "requestedModel",
      "providerId",
      "realModelId",
      "clientSessionId",
      "effectiveSessionId",
      "profileId",
      "profileDisplayName",
      "httpStatus",
      "outcome",
      "completeness",
      "createdAt",
      "closedAt",
      "primaryFailureLocation",
      "usage",
    ]) ||
    !Number.isSafeInteger(value.id) ||
    (value.id as number) < 1 ||
    !boundedText(value.runtimeId, MAX_ID_TEXT) ||
    !boundedText(value.requestId, MAX_ID_TEXT) ||
    !OPERATIONS.has(value.operation as RequestJourneyOperationCandidate) ||
    (value.protocol !== undefined &&
      !boundedText(value.protocol, MAX_PROTOCOL_TEXT)) ||
    (value.lane !== undefined && !LANES.has(value.lane as DataPlaneLane)) ||
    (value.requestedModel !== undefined &&
      !boundedText(value.requestedModel, MAX_ID_TEXT)) ||
    (value.providerId !== undefined &&
      !boundedText(value.providerId, MAX_ID_TEXT)) ||
    (value.realModelId !== undefined &&
      !boundedText(value.realModelId, MAX_ID_TEXT)) ||
    (value.clientSessionId !== undefined &&
      !boundedText(value.clientSessionId, MAX_ID_TEXT)) ||
    (value.effectiveSessionId !== undefined &&
      !boundedText(value.effectiveSessionId, MAX_ID_TEXT)) ||
    (value.profileId !== undefined &&
      !boundedText(value.profileId, MAX_ID_TEXT)) ||
    (value.profileDisplayName !== undefined &&
      !boundedText(value.profileDisplayName, 256)) ||
    (value.httpStatus !== undefined &&
      (!Number.isSafeInteger(value.httpStatus) ||
        (value.httpStatus as number) < 100 ||
        (value.httpStatus as number) > 599)) ||
    !OUTCOMES.has(value.outcome as RequestJourneyOutcome | "running") ||
    (value.completeness !== "complete" && value.completeness !== "degraded") ||
    !isNonNegativeSafeInteger(value.createdAt) ||
    (value.closedAt !== undefined &&
      (!isNonNegativeSafeInteger(value.closedAt) ||
        (value.closedAt as number) < value.createdAt)) ||
    ((value.outcome === "running") !== (value.closedAt === undefined))
  ) {
    return undefined;
  }
  const primaryFailureLocation =
    value.primaryFailureLocation === undefined
      ? undefined
      : decodeRequestJourneyLocation(value.primaryFailureLocation);
  if (
    value.primaryFailureLocation !== undefined &&
    primaryFailureLocation === undefined
  ) {
    return undefined;
  }
  const usage =
    value.usage === undefined
      ? undefined
      : decodeRequestJourneyUsageSummary(value.usage);
  if (value.usage !== undefined && usage === undefined) return undefined;
  return Object.freeze({
    id: value.id as number,
    runtimeId: value.runtimeId,
    requestId: value.requestId,
    operation: value.operation as RequestJourneyOperationCandidate,
    ...(value.protocol === undefined ? {} : { protocol: value.protocol }),
    ...(value.lane === undefined ? {} : { lane: value.lane as DataPlaneLane }),
    ...(value.requestedModel === undefined
      ? {}
      : { requestedModel: value.requestedModel }),
    ...(value.providerId === undefined ? {} : { providerId: value.providerId }),
    ...(value.realModelId === undefined ? {} : { realModelId: value.realModelId }),
    ...(value.clientSessionId === undefined
      ? {}
      : { clientSessionId: value.clientSessionId }),
    ...(value.effectiveSessionId === undefined
      ? {}
      : { effectiveSessionId: value.effectiveSessionId }),
    ...(value.profileId === undefined ? {} : { profileId: value.profileId }),
    ...(value.profileDisplayName === undefined
      ? {}
      : { profileDisplayName: value.profileDisplayName }),
    ...(value.httpStatus === undefined
      ? {}
      : { httpStatus: value.httpStatus as number }),
    outcome: value.outcome as RequestJourneyOutcome | "running",
    completeness: value.completeness,
    createdAt: value.createdAt,
    ...(value.closedAt === undefined ? {} : { closedAt: value.closedAt as number }),
    ...(primaryFailureLocation === undefined ? {} : { primaryFailureLocation }),
    ...(usage === undefined ? {} : { usage }),
  });
}

export function decodeRequestJourneyRecord(
  value: unknown,
): RequestJourneyRecord | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "id",
      "runtimeId",
      "requestId",
      "operation",
      "protocol",
      "lane",
      "requestedModel",
      "providerId",
      "realModelId",
      "clientSessionId",
      "effectiveSessionId",
      "profileId",
      "profileDisplayName",
      "httpStatus",
      "outcome",
      "completeness",
      "createdAt",
      "closedAt",
      "primaryFailureLocation",
      "usage",
      "admission",
      "timeline",
      "artifacts",
      "incident",
      "workOutcome",
      "clientPresentation",
      "handoffOutcome",
    ]) ||
    !Array.isArray(value.timeline) ||
    value.timeline.length > MAX_REQUEST_DIAGNOSTICS_DETAIL_ITEMS ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.length > MAX_REQUEST_DIAGNOSTICS_DETAIL_ITEMS
  ) {
    return undefined;
  }
  const summary = decodeRequestJourneySummary({
    id: value.id,
    runtimeId: value.runtimeId,
    requestId: value.requestId,
    operation: value.operation,
    ...(value.protocol === undefined ? {} : { protocol: value.protocol }),
    ...(value.lane === undefined ? {} : { lane: value.lane }),
    ...(value.requestedModel === undefined
      ? {}
      : { requestedModel: value.requestedModel }),
    ...(value.providerId === undefined ? {} : { providerId: value.providerId }),
    ...(value.realModelId === undefined ? {} : { realModelId: value.realModelId }),
    ...(value.clientSessionId === undefined
      ? {}
      : { clientSessionId: value.clientSessionId }),
    ...(value.effectiveSessionId === undefined
      ? {}
      : { effectiveSessionId: value.effectiveSessionId }),
    ...(value.profileId === undefined ? {} : { profileId: value.profileId }),
    ...(value.profileDisplayName === undefined
      ? {}
      : { profileDisplayName: value.profileDisplayName }),
    ...(value.httpStatus === undefined ? {} : { httpStatus: value.httpStatus }),
    outcome: value.outcome,
    completeness: value.completeness,
    createdAt: value.createdAt,
    ...(value.closedAt === undefined ? {} : { closedAt: value.closedAt }),
    ...(value.primaryFailureLocation === undefined
      ? {}
      : { primaryFailureLocation: value.primaryFailureLocation }),
    ...(value.usage === undefined ? {} : { usage: value.usage }),
  });
  const admission = decodeAdmission(value.admission);
  if (summary === undefined || admission === undefined) return undefined;

  const timeline: RequestJourneyTimelineEvent[] = [];
  for (const raw of value.timeline) {
    const event = decodeTimelineEvent(raw);
    if (
      event === undefined ||
      event.runtimeId !== summary.runtimeId ||
      event.requestId !== summary.requestId
    ) {
      return undefined;
    }
    timeline.push(event);
  }
  const artifacts: RequestArtifactDescriptor[] = [];
  for (const raw of value.artifacts) {
    const artifact = decodeArtifactDescriptor(raw);
    if (artifact === undefined) return undefined;
    artifacts.push(artifact);
  }
  const incident =
    value.incident === undefined ? undefined : decodeIncident(value.incident);
  const workOutcome =
    value.workOutcome === undefined
      ? undefined
      : decodeWorkOutcome(value.workOutcome);
  const clientPresentation =
    value.clientPresentation === undefined
      ? undefined
      : decodeClientPresentation(value.clientPresentation);
  const handoffOutcome =
    value.handoffOutcome === undefined
      ? undefined
      : decodeHandoffOutcome(value.handoffOutcome);
  if (
    (value.incident !== undefined && incident === undefined) ||
    (value.workOutcome !== undefined && workOutcome === undefined) ||
    (value.clientPresentation !== undefined && clientPresentation === undefined) ||
    (value.handoffOutcome !== undefined && handoffOutcome === undefined)
  ) {
    return undefined;
  }
  return Object.freeze({
    ...summary,
    admission,
    timeline: Object.freeze(timeline),
    artifacts: Object.freeze(artifacts),
    ...(incident === undefined ? {} : { incident }),
    ...(workOutcome === undefined ? {} : { workOutcome }),
    ...(clientPresentation === undefined ? {} : { clientPresentation }),
    ...(handoffOutcome === undefined ? {} : { handoffOutcome }),
  });
}

export function decodeRequestJourneyQuery(
  value: unknown,
): RequestJourneyQuery | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "afterId",
      "limit",
      "from",
      "to",
      "excludeOperations",
    ])
  ) {
    return undefined;
  }
  if (
    value.afterId !== undefined &&
    !isNonNegativeSafeInteger(value.afterId)
  ) {
    return undefined;
  }
  if (
    value.limit !== undefined &&
    (!Number.isSafeInteger(value.limit) ||
      (value.limit as number) < 1 ||
      (value.limit as number) > MAX_REQUEST_DIAGNOSTICS_QUERY_LIMIT)
  ) {
    return undefined;
  }
  if (
    (value.from !== undefined && !isNonNegativeSafeInteger(value.from)) ||
    (value.to !== undefined && !isNonNegativeSafeInteger(value.to)) ||
    (value.from !== undefined &&
      value.to !== undefined &&
      (value.from as number) >= (value.to as number)) ||
    (value.excludeOperations !== undefined &&
      (!Array.isArray(value.excludeOperations) ||
        value.excludeOperations.length > OPERATIONS.size ||
        value.excludeOperations.some(
          (operation) => !OPERATIONS.has(operation as RequestJourneyOperationCandidate),
        )))
  ) {
    return undefined;
  }
  return Object.freeze({
    ...(value.afterId === undefined ? {} : { afterId: value.afterId as number }),
    ...(value.limit === undefined ? {} : { limit: value.limit as number }),
    ...(value.from === undefined ? {} : { from: value.from as number }),
    ...(value.to === undefined ? {} : { to: value.to as number }),
    ...(value.excludeOperations === undefined
      ? {}
      : {
          excludeOperations: Object.freeze(
            value.excludeOperations as RequestJourneyOperationCandidate[],
          ),
        }),
  });
}

export function decodeRequestJourneyQueryResult(
  value: unknown,
): RequestJourneyQueryResult | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["records", "hasMore"]) ||
    !Array.isArray(value.records) ||
    value.records.length > MAX_REQUEST_DIAGNOSTICS_QUERY_LIMIT ||
    typeof value.hasMore !== "boolean"
  ) {
    return undefined;
  }
  const records: RequestJourneySummary[] = [];
  for (const raw of value.records) {
    const record = decodeRequestJourneySummary(raw);
    if (record === undefined) return undefined;
    records.push(record);
  }
  return Object.freeze({ records: Object.freeze(records), hasMore: value.hasMore });
}

export function decodeRequestJourneyGetInput(
  value: unknown,
): RequestJourneyGetInput | undefined {
  return isRecord(value) &&
    hasOnlyKeys(value, ["requestId"]) &&
    boundedText(value.requestId, MAX_ID_TEXT)
    ? Object.freeze({ requestId: value.requestId })
    : undefined;
}

export function decodeRequestArtifactGetInput(
  value: unknown,
): RequestArtifactGetInput | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["requestId", "artifactId", "offset", "limit"]) ||
    !boundedText(value.requestId, MAX_ID_TEXT) ||
    !boundedText(value.artifactId, MAX_ID_TEXT) ||
    !isNonNegativeSafeInteger(value.offset) ||
    !Number.isSafeInteger(value.limit) ||
    (value.limit as number) < 1 ||
    (value.limit as number) > MAX_REQUEST_ARTIFACT_CHUNK_BYTES
  ) {
    return undefined;
  }
  return Object.freeze({
    requestId: value.requestId,
    artifactId: value.artifactId,
    offset: value.offset,
    limit: value.limit as number,
  });
}

export function decodeRequestArtifactReadResult(
  value: unknown,
): RequestArtifactReadResult | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "requestId",
      "artifactId",
      "offset",
      "nextOffset",
      "complete",
      "dataBase64",
    ]) ||
    !boundedText(value.requestId, MAX_ID_TEXT) ||
    !boundedText(value.artifactId, MAX_ID_TEXT) ||
    !isNonNegativeSafeInteger(value.offset) ||
    !isNonNegativeSafeInteger(value.nextOffset) ||
    value.nextOffset < value.offset ||
    typeof value.complete !== "boolean"
  ) {
    return undefined;
  }
  const byteLength = decodedBase64ByteLength(value.dataBase64);
  if (
    byteLength === undefined ||
    byteLength > MAX_REQUEST_ARTIFACT_CHUNK_BYTES ||
    value.nextOffset - value.offset !== byteLength
  ) {
    return undefined;
  }
  return Object.freeze({
    requestId: value.requestId,
    artifactId: value.artifactId,
    offset: value.offset,
    nextOffset: value.nextOffset,
    complete: value.complete,
    dataBase64: value.dataBase64 as string,
  });
}

export function decodeRuntimeEventQuery(
  value: unknown,
): RuntimeEventQuery | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !hasOnlyKeys(value, ["afterId", "limit"])) {
    return undefined;
  }
  if (
    (value.afterId !== undefined &&
      !isNonNegativeSafeInteger(value.afterId)) ||
    (value.limit !== undefined &&
      (!Number.isSafeInteger(value.limit) ||
        (value.limit as number) < 1 ||
        (value.limit as number) > MAX_REQUEST_DIAGNOSTICS_QUERY_LIMIT))
  ) {
    return undefined;
  }
  return Object.freeze({
    ...(value.afterId === undefined ? {} : { afterId: value.afterId as number }),
    ...(value.limit === undefined ? {} : { limit: value.limit as number }),
  });
}

export function decodeRuntimeEventRecord(
  value: unknown,
): RuntimeEventRecord | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "kind",
      "id",
      "runtimeId",
      "recordId",
      "sequence",
      "time",
      "level",
      "classification",
      "safeMessage",
    ]) ||
    value.kind !== "runtime_event" ||
    !Number.isSafeInteger(value.id) ||
    (value.id as number) < 1 ||
    !boundedText(value.runtimeId, MAX_ID_TEXT) ||
    !boundedText(value.recordId, MAX_ID_TEXT) ||
    !isNonNegativeSafeInteger(value.sequence) ||
    !isNonNegativeSafeInteger(value.time) ||
    (value.level !== "info" &&
      value.level !== "warning" &&
      value.level !== "error" &&
      value.level !== "critical") ||
    !boundedText(value.classification, 256) ||
    !boundedText(value.safeMessage, MAX_SAFE_TEXT)
  ) {
    return undefined;
  }
  return Object.freeze({
    kind: "runtime_event",
    id: value.id as number,
    runtimeId: value.runtimeId,
    recordId: value.recordId,
    sequence: value.sequence,
    time: value.time,
    level: value.level,
    classification: value.classification,
    safeMessage: value.safeMessage,
  });
}

export function decodeRuntimeEventQueryResult(
  value: unknown,
): RuntimeEventQueryResult | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["records", "hasMore"]) ||
    !Array.isArray(value.records) ||
    value.records.length > MAX_REQUEST_DIAGNOSTICS_QUERY_LIMIT ||
    typeof value.hasMore !== "boolean"
  ) {
    return undefined;
  }
  const records: RuntimeEventRecord[] = [];
  for (const raw of value.records) {
    const record = decodeRuntimeEventRecord(raw);
    if (record === undefined) return undefined;
    records.push(record);
  }
  return Object.freeze({ records: Object.freeze(records), hasMore: value.hasMore });
}

export function decodeRequestJourneyQueryReadResult(
  value: unknown,
): RequestJourneyQueryReadResult | undefined {
  return decodeReadResult(value, decodeRequestJourneyQueryResult);
}

export function decodeRequestJourneyDetailReadResult(
  value: unknown,
): RequestJourneyDetailReadResult | undefined {
  return decodeReadResult(value, decodeRequestJourneyRecord);
}

export function decodeRequestArtifactChunkReadResult(
  value: unknown,
): RequestArtifactChunkReadResult | undefined {
  return decodeReadResult(value, decodeRequestArtifactReadResult);
}

export function decodeRuntimeEventQueryReadResult(
  value: unknown,
): RuntimeEventQueryReadResult | undefined {
  return decodeReadResult(value, decodeRuntimeEventQueryResult);
}

export function decodeUnifiedDiagnosticsSubscriptionEvent(
  value: unknown,
): UnifiedDiagnosticsSubscriptionEvent | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["type", "record"])
  ) {
    return undefined;
  }
  if (value.type === "request_journey") {
    const record = decodeRequestJourneySummary(value.record);
    return record === undefined
      ? undefined
      : Object.freeze({ type: "request_journey", record });
  }
  if (value.type === "runtime_event") {
    const record = decodeRuntimeEventRecord(value.record);
    return record === undefined
      ? undefined
      : Object.freeze({ type: "runtime_event", record });
  }
  return undefined;
}
