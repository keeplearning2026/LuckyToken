import type { CodexDirectFetch } from "./codex-direct-seam.js";
import type {
  RequestJourneyLocation,
  RequestJourneyObservationInput,
  RequestJourneyObserver,
} from "./diagnostics/contract.js";
import { publishSafeHttpEnvelopeArtifact } from "./diagnostics/http-envelope.js";

export const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
export const CODEX_RESPONSES_COMPACT_URL =
  "https://chatgpt.com/backend-api/codex/responses/compact";

export interface CodexDirectResponsesResult {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly body: Uint8Array<ArrayBuffer>;
}

export interface CodexDirectResponsesTransportOptions {
  readonly rawBody: Uint8Array<ArrayBuffer>;
  readonly requestUrl: string;
  readonly requestHeaders: Headers;
  readonly signal: AbortSignal;
  readonly fetch: CodexDirectFetch;
  readonly journey?: RequestJourneyObserver;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "proxy-connection",
  "expect",
]);

function buildRequestHeaders(source: Headers): Headers {
  const connectionHeaders = new Set(
    (source.get("connection") ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name.length > 0),
  );
  const headers = new Headers();
  for (const [name, value] of source) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || connectionHeaders.has(lower)) continue;
    headers.set(lower, value);
  }
  return headers;
}

function responseHeaders(source: Headers): Headers {
  const connectionHeaders = new Set(
    (source.get("connection") ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name.length > 0),
  );
  const result = new Headers();
  for (const [name, value] of source) {
    const lower = name.toLowerCase();
    if (
      HOP_BY_HOP.has(lower) ||
      connectionHeaders.has(lower)
    ) continue;
    result.append(lower, value);
  }
  return result;
}

export class CodexDirectResponsesTransportError extends Error {
  readonly kind = "CodexDirectResponsesTransportError" as const;

  constructor(cause: unknown) {
    super("Codex upstream request failed", { cause });
    this.name = "CodexDirectResponsesTransportError";
  }
}

export class CodexDirectResponsesBodyReadError extends Error {
  readonly kind = "CodexDirectResponsesBodyReadError" as const;

  constructor(cause: unknown) {
    super("Codex upstream response could not be read", { cause });
    this.name = "CodexDirectResponsesBodyReadError";
  }
}

function observeDirectTransportJourney(
  journey: RequestJourneyObserver | undefined,
  observation: RequestJourneyObservationInput,
): void {
  try {
    journey?.observe(observation);
  } catch {
    // Direct Mode transport behavior is authoritative over observation failure.
  }
}

function enterDirectTransportStep(
  journey: RequestJourneyObserver | undefined,
  stepInstanceId: string,
  location: RequestJourneyLocation,
): void {
  observeDirectTransportJourney(journey, {
    kind: "step_entered",
    stepInstanceId,
    location,
  });
}

function completeDirectTransportStep(
  journey: RequestJourneyObserver | undefined,
  stepInstanceId: string,
  location: RequestJourneyLocation,
  completion: "success" | "failed",
): void {
  observeDirectTransportJourney(journey, {
    kind: "step_completed",
    stepInstanceId,
    completion,
    location,
  });
}

