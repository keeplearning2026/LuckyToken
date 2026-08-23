import type { CodexFetchFunction, CodexForwardAuth } from "./codex-native-seam.js";
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
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array<ArrayBuffer>;
}

export interface CodexResponsesPassthroughOptions {
  readonly rawBody: string;
  readonly requestHeaders: Headers;
  readonly forwardAuth: CodexForwardAuth;
  readonly signal: AbortSignal;
  readonly fetch: CodexFetchFunction;
  readonly journey?: RequestJourneyObserver;
  readonly profileId?: string;
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
  "content-encoding",
]);

const RESPONSE_FORBIDDEN = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "www-authenticate",
]);

const EXACT_FORWARD_HEADERS = new Set([
  "chatgpt-account-id",
  "openai-beta",
  "originator",
  "session_id",
  "session-id",
  "thread-id",
  "x-client-request-id",
  "x-oai-attestation",
  "x-openai-subagent",
  "x-responsesapi-include-timing-metrics",
]);

function shouldForwardRequestHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return EXACT_FORWARD_HEADERS.has(lower) || lower.startsWith("x-codex-");
}

function buildRequestHeaders(source: Headers, auth: CodexForwardAuth): Headers {
  const headers = new Headers({
    "content-type": "application/json",
    authorization: auth.authorization,
  });
  for (const [name, value] of source) {
    const lower = name.toLowerCase();
    if (!shouldForwardRequestHeader(lower)) continue;
    headers.set(lower, value);
  }
  if (
    headers.get("chatgpt-account-id") === null &&
    auth.accountId !== undefined
  ) {
    headers.set("chatgpt-account-id", auth.accountId);
  }
  return headers;
}

function responseHeaders(source: Headers): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [name, value] of source) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || RESPONSE_FORBIDDEN.has(lower)) continue;
    result[lower] = value;
  }
  return Object.freeze(result);
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
    lane: "local_native",
    step: "project_local_request",
  } as const;
  enterLocalTransportStep(
    options.journey,
    "p3.project_local_request",
    projectionLocation,
  );
  const outboundBytes = new TextEncoder().encode(options.rawBody);
  completeLocalTransportStep(
    options.journey,
    "p3.project_local_request",
    projectionLocation,
    "success",
  );
  const envelopeLocation = {
    phase: "lane_request_preparation",
    lane: "local_native",
    step: "construct_local_envelope",
  } as const;
  enterLocalTransportStep(
    options.journey,
    "p3.construct_local_envelope",
    envelopeLocation,
  );
  const headers = buildRequestHeaders(
    options.requestHeaders,
    options.forwardAuth,
  );
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
    "p3.construct_local_envelope",
    envelopeLocation,
    "success",
  );

  const dispatchLocation = {
    phase: "upstream_execution",
    lane: "local_native",
    step: "dispatch_local_transport",
    attempt: 1,
  } as const;
  enterLocalTransportStep(
    options.journey,
    "p4.dispatch_local_transport",
    dispatchLocation,
  );
  observeLocalTransportJourney(options.journey, {
    kind: "attempt_observed",
    attempt: 1,
    ...(options.profileId === undefined
      ? {}
      : { profileId: options.profileId }),
    transition: "started",
    location: dispatchLocation,
  });
  let response: Response;
  try {
    response = await options.fetch(url, {
      method: "POST",
      headers,
      body: options.rawBody,
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal.aborted) throw error;
    completeLocalTransportStep(
      options.journey,
      "p4.dispatch_local_transport",
      dispatchLocation,
      "failed",
    );
    observeLocalTransportJourney(options.journey, {
      kind: "artifact_observed",
      artifactId: "local_upstream_response_wire",
      artifactKind: "local_upstream_response_wire",
      state: "unavailable",
      reason: "local_transport_failed",
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
    "p4.dispatch_local_transport",
    dispatchLocation,
    "success",
  );

  const readLocation = {
    phase: "upstream_execution",
    lane: "local_native",
    step: "read_local_response",
    attempt: 1,
  } as const;
  enterLocalTransportStep(
    options.journey,
    "p4.read_local_response",
    readLocation,
  );
  observeLocalTransportJourney(options.journey, {
    kind: "attempt_observed",
    attempt: 1,
    ...(options.profileId === undefined
      ? {}
      : { profileId: options.profileId }),
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
      "p4.read_local_response",
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
    "p4.read_local_response",
    readLocation,
    "success",
  );
  return Object.freeze({
    status: response.status,
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
