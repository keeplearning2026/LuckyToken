import type { CodexDirectFetch } from "../../codex-direct-seam.js";
import {
  deflateSync,
  gunzipSync,
  gzipSync,
  inflateSync,
  zstdCompressSync,
  zstdDecompressSync,
} from "node:zlib";
import { parseTree, type ParseError } from "jsonc-parser";
import {
  observeRequestJourney,
  type ClientProtocolHandler,
  type ClientProtocolRequestContext,
} from "../../http.js";
import {
  preserveDirectResponse,
  preserveDirectStatusText,
} from "../../direct-http-response.js";

export const CODEX_SEARCH_URL =
  "https://chatgpt.com/backend-api/codex/alpha/search";
export const DEFAULT_CODEX_SEARCH_MODEL = "gpt-6-luna";

export interface CreateCodexDirectSearchHandlerOptions {
  readonly fetch: CodexDirectFetch;
  readonly maxRequestBytes: number;
  readonly model?: () => string;
}

type SearchRequestDecodeFailureReason =
  | "unsupported_content_encoding"
  | "request_body_exceeds_limit"
  | "request_body_decode_failed";

type SearchClientRequestUnavailableReason =
  | SearchRequestDecodeFailureReason
  | "request_body_read_failed"
  | "request_body_read_aborted";

type DecodedSearchRequest =
  | { readonly state: "decoded"; readonly bytes: Uint8Array<ArrayBuffer> }
  | {
      readonly state: "unavailable";
      readonly reason: SearchRequestDecodeFailureReason;
    };

interface RewrittenSearchRequest {
  readonly decodedBytes: Uint8Array<ArrayBuffer>;
  readonly outboundBytes: Uint8Array<ArrayBuffer>;
}

const SEARCH_CONTENT_ENCODINGS = new Set([
  "",
  "identity",
  "zstd",
  "gzip",
  "x-gzip",
  "deflate",
]);

const CLIENT_REQUEST_WIRE_LOCATION = {
  phase: "protocol_ingress",
  step: "read_and_decode_body",
} as const;

const DIRECT_OUTBOUND_REQUEST_WIRE_LOCATION = {
  phase: "lane_request_preparation",
  lane: "direct",
  step: "construct_direct_envelope",
} as const;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "expect",
]);

function requestHeaders(
  source: Headers,
): Headers {
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
      HOP_BY_HOP_HEADERS.has(lower) ||
      connectionHeaders.has(lower)
    ) {
      continue;
    }
    result.append(lower, value);
  }
  return result;
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
      HOP_BY_HOP_HEADERS.has(lower) ||
      connectionHeaders.has(lower)
    ) {
      continue;
    }
    result.append(lower, value);
  }
  return result;
}

function payloadTooLargeError(): Response {
  return new Response(
    JSON.stringify({
      error: {
        type: "invalid_request_error",
        message: "Search request body is too large",
      },
    }),
    { status: 413, headers: { "content-type": "application/json" } },
  );
}

function requestReadFailureError(): Response {
  return new Response(null, { status: 500 });
}

