import type {
  RequestJourneyLocation,
  RequestJourneyObservationInput,
  RequestJourneyObserver,
} from "../diagnostics/contract.js";

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
