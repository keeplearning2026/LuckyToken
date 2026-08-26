import type { TerminalUsageFact } from "@token/provider-contract/usage";

export const REQUEST_JOURNEY_PHASES = Object.freeze([
  "http_admission",
  "protocol_ingress",
  "request_resolution",
  "lane_request_preparation",
  "upstream_execution",
  "lane_response_processing",
  "client_response_preparation",
  "outcome_commit",
  "http_handoff",
] as const);

export type RequestJourneyPhase = (typeof REQUEST_JOURNEY_PHASES)[number];

export type DataPlaneLane =
  | "direct"
  | "provider_native"
  | "semantic_conversion";

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

export type RequestJourneyOutcome =
  | "success"
  | "failed"
  | "aborted"
  | "interrupted";

export type RequestJourneyOperationCandidate =
  | RequestJourneyOperation
  | "pending";

export interface RequestCancellationSnapshot {
  readonly caller: "active" | "aborted";
  readonly shutdown: "not_bound" | "active" | "aborted";
  readonly timeoutMs?: number;
}

export interface RequestJourneyLocation {
  readonly phase: RequestJourneyPhase;
  readonly lane?: DataPlaneLane;
  readonly direction?: RequestJourneyDirection;
  readonly step: string;
  readonly subject?: RequestJourneySubject;
  readonly sourcePath?: string;
  readonly attempt?: number;
}

export interface RequestJourneyBeginInput {
  readonly requestId: string;
  readonly operationCandidate: RequestJourneyOperationCandidate;
  readonly transport: "http" | "websocket" | "in_process";
  readonly method: string;
  readonly path: string;
  readonly acceptedAt: number;
  readonly cancellation: RequestCancellationSnapshot;
}

interface LocatedObservation {
  readonly location: RequestJourneyLocation;
}

export interface StepEnteredObservation extends LocatedObservation {
  readonly kind: "step_entered";
  readonly stepInstanceId: string;
}

export interface StepCompletedObservation extends LocatedObservation {
  readonly kind: "step_completed";
  readonly stepInstanceId: string;
  readonly completion: "success" | "failed" | "aborted";
  readonly operation?: RequestJourneyOperation;
  readonly protocol?: string;
  readonly summary?: string;
}

export interface LaneCommittedObservation extends LocatedObservation {
  readonly kind: "lane_committed";
  readonly lane: DataPlaneLane;
}

export interface ModelResolvedObservation extends LocatedObservation {
  readonly kind: "model_resolved";
  /** Client-visible model selector captured at request time. */
  readonly requestedModel: string;
  readonly providerId: string;
  readonly modelId: string;
}

export interface RequestIdentityEstablishedObservation
  extends LocatedObservation {
  readonly kind: "request_identity_established";
  readonly effectiveSessionId: string;
  readonly clientSessionId?: string;
}

export interface ProfileAttributedObservation extends LocatedObservation {
  readonly kind: "profile_attributed";
  readonly profileId: string;
  readonly displayName: string;
}

export interface AttemptObservedObservation extends LocatedObservation {
  readonly kind: "attempt_observed";
  readonly attempt: number;
  readonly profileId?: string;
  readonly status?: number;
  readonly transition?: "started" | "response" | "retry" | "terminal";
}

export interface ConversionNoticeObservedObservation
  extends LocatedObservation {
  readonly kind: "conversion_notice_observed";
  readonly code: string;
  readonly severity: "info" | "warning" | "error";
}

export type RequestArtifactState =
  | "captured"
  | "partial"
  | "unavailable"
  | "not_applicable";

export interface ArtifactObservedObservation extends LocatedObservation {
  readonly kind: "artifact_observed";
  readonly artifactId: string;
  readonly artifactKind: string;
  readonly state: RequestArtifactState;
  readonly mediaType?: string;
  readonly bytes?: Uint8Array;
  readonly originalBytes?: number;
  readonly capturedBytes?: number;
  readonly redaction?: "not_required" | "applied" | "failed";
  readonly truncated?: boolean;
  readonly integrityHash?: string;
  readonly reason?: string;
}

