import type { FetchFunction, Model } from "@earendil-works/pi-ai";
import type {
  RequestJourneyLocation,
  RequestJourneyObservationInput,
  RequestJourneyObserver,
} from "../diagnostics/contract.js";
import { publishSafeHttpEnvelopeArtifact } from "../diagnostics/http-envelope.js";

import {
  AnthropicNativeBodyProjectionError,
  projectAnthropicNativeBody,
  type AnthropicNativeBodyProjectionMode,
} from "./body-projection.js";
import {
  parseSseFrames,
  renderSseFrame,
  sseFramePayload,
  type SseFrameLine,
} from "../protocols/sse-lines.js";

export interface PassthroughAnthropicRequestOptions {
  readonly model: Model<string>;
  readonly rawBody: string;
  readonly apiKey: string | undefined;
  readonly signal: AbortSignal;
  readonly fetch: FetchFunction;
  readonly bodyProjectionMode: AnthropicNativeBodyProjectionMode;
  readonly authMode: "api_key" | "oauth" | "github_copilot" | "ambient";
  readonly sessionId?: string;
  readonly attempt: number;
  readonly profileId?: string;
  readonly journey?: RequestJourneyObserver;
  /**
   * Composed Provider-facing request facts (Ticket 10): the auth result's
   * merged headers (built-in static model headers, configured provider/
   * model headers, authHeader Authorization). These are Pi/Provider-owned
   * request facts. No generic inbound request header enters this transport.
   * Null values (ProviderHeaders) are ignored.
   */
  readonly composedHeaders?: Readonly<Record<string, string | null>>;
}

export interface PassthroughAnthropicResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array<ArrayBuffer>;
}

/**
 * Declared wire compatibility for native Anthropic passthrough.
 *
 * Every claimed tuple has a reviewed Pi-wire fixture. A custom Provider that
 * happens to reuse the API id remains Semantic Conversion unless its own
 * Provider Native projection is explicitly certified here.
 */
const CERTIFIED_ANTHROPIC_NATIVE_PROVIDERS = new Set([
  "anthropic",
  "github-copilot",
  "cloudflare-ai-gateway",
]);

export function isAnthropicNativePassthroughModel(
  model: Model<string>,
): boolean {
  return (
    model.api === "anthropic-messages" &&
    CERTIFIED_ANTHROPIC_NATIVE_PROVIDERS.has(model.provider)
  );
}

function observeAnthropicNativeTransport(
  journey: RequestJourneyObserver | undefined,
  observation: RequestJourneyObservationInput,
): void {
  try {
    journey?.observe(observation);
  } catch {
    // Provider Native transport remains authoritative over observation.
  }
}

function enterAnthropicNativeTransportStep(
  journey: RequestJourneyObserver | undefined,
  stepInstanceId: string,
  location: RequestJourneyLocation,
): void {
  observeAnthropicNativeTransport(journey, {
    kind: "step_entered",
    stepInstanceId,
    location,
  });
}

function completeAnthropicNativeTransportStep(
  journey: RequestJourneyObserver | undefined,
  stepInstanceId: string,
  location: RequestJourneyLocation,
  completion: "success" | "failed" | "aborted",
): void {
  observeAnthropicNativeTransport(journey, {
    kind: "step_completed",
    stepInstanceId,
    completion,
    location,
  });
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

const FORBIDDEN_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "cookie",
  "authorization",
  "proxy-authorization",
  "www-authenticate",
  // The upstream credential must never be echoed back toward the client even
  // if the upstream mislabels it as a response header.
  "x-api-key",
]);

function isSafeResponseHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (HOP_BY_HOP.has(lower)) return false;
  if (FORBIDDEN_RESPONSE_HEADERS.has(lower)) return false;
  return true;
}

function filterHeaders(
  source: Headers | Readonly<Record<string, string>>,
  allow: (name: string) => boolean,
): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  const entries =
    source instanceof Headers ? source.entries() : Object.entries(source);
  for (const [rawName, rawValue] of entries) {
    const name = rawName.toLowerCase();
    if (!allow(name)) continue;
    output[name] = rawValue;
  }
  return Object.freeze(output);
}

/** Request fields the transport itself owns. Composed Provider headers may
 *  override Pi SDK defaults but never framing fields produced after that
 *  merge, matching the pinned SDK request construction order. */
const TRANSPORT_OWNED = new Set([
  "content-type",
  "content-length",
  "content-encoding",
  "host",
]);

