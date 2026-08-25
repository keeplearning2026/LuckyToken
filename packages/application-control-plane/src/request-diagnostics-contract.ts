import type {
  NormalizedTerminalUsage,
  UsageCompletenessReason,
} from "@luckytoken/provider-contract/usage";

/** Maximum records returned by one unified diagnostics query. */
export const MAX_REQUEST_DIAGNOSTICS_QUERY_LIMIT = 1_000 as const;
/** Maximum lifecycle observations or artifact descriptors in one detail DTO. */
export const MAX_REQUEST_DIAGNOSTICS_DETAIL_ITEMS = 512 as const;
/** Maximum decoded bytes returned by one artifact read. */
export const MAX_REQUEST_ARTIFACT_CHUNK_BYTES = 256 * 1_024;

export type DataPlaneLane =
  | "direct"
  | "provider_native"
  | "semantic_conversion";

export type RequestJourneyPhase =
  | "http_admission"
  | "protocol_ingress"
  | "request_resolution"
  | "lane_request_preparation"
  | "upstream_execution"
  | "lane_response_processing"
  | "client_response_preparation"
  | "outcome_commit"
  | "http_handoff";

export type RequestJourneyDirection =
  | "client_to_pi"
  | "pi_to_provider"
  | "provider_to_pi"
  | "pi_to_client";

export type RequestJourneySubject =
  | "envelope"
  | "system"
  | "message"
  | "content"
  | "tool"
  | "tool_call"
  | "tool_result"
  | "reasoning"
  | "metadata"
  | "usage"
  | "stop_reason";

export type RequestJourneyOperation =
  | "model_generation"
  | "conversation_compaction"
  | "model_discovery"
  | "web_search"
  | "image_generation"
  | "realtime_session"
  | "unmatched_request"
  | "unsupported_transport";

export type RequestJourneyOperationCandidate =
  | RequestJourneyOperation
  | "pending";

export type RequestJourneyOutcome =
  | "success"
  | "failed"
  | "aborted"
  | "interrupted";

/** Bounded row-level usage projection for management clients. Incomplete
 * terminal usage never carries component values because those values are not
 * certified for product display or aggregation. */
export type RequestJourneyUsageSummary =
  | Readonly<{
      readonly completeness: "complete";
      readonly inputTokens: number;
      readonly cacheReadTokens: number;
      readonly outputTokens: number;
      readonly cacheHitRate?: number;
      readonly outputTokensPerSecond?: number;
    }>
  | Readonly<{
      readonly completeness: "partial" | "unavailable";
      readonly reason: UsageCompletenessReason;
    }>;

export interface RequestJourneyLocation {
  readonly phase: RequestJourneyPhase;
  readonly lane?: DataPlaneLane;
  readonly direction?: RequestJourneyDirection;
  readonly step: string;
  readonly subject?: RequestJourneySubject;
  readonly sourcePath?: string;
  readonly attempt?: number;
}

export interface RequestJourneySummary {
  /** Global diagnostics-record cursor. */
  readonly id: number;
  readonly runtimeId: string;
  readonly requestId: string;
  readonly operation: RequestJourneyOperationCandidate;
  readonly protocol?: string;
  readonly lane?: DataPlaneLane;
  /** Client-visible model selector captured at request time. */
  readonly requestedModel?: string;
  readonly providerId?: string;
  readonly realModelId?: string;
  readonly clientSessionId?: string;
  readonly effectiveSessionId?: string;
  readonly profileId?: string;
  readonly profileDisplayName?: string;
  /** Final HTTP status prepared for the client. */
  readonly httpStatus?: number;
  readonly outcome: RequestJourneyOutcome | "running";
  readonly completeness: "complete" | "degraded";
  readonly createdAt: number;
  readonly closedAt?: number;
  readonly primaryFailureLocation?: RequestJourneyLocation;
  readonly usage?: RequestJourneyUsageSummary;
}

export interface RequestCancellationSnapshot {
  readonly caller: "active" | "aborted";
  readonly shutdown: "not_bound" | "active" | "aborted";
  readonly timeoutMs?: number;
}

export interface RequestJourneyAdmission {
  readonly operationCandidate: RequestJourneyOperationCandidate;
  readonly transport: "http" | "websocket" | "in_process";
  readonly method: string;
  readonly path: string;
  readonly acceptedAt: number;
  readonly cancellation: RequestCancellationSnapshot;
}

interface LocatedPersistedObservation {
  readonly location: RequestJourneyLocation;
}

export interface StepEnteredPersistedObservation
  extends LocatedPersistedObservation {
  readonly kind: "step_entered";
  readonly stepInstanceId: string;
}

export interface StepCompletedPersistedObservation
  extends LocatedPersistedObservation {
  readonly kind: "step_completed";
  readonly stepInstanceId: string;
  readonly completion: "success" | "failed" | "aborted";
  readonly operation?: RequestJourneyOperation;
  readonly protocol?: string;
  readonly summary?: string;
}

