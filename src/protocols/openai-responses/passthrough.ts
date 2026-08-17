import type { FetchFunction, Model } from "@earendil-works/pi-ai";

import {
  parseSseFrames,
  renderSseFrame,
  sseFramePayload,
  type SseFrameLine,
} from "../sse-lines.js";

export interface PassthroughResponsesRequestOptions {
  readonly model: Model<string>;
  readonly rawBody: string;
  readonly apiKey: string | undefined;
  readonly signal: AbortSignal;
  readonly fetch: FetchFunction;
  readonly upstreamHeaders?: Readonly<Record<string, string>>;
  /**
   * Composed Provider-facing request facts (Ticket 10): the auth result's
   * merged headers (built-in static model headers, configured provider/
   * model headers, authHeader Authorization). The resolved apiKey always
   * owns the transport Authorization field; other composed headers merge
   * above client-forwarded ones. Null values (ProviderHeaders) are ignored.
   */
  readonly composedHeaders?: Readonly<Record<string, string | null>>;
}

export interface PassthroughResponsesResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array<ArrayBuffer>;
}

/**
 * Declared wire compatibility for native Responses passthrough.
 *
 * Selection is based on the Pi model's declared API (`openai-responses`),
 * never on a concrete Provider name or provider-private fields. Codex and
 * Azure Responses variants are distinct wire protocols and are not selected
 * here; they are not "the same protocol" merely because they share the
 * Responses name family.
 */
export function isResponsesNativePassthroughModel(
  model: Model<string>,
): boolean {
  return model.api === "openai-responses";
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

const FORBIDDEN_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "proxy-authorization",
  "www-authenticate",
]);

function isSafeForwardedRequestHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (HOP_BY_HOP.has(lower)) return false;
  if (FORBIDDEN_HEADERS.has(lower)) return false;
  if (lower.startsWith("x-stainless-")) return true;
  return false;
}

function isSafeResponseHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (HOP_BY_HOP.has(lower)) return false;
  if (FORBIDDEN_HEADERS.has(lower)) return false;
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

function buildUpstreamHeaders(
  apiKey: string | undefined,
  upstreamHeaders: Readonly<Record<string, string>> | undefined,
  composedHeaders: Readonly<Record<string, string | null>> | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  // The transport owns the Bearer Authorization exactly when a non-empty
  // API key resolved (pinned getClientApiKey): no fabricated `Bearer
  // undefined`/`Bearer unused` for header-only auth.
  const ownsAuthorization = apiKey !== undefined && apiKey.length > 0;
  if (ownsAuthorization) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  if (upstreamHeaders !== undefined) {
    for (const [name, value] of Object.entries(upstreamHeaders)) {
      const lower = name.toLowerCase();
      if (HOP_BY_HOP.has(lower) || FORBIDDEN_HEADERS.has(lower)) {
        continue;
      }
      headers[lower] = value;
    }
  }
  // Composed Provider-facing headers merge above client headers. When no
  // API key resolved, a composed `authorization` (or `cf-aig-authorization`)
  // is the credential and passes through untouched; with an API key the
  // transport-owned Authorization stays authoritative.
  if (composedHeaders !== undefined) {
    for (const [name, value] of Object.entries(composedHeaders)) {
      const lower = name.toLowerCase();
      if (HOP_BY_HOP.has(lower) || lower === "content-type") {
        continue;
      }
      if (ownsAuthorization && lower === "authorization") continue;
      if (value === undefined || value === null) continue;
      headers[lower] = value;
    }
  }
  return headers;
}

/**
 * Join a configured base URL with a fixed endpoint path, preserving any
 * base-path prefix. The Responses wire addresses models under a configured
 * origin/path; an absolute `new URL` would silently drop a configured path
 * prefix. This mirrors the SDK concatURL semantics (architecture §1.2: "URL
 * construction preserves the configured base path unless the upstream
 * contract explicitly defines an absolute endpoint").
 */
function joinEndpoint(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}${path}`;
}

/**
 * Replace the `model` field of a raw Responses request body with the
 * registered model id.
 *
 * The client selector is a LuckyToken `provider/model_id` string; the
 * upstream wire addresses models by their bare model id. Forwarding the
 * qualified selector would leak a Lucky selector to the upstream, which
 * cannot resolve it. When the selector already equals the model id the raw
 * body is returned byte-identical. When the body has no `model` field it is
 * passed through untouched (a legal Responses request must carry one, but
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
 * Forward a Responses request to a compatible upstream under the native
 * passthrough profile.
 *
 * The client's raw body is sent with the upstream bearer credential and the
 * model selector rewritten to the registered model id (no qualified Lucky
 * selector crosses the boundary). Only approved end-to-end headers cross;
 * hop-by-hop, cookie, auth, and stale content-length/encoding headers never
 * do. The upstream response is buffered once, its headers filtered to the
 * safe set, and returned for atomic delivery.
 */
export async function passthroughResponsesRequest(
  options: PassthroughResponsesRequestOptions,
): Promise<PassthroughResponsesResult> {
  const { model, rawBody, apiKey, signal, fetch: fetchImpl } = options;
  if (apiKey === undefined || apiKey.length === 0) {
    // Header-owned auth (e.g. cloudflare-ai-gateway's cf-aig-authorization,
    // a composed authorization) is a valid Provider-facing credential;
    // mirror the pinned getClientApiKey acceptance.
    const composed = options.composedHeaders ?? {};
    const hasHeaderAuth = Object.entries(composed).some(([name, value]) => {
      const lower = name.toLowerCase();
      return (
        (lower === "authorization" || lower === "cf-aig-authorization") &&
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
  const endpoint = joinEndpoint(model.baseUrl, "/v1/responses");
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
    // the handler turns it into a legal Responses error, never a raw
    // exception. Caller cancellation keeps its own identity so the handler
    // can rethrow it as cancellation rather than as a transport failure.
    if (signal.aborted) throw error;
    throw new ResponsesPassthroughTransportError(error);
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
    throw new ResponsesPassthroughBodyReadError(error);
  }
  return {
    status: upstream.status,
    headers: filterHeaders(upstream.headers, isSafeResponseHeader),
    body,
  };
}

/**
 * A pre-commit failure while reading the upstream response body: the upstream
 * response headers arrived but the body never committed to the client. This
 * follows the pre-commit error lifecycle: the handler renders a legal
 * Responses error instead of a raw transport exception. Request-local; never
 * crosses into a shared boundary.
 */
export class ResponsesPassthroughBodyReadError extends Error {
  readonly kind = "ResponsesPassthroughBodyReadError";

  constructor(cause: unknown) {
    super(
      `Failed to read the upstream response body: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = "ResponsesPassthroughBodyReadError";
  }
}

