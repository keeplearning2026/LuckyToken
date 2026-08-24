import type {
  CodexFetchFunction,
  CodexLocalCredentialAuthority,
} from "../../codex-native-seam.js";
import {
  observeRequestJourney,
  type ClientProtocolHandler,
  type ClientProtocolRequestContext,
} from "../../http.js";

export const CODEX_SEARCH_URL =
  "https://chatgpt.com/backend-api/codex/alpha/search";

export interface CreateCodexLocalSearchHandlerOptions {
  readonly credentials: CodexLocalCredentialAuthority;
  readonly fetch: CodexFetchFunction;
  readonly maxRequestBytes: number;
}

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
]);

const CLIENT_CREDENTIAL_HEADERS = new Set([
  "authorization",
  "cookie",
  "api-key",
  "x-api-key",
  "chatgpt-account-id",
]);

const FORBIDDEN_RESPONSE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "www-authenticate",
]);

function requestHeaders(
  source: Headers,
  authorization: string,
  accountId: string | undefined,
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
      CLIENT_CREDENTIAL_HEADERS.has(lower) ||
      connectionHeaders.has(lower)
    ) {
      continue;
    }
    result.set(lower, value);
  }
  result.set("authorization", authorization);
  if (accountId !== undefined) {
    result.set("chatgpt-account-id", accountId);
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
      FORBIDDEN_RESPONSE_HEADERS.has(lower) ||
      connectionHeaders.has(lower)
    ) {
      continue;
    }
    result.set(lower, value);
  }
  return result;
}

function authenticationError(): Response {
  return new Response(
    JSON.stringify({
      error: {
        type: "authentication_error",
        message: "Local Codex credential is unavailable",
      },
    }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
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

function completeSearch(
  context: ClientProtocolRequestContext | undefined,
  response: Response,
): Response {
  const failed = response.status >= 400;
  const presentationLocation = {
    phase: "client_response_preparation",
    lane: "local_native",
    step: failed ? "render_local_search_error" : "prepare_local_search_response",
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
    lane: "local_native",
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
    terminalAuthority: "codex_local_search_handler",
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
  return response;
}

export function createCodexLocalSearchHandler(
  options: CreateCodexLocalSearchHandlerOptions,
): ClientProtocolHandler {
  return Object.freeze({
    method: "POST",
    pathname: "/v1/alpha/search",
    async handle(
      request: Request,
      context?: ClientProtocolRequestContext,
    ): Promise<Response> {
      const laneLocation = {
        phase: "request_resolution",
        lane: "local_native",
        step: "commit_local_search_lane",
      } as const;
      observeSearch(context, {
        kind: "step_entered",
        stepInstanceId: "p2.commit_local_search_lane",
        location: laneLocation,
      });
      observeSearch(context, {
        kind: "lane_committed",
        lane: "local_native",
        location: laneLocation,
      });
      observeSearch(context, {
        kind: "step_completed",
        stepInstanceId: "p2.commit_local_search_lane",
        completion: "success",
        operation: "web_search",
        protocol: "codex-alpha-search",
        location: laneLocation,
      });
      const forwardAuth = await options.credentials.resolveForwardAuth(
        request.headers,
      );
      if (forwardAuth === undefined) {
        return completeSearch(context, authenticationError());
      }
      const body = await readBoundedBody(request, options.maxRequestBytes);
      if (body === undefined) {
        return completeSearch(context, payloadTooLargeError());
      }
      const headers = requestHeaders(
        request.headers,
        forwardAuth.authorization,
        forwardAuth.accountId,
      );
      const upstreamUrl = `${CODEX_SEARCH_URL}${new URL(request.url).search}`;
      let upstream: Response;
      try {
        upstream = await options.fetch(upstreamUrl, {
          method: "POST",
          headers,
          body,
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
      return completeSearch(context, response);
    },
  });
}