function invalidSearchBodyError(): Response {
  return new Response(
    JSON.stringify({
      error: {
        type: "invalid_request_error",
        message: "Search request must contain a top-level model string in JSON",
      },
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

/** Bounded decode of the Client Request Wire. Diagnostics retains these
 *  decoded bytes, so transport compression never hides the search body. */
function decodeSearchRequest(
  wireBytes: Uint8Array<ArrayBuffer>,
  encodingHeader: string | null,
  maximumBytes: number,
): DecodedSearchRequest {
  const encoding = (encodingHeader ?? "identity").trim().toLowerCase();
  if (!SEARCH_CONTENT_ENCODINGS.has(encoding)) {
    return { state: "unavailable", reason: "unsupported_content_encoding" };
  }
  try {
    const limit = { maxOutputLength: maximumBytes };
    const decoded: Uint8Array =
      encoding === "identity" || encoding === ""
        ? wireBytes
        : encoding === "zstd"
          ? zstdDecompressSync(wireBytes, limit)
          : encoding === "gzip" || encoding === "x-gzip"
            ? gunzipSync(wireBytes, limit)
            : inflateSync(wireBytes, limit);
    if (decoded.byteLength > maximumBytes) {
      return { state: "unavailable", reason: "request_body_exceeds_limit" };
    }
    return {
      state: "decoded",
      bytes: decoded as Uint8Array<ArrayBuffer>,
    };
  } catch (error) {
    return {
      state: "unavailable",
      reason:
        (error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE"
          ? "request_body_exceeds_limit"
          : "request_body_decode_failed",
    };
  }
}

function rewriteSearchModel(
  decoded: Uint8Array<ArrayBuffer>,
  encodingHeader: string | null,
  model: string,
  maximumBytes: number,
): RewrittenSearchRequest | undefined {
  const encoding = (encodingHeader ?? "identity").trim().toLowerCase();
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
    const errors: ParseError[] = [];
    const root = parseTree(text, errors, {
      allowTrailingComma: false,
      disallowComments: true,
    });
    if (errors.length !== 0 || root?.type !== "object") return undefined;
    const modelProperties = root.children?.filter(
      (entry) => entry.children?.[0]?.value === "model",
    );
    if (modelProperties?.length !== 1) return undefined;
    const modelNode = modelProperties[0]?.children?.[1];
    if (modelNode?.type !== "string") return undefined;
    const rewritten = new TextEncoder().encode(
      text.slice(0, modelNode.offset) +
      JSON.stringify(model) +
      text.slice(modelNode.offset + modelNode.length),
    );
    if (rewritten.byteLength > maximumBytes) {
      return undefined;
    }
    return {
      decodedBytes: rewritten,
      outboundBytes: new Uint8Array(
        encoding === "zstd"
          ? zstdCompressSync(rewritten)
          : encoding === "gzip" || encoding === "x-gzip"
            ? gzipSync(rewritten)
            : encoding === "deflate"
              ? deflateSync(rewritten)
              : rewritten,
      ),
    };
  } catch {
    return undefined;
  }
}

function upstreamFailureError(): Response {
  return new Response(
    JSON.stringify({
      error: {
        type: "api_error",
        message: "Upstream search request failed",
      },
    }),
    { status: 502, headers: { "content-type": "application/json" } },
  );
}

async function readBoundedBody(
  request: Request,
  maximumBytes: number,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const declaredLength = request.headers.get("content-length")?.trim();
  if (
    declaredLength !== undefined &&
    /^\d+$/u.test(declaredLength) &&
    Number(declaredLength) > maximumBytes
  ) {
    return undefined;
  }
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const onAbort = () => {
    void reader.cancel(request.signal.reason).catch(() => undefined);
  };
  request.signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      request.signal.throwIfAborted();
      const { value, done } = await reader.read();
      request.signal.throwIfAborted();
      if (done) break;
      if (value === undefined || value.byteLength === 0) continue;
      length += value.byteLength;
      if (length > maximumBytes) {
        void reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    request.signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // Request cancellation may retain the reader lock briefly.
    }
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function observeSearch(
  context: ClientProtocolRequestContext | undefined,
  observation: Parameters<typeof observeRequestJourney>[1],
): void {
  if (context !== undefined) observeRequestJourney(context, observation);
}

function observeClientRequestUnavailable(
  context: ClientProtocolRequestContext | undefined,
  reason: SearchClientRequestUnavailableReason,
): void {
  observeSearch(context, {
    kind: "artifact_observed",
    artifactId: "client_request_wire",
    artifactKind: "client_request_wire",
    state: "unavailable",
    mediaType: "application/json",
    reason,
    location: CLIENT_REQUEST_WIRE_LOCATION,
  });
}

function completeSearch(
  context: ClientProtocolRequestContext | undefined,
  response: Response,
): Response {
  const failed = response.status >= 400;
  const presentationLocation = {
    phase: "client_response_preparation",
    lane: "direct",
    step: failed ? "render_direct_search_error" : "prepare_direct_search_response",
  } as const;
  observeSearch(context, {
    kind: "step_entered",
    stepInstanceId: `p6.${presentationLocation.step}`,
    location: presentationLocation,
  });
  observeSearch(context, {
    kind: "client_response_prepared",
    status: response.status,
    ...(response.headers.get("content-type") === null
      ? {}
      : { mediaType: response.headers.get("content-type")! }),
    location: presentationLocation,
  });
  observeSearch(context, {
    kind: "step_completed",
    stepInstanceId: `p6.${presentationLocation.step}`,
    completion: "success",
    operation: "web_search",
    protocol: "codex-alpha-search",
    location: presentationLocation,
  });
  const outcomeLocation = {
    phase: "outcome_commit",
    lane: "direct",
    step: "commit_request_outcome",
  } as const;
  observeSearch(context, {
    kind: "step_entered",
    stepInstanceId: "p7.commit_request_outcome",
    location: outcomeLocation,
  });
  observeSearch(context, {
    kind: "work_outcome_committed",
    outcome: failed ? "failed" : "success",
    terminalAuthority: "codex_direct_search_handler",
    location: outcomeLocation,
  });
  observeSearch(context, {
    kind: "step_completed",
    stepInstanceId: "p7.commit_request_outcome",
    completion: "success",
    operation: "web_search",
    protocol: "codex-alpha-search",
    location: outcomeLocation,
  });
  return preserveDirectResponse(response);
}

export function createCodexDirectSearchHandler(
  options: CreateCodexDirectSearchHandlerOptions,
): ClientProtocolHandler {
  return Object.freeze({
    method: "POST",
    pathname: "/v1/alpha/search",
    async handle(
      request: Request,
      context?: ClientProtocolRequestContext,
    ): Promise<Response> {
      let body: Uint8Array<ArrayBuffer> | undefined;
      try {
        body = await readBoundedBody(request, options.maxRequestBytes);
      } catch (error) {
        if (request.signal.aborted) {
          observeClientRequestUnavailable(context, "request_body_read_aborted");
          throw error;
        }
        observeClientRequestUnavailable(context, "request_body_read_failed");
        return completeSearch(context, requestReadFailureError());
      }
      if (body === undefined) {
        observeClientRequestUnavailable(context, "request_body_exceeds_limit");
        return completeSearch(context, payloadTooLargeError());
      }
      const decoded = decodeSearchRequest(
        body,
        request.headers.get("content-encoding"),
        options.maxRequestBytes,
      );
      if (decoded.state === "unavailable") {
        observeClientRequestUnavailable(context, decoded.reason);
        return completeSearch(context, invalidSearchBodyError());
      }
      observeSearch(context, {
        kind: "artifact_observed",
        artifactId: "client_request_wire",
        artifactKind: "client_request_wire",
        state: "captured",
        mediaType: "application/json",
        bytes: decoded.bytes,
        originalBytes: decoded.bytes.byteLength,
        truncated: false,
        location: CLIENT_REQUEST_WIRE_LOCATION,
      });

      const laneLocation = {
        phase: "request_resolution",
        lane: "direct",
        step: "commit_direct_search_lane",
      } as const;
      observeSearch(context, {
        kind: "step_entered",
        stepInstanceId: "p2.commit_direct_search_lane",
        location: laneLocation,
      });
      observeSearch(context, {
        kind: "lane_committed",
        lane: "direct",
        location: laneLocation,
      });
      observeSearch(context, {
        kind: "step_completed",
        stepInstanceId: "p2.commit_direct_search_lane",
        completion: "success",
        operation: "web_search",
        protocol: "codex-alpha-search",
        location: laneLocation,
      });

      const rewritten = rewriteSearchModel(
        decoded.bytes,
        request.headers.get("content-encoding"),
        options.model?.() ?? DEFAULT_CODEX_SEARCH_MODEL,
        options.maxRequestBytes,
      );
      if (rewritten === undefined) {
        return completeSearch(context, invalidSearchBodyError());
      }
      observeSearch(context, {
        kind: "artifact_observed",
        artifactId: "direct_outbound_request_wire",
        artifactKind: "direct_outbound_request_wire",
        state: "captured",
        mediaType: "application/json",
        bytes: rewritten.decodedBytes,
        originalBytes: rewritten.decodedBytes.byteLength,
        truncated: false,
        location: DIRECT_OUTBOUND_REQUEST_WIRE_LOCATION,
      });
      const headers = requestHeaders(request.headers);
      const upstreamUrl = `${CODEX_SEARCH_URL}${new URL(request.url).search}`;
      let upstream: Response;
      try {
        upstream = await options.fetch(upstreamUrl, {
          method: "POST",
          headers,
          body: rewritten.outboundBytes,
          signal: request.signal,
          redirect: "manual",
        });
      } catch (error) {
        if (request.signal.aborted) throw error;
        return completeSearch(context, upstreamFailureError());
      }
      let responseBody: Uint8Array<ArrayBuffer>;
      try {
        responseBody = new Uint8Array(await upstream.arrayBuffer());
      } catch (error) {
        if (request.signal.aborted) throw error;
        return completeSearch(context, upstreamFailureError());
      }
      const response = new Response(
        upstream.status === 204 || upstream.status === 205 || upstream.status === 304
          ? null
          : responseBody,
        {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders(upstream.headers),
        },
      );
      return preserveDirectStatusText(completeSearch(context, response));
    },
  });
}
