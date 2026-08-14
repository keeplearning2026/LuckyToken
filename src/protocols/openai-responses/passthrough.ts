import type { FetchFunction, Model } from "@earendil-works/pi-ai";

export interface PassthroughResponsesRequestOptions {
  readonly model: Model<string>;
  readonly rawBody: string;
  readonly apiKey: string | undefined;
  readonly signal: AbortSignal;
  readonly fetch: FetchFunction;
  readonly upstreamHeaders?: Readonly<Record<string, string>>;
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
  apiKey: string,
  upstreamHeaders: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
  if (upstreamHeaders !== undefined) {
    for (const [name, value] of Object.entries(upstreamHeaders)) {
      const lower = name.toLowerCase();
      if (HOP_BY_HOP.has(lower) || FORBIDDEN_HEADERS.has(lower)) {
        continue;
      }
      headers[lower] = value;
    }
  }
  return headers;
}

/**
 * Forward a Responses request verbatim to a compatible upstream under the
 * native passthrough profile.
 *
 * The client's raw body is sent unchanged with the upstream bearer
 * credential. Only approved end-to-end headers cross; hop-by-hop, cookie,
 * auth, and stale content-length/encoding headers never do. The upstream
 * response is buffered once, its headers filtered to the safe set, and
 * returned for atomic delivery.
 */
export async function passthroughResponsesRequest(
  options: PassthroughResponsesRequestOptions,
): Promise<PassthroughResponsesResult> {
  const { model, rawBody, apiKey, signal, fetch: fetchImpl } = options;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(
      `No API key configured for passthrough provider: ${model.provider}`,
    );
  }
  const endpoint = new URL("/v1/responses", model.baseUrl).toString();
  const upstream = await fetchImpl(endpoint, {
    method: "POST",
    headers: buildUpstreamHeaders(apiKey, options.upstreamHeaders),
    body: rawBody,
    signal,
  });
  let body: Uint8Array<ArrayBuffer>;
  try {
    body = new Uint8Array(await upstream.arrayBuffer());
  } catch (error) {
    // The upstream response never committed to the client (pre-commit). A
    // body-read/stream failure follows the pre-commit error lifecycle: the
    // handler turns it into a legal Responses error, never a raw exception.
    // Caller cancellation keeps its own identity so the handler can rethrow
    // it as cancellation rather than as a body failure.
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
 * A pre-commit failure while reading the upstream response body. The
 * upstream response bytes never committed to the client, so this follows the
 * pre-commit error lifecycle: the handler renders a legal Responses error
 * instead of a raw transport exception. Request-local; never crosses into a
 * shared boundary.
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

export function passthroughResponsesRequestHeaders(
  request: Request,
): Readonly<Record<string, string>> {
  return filterHeaders(request.headers, isSafeForwardedRequestHeader);
}