export interface LaneCommittedPersistedObservation
  extends LocatedPersistedObservation {
  readonly kind: "lane_committed";
  readonly lane: DataPlaneLane;
}

export interface ModelResolvedPersistedObservation
  extends LocatedPersistedObservation {
  readonly kind: "model_resolved";
  readonly requestedModel: string;
  readonly providerId: string;
  readonly modelId: string;
}

export interface RequestIdentityEstablishedPersistedObservation
  extends LocatedPersistedObservation {
  readonly kind: "request_identity_established";
  readonly effectiveSessionId: string;
  readonly clientSessionId?: string;
}

export interface ProfileAttributedPersistedObservation
  extends LocatedPersistedObservation {
  readonly kind: "profile_attributed";
  readonly profileId: string;
  readonly displayName: string;
}

export interface AttemptObservedPersistedObservation
  extends LocatedPersistedObservation {
  readonly kind: "attempt_observed";
  readonly attempt: number;
  readonly profileId?: string;
  readonly status?: number;
  readonly transition?: "started" | "response" | "retry" | "terminal";
}

export interface ConversionNoticePersistedObservation
  extends LocatedPersistedObservation {
  readonly kind: "conversion_notice_observed";
  readonly code: string;
  readonly severity: "info" | "warning" | "error";
}

export type RequestArtifactState =
  | "captured"
  | "partial"
  | "unavailable"
  | "not_applicable";

export interface ArtifactPersistedObservation
  extends LocatedPersistedObservation {
  readonly kind: "artifact_observed";
  readonly artifactId: string;
  readonly artifactKind: string;
  readonly state: RequestArtifactState;
  readonly mediaType?: string;
  readonly originalBytes?: number;
  readonly capturedBytes?: number;
  readonly redaction?: "not_required" | "applied" | "failed";
  readonly truncated?: boolean;
  readonly integrityHash?: string;
  readonly reason?: string;
}

export interface FailureDetectedPersistedObservation
  extends LocatedPersistedObservation {
  readonly kind: "failure_detected";
  readonly failureId: string;
  readonly role: "primary" | "supporting";
  readonly classification: string;
  readonly origin: "client" | "luckytoken" | "provider" | "network_os";
  readonly originPrecision: "exact" | "boundary" | "external_boundary";
  readonly safeMessage?: string;
  readonly exceptionFingerprint?: string;
}

export type RequestAnalyticsOutcome =
  | "success"
  | "failed"
  | "aborted"
  | "rejected-auth"
  | "unknown-alias"
  | "unavailable-alias";

export interface WorkOutcomeCommittedPersistedObservation
  extends LocatedPersistedObservation {
  readonly kind: "work_outcome_committed";
  readonly outcome: "success" | "failed" | "aborted";
  readonly requestOutcome?: RequestAnalyticsOutcome;
  readonly terminalAuthority: string;
}

export interface TerminalUsagePersistedObservation
  extends LocatedPersistedObservation {
  readonly kind: "terminal_usage_observed";
  readonly usage: NormalizedTerminalUsage;
}

export interface ClientResponsePreparedPersistedObservation
  extends LocatedPersistedObservation {
  readonly kind: "client_response_prepared";
  readonly status: number;
  readonly mediaType?: string;
}

export interface HandoffPersistedObservation extends LocatedPersistedObservation {
  readonly kind: "handoff_observed";
  readonly outcome: "prepared" | "finished" | "closed" | "failed";
  readonly transport: "http" | "websocket" | "in_process";
  readonly writableFinished?: boolean;
}

export type RequestJourneyPersistedObservation =
  | StepEnteredPersistedObservation
  | StepCompletedPersistedObservation
  | LaneCommittedPersistedObservation
  | ModelResolvedPersistedObservation
  | RequestIdentityEstablishedPersistedObservation
  | ProfileAttributedPersistedObservation
  | AttemptObservedPersistedObservation
  | ConversionNoticePersistedObservation
  | ArtifactPersistedObservation
  | FailureDetectedPersistedObservation
  | WorkOutcomeCommittedPersistedObservation
  | TerminalUsagePersistedObservation
  | ClientResponsePreparedPersistedObservation
  | HandoffPersistedObservation;

export interface RequestJourneyTimelineEvent {
  readonly runtimeId: string;
  readonly requestId: string;
  readonly sequence: number;
  readonly time: number;
  readonly observation: RequestJourneyPersistedObservation;
}

export interface RequestArtifactDescriptor {
  readonly artifactId: string;
  readonly artifactKind: string;
  readonly state: RequestArtifactState;
  readonly mediaType?: string;
  readonly originalBytes?: number;
  readonly capturedBytes?: number;
  readonly redaction: "not_required" | "applied" | "failed";
  readonly truncated: boolean;
  readonly integrityHash?: string;
  readonly reason?: string;
}

export interface RequestIncident {
  readonly primaryFailureId: string;
  readonly failures: readonly FailureDetectedPersistedObservation[];
}

