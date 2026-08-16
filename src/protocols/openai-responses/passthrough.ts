import type { FetchFunction, Model } from "@earendil-works/pi-ai";

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