const ANTHROPIC_SDK_VERSION = "0.91.1";
const CLAUDE_CODE_VERSION = "2.1.75";
const FINE_GRAINED_TOOL_STREAMING_BETA =
  "fine-grained-tool-streaming-2025-05-14";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";

function normalizedPlatform(): string {
  switch (process.platform) {
    case "darwin":
      return "MacOS";
    case "linux":
      return "Linux";
    case "win32":
      return "Windows";
    case "freebsd":
      return "FreeBSD";
    case "openbsd":
      return "OpenBSD";
    default:
      return process.platform.length > 0
        ? `Other:${process.platform}`
        : "Unknown";
  }
}

function normalizedArchitecture(): string {
  switch (process.arch) {
    case "ia32":
      return "x32";
    case "x64":
      return "x64";
    case "arm":
      return "arm";
    case "arm64":
      return "arm64";
    default:
      return process.arch.length > 0 ? `other:${process.arch}` : "unknown";
  }
}

function parsedBody(rawBody: string): Record<string, unknown> {
  const parsed = JSON.parse(rawBody) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AnthropicNativeBodyProjectionError(
      "Anthropic Native body must be a JSON object",
    );
  }
  return parsed as Record<string, unknown>;
}

interface AnthropicNativeCompatFacts {
  readonly supportsEagerToolInputStreaming?: boolean;
  readonly forceAdaptiveThinking?: boolean;
  readonly sendSessionAffinityHeaders?: boolean;
}

function anthropicCompat(model: Model<string>): AnthropicNativeCompatFacts {
  return (
    model as unknown as { readonly compat?: AnthropicNativeCompatFacts }
  ).compat ?? {};
}

function piBetaFeatures(model: Model<string>, rawBody: string): string[] {
  const body = parsedBody(rawBody);
  const features: string[] = [];
  if (
    Array.isArray(body.tools) &&
    body.tools.length > 0 &&
    anthropicCompat(model).supportsEagerToolInputStreaming !== true
  ) {
    features.push(FINE_GRAINED_TOOL_STREAMING_BETA);
  }
  if (anthropicCompat(model).forceAdaptiveThinking !== true) {
    features.push(INTERLEAVED_THINKING_BETA);
  }
  return features;
}

function copilotDynamicHeaders(rawBody: string): Record<string, string> {
  const body = parsedBody(rawBody);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const last = messages.at(-1);
  const lastRole =
    typeof last === "object" && last !== null && !Array.isArray(last)
      ? (last as Record<string, unknown>).role
      : undefined;
  const hasImage = messages.some((message) => {
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      return false;
    }
    const content = (message as Record<string, unknown>).content;
    return (
      Array.isArray(content) &&
      content.some(
        (block) =>
          typeof block === "object" &&
          block !== null &&
          !Array.isArray(block) &&
          (block as Record<string, unknown>).type === "image",
      )
    );
  });
  return {
    "x-initiator": lastRole !== undefined && lastRole !== "user" ? "agent" : "user",
    "openai-intent": "conversation-edits",
    ...(hasImage ? { "copilot-vision-request": "true" } : {}),
  };
}

function buildUpstreamHeaders(
  model: Model<string>,
  rawBody: string,
  apiKey: string | undefined,
  authMode: PassthroughAnthropicRequestOptions["authMode"],
  sessionId: string | undefined,
  composedHeaders: Readonly<Record<string, string | null>> | undefined,
): Record<string, string> {
  const betaFeatures = piBetaFeatures(model, rawBody);
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": `Anthropic/JS ${ANTHROPIC_SDK_VERSION}`,
    "x-stainless-retry-count": "0",
    "x-stainless-lang": "js",
    "x-stainless-package-version": ANTHROPIC_SDK_VERSION,
    "x-stainless-os": normalizedPlatform(),
    "x-stainless-arch": normalizedArchitecture(),
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": process.version,
    "anthropic-dangerous-direct-browser-access": "true",
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  const ownsApiKey = apiKey !== undefined && apiKey.length > 0;
  if (ownsApiKey) {
    if (authMode === "oauth" || authMode === "github_copilot") {
      headers.authorization = `Bearer ${apiKey}`;
    } else {
      headers["x-api-key"] = apiKey;
    }
  }
  if (authMode === "oauth") {
    headers["anthropic-beta"] = [
      "claude-code-20250219",
      "oauth-2025-04-20",
      ...betaFeatures,
    ].join(",");
    headers["user-agent"] = `claude-cli/${CLAUDE_CODE_VERSION}`;
    headers["x-app"] = "cli";
  } else if (betaFeatures.length > 0) {
    headers["anthropic-beta"] = betaFeatures.join(",");
  }
  if (
    authMode !== "oauth" &&
    authMode !== "github_copilot" &&
    sessionId !== undefined &&
    anthropicCompat(model).sendSessionAffinityHeaders === true
  ) {
    headers["x-session-affinity"] = sessionId;
  }
  if (authMode === "github_copilot") {
    Object.assign(headers, copilotDynamicHeaders(rawBody));
  }

  if (composedHeaders !== undefined) {
    for (const [name, value] of Object.entries(composedHeaders)) {
      const lower = name.toLowerCase();
      if (HOP_BY_HOP.has(lower) || TRANSPORT_OWNED.has(lower)) continue;
      if (
        ownsApiKey &&
        (authMode === "api_key" || authMode === "ambient") &&
        lower === "x-api-key"
      ) {
        continue;
      }
      if (value === undefined || value === null) continue;
      headers[lower] = value;
    }
  }
  return headers;
}

