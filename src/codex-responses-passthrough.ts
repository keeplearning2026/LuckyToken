import type { CodexFetchFunction } from "./codex-native-seam.js";
import type {
  RequestJourneyLocation,
  RequestJourneyObservationInput,
  RequestJourneyObserver,
} from "./diagnostics/contract.js";

export const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
export const CODEX_RESPONSES_COMPACT_URL =
  "https://chatgpt.com/backend-api/codex/responses/compact";

export interface CodexResponsesPassthroughResult {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly body: Uint8Array<ArrayBuffer>;
}

export interface CodexResponsesPassthroughOptions {
  readonly rawBody: Uint8Array<ArrayBuffer>;
  readonly requestUrl: string;
  readonly requestHeaders: Headers;
  readonly signal: AbortSignal;
  readonly fetch: CodexFetchFunction;
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

const STALE_RESPONSE_REPRESENTATION_HEADERS = new Set([
  "content-encoding",
  "content-md5",
  "digest",
  "content-digest",
  "repr-digest",
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
  headers.set("accept-encoding", "identity");
  return headers;
}

function responseHeaders(source: Headers): Headers {
  const contentEncoding = source.get("content-encoding")?.trim().toLowerCase();
  const representationWasDecoded =
    contentEncoding === "gzip" ||
    contentEncoding === "x-gzip" ||
    contentEncoding === "deflate" ||
    contentEncoding === "br";
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
      (representationWasDecoded && STALE_RESPONSE_REPRESENTATION_HEADERS.has(lower)) ||
      connectionHeaders.has(lower)
    ) continue;
    result.append(lower, value);
  }
  return result;
}

export class CodexResponsesPassthroughTransportError extends Error {
  readonly kind = "CodexResponsesPassthroughTransportError" as const;

  constructor(cause: unknown) {
    super("Codex upstream request failed", { cause });
    this.name = "CodexResponsesPassthroughTransportError";
  }
}

export class CodexResponsesPassthroughBodyReadError extends Error {
  readonly kind = "CodexResponsesPassthroughBodyReadError" as const;

  constructor(cause: unknown) {
    super("Codex upstream response could not be read", { cause });
    this.name = "CodexResponsesPassthroughBodyReadError";
  }
}

function observeLocalTransportJourney(
  journey: RequestJourneyObserver | undefined,
  observation: RequestJourneyObservationInput,
): void {
  try {
    journey?.observe(observation);
  } catch {
    // Local transport behavior is authoritative over observation failure.
  }
}

function enterLocalTransportStep(
  journey: RequestJourneyObserver | undefined,
  stepInstanceId: string,
  location: RequestJourneyLocation,
): void {
  observeLocalTransportJourney(journey, {
    kind: "step_entered",
    stepInstanceId,
    location,
  });
}

function completeLocalTransportStep(
  journey: RequestJourneyObserver | undefined,
  stepInstanceId: string,
  location: RequestJourneyLocation,
  completion: "success" | "failed",
): void {
  observeLocalTransportJourney(journey, {
    kind: "step_completed",
    stepInstanceId,
    completion,
    location,
  });
}