export interface RequestWorkOutcome {
  readonly outcome: "success" | "failed" | "aborted";
  readonly requestOutcome?: RequestAnalyticsOutcome;
  readonly terminalAuthority: string;
  readonly location: RequestJourneyLocation;
}

export interface ClientResponsePresentation {
  readonly status: number;
  readonly mediaType?: string;
  readonly location: RequestJourneyLocation;
}

export interface RequestHandoffOutcome {
  readonly outcome: "prepared" | "finished" | "closed" | "failed";
  readonly transport: "http" | "websocket" | "in_process";
  readonly writableFinished?: boolean;
  readonly location: RequestJourneyLocation;
}

export interface RequestJourneyRecord extends RequestJourneySummary {
  readonly admission: RequestJourneyAdmission;
  readonly timeline: readonly RequestJourneyTimelineEvent[];
  readonly artifacts: readonly RequestArtifactDescriptor[];
  readonly incident?: RequestIncident;
  readonly workOutcome?: RequestWorkOutcome;
  readonly clientPresentation?: ClientResponsePresentation;
  readonly handoffOutcome?: RequestHandoffOutcome;
}

export interface RequestJourneyQuery {
  /** Global diagnostics-record cursor; results are strictly newer. */
  readonly afterId?: number;
  /** Defaults to 100 at the authority; the wire accepts 1..1,000. */
  readonly limit?: number;
}

export interface RequestJourneyQueryResult {
  readonly records: readonly RequestJourneySummary[];
  readonly hasMore: boolean;
}

export interface RequestJourneyGetInput {
  readonly requestId: string;
}

export interface RequestArtifactGetInput {
  readonly requestId: string;
  readonly artifactId: string;
  readonly offset: number;
  readonly limit: number;
}

export interface RequestArtifactReadResult {
  readonly requestId: string;
  readonly artifactId: string;
  readonly offset: number;
  readonly nextOffset: number;
  readonly complete: boolean;
  readonly dataBase64: string;
}

export interface RuntimeEventRecord {
  readonly kind: "runtime_event";
  /** Global diagnostics-record cursor shared with Request Journeys. */
  readonly id: number;
  readonly runtimeId: string;
  readonly recordId: string;
  readonly sequence: number;
  readonly time: number;
  readonly level: "info" | "warning" | "error" | "critical";
  readonly classification: string;
  readonly safeMessage: string;
}

export interface RuntimeEventQuery {
  readonly afterId?: number;
  readonly limit?: number;
}

export interface RuntimeEventQueryResult {
  readonly records: readonly RuntimeEventRecord[];
  readonly hasMore: boolean;
}

export interface DiagnosticsUnavailableProjection {
  readonly code: "diagnostics_unavailable";
  readonly classification: "diagnostics_storage_unavailable";
  readonly message: "Diagnostics storage is unavailable";
}

export interface DiagnosticsUnavailableResult {
  readonly outcome: "unavailable";
  readonly error: DiagnosticsUnavailableProjection;
}

export type DiagnosticsReadResult<T> =
  | { readonly outcome: "ok"; readonly result: T }
  | DiagnosticsUnavailableResult;

export type RequestJourneyQueryReadResult =
  DiagnosticsReadResult<RequestJourneyQueryResult>;
export type RequestJourneyDetailReadResult =
  DiagnosticsReadResult<RequestJourneyRecord>;
export type RequestArtifactChunkReadResult =
  DiagnosticsReadResult<RequestArtifactReadResult>;
export type RuntimeEventQueryReadResult =
  DiagnosticsReadResult<RuntimeEventQueryResult>;

export interface RequestJourneySubscriptionEvent {
  readonly type: "request_journey";
  readonly record: RequestJourneySummary;
}

export interface RuntimeEventSubscriptionEvent {
  readonly type: "runtime_event";
  readonly record: RuntimeEventRecord;
}

export type UnifiedDiagnosticsSubscriptionEvent =
  | RequestJourneySubscriptionEvent
  | RuntimeEventSubscriptionEvent;

export interface DiagnosticsSubscription {
  unsubscribe(): void;
}

export type RequestJourneySubscriber = (
  record: RequestJourneySummary,
) => void | PromiseLike<void>;

export type RuntimeEventSubscriber = (
  record: RuntimeEventRecord,
) => void | PromiseLike<void>;

/** Backend-owned management view projected by the Control Plane. */
export interface UnifiedDiagnosticsManagement {
  queryRequestJourneys(
    query?: RequestJourneyQuery,
  ): Promise<RequestJourneyQueryResult>;
  getRequestJourney(
    input: RequestJourneyGetInput,
  ): Promise<RequestJourneyRecord>;
  getRequestArtifact(
    input: RequestArtifactGetInput,
  ): Promise<RequestArtifactReadResult>;
  queryRuntimeEvents(
    query?: RuntimeEventQuery,
  ): Promise<RuntimeEventQueryResult>;
  subscribeRequestJourneys(
    listener: RequestJourneySubscriber,
  ): DiagnosticsSubscription;
  subscribeRuntimeEvents(listener: RuntimeEventSubscriber): DiagnosticsSubscription;
}
