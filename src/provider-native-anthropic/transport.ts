import type { FetchFunction, Model } from "@earendil-works/pi-ai";

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
  readonly upstreamHeaders?: Readonly<Record<string, string>>;
  /**
   * Composed Provider-facing request facts (Ticket 10): the auth result's
   * merged headers (built-in static model headers, configured provider/
   * model headers, authHeader Authorization). These are the operator's
   * authoritative request headers; client-forwarded headers merge below
   * them and the resolved apiKey always owns `x-api-key`. Null values
   * (ProviderHeaders) are ignored.
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
 * Selection is based on the Pi model's declared API (`anthropic-messages`),
 * never on a concrete Provider name or provider-private fields. This is the
 * only place that knows the compatibility rule; the handler routes on the
 * result.
 */
export function isAnthropicNativePassthroughModel(
  model: Model<string>,
): boolean {
  return model.api === "anthropic-messages";
}

const FORWARDED_REQUEST_HEADERS = new Set([
  "anthropic-beta",
  "anthropic-user-profile-id",
  "x-stainless-*",
]);

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

function isSafeForwardedRequestHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (HOP_BY_HOP.has(lower)) return false;
  if (FORBIDDEN_RESPONSE_HEADERS.has(lower)) return false;
  if (lower.startsWith("x-stainless-")) return true;
  return FORWARDED_REQUEST_HEADERS.has(lower);
}

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

/** Request fields the transport itself owns: neither composed Provider
 *  headers nor client headers may override them (mirrors the pinned SDK,
 *  which sets these after merging default headers). */
const TRANSPORT_OWNED = new Set(["content-type", "anthropic-version"]);

function buildUpstreamHeaders(
  apiKey: string | undefined,
  upstreamHeaders: Readonly<Record<string, string>> | undefined,
  composedHeaders: Readonly<Record<string, string | null>> | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  // Header-only auth (no resolved apiKey) must not fabricate an empty
  // x-api-key field; a composed x-api-key then carries the credential.
  const ownsApiKey = apiKey !== undefined && apiKey.length > 0;
  if (ownsApiKey) {
    headers["x-api-key"] = apiKey;
  }
  // Client-forwarded end-to-end headers (existing strict whitelist).
  if (upstreamHeaders !== undefined) {
    for (const [name, value] of Object.entries(upstreamHeaders)) {
      const lower = name.toLowerCase();
      if (HOP_BY_HOP.has(lower) || FORBIDDEN_RESPONSE_HEADERS.has(lower)) {
        continue;
      }
      headers[lower] = value;
    }
  }
  // Composed Provider-facing headers are the operator's authority: they
  // merge above client headers and may carry their own Authorization or
  // x-api-key (header-only auth). Hop-by-hop and transport-owned fields
  // stay fixed; a composed x-api-key yields to the transport-generated
  // credential whenever a resolved apiKey exists (lowercased names, so a
  // mixed-case composed entry emits exactly one header).
  if (composedHeaders !== undefined) {
    for (const [name, value] of Object.entries(composedHeaders)) {
      const lower = name.toLowerCase();
      if (HOP_BY_HOP.has(lower) || TRANSPORT_OWNED.has(lower)) continue;
      if (ownsApiKey && lower === "x-api-key") continue;
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
 * Replace the `model` field of a raw Anthropic request body with the
 * registered model id.
 *
 * The client selector is a LuckyToken `provider/model_id` string; the
 * upstream wire addresses models by their bare model id. Forwarding the
 * qualified selector would leak a Lucky selector to the upstream, which
 * cannot resolve it. When the selector already equals the model id the raw
 * body is returned byte-identical. When the body has no `model` field it is
 * passed through untouched (a legal Anthropic request must carry one, but
 * this module never fabricates fields).
 */
function rewriteModelSelector(rawBody: string, modelId: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return rawBody;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.model !== "string") return rawBody;
  if (record.model === modelId) return rawBody;
  return JSON.stringify({ ...record, model: modelId });
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
  const endpoint = joinEndpoint(model.baseUrl, "/v1/messages");
  const forwardedBody = rewriteModelSelector(rawBody, model.id);
  let upstream: Response;
  try {
    upstream = await fetchImpl(endpoint, {
      method: "POST",
      headers: buildUpstreamHeaders(apiKey, options.upstreamHeaders, options.composedHeaders),
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
    if (signal.aborted) throw error;
    throw new AnthropicPassthroughTransportError(error);
  }
  let body: Uint8Array<ArrayBuffer>;
  try {
    body = new Uint8Array(await upstream.arrayBuffer());
  } catch (error) {
    // The upstream response headers arrived but the body read failed
    // (pre-commit): the upstream response never committed to the client. Same
    // pre-commit error lifecycle as above. Caller cancellation keeps its own
    // identity so the handler can rethrow it as cancellation rather than as
    // a body failure.
    if (signal.aborted) throw error;
    throw new AnthropicPassthroughBodyReadError(error);
  }
  return {
    status: upstream.status,
    headers: filterHeaders(upstream.headers, isSafeResponseHeader),
    body,
  };
}

export function passthroughRequestHeaders(
  request: Request,
): Readonly<Record<string, string>> {
  return filterHeaders(request.headers, isSafeForwardedRequestHeader);
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
