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
 * Forward an Anthropic Messages request verbatim to an upstream Anthropic
 * endpoint under the native passthrough profile.
 *
 * The client's raw request body is sent unchanged, authenticated with the
 * upstream `x-api-key`. Only approved end-to-end headers cross; hop-by-hop,
 * cookie, auth, and stale content-length/encoding headers never do. The
 * upstream response is buffered once, its headers filtered to the safe set,
 * and returned for atomic delivery.
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
  const endpoint = new URL("/v1/messages", model.baseUrl).toString();
  const upstream = await fetchImpl(endpoint, {
    method: "POST",
    headers: buildUpstreamHeaders(apiKey, options.upstreamHeaders),
    body: rawBody,
    signal,
  });
  const body = new Uint8Array(await upstream.arrayBuffer());
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
