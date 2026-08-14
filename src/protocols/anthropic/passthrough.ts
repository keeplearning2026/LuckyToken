import type { FetchFunction, Model } from "@earendil-works/pi-ai";

export interface PassthroughAnthropicRequestOptions {
  readonly model: Model<string>;
  readonly rawBody: string;
  readonly apiKey: string | undefined;
  readonly signal: AbortSignal;
  readonly fetch: FetchFunction;
  readonly upstreamHeaders?: Readonly<Record<string, string>>;
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

function buildUpstreamHeaders(
  apiKey: string,
  upstreamHeaders: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (upstreamHeaders !== undefined) {
    for (const [name, value] of Object.entries(upstreamHeaders)) {
      const lower = name.toLowerCase();
      if (HOP_BY_HOP.has(lower) || FORBIDDEN_RESPONSE_HEADERS.has(lower)) {
        continue;
      }
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
    throw new Error(
      `No API key configured for passthrough provider: ${model.provider}`,
    );
  }
  const endpoint = joinEndpoint(model.baseUrl, "/v1/messages");
  const forwardedBody = rewriteModelSelector(rawBody, model.id);
  const upstream = await fetchImpl(endpoint, {
    method: "POST",
    headers: buildUpstreamHeaders(apiKey, options.upstreamHeaders),
    body: forwardedBody,
    signal,
  });
  let body: Uint8Array<ArrayBuffer>;
  try {
    body = new Uint8Array(await upstream.arrayBuffer());
  } catch (error) {
    // The upstream response never committed to the client (pre-commit). A
    // body-read/stream failure follows the pre-commit error lifecycle: the
    // handler turns it into a legal Anthropic error, never a raw exception.
    // Caller cancellation keeps its own identity so the handler can rethrow
    // it as cancellation rather than as a body failure.
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
 * A pre-commit failure while reading the upstream response body. The
 * upstream response bytes never committed to the client, so this follows the
 * pre-commit error lifecycle: the handler renders a legal Anthropic error
 * instead of a raw transport exception. Request-local; never crosses into a
 * shared boundary.
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