/** Client-owned Codex Direct Mode transport. No Pi credential or Pi Model participates. */
async function executeCodexDirectRequest(
  url: string,
  options: CodexDirectResponsesTransportOptions,
): Promise<CodexDirectResponsesResult> {
  const projectionLocation = {
    phase: "lane_request_preparation",
    lane: "direct",
    step: "project_direct_request",
  } as const;
  enterDirectTransportStep(
    options.journey,
    "p3.project_direct_request",
    projectionLocation,
  );
  const outboundBytes = options.rawBody;
  completeDirectTransportStep(
    options.journey,
    "p3.project_direct_request",
    projectionLocation,
    "success",
  );
  const envelopeLocation = {
    phase: "lane_request_preparation",
    lane: "direct",
    step: "construct_direct_envelope",
  } as const;
  enterDirectTransportStep(
    options.journey,
    "p3.construct_direct_envelope",
    envelopeLocation,
  );
  const headers = buildRequestHeaders(options.requestHeaders);
  const outboundUrl = `${url}${new URL(options.requestUrl).search}`;
  publishSafeHttpEnvelopeArtifact(options.journey, {
    artifactId: "direct_outbound_request_envelope",
    artifactKind: "direct_outbound_request_envelope",
    method: "POST",
    url: outboundUrl,
    headers,
    location: envelopeLocation,
  });
  observeDirectTransportJourney(options.journey, {
    kind: "artifact_observed",
    artifactId: "direct_outbound_request_wire",
    artifactKind: "direct_outbound_request_wire",
    state: "captured",
    mediaType: "application/json",
    bytes: outboundBytes,
    originalBytes: outboundBytes.byteLength,
    capturedBytes: outboundBytes.byteLength,
    truncated: false,
    location: envelopeLocation,
  });
  completeDirectTransportStep(
    options.journey,
    "p3.construct_direct_envelope",
    envelopeLocation,
    "success",
  );

  const dispatchLocation = {
    phase: "upstream_execution",
    lane: "direct",
    step: "dispatch_direct_transport",
    attempt: 1,
  } as const;
  enterDirectTransportStep(
    options.journey,
    "p4.dispatch_direct_transport",
    dispatchLocation,
  );
  observeDirectTransportJourney(options.journey, {
    kind: "attempt_observed",
    attempt: 1,
    transition: "started",
    location: dispatchLocation,
  });
  let response: Response;
  try {
    response = await options.fetch(outboundUrl, {
      method: "POST",
      headers,
      body: options.rawBody,
      signal: options.signal,
      redirect: "manual",
    });
  } catch (error) {
    if (options.signal.aborted) throw error;
    completeDirectTransportStep(
      options.journey,
      "p4.dispatch_direct_transport",
      dispatchLocation,
      "failed",
    );
    observeDirectTransportJourney(options.journey, {
      kind: "artifact_observed",
      artifactId: "direct_upstream_response_wire",
      artifactKind: "direct_upstream_response_wire",
      state: "unavailable",
      reason: "direct_transport_failed",
      location: dispatchLocation,
    });
    observeDirectTransportJourney(options.journey, {
      kind: "failure_detected",
      failureId: `${options.journey?.requestId ?? "direct"}:direct_upstream_transport_failed`,
      role: "primary",
      classification: "direct_upstream_transport_failed",
      origin: "network_os",
      originPrecision: "boundary",
      location: dispatchLocation,
    });
    throw new CodexDirectResponsesTransportError(error);
  }
  completeDirectTransportStep(
    options.journey,
    "p4.dispatch_direct_transport",
    dispatchLocation,
    "success",
  );
  publishSafeHttpEnvelopeArtifact(options.journey, {
    artifactId: "direct_upstream_response_envelope",
    artifactKind: "direct_upstream_response_envelope",
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    location: dispatchLocation,
  });

  const readLocation = {
    phase: "upstream_execution",
    lane: "direct",
    step: "read_direct_response",
    attempt: 1,
  } as const;
  enterDirectTransportStep(
    options.journey,
    "p4.read_direct_response",
    readLocation,
  );
  observeDirectTransportJourney(options.journey, {
    kind: "attempt_observed",
    attempt: 1,
    status: response.status,
    transition: "response",
    location: readLocation,
  });
  let body: Uint8Array<ArrayBuffer>;
  try {
    body = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (options.signal.aborted) throw error;
    observeDirectTransportJourney(options.journey, {
      kind: "artifact_observed",
      artifactId: "direct_upstream_response_wire",
      artifactKind: "direct_upstream_response_wire",
      state: "unavailable",
      ...(response.headers.get("content-type") === null
        ? {}
        : { mediaType: response.headers.get("content-type")! }),
      reason: "response_body_read_failed",
      location: readLocation,
    });
    completeDirectTransportStep(
      options.journey,
      "p4.read_direct_response",
      readLocation,
      "failed",
    );
    observeDirectTransportJourney(options.journey, {
      kind: "failure_detected",
      failureId: `${options.journey?.requestId ?? "direct"}:direct_upstream_response_body_read_failed`,
      role: "primary",
      classification: "direct_upstream_response_body_read_failed",
      origin: "network_os",
      originPrecision: "boundary",
      location: readLocation,
    });
    throw new CodexDirectResponsesBodyReadError(error);
  }
  observeDirectTransportJourney(options.journey, {
    kind: "artifact_observed",
    artifactId: "direct_upstream_response_wire",
    artifactKind: "direct_upstream_response_wire",
    state: "captured",
    ...(response.headers.get("content-type") === null
      ? {}
      : { mediaType: response.headers.get("content-type")! }),
    bytes: body,
    originalBytes: body.byteLength,
    capturedBytes: body.byteLength,
    truncated: false,
    location: readLocation,
  });
  completeDirectTransportStep(
    options.journey,
    "p4.read_direct_response",
    readLocation,
    "success",
  );
  return Object.freeze({
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders(response.headers),
    body,
  });
}

export function executeCodexDirectResponses(
  options: CodexDirectResponsesTransportOptions,
): Promise<CodexDirectResponsesResult> {
  return executeCodexDirectRequest(CODEX_RESPONSES_URL, options);
}

export function executeCodexDirectResponsesCompact(
  options: CodexDirectResponsesTransportOptions,
): Promise<CodexDirectResponsesResult> {
  return executeCodexDirectRequest(CODEX_RESPONSES_COMPACT_URL, options);
}