export interface FailureDetectedObservation extends LocatedObservation {
  readonly kind: "failure_detected";
  readonly failureId: string;
  readonly role: "primary" | "supporting";
  readonly classification: string;
  readonly origin: "client" | "Token" | "provider" | "network_os";
  readonly originPrecision: "exact" | "boundary" | "external_boundary";
  readonly safeMessage?: string;
  readonly exceptionFingerprint?: string;
}

export interface WorkOutcomeCommittedObservation extends LocatedObservation {
  readonly kind: "work_outcome_committed";
  readonly outcome: "success" | "failed" | "aborted";
  readonly requestOutcome?:
    | "success"
    | "failed"
    | "aborted"
    | "rejected-auth"
    | "unknown-alias"
    | "unavailable-alias";
  readonly terminalAuthority: string;
}

export interface TerminalUsageObservedObservation extends LocatedObservation {
  readonly kind: "terminal_usage_observed";
  readonly usage: TerminalUsageFact;
}

export interface ClientResponsePreparedObservation extends LocatedObservation {
  readonly kind: "client_response_prepared";
  readonly status: number;
  readonly mediaType?: string;
}

export interface HandoffObservedObservation extends LocatedObservation {
  readonly kind: "handoff_observed";
  readonly outcome: "prepared" | "finished" | "closed" | "failed";
  readonly transport: "http" | "websocket" | "in_process";
  readonly writableFinished?: boolean;
}

export type RequestJourneyObservationInput =
  | StepEnteredObservation
  | StepCompletedObservation
  | LaneCommittedObservation
  | ModelResolvedObservation
  | RequestIdentityEstablishedObservation
  | ProfileAttributedObservation
  | AttemptObservedObservation
  | ConversionNoticeObservedObservation
  | ArtifactObservedObservation
  | FailureDetectedObservation
  | TerminalUsageObservedObservation
  | WorkOutcomeCommittedObservation
  | ClientResponsePreparedObservation
  | HandoffObservedObservation;

export interface RequestJourneyCloseInput {
  readonly outcome: RequestJourneyOutcome;
  readonly primaryFailureId?: string;
  readonly closeReason?: string;
  readonly lastKnownLocation?: RequestJourneyLocation;
  readonly completeness?: "complete" | "degraded";
}

export interface ImmutableArtifactMeta extends LocatedObservation {
  readonly artifactId: string;
  readonly artifactKind: string;
  readonly mediaType?: string;
  readonly originalBytes?: number;
}

export interface ArtifactRecorder {
  /**
   * Synchronously snapshots a JSON-like object under diagnostics-owned work
   * and size bounds. Implementations must not retain `value` or invoke
   * getters, toJSON, or other object conversion hooks.
   */
  captureJson(value: unknown): void;
  append(bytes: Uint8Array): void;
  finish(input: Readonly<{
    readonly originalBytes: number;
    readonly complete: boolean;
    readonly reason?: string;
  }>): void;
  abandon(reason: string): void;
}

export interface RuntimeEventObservationInput {
  readonly level: "info" | "warning" | "error" | "critical";
  readonly classification: string;
  readonly safeMessage: string;
}

export interface RequestJourneyObserver {
  readonly requestId: string;
  /** Diagnostics authorities expose this streaming seam; minimal test and
   * unavailable observers may omit it and remain fail-open. */
  openArtifact?(meta: ImmutableArtifactMeta): ArtifactRecorder;
  observe(input: RequestJourneyObservationInput): void;
  close(input: RequestJourneyCloseInput): void;
}

export interface RequestJourneyObservationAuthority {
  begin(input: RequestJourneyBeginInput): RequestJourneyObserver;
  observeRuntime(input: RuntimeEventObservationInput): void;
}

export interface PersistedArtifactObservation
  extends Omit<ArtifactObservedObservation, "bytes"> {
  readonly capturedBytes?: number;
}

export type RequestJourneyPersistedObservation =
  | Exclude<RequestJourneyObservationInput, ArtifactObservedObservation>
  | PersistedArtifactObservation;