/**
 * A pre-commit transport failure: the upstream request itself rejected
 * (connection refused, DNS/TLS failure, network reset) before any response
 * header arrived. Same pre-commit error lifecycle as
 * `ResponsesPassthroughBodyReadError`; the handler renders a legal Responses
 * error instead of a raw transport exception. Caller cancellation keeps its
 * own identity so the handler can rethrow it as cancellation rather than as
 * a transport failure. Request-local; never crosses a shared boundary.
 */
export class ResponsesPassthroughTransportError extends Error {
  readonly kind = "ResponsesPassthroughTransportError";

  constructor(cause: unknown) {
    super(
      `Upstream passthrough request failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = "ResponsesPassthroughTransportError";
  }
}

export function passthroughResponsesRequestHeaders(
  request: Request,
): Readonly<Record<string, string>> {
  return filterHeaders(request.headers, isSafeForwardedRequestHeader);
}

/**
 * Project every externally visible model identity of a buffered upstream
 * Responses response to the requested alias (Ticket 15 native passthrough
 * symmetry).
 *
 * Supported shapes:
 *
 * - non-streaming (`application/json`): the top-level `model` field of the
 *   Response object;
 * - streaming (`text/event-stream`): every event payload that carries a
 *   top-level `model` (the full Response objects embedded in
 *   `response.created`, `response.completed`, `response.failed` and
 *   `response.incomplete`).
 *
 * The response is buffered before projection, so a shape that cannot be
 * guaranteed symmetric fails with `{ error }` and the caller returns a
 * legal target-protocol error instead of leaking upstream bytes or the
 * canonical model id. Events without a model identity pass through
 * byte-identical; rewritten events are re-serialized with only the model
 * field changed.
 */
export function projectResponsesPassthroughBody(
  body: Uint8Array,
  contentType: string,
  alias: string,
): { readonly body: Uint8Array<ArrayBuffer> } | { readonly error: string } {
  const text = new TextDecoder().decode(body);
  if (contentType.toLowerCase().includes("text/event-stream")) {
    return projectResponsesSse(text, alias);
  }
  return projectResponsesJsonObject(text, alias);
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

function projectResponsesJsonObject(
  text: string,
  alias: string,
): { readonly body: Uint8Array<ArrayBuffer> } | { readonly error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "Responses passthrough response is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: "Responses passthrough response is not a JSON object" };
  }
  const record = parsed as Record<string, unknown>;
  // The approved response-metadata position is exactly the top-level
  // `model`. Any other `model` key in the tree (output items, nested
  // objects) cannot be told apart from semantic content: fail closed
  // rather than rewrite user/tool payloads or leak identity.
  const paths = collectModelPaths(parsed);
  if (paths.length !== 1 || paths[0] !== "model") {
    return {
      error: "Responses passthrough response carries an ambiguous model position",
    };
  }
  if (typeof record.model !== "string") {
    return {
      error: "Responses passthrough response carries no model identity",
    };
  }
  record.model = alias;
  return { body: new TextEncoder().encode(JSON.stringify(record)) };
}

/**
 * Rewrite the model identity of one parsed Responses SSE event payload.
 *
 * The approved position is the top-level `model` of a full Response
 * object (embedded in `response.created`, `response.completed`, and the
 * failed/incomplete variants). Any nested `model` key (e.g. inside an
 * output item object) cannot be told apart from semantic content: fail
 * closed. Events without any model key pass through unchanged.
 */
function rewriteResponsesSseEvent(
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
  if (paths.length === 0) return { unchanged: true };
  if (paths.length !== 1 || paths[0] !== "model") {
    return {
      error: "Responses SSE event carries an ambiguous model position",
    };
  }
  if (typeof record.model !== "string") {
    return { error: "Responses SSE event carries a non-string model" };
  }
  record.model = alias;
  return { json: JSON.stringify(record) };
}

function projectResponsesSse(
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
      return { error: "Responses passthrough SSE event is not valid JSON" };
    }
    const rewritten = rewriteResponsesSseEvent(parsed, alias);
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
