import type { AuthResult, FetchFunction, Model } from "@earendil-works/pi-ai";
import type { RequestJourneyObserver } from "../diagnostics/contract.js";
import type { CredentialActivitySink } from "../credentials/activity.js";

export type ProviderResponsesOperation = "responses" | "compact";
/**
 * Claim surface. `responses-compaction` is a Codex remote compaction v2 turn:
 * a `POST /v1/responses` whose input ends with `compaction_trigger`. It is a
 * claim-only capability — execution keeps using the `responses` transport —
 * because an upstream can serve the Responses wire without implementing the
 * backend-side compaction semantic. The lane consults it internally: a
 * certified upstream receives the turn unchanged, everything else takes the
 * shared in-lane summarizer rewrite.
 */
export type ProviderResponsesClaim =
  | ProviderResponsesOperation
  | "responses-compaction";

export class ProviderResponsesNetworkError extends Error {
  constructor(cause: unknown) {
    super("Provider native fetch failed", { cause });
    this.name = "ProviderResponsesNetworkError";
  }
}

/** Responses Provider Native owns these physical-attempt observations. The
 * callback returns only the final physical attempt number to the protocol's
 * one response-body ownership seam; it is observation-only and must be
 * invoked fail-open by the lane. */
export interface ProviderResponsesObservationContext {
  readonly requestId: string;
  readonly journey: RequestJourneyObserver;
  finalResponseAttempt(attempt: number): void;
}

export interface ProviderResponsesPhysicalAttemptObservation {
  readonly journey: RequestJourneyObserver;
  readonly attempt: number;
  readonly profileId?: string;
}

export type ProviderResponsesLaneInput = {
  readonly model: Model<string>;
  readonly rawBody: string;
  readonly signal: AbortSignal;
  /** Effective Provider request timeout, the same fact the Semantic lane
   *  passes to Pi. Provider Native mirrors it so SDK timeout/identity headers
   *  match Pi's envelope instead of inventing a different value. */
  readonly requestTimeoutMs?: number;
  readonly credentialActivity?: CredentialActivitySink;
  readonly observation?: ProviderResponsesObservationContext;
} & (
  | {
      readonly operation: "responses";
      readonly sessionId: string;
    }
  | {
      readonly operation: "compact";
    }
);

export interface ProviderResponsesLane {
  claims(model: Model<string>, operation: ProviderResponsesClaim): boolean;
  execute(input: ProviderResponsesLaneInput): Promise<Response>;
}

export interface ProviderResponsesSender {
  readonly supportsNativeCompact: boolean;
  send(
    operation: ProviderResponsesOperation,
    rawBody: string,
    signal: AbortSignal,
    observation?: ProviderResponsesPhysicalAttemptObservation,
  ): Promise<Response>;
}

export interface CreateProviderResponsesSenderOptions {
  readonly model: Model<string>;
  readonly auth: AuthResult;
  readonly fetch: FetchFunction;
  readonly sessionId?: string;
  readonly requestTimeoutMs?: number;
}