/** Client-owned Codex OAuth passthrough. No Pi credential or Pi Model participates. */
async function passthroughCodexRequest(
  url: string,
  options: CodexResponsesPassthroughOptions,
): Promise<CodexResponsesPassthroughResult> {
  const projectionLocation = {
    phase: "lane_request_preparation",
    lane: "direct",
    step: "project_local_request",
  } as const;
  enterLocalTransportStep(
    options.journey,
    "p3.project_local_request",
    projectionLocation,
  );
  const outboundBytes = options.rawBody;
  completeLocalTransportStep(
    options.journey,
    "p3.project_local_request",
    projectionLocation,
    "success",
  );
  const envelopeLocation = {
    phase: "lane_request_preparation",
    lane: "direct",
    step: "construct_direct_envelope",
  } as const;
  enterLocalTransportStep(
    options.journey,
    "p3.construct_direct_envelope",
    envelopeLocation,
  );
  const headers = buildRequestHeaders(options.requestHeaders);
  observeLocalTransportJourney(options.journey, {
    kind: "artifact_observed",
    artifactId: "local_outbound_request_wire",
    artifactKind: "local_outbound_request_wire",
    state: "captured",
    mediaType: "application/json",
    bytes: outboundBytes,
    originalBytes: outboundBytes.byteLength,
    capturedBytes: outboundBytes.byteLength,
    truncated: false,
    location: envelopeLocation,
  });
  completeLocalTransportStep(
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
  enterLocalTransportStep(
    options.journey,
    "p4.dispatch_direct_transport",
    dispatchLocation,
  );
  observeLocalTransportJourney(options.journey, {
    kind: "attempt_observed",
    attempt: 1,
    transition: "started",
    location: dispatchLocation,
  });
  let response: Response;
  try {
    response = await options.fetch(`${url}${new URL(options.requestUrl).search}`, {
      method: "POST",
      headers,
      body: options.rawBody,
      signal: options.signal,
      redirect: "manual",
    });
  } catch (error) {
    if (options.signal.aborted) throw error;
    completeLocalTransportStep(
      options.journey,
      "p4.dispatch_direct_transport",
      dispatchLocation,
      "failed",
    );
    observeLocalTransportJourney(options.journey, {
      kind: "artifact_observed",
      artifactId: "local_upstream_response_wire",
      artifactKind: "local_upstream_response_wire",
      state: "unavailable",
      reason: "direct_transport_failed",
      location: dispatchLocation,
    });
    observeLocalTransportJourney(options.journey, {
      kind: "failure_detected",
      failureId: `${options.journey?.requestId ?? "local"}:local_upstream_transport_failed`,
      role: "primary",
      classification: "local_upstream_transport_failed",
      origin: "network_os",
      originPrecision: "boundary",
      location: dispatchLocation,
    });
    throw new CodexResponsesPassthroughTransportError(error);
  }
  completeLocalTransportStep(
    options.journey,
    "p4.dispatch_direct_transport",
    dispatchLocation,
    "success",
  );

  const readLocation = {
    phase: "upstream_execution",
    lane: "direct",
    step: "read_direct_response",
    attempt: 1,
  } as const;
  enterLocalTransportStep(
    options.journey,
    "p4.read_direct_response",
    readLocation,
  );
  observeLocalTransportJourney(options.journey, {
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
    observeLocalTransportJourney(options.journey, {
      kind: "artifact_observed",
      artifactId: "local_upstream_response_wire",
      artifactKind: "local_upstream_response_wire",
      state: "unavailable",
      ...(response.headers.get("content-type") === null
        ? {}
        : { mediaType: response.headers.get("content-type")! }),
      reason: "response_body_read_failed",
      location: readLocation,
    });
    completeLocalTransportStep(
      options.journey,
      "p4.read_direct_response",
      readLocation,
      "failed",
    );
    observeLocalTransportJourney(options.journey, {
      kind: "failure_detected",
      failureId: `${options.journey?.requestId ?? "local"}:local_upstream_response_body_read_failed`,
      role: "primary",
      classification: "local_upstream_response_body_read_failed",
      origin: "network_os",
      originPrecision: "boundary",
      location: readLocation,
    });
    throw new CodexResponsesPassthroughBodyReadError(error);
  }
  observeLocalTransportJourney(options.journey, {
    kind: "artifact_observed",
    artifactId: "local_upstream_response_wire",
    artifactKind: "local_upstream_response_wire",
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
  completeLocalTransportStep(
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

export function passthroughCodexResponses(
  options: CodexResponsesPassthroughOptions,
): Promise<CodexResponsesPassthroughResult> {
  return passthroughCodexRequest(CODEX_RESPONSES_URL, options);
}

export function passthroughCodexResponsesCompact(
  options: CodexResponsesPassthroughOptions,
): Promise<CodexResponsesPassthroughResult> {
  return passthroughCodexRequest(CODEX_RESPONSES_COMPACT_URL, options);
}
