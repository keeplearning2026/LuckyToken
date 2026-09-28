import type {
  RequestJourneyLocation,
  RequestJourneyObservationInput,
  RequestJourneyObserver,
} from "../diagnostics/contract.js";
import {
  TOOL_CALL_ADJACENCY_DEFERRED_NOTICE_CODE,
  TOOL_CALL_GROUP_ABANDONED_NOTICE_CODE,
  TOOL_CALL_GROUP_UNSUPPORTED_ITEM_NOTICE_CODE,
  type ProviderNativeBodyOutcome,
} from "./tool-call-adjacency.js";

export function observeProviderResponses(
  journey: RequestJourneyObserver | undefined,
  observation: RequestJourneyObservationInput,
): void {
  try {
    journey?.observe(observation);
  } catch {
    // Provider Native serving remains authoritative over observation.
  }
}

export function enterProviderResponsesStep(
  journey: RequestJourneyObserver | undefined,
  stepInstanceId: string,
  location: RequestJourneyLocation,
): void {
  observeProviderResponses(journey, {
    kind: "step_entered",
    stepInstanceId,
    location,
  });
}

export function completeProviderResponsesStep(
  journey: RequestJourneyObserver | undefined,
  stepInstanceId: string,
  location: RequestJourneyLocation,
  completion: "success" | "failed" | "aborted",
): void {
  observeProviderResponses(journey, {
    kind: "step_completed",
    stepInstanceId,
    completion,
    location,
  });
}

/** Read-only projection notice. The caller emits it from the single
 * project_native_body step, which may also carry the capability notice. */
export function observeProviderResponsesBodyProjection(
  journey: RequestJourneyObserver | undefined,
  projection: Readonly<{
    outcome: ProviderNativeBodyOutcome;
    deferredMessages: number;
  }>,
  location: RequestJourneyLocation,
): void {
  if (projection.outcome === "model-only") return;
  const deferred = projection.outcome === "deferred";
  const code = deferred
    ? TOOL_CALL_ADJACENCY_DEFERRED_NOTICE_CODE
    : projection.outcome === "abandoned"
      ? TOOL_CALL_GROUP_ABANDONED_NOTICE_CODE
      : TOOL_CALL_GROUP_UNSUPPORTED_ITEM_NOTICE_CODE;
  const message = deferred
    ? `Deferred ${projection.deferredMessages} developer message item(s) out of a closed tool-call group.`
    : projection.outcome === "abandoned"
      ? "A developer message item interrupted a tool-call group; the request was not reordered."
      : "A non-message item appeared inside an open tool-call group; the request was not reordered.";
  observeProviderResponses(journey, {
    kind: "conversion_notice_observed",
    code,
    severity: deferred ? "info" : "warning",
    message,
    location,
  });
}

export function observeProviderResponsesArtifact(
  journey: RequestJourneyObserver | undefined,
  input: Readonly<{
    artifactId: string;
    artifactKind: string;
    bytes: Uint8Array;
    mediaType?: string;
    location: RequestJourneyLocation;
  }>,
): void {
  const capturedBytes = input.bytes.byteLength;
  observeProviderResponses(journey, {
    kind: "artifact_observed",
    artifactId: input.artifactId,
    artifactKind: input.artifactKind,
    state: capturedBytes < input.bytes.byteLength ? "partial" : "captured",
    ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
    bytes: input.bytes,
    originalBytes: input.bytes.byteLength,
    capturedBytes,
    truncated: capturedBytes < input.bytes.byteLength,
    location: input.location,
  });
}

export const PROVIDER_NATIVE_STREAM_OPTIONS_OMITTED_NOTICE_CODE =
  "provider_native_stream_options_omitted";

/** Bounded notice for the one capability-driven wire edit the lane performs on
 *  the caller's own top-level JSON text. */
export function observeProviderResponsesStreamOptionsOmitted(
  journey: RequestJourneyObserver | undefined,
  location: RequestJourneyLocation,
): void {
  observeProviderResponses(journey, {
    kind: "conversion_notice_observed",
    code: PROVIDER_NATIVE_STREAM_OPTIONS_OMITTED_NOTICE_CODE,
    severity: "warning",
    message:
      "The resolved model does not accept stream_options; the top-level property was not forwarded.",
    location,
  });
}