/**
 * Join a configured base URL with a fixed endpoint path, preserving any
 * base-path prefix. The Anthropic SDK resolves `baseURL + "/v1/messages"` by
 * string concatenation, so a configured `https://host/prefix` requests
 * `https://host/prefix/v1/messages`; an absolute `new URL` would silently drop
 * the prefix. This mirrors the SDK's concatURL semantics (architecture §1.2:
 * "URL construction preserves the configured base path unless the upstream
 * contract explicitly defines an absolute endpoint").
 */
function joinEndpoint(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}${path}`;
}

/**
 * Forward an Anthropic Messages request to an upstream Anthropic endpoint
 * under the native passthrough profile.
 *
 * The client's raw request body is sent with the upstream `x-api-key` and the
 * model selector rewritten to the registered model id (no qualified Lucky
 * selector crosses the boundary). Only approved end-to-end headers cross;
 * hop-by-hop, cookie, auth, and stale content-length/encoding headers never
 * do. The upstream response is buffered once, its headers filtered to the
 * safe set, and returned for atomic delivery.
 */
export async function passthroughAnthropicRequest(
  options: PassthroughAnthropicRequestOptions,
): Promise<PassthroughAnthropicResult> {
  const { model, rawBody, apiKey, signal, fetch: fetchImpl } = options;
  if (apiKey === undefined || apiKey.length === 0) {
    // Header-owned auth (e.g. ANTHROPIC_AUTH_TOKEN, authHeader) is a valid
    // Provider-facing credential; mirror the pinned API-layer
    // assertRequestAuth which accepts authorization/x-api-key/cf-aig-
    // authorization without an apiKey.
    const composed = options.composedHeaders ?? {};
    const hasHeaderAuth = Object.entries(composed).some(([name, value]) => {
      const lower = name.toLowerCase();
      return (
        (lower === "authorization" ||
          lower === "x-api-key" ||
          lower === "cf-aig-authorization") &&
        value !== undefined &&
        value !== null &&
        value.trim().length > 0
      );
    });
    if (!hasHeaderAuth) {
      throw new Error(
        `No API key configured for passthrough provider: ${model.provider}`,
      );
    }
  }
  const projectionLocation = {
    phase: "lane_request_preparation",
    lane: "provider_native",
    step: "project_native_body",
    attempt: options.attempt,
  } as const;
  const projectionStep = `p3.project_native_body.${options.attempt}`;
  enterAnthropicNativeTransportStep(
    options.journey,
    projectionStep,
    projectionLocation,
  );
  let forwardedBody: string;
  try {
    forwardedBody = projectAnthropicNativeBody({
      rawBody,
      modelId: model.id,
      mode: options.bodyProjectionMode,
    }).body;
    completeAnthropicNativeTransportStep(
      options.journey,
      projectionStep,
      projectionLocation,
      "success",
    );
  } catch (error) {
    completeAnthropicNativeTransportStep(
      options.journey,
      projectionStep,
      projectionLocation,
      "failed",
    );
    throw error;
  }

  const envelopeLocation = {
    phase: "lane_request_preparation",
    lane: "provider_native",
    step: "reconstruct_provider_envelope",
    attempt: options.attempt,
  } as const;
  const envelopeStep = `p3.reconstruct_provider_envelope.${options.attempt}`;
  enterAnthropicNativeTransportStep(
    options.journey,
    envelopeStep,
    envelopeLocation,
  );
  let endpoint: string;
  let headers: Record<string, string>;
  try {
    endpoint = joinEndpoint(model.baseUrl, "/v1/messages");
    headers = buildUpstreamHeaders(
      model,
      rawBody,
      apiKey,
      options.authMode,
      options.sessionId,
      options.composedHeaders,
    );
    const outboundBytes = new TextEncoder().encode(forwardedBody);
    publishSafeHttpEnvelopeArtifact(options.journey, {
      artifactId: `provider_native_outbound_request_envelope.${options.attempt}`,
      artifactKind: "provider_native_outbound_request_envelope",
      method: "POST",
      url: endpoint,
      headers: new Headers(headers),
      location: envelopeLocation,
    });
    const capturedBytes = outboundBytes.byteLength;
    observeAnthropicNativeTransport(options.journey, {
      kind: "artifact_observed",
      artifactId: `provider_native_outbound_request_wire.${options.attempt}`,
      artifactKind: "provider_native_outbound_request_wire",
      state:
        capturedBytes < outboundBytes.byteLength ? "partial" : "captured",
      mediaType: "application/json",
      bytes: outboundBytes.subarray(0, capturedBytes),
      originalBytes: outboundBytes.byteLength,
      capturedBytes,
      truncated: capturedBytes < outboundBytes.byteLength,
      location: envelopeLocation,
    });
    completeAnthropicNativeTransportStep(
      options.journey,
      envelopeStep,
      envelopeLocation,
      "success",
    );
  } catch (error) {
    completeAnthropicNativeTransportStep(
      options.journey,
      envelopeStep,
      envelopeLocation,
      "failed",
    );
    throw error;
  }

  const dispatchLocation = {
    phase: "upstream_execution",
    lane: "provider_native",
    step: "dispatch_provider_native",
    attempt: options.attempt,
  } as const;
  const dispatchStep = `p4.dispatch_provider_native.${options.attempt}`;
  enterAnthropicNativeTransportStep(
    options.journey,
    dispatchStep,
    dispatchLocation,
  );
  observeAnthropicNativeTransport(options.journey, {
    kind: "attempt_observed",
    attempt: options.attempt,
    ...(options.profileId === undefined
      ? {}
      : { profileId: options.profileId }),
    transition: "started",
    location: dispatchLocation,
  });
  let upstream: Response;
  try {
    upstream = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: forwardedBody,
      signal,
    });
  } catch (error) {
    // The upstream request never reached a response (pre-commit transport
    // failure: connection refused, DNS, TLS, or abort). The client has not
    // received a single byte, so this follows the pre-commit error lifecycle:
    // the handler turns it into a legal Anthropic error, never a raw
    // exception. Caller cancellation keeps its own identity so the handler
    // can rethrow it as cancellation rather than as a transport failure.
    completeAnthropicNativeTransportStep(
      options.journey,
      dispatchStep,
      dispatchLocation,
      signal.aborted ? "aborted" : "failed",
    );
    if (signal.aborted) throw error;
    throw new AnthropicPassthroughTransportError(error);
  }
  completeAnthropicNativeTransportStep(
    options.journey,
    dispatchStep,
    dispatchLocation,
    "success",
  );
  publishSafeHttpEnvelopeArtifact(options.journey, {
    artifactId: `provider_native_upstream_response_envelope.${options.attempt}`,
    artifactKind: "provider_native_upstream_response_envelope",
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
    location: dispatchLocation,
  });

  const readLocation = {
    phase: "upstream_execution",
    lane: "provider_native",
    step: "read_provider_native_response",
    attempt: options.attempt,
  } as const;
  const readStep = `p4.read_provider_native_response.${options.attempt}`;
  enterAnthropicNativeTransportStep(options.journey, readStep, readLocation);
  observeAnthropicNativeTransport(options.journey, {
    kind: "attempt_observed",
    attempt: options.attempt,
    ...(options.profileId === undefined
      ? {}
      : { profileId: options.profileId }),
    status: upstream.status,
    transition: "response",
    location: readLocation,
  });
  let body: Uint8Array<ArrayBuffer>;
  try {
    body = new Uint8Array(await upstream.arrayBuffer());
  } catch (error) {
    // The upstream response headers arrived but the body read failed
    // (pre-commit): the upstream response never committed to the client. Same
    // pre-commit error lifecycle as above. Caller cancellation keeps its own
    // identity so the handler can rethrow it as cancellation rather than as
    // a body failure.
    observeAnthropicNativeTransport(options.journey, {
      kind: "artifact_observed",
      artifactId: `provider_native_upstream_response_wire.${options.attempt}`,
      artifactKind: "provider_native_upstream_response_wire",
      state: "unavailable",
      ...(upstream.headers.get("content-type") === null
        ? {}
        : { mediaType: upstream.headers.get("content-type")! }),
      reason: "response_body_read_failed",
      location: readLocation,
    });
    completeAnthropicNativeTransportStep(
      options.journey,
      readStep,
      readLocation,
      signal.aborted ? "aborted" : "failed",
    );
    if (signal.aborted) throw error;
    throw new AnthropicPassthroughBodyReadError(error);
  }
  const capturedBytes = body.byteLength;
  observeAnthropicNativeTransport(options.journey, {
    kind: "artifact_observed",
    artifactId: `provider_native_upstream_response_wire.${options.attempt}`,
    artifactKind: "provider_native_upstream_response_wire",
    state: capturedBytes < body.byteLength ? "partial" : "captured",
    ...(upstream.headers.get("content-type") === null
      ? {}
      : { mediaType: upstream.headers.get("content-type")! }),
    bytes: body.subarray(0, capturedBytes),
    originalBytes: body.byteLength,
    capturedBytes,
    truncated: capturedBytes < body.byteLength,
    location: readLocation,
  });
  completeAnthropicNativeTransportStep(
    options.journey,
    readStep,
    readLocation,
    "success",
  );
  return {
    status: upstream.status,
    headers: filterHeaders(upstream.headers, isSafeResponseHeader),
    body,
  };
}

/**
 * Project every externally visible model identity of a buffered upstream
 * Anthropic response to the requested alias (Ticket 15 native passthrough
 * symmetry).
 *
 * Supported shapes:
 *
 * - non-streaming (`application/json`): the top-level `model` field;
 * - streaming (`text/event-stream`): the nested `message.model` of the
 *   `message_start` event, plus any event that carries a top-level `model`.
 *
 * The response is buffered before projection, so a shape that cannot be
 * guaranteed symmetric fails with `{ error }` and the caller returns a
 * legal target-protocol error instead of leaking upstream bytes or the
 * canonical model id. Non-model-bearing SSE events pass through
 * byte-identical; rewritten events are re-serialized with only the model
 * field changed.
 */
export function projectAnthropicPassthroughBody(
  body: Uint8Array,
  contentType: string,
  alias: string,
): { readonly body: Uint8Array<ArrayBuffer> } | { readonly error: string } {
  const text = new TextDecoder().decode(body);
  if (contentType.toLowerCase().includes("text/event-stream")) {
    return projectAnthropicSse(text, alias);
  }
  return projectAnthropicJsonObject(text, alias);
}

/**
 * Collect every path to a `model` property key in a parsed JSON tree.
 * Only keys are identity candidates; `model` text inside string values is
 * semantic content and is never scanned. A depth bound keeps adversarial
 * nesting bounded; the sentinel path fails every approved-position check.
 */
const MAX_MODEL_SCAN_DEPTH = 64;
const DEPTH_SENTINEL = "<max-depth>";

function collectModelPaths(
  value: unknown,
  path: string[] = [],
  out: string[] = [],
  depth = 0,
): string[] {
  if (depth > MAX_MODEL_SCAN_DEPTH) {
    out.push(DEPTH_SENTINEL);
    return out;
  }
  if (typeof value !== "object" || value === null) return out;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      collectModelPaths(value[index], [...path, String(index)], out, depth + 1);
    }
    return out;
  }
  for (const [key, entry] of Object.entries(value)) {
    const next = [...path, key];
    if (key === "model") out.push(next.join("."));
    collectModelPaths(entry, next, out, depth + 1);
  }
  return out;
}

function projectAnthropicJsonObject(
  text: string,
  alias: string,
): { readonly body: Uint8Array<ArrayBuffer> } | { readonly error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "Anthropic passthrough response is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: "Anthropic passthrough response is not a JSON object" };
  }
  const record = parsed as Record<string, unknown>;
  // The approved response-metadata position is exactly the top-level
  // `model`. Any other `model` key in the tree (tool inputs, nested
  // objects) cannot be told apart from semantic content: fail closed
  // rather than rewrite user/tool payloads or leak identity.
  const paths = collectModelPaths(parsed);
  if (paths.length !== 1 || paths[0] !== "model") {
    return {
      error: "Anthropic passthrough response carries an ambiguous model position",
    };
  }
  if (typeof record.model !== "string") {
    return {
      error: "Anthropic passthrough response carries no model identity",
    };
  }
  record.model = alias;
  return { body: new TextEncoder().encode(JSON.stringify(record)) };
}

/**
 * Rewrite model identity in one parsed Anthropic SSE event payload.
 *
 * The only approved position in the Anthropic streaming shape is
 * `message_start.message.model`. Any other `model` key anywhere in an
 * event (a simultaneous top-level `model`, a type-less nested
 * `message.model`, or a model inside any other event) is ambiguous: fail
 * closed so no structural model identity outside the approved position can
 * survive. Events without any model key pass through unchanged.
 */
function rewriteAnthropicSseEvent(
  parsed: unknown,
  alias: string,
): { readonly json: string } | { readonly unchanged: true } | { readonly error: string } {
  if (typeof parsed !== "object" || parsed === null) {
    // Non-object data cannot carry model keys: pass through unchanged.
    // Array roots fall through to the same structural model-key scan as
    // objects (an array element may carry a `model` key).
    return { unchanged: true };
  }
  const record = parsed as Record<string, unknown>;
  const paths = collectModelPaths(parsed);
  if (record.type === "message_start") {
    if (paths.length !== 1 || paths[0] !== "message.model") {
      return {
        error: "message_start carries an ambiguous model position",
      };
    }
    const message = record.message as Record<string, unknown>;
    if (typeof message.model !== "string") {
      return { error: "message_start carries no model identity" };
    }
    message.model = alias;
    return { json: JSON.stringify(record) };
  }
  if (paths.length !== 0) {
    return { error: "Anthropic SSE event carries an unsupported model position" };
  }
  return { unchanged: true };
}

function projectAnthropicSse(
  text: string,
  alias: string,
): { readonly body: Uint8Array<ArrayBuffer> } | { readonly error: string } {
  const out: string[] = [];
  for (const frame of parseSseFrames(text)) {
    const payload = sseFramePayload(frame);
    if (payload.length === 0) {
      out.push(renderSseFrame(frame));
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return { error: "Anthropic passthrough SSE event is not valid JSON" };
    }
    const rewritten = rewriteAnthropicSseEvent(parsed, alias);
    if ("error" in rewritten) return { error: rewritten.error };
    if ("unchanged" in rewritten) {
      out.push(renderSseFrame(frame));
      continue;
    }
    // Rewritten frames keep their non-data fields and carry the projected
    // payload as one canonical data line.
    const fields = frame.lines.filter(
      (line): line is Extract<SseFrameLine, { kind: "field" }> =>
        line.kind === "field",
    );
    out.push(
      renderSseFrame({
        lines: Object.freeze([
          ...fields,
          { kind: "data" as const, payload: rewritten.json },
        ]),
      }),
    );
  }
  return { body: new TextEncoder().encode(out.join("")) };
}

/**
 * A pre-commit failure while reading the upstream response body: the upstream
 * response headers arrived but the body never committed to the client. This
 * follows the pre-commit error lifecycle: the handler renders a legal
 * Anthropic error instead of a raw transport exception. Request-local; never
 * crosses into a shared boundary.
 */
export class AnthropicPassthroughBodyReadError extends Error {
  readonly kind = "AnthropicPassthroughBodyReadError";

  constructor(cause: unknown) {
    super(
      `Failed to read the upstream response body: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = "AnthropicPassthroughBodyReadError";
  }
}

/**
 * A pre-commit transport failure: the upstream request itself rejected
 * (connection refused, DNS/TLS failure, network reset) before any response
 * header arrived. Same pre-commit error lifecycle as
 * `AnthropicPassthroughBodyReadError`; the handler renders a legal Anthropic
 * error instead of a raw transport exception. Caller cancellation keeps its
 * own identity so the handler can rethrow it as cancellation rather than as
 * a transport failure. Request-local; never crosses a shared boundary.
 */
export class AnthropicPassthroughTransportError extends Error {
  readonly kind = "AnthropicPassthroughTransportError";

  constructor(cause: unknown) {
    super(
      `Upstream passthrough request failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = "AnthropicPassthroughTransportError";
  }
}
