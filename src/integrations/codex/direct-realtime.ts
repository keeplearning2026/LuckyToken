import type { CodexDirectFetch } from "../../codex-direct-seam.js";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  closeRequestJourney,
  observeRequestJourney,
  type ClientProtocolHandler,
  type ClientProtocolRequestContext,
} from "../../http.js";
import type { WebSocketUpgradeHandler } from "../../websocket-upgrade.js";
import { preserveDirectStatusText } from "../../direct-http-response.js";
import WebSocket, { WebSocketServer, type RawData } from "ws";

export const CODEX_REALTIME_CALLS_URL =
  "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";
export const CODEX_REALTIME_HTTP_MAX_BYTES = 16 * 1024 * 1024;

export interface CreateCodexDirectRealtimeOptions {
  readonly fetch: CodexDirectFetch;
  readonly connectWebSocket?: CodexRealtimeWebSocketConnect;
}

export type CodexRealtimeWebSocketConnect = (
  url: string,
  headers: Record<string, string>,
) => WebSocket;

export interface CodexDirectRealtimeModule {
  readonly httpHandlers: readonly [ClientProtocolHandler, ClientProtocolHandler];
  readonly webSocketUpgrade: WebSocketUpgradeHandler;
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
  "expect",
]);

const STALE_RESPONSE_REPRESENTATION_HEADERS = new Set([
  "content-encoding",
  "content-md5",
  "digest",
  "content-digest",
  "repr-digest",
]);

function jsonError(
  status: number,
  type: string,
  message: string,
): Response {
  return new Response(JSON.stringify({ error: { type, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const onAbort = () => void reader.cancel(signal.reason).catch(() => undefined);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      if (value === undefined || value.byteLength === 0) continue;
      length += value.byteLength;
      if (length > CODEX_REALTIME_HTTP_MAX_BYTES) {
        void reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // An aborted stream can retain the reader lock briefly.
    }
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function relayHeaders(
  source: Headers,
  contentType: string,
): Headers {
  const connectionScoped = new Set(
    (source.get("connection") ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name.length > 0),
  );
  const result = new Headers();
  for (const [name, value] of source) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || connectionScoped.has(lower)) continue;
    result.append(lower, value);
  }
  result.set("content-type", contentType);
  result.set("accept-encoding", "identity");
  return result;
}

function safeResponseHeaders(source: Headers): Headers {
  const contentEncoding = source.get("content-encoding")?.trim().toLowerCase();
  const representationWasDecoded =
    contentEncoding === "gzip" ||
    contentEncoding === "x-gzip" ||
    contentEncoding === "deflate" ||
    contentEncoding === "br";
  const connectionScoped = new Set(
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
      (representationWasDecoded && STALE_RESPONSE_REPRESENTATION_HEADERS.has(lower)) ||
      connectionScoped.has(lower)
    ) {
      continue;
    }
    result.append(lower, value);
  }
  return result;
}

async function backendBody(
  inbound: Uint8Array<ArrayBuffer>,
  contentType: string,
): Promise<
  | Readonly<{ body: Uint8Array<ArrayBuffer>; contentType: string }>
  | Response
> {
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return Object.freeze({ body: inbound, contentType });
  }
  let form: FormData;
  try {
    form = await new Response(inbound, {
      headers: { "content-type": contentType },
    }).formData();
  } catch {
    return jsonError(
      400,
      "invalid_request_error",
      "Realtime call body is not valid multipart form data",
    );
  }
  const sdp = form.get("sdp");
  if (typeof sdp !== "string") {
    return jsonError(
      400,
      "invalid_request_error",
      "Realtime call requires a string sdp field",
    );
  }
  const sessionRaw = form.get("session");
  let session: unknown | undefined;
  if (sessionRaw !== null) {
    if (typeof sessionRaw !== "string") {
      return jsonError(
        400,
        "invalid_request_error",
        "Realtime call session field must be JSON text",
      );
    }
    try {
      session = JSON.parse(sessionRaw) as unknown;
    } catch {
      return jsonError(
        400,
        "invalid_request_error",
        "Realtime call session field must contain valid JSON",
      );
    }
  }
  return Object.freeze({
    body: new TextEncoder().encode(
      JSON.stringify(session === undefined ? { sdp } : { sdp, session }),
    ),
    contentType: "application/json",
  });
}

function createRealtimeHttpHandler(
  options: CreateCodexDirectRealtimeOptions,
  pathname: "/v1/realtime/calls" | "/v1/live",
): ClientProtocolHandler {
  return Object.freeze({
    method: "POST",
    pathname,
    async handle(
      request: Request,
      context?: ClientProtocolRequestContext,
    ): Promise<Response> {
      observeRealtimeLane(context);
      const callerEnvelopeLocation = realtimeLocation(
        "lane_request_preparation",
        "preserve_caller_envelope",
      );
      observeRealtime(context, {
        kind: "step_entered",
        stepInstanceId: "p3.preserve_caller_envelope",
        location: callerEnvelopeLocation,
      });
      observeRealtime(context, {
        kind: "step_completed",
        stepInstanceId: "p3.preserve_caller_envelope",
        completion: "success",
        location: callerEnvelopeLocation,
      });
      const envelopeLocation = realtimeLocation(
        "lane_request_preparation",
        "construct_direct_envelope",
      );
      observeRealtime(context, {
        kind: "step_entered",
        stepInstanceId: "p3.construct_direct_envelope",
        location: envelopeLocation,
      });
      const declaredLength = request.headers.get("content-length")?.trim();
      if (
        declaredLength !== undefined &&
        /^\d+$/u.test(declaredLength) &&
        Number(declaredLength) > CODEX_REALTIME_HTTP_MAX_BYTES
      ) {
        observeRealtime(context, {
          kind: "step_completed",
          stepInstanceId: "p3.construct_direct_envelope",
          completion: "failed",
          location: envelopeLocation,
        });
        return completeRealtimeHttp(context, jsonError(
          413,
          "invalid_request_error",
          "Realtime request body is too large",
        ), {
          classification: "realtime_request_too_large",
          origin: "client",
          location: envelopeLocation,
        });
      }
      const inbound = await readBoundedBody(request.body, request.signal);
      if (inbound === undefined) {
        observeRealtime(context, {
          kind: "step_completed",
          stepInstanceId: "p3.construct_direct_envelope",
          completion: "failed",
          location: envelopeLocation,
        });
        return completeRealtimeHttp(context, jsonError(
          413,
          "invalid_request_error",
          "Realtime request body is too large",
        ), {
          classification: "realtime_request_too_large",
          origin: "client",
          location: envelopeLocation,
        });
      }
      const encoded = await backendBody(
        inbound,
        request.headers.get("content-type") ?? "application/octet-stream",
      );
      if (encoded instanceof Response) {
        observeRealtime(context, {
          kind: "step_completed",
          stepInstanceId: "p3.construct_direct_envelope",
          completion: "failed",
          location: envelopeLocation,
        });
        return completeRealtimeHttp(context, encoded, {
          classification: "invalid_realtime_call_envelope",
          origin: "client",
          location: envelopeLocation,
        });
      }
      observeRealtime(context, {
        kind: "step_completed",
        stepInstanceId: "p3.construct_direct_envelope",
        completion: "success",
        location: envelopeLocation,
      });
      const dispatchLocation = realtimeLocation(
        "upstream_execution",
        "dispatch_direct_transport",
      );
      observeRealtime(context, {
        kind: "step_entered",
        stepInstanceId: "p4.dispatch_direct_transport",
        location: dispatchLocation,
      });
      let upstream: Response;
      try {
        upstream = await options.fetch(
          `${CODEX_REALTIME_CALLS_URL}${new URL(request.url).search.replace(/^\?/u, "&")}`,
          {
          method: "POST",
          headers: relayHeaders(request.headers, encoded.contentType),
          body: encoded.body,
          signal: request.signal,
          redirect: "manual",
          },
        );
      } catch (error) {
        if (request.signal.aborted) throw error;
        observeRealtime(context, {
          kind: "step_completed",
          stepInstanceId: "p4.dispatch_direct_transport",
          completion: "failed",
          location: dispatchLocation,
        });
        return completeRealtimeHttp(
          context,
          jsonError(502, "api_error", "Upstream realtime request failed"),
          {
            classification: "upstream_realtime_connection_failed",
            origin: "network_os",
            location: dispatchLocation,
          },
        );
      }
      observeRealtime(context, {
        kind: "step_completed",
        stepInstanceId: "p4.dispatch_direct_transport",
        completion: "success",
        location: dispatchLocation,
      });
      const preserveLocation = realtimeLocation(
        "lane_response_processing",
        "preserve_direct_response",
      );
      observeRealtime(context, {
        kind: "step_entered",
        stepInstanceId: "p5.preserve_direct_response",
        location: preserveLocation,
      });
      let responseBody: Uint8Array<ArrayBuffer> | undefined;
      try {
        responseBody = await readBoundedBody(upstream.body, request.signal);
      } catch (error) {
        if (request.signal.aborted) throw error;
        observeRealtime(context, {
          kind: "step_completed",
          stepInstanceId: "p5.preserve_direct_response",
          completion: "failed",
          location: preserveLocation,
        });
        return completeRealtimeHttp(
          context,
          jsonError(502, "api_error", "Upstream realtime request failed"),
          {
            classification: "upstream_realtime_response_read_failed",
            origin: "network_os",
            location: preserveLocation,
          },
        );
      }
      if (responseBody === undefined) {
        observeRealtime(context, {
          kind: "step_completed",
          stepInstanceId: "p5.preserve_direct_response",
          completion: "failed",
          location: preserveLocation,
        });
        return completeRealtimeHttp(
          context,
          jsonError(502, "api_error", "Upstream realtime response is too large"),
          {
            classification: "upstream_realtime_response_too_large",
            origin: "provider",
            location: preserveLocation,
          },
        );
      }
      observeRealtime(context, {
        kind: "step_completed",
        stepInstanceId: "p5.preserve_direct_response",
        completion: "success",
        location: preserveLocation,
      });
      return preserveDirectStatusText(completeRealtimeHttp(context, new Response(
        upstream.status === 204 || upstream.status === 205 || upstream.status === 304
          ? null
          : responseBody,
        {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: safeResponseHeaders(upstream.headers),
        },
      )));
    },
  });
}

function realtimeLocation(
  phase:
    | "request_resolution"
    | "lane_request_preparation"
    | "upstream_execution"
    | "lane_response_processing"
    | "client_response_preparation"
    | "outcome_commit"
    | "http_handoff",
  step: string,
) {
  return { phase, lane: "direct", step } as const;
}

function observeRealtime(
  context: ClientProtocolRequestContext | undefined,
  observation: Parameters<typeof observeRequestJourney>[1],
): void {
  if (context !== undefined) observeRequestJourney(context, observation);
}

function observeRealtimeLane(
  context: ClientProtocolRequestContext | undefined,
): void {
  const location = realtimeLocation(
    "request_resolution",
    "commit_direct_realtime_lane",
  );
  observeRealtime(context, {
    kind: "step_entered",
    stepInstanceId: "p2.commit_direct_realtime_lane",
    location,
  });
  observeRealtime(context, {
    kind: "lane_committed",
    lane: "direct",
    location,
  });
  observeRealtime(context, {
    kind: "step_completed",
    stepInstanceId: "p2.commit_direct_realtime_lane",
    completion: "success",
    operation: "realtime_session",
    protocol: "codex-realtime",
    location,
  });
}

function completeRealtimeHttp(
  context: ClientProtocolRequestContext | undefined,
  response: Response,
  failure?: Readonly<{
    classification: string;
    origin: "client" | "Token" | "provider" | "network_os";
    location: ReturnType<typeof realtimeLocation>;
  }>,
): Response {
  const failed = response.status >= 400;
  if (failed) {
    const incident = failure ?? {
      classification: "upstream_realtime_http_error",
      origin: "provider" as const,
      location: realtimeLocation("lane_response_processing", "preserve_direct_response"),
    };
    observeRealtime(context, {
      kind: "failure_detected",
      failureId: `${context?.requestId ?? "realtime"}:${incident.classification}`,
      role: "primary",
      classification: incident.classification,
      origin: incident.origin,
      originPrecision: incident.origin === "network_os" ? "boundary" : "exact",
      location: incident.location,
    });
  }
  const presentationLocation = realtimeLocation(
    "client_response_preparation",
    failed ? "render_direct_realtime_error" : "prepare_direct_realtime_response",
  );
  observeRealtime(context, {
    kind: "step_entered",
    stepInstanceId: `p6.${presentationLocation.step}`,
    location: presentationLocation,
  });
  observeRealtime(context, {
    kind: "client_response_prepared",
    status: response.status,
    ...(response.headers.get("content-type") === null
      ? {}
      : { mediaType: response.headers.get("content-type")! }),
    location: presentationLocation,
  });
  observeRealtime(context, {
    kind: "step_completed",
    stepInstanceId: `p6.${presentationLocation.step}`,
    completion: "success",
    operation: "realtime_session",
    protocol: "codex-realtime",
    location: presentationLocation,
  });
  const outcomeLocation = realtimeLocation("outcome_commit", "commit_request_outcome");
  observeRealtime(context, {
    kind: "step_entered",
    stepInstanceId: "p7.commit_request_outcome",
    location: outcomeLocation,
  });
  observeRealtime(context, {
    kind: "work_outcome_committed",
    outcome: failed ? "failed" : "success",
    terminalAuthority: "codex_direct_realtime_handler",
    location: outcomeLocation,
  });
  observeRealtime(context, {
    kind: "step_completed",
    stepInstanceId: "p7.commit_request_outcome",
    completion: "success",
    operation: "realtime_session",
    protocol: "codex-realtime",
    location: outcomeLocation,
  });
  return response;
}

function createCodexDirectRealtimeCallsHandler(
  options: CreateCodexDirectRealtimeOptions,
): ClientProtocolHandler {
  return createRealtimeHttpHandler(options, "/v1/realtime/calls");
}

function createCodexDirectLiveHandler(
  options: CreateCodexDirectRealtimeOptions,
): ClientProtocolHandler {
  return createRealtimeHttpHandler(options, "/v1/live");
}

const REALTIME_WS_API_ROOT = "wss://api.openai.com/v1";
const REALTIME_WS_MAX_MESSAGE_BYTES = 50 * 1024 * 1024;
const REALTIME_WS_PENDING_MAX_MESSAGES = 32;
const REALTIME_WS_PENDING_MAX_BYTES = 1024 * 1024;
const REALTIME_WS_CLOSE_FALLBACK_MS = 1_000;
const CALL_ID = /^[A-Za-z0-9_-]{1,128}$/u;
type RealtimeWebSocketTarget =
  | Readonly<{ style: "live-call"; callId: string; query: string }>
  | Readonly<{ style: "realtime-call"; callId: string; query: string }>
  | Readonly<{ style: "realtime-query"; callId: string; query: string }>
  | Readonly<{ style: "live-standalone"; query: string }>
  | Readonly<{ style: "realtime-standalone"; query: string }>;

function parseRealtimeWebSocketTarget(url: URL): RealtimeWebSocketTarget | undefined {
  const rawQuery = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  const live = url.pathname.match(/^\/v1\/live\/([^/]+)$/u);
  if (live !== null) {
    try {
      const callId = decodeURIComponent(live[1]!);
      return CALL_ID.test(callId)
        ? { style: "live-call", callId, query: rawQuery }
        : undefined;
    } catch {
      return undefined;
    }
  }
  const realtimeCall = url.pathname.match(
    /^\/v1\/realtime\/calls\/([^/]+)$/u,
  );
  if (realtimeCall !== null) {
    try {
      const callId = decodeURIComponent(realtimeCall[1]!);
      return CALL_ID.test(callId)
        ? { style: "realtime-call", callId, query: rawQuery }
        : undefined;
    } catch {
      return undefined;
    }
  }
  if (url.pathname === "/v1/live") {
    return {
      style: "live-standalone",
      query: rawQuery,
    };
  }
  if (url.pathname === "/v1/realtime") {
    if (url.searchParams.has("call_id")) {
      const callId = url.searchParams.get("call_id") ?? "";
      return CALL_ID.test(callId)
        ? { style: "realtime-query", callId, query: rawQuery }
        : undefined;
    }
    return {
      style: "realtime-standalone",
      query: rawQuery,
    };
  }
  return undefined;
}

function realtimeUpstreamUrl(target: RealtimeWebSocketTarget): string {
  if (target.style === "live-call") {
    return `${REALTIME_WS_API_ROOT}/live/${encodeURIComponent(target.callId)}${target.query.length === 0 ? "" : `?${target.query}`}`;
  }
  if (target.style === "realtime-call") {
    return `${REALTIME_WS_API_ROOT}/realtime/calls/${encodeURIComponent(target.callId)}${target.query.length === 0 ? "" : `?${target.query}`}`;
  }
  if (target.style === "realtime-query") {
    return `${REALTIME_WS_API_ROOT}/realtime?intent=quicksilver&${target.query}`;
  }
  const path = target.style === "live-standalone" ? "live" : "realtime";
  return `${REALTIME_WS_API_ROOT}/${path}${target.query.length === 0 ? "" : `?${target.query}`}`;
}

function incomingHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) headers.append(name, value);
  }
  return headers;
}

function realtimeWebSocketHeaders(
  source: Headers,
): Record<string, string> {
  const connectionScoped = new Set(
    (source.get("connection") ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name.length > 0),
  );
  const headers: Record<string, string> = {};
  for (const [name, value] of source) {
    const lower = name.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(lower) ||
      connectionScoped.has(lower) ||
      lower.startsWith("sec-websocket-")
    ) {
      continue;
    }
    headers[lower] = value;
  }
  return headers;
}

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.concat(data);
}

function writeUpgradeError(
  socket: Duplex,
  status: number,
  reason: string,
  type: string,
  message: string,
): Promise<void> {
  const body = Buffer.from(JSON.stringify({ error: { type, message } }), "utf8");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      socket.off("finish", finish);
      socket.off("close", finish);
      socket.off("error", finish);
      resolve();
    };
    socket.once("finish", finish);
    socket.once("close", finish);
    socket.once("error", finish);
    socket.end(
      Buffer.concat([
        Buffer.from(
          [
            `HTTP/1.1 ${status} ${reason}`,
            "Content-Type: application/json; charset=utf-8",
            `Content-Length: ${body.byteLength}`,
            "Cache-Control: no-store",
            "Connection: close",
            "",
            "",
          ].join("\r\n"),
          "ascii",
        ),
        body,
      ]),
    );
  });
}

async function rejectRealtimeUpgrade(
  context: ClientProtocolRequestContext,
  socket: Duplex,
  status: number,
  reason: string,
  type: string,
  message: string,
  classification: string,
  failureLocation: ReturnType<typeof realtimeLocation>,
): Promise<void> {
  const failureId = `${context.requestId}:${classification}`;
  observeRealtime(context, {
    kind: "failure_detected",
    failureId,
    role: "primary",
    classification,
    origin: status === 401 ? "client" : "Token",
    originPrecision: "exact",
    location: failureLocation,
  });
  const presentationLocation = realtimeLocation(
    "client_response_preparation",
    "render_direct_realtime_error",
  );
  observeRealtime(context, {
    kind: "client_response_prepared",
    status,
    mediaType: "application/json; charset=utf-8",
    location: presentationLocation,
  });
  const outcomeLocation = realtimeLocation(
    "outcome_commit",
    "commit_request_outcome",
  );
  observeRealtime(context, {
    kind: "work_outcome_committed",
    outcome: "failed",
    terminalAuthority: "codex_direct_realtime_websocket",
    location: outcomeLocation,
  });
  await writeUpgradeError(socket, status, reason, type, message);
  const handoffLocation = realtimeLocation(
    "http_handoff",
    "write_websocket_rejection",
  );
  observeRealtime(context, {
    kind: "handoff_observed",
    outcome: "finished",
    transport: "websocket",
    location: handoffLocation,
  });
  closeRequestJourney(context, {
    outcome: "failed",
    primaryFailureId: failureId,
    closeReason: classification,
    lastKnownLocation: handoffLocation,
  });
}

interface RealtimeWebSocketSession {
  readonly local: WebSocket;
  readonly context: ClientProtocolRequestContext;
  upstream?: WebSocket;
  readonly pending: Array<Readonly<{ data: Buffer; binary: boolean }>>;
  pendingBytes: number;
  localClosed: boolean;
  upstreamClosed: boolean;
  settled: boolean;
  upstreamOpened: boolean;
  dispatchCompleted: boolean;
  relayStarted: boolean;
  outcome: "success" | "failed" | "aborted";
  closeReason?: string;
  primaryFailureId?: string;
  closeTimer?: ReturnType<typeof setTimeout>;
  readonly resolve: () => void;
}

function createCodexDirectRealtimeWebSocketUpgradeHandler(
  options: CreateCodexDirectRealtimeOptions,
): WebSocketUpgradeHandler {
  const webSocketServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: REALTIME_WS_MAX_MESSAGE_BYTES,
    handleProtocols: () => false,
  });
  const connect =
    options.connectWebSocket ??
    ((url: string, headers: Record<string, string>) =>
      new WebSocket(url, {
        headers,
        followRedirects: false,
        perMessageDeflate: false,
        maxPayload: REALTIME_WS_MAX_MESSAGE_BYTES,
      }));
  const sessions = new Set<RealtimeWebSocketSession>();

  const markSessionFailure = (
    session: RealtimeWebSocketSession,
    classification: string,
    location: ReturnType<typeof realtimeLocation>,
    origin: "client" | "Token" | "provider" | "network_os",
  ): void => {
    if (session.primaryFailureId !== undefined) return;
    const failureId = `${session.context.requestId}:${classification}`;
    session.primaryFailureId = failureId;
    observeRealtime(session.context, {
      kind: "failure_detected",
      failureId,
      role: "primary",
      classification,
      origin,
      originPrecision: origin === "network_os" ? "boundary" : "exact",
      location,
    });
  };

  const finishJourney = (session: RealtimeWebSocketSession): void => {
    if (session.relayStarted) {
      const relayLocation = realtimeLocation(
        "upstream_execution",
        "relay_realtime_frames",
      );
      observeRealtime(session.context, {
        kind: "step_completed",
        stepInstanceId: "p4.relay_realtime_frames",
        completion: session.outcome,
        location: relayLocation,
      });
    }
    const closeLocation = realtimeLocation(
      "lane_response_processing",
      "preserve_realtime_close",
    );
    observeRealtime(session.context, {
      kind: "step_entered",
      stepInstanceId: "p5.preserve_realtime_close",
      location: closeLocation,
    });
    observeRealtime(session.context, {
      kind: "step_completed",
      stepInstanceId: "p5.preserve_realtime_close",
      completion: session.outcome,
      operation: "realtime_session",
      protocol: "codex-realtime",
      location: closeLocation,
    });
    const outcomeLocation = realtimeLocation(
      "outcome_commit",
      "commit_request_outcome",
    );
    observeRealtime(session.context, {
      kind: "step_entered",
      stepInstanceId: "p7.commit_request_outcome",
      location: outcomeLocation,
    });
    observeRealtime(session.context, {
      kind: "work_outcome_committed",
      outcome: session.outcome,
      terminalAuthority: "codex_direct_realtime_websocket",
      location: outcomeLocation,
    });
    observeRealtime(session.context, {
      kind: "step_completed",
      stepInstanceId: "p7.commit_request_outcome",
      completion: "success",
      operation: "realtime_session",
      protocol: "codex-realtime",
      location: outcomeLocation,
    });
    const handoffLocation = realtimeLocation(
      "http_handoff",
      "close_websocket_session",
    );
    observeRealtime(session.context, {
      kind: "step_entered",
      stepInstanceId: "p8.close_websocket_session",
      location: handoffLocation,
    });
    observeRealtime(session.context, {
      kind: "handoff_observed",
      outcome:
        session.outcome === "success"
          ? "finished"
          : session.outcome === "aborted"
            ? "closed"
            : "failed",
      transport: "websocket",
      location: handoffLocation,
    });
    observeRealtime(session.context, {
      kind: "step_completed",
      stepInstanceId: "p8.close_websocket_session",
      completion: session.outcome === "success" ? "success" : session.outcome,
      location: handoffLocation,
    });
    closeRequestJourney(session.context, {
      outcome: session.outcome,
      ...(session.primaryFailureId === undefined
        ? {}
        : { primaryFailureId: session.primaryFailureId }),
      ...(session.closeReason === undefined
        ? {}
        : { closeReason: session.closeReason }),
      lastKnownLocation: handoffLocation,
    });
  };

  const settle = (session: RealtimeWebSocketSession): void => {
    if (session.settled) return;
    if (!session.localClosed || !session.upstreamClosed) return;
    session.settled = true;
    if (session.closeTimer !== undefined) clearTimeout(session.closeTimer);
    sessions.delete(session);
    finishJourney(session);
    session.resolve();
  };

  const closePeer = (
    socket: WebSocket | undefined,
    code: number,
    reason: string,
  ): void => {
    if (socket === undefined || socket.readyState === WebSocket.CLOSED) return;
    if (socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
      return;
    }
    try {
      socket.close(code, reason);
    } catch {
      socket.terminate();
    }
  };

  const armCloseFallback = (session: RealtimeWebSocketSession): void => {
    if (session.closeTimer !== undefined) return;
    session.closeTimer = setTimeout(() => {
      if (session.local.readyState !== WebSocket.CLOSED) session.local.terminate();
      if (
        session.upstream !== undefined &&
        session.upstream.readyState !== WebSocket.CLOSED
      ) {
        session.upstream.terminate();
      }
    }, REALTIME_WS_CLOSE_FALLBACK_MS);
    session.closeTimer.unref?.();
  };

  const failSession = (
    session: RealtimeWebSocketSession,
    code: number,
    reason: string,
    classification = "realtime_websocket_transport_failed",
  ): void => {
    if (session.outcome === "success") session.outcome = "failed";
    session.closeReason ??= classification;
    markSessionFailure(
      session,
      classification,
      realtimeLocation(
        session.upstreamOpened ? "lane_response_processing" : "upstream_execution",
        session.upstreamOpened
          ? "preserve_realtime_close"
          : "dispatch_direct_transport",
      ),
      classification.startsWith("client_") ? "client" : "network_os",
    );
    closePeer(session.local, code, reason);
    closePeer(session.upstream, code, reason);
    armCloseFallback(session);
  };

  const markServerShutdown = (session: RealtimeWebSocketSession): void => {
    session.outcome = "aborted";
    session.closeReason = "server_shutdown";
    markSessionFailure(
      session,
      "server_shutdown",
      realtimeLocation("lane_response_processing", "preserve_realtime_close"),
      "Token",
    );
  };

  return Object.freeze({
    matches(
      _request: IncomingMessage,
      url: URL,
    ): boolean {
      return parseRealtimeWebSocketTarget(url) !== undefined;
    },
    async handleUpgrade(
      input: Parameters<WebSocketUpgradeHandler["handleUpgrade"]>[0],
    ): Promise<void> {
      observeRealtimeLane(input.context);
      const target = parseRealtimeWebSocketTarget(input.url);
      if (target === undefined) {
        await rejectRealtimeUpgrade(
          input.context,
          input.socket,
          404,
          "Not Found",
          "not_found",
          "Realtime WebSocket endpoint not found",
          "realtime_websocket_route_not_found",
          realtimeLocation("request_resolution", "commit_direct_realtime_lane"),
        );
        return;
      }
      const headers = incomingHeaders(input.request);
      const callerEnvelopeLocation = realtimeLocation(
        "lane_request_preparation",
        "preserve_caller_envelope",
      );
      observeRealtime(input.context, {
        kind: "step_entered",
        stepInstanceId: "p3.preserve_caller_envelope",
        location: callerEnvelopeLocation,
      });
      observeRealtime(input.context, {
        kind: "step_completed",
        stepInstanceId: "p3.preserve_caller_envelope",
        completion: "success",
        location: callerEnvelopeLocation,
      });
      const envelopeLocation = realtimeLocation(
        "lane_request_preparation",
        "construct_direct_envelope",
      );
      observeRealtime(input.context, {
        kind: "step_entered",
        stepInstanceId: "p3.construct_direct_envelope",
        location: envelopeLocation,
      });
      const upstreamUrl = realtimeUpstreamUrl(target);
      const upstreamHeaders = realtimeWebSocketHeaders(headers);
      observeRealtime(input.context, {
        kind: "step_completed",
        stepInstanceId: "p3.construct_direct_envelope",
        completion: "success",
        location: envelopeLocation,
      });
      let local: WebSocket;
      try {
        local = await new Promise<WebSocket>((resolve, reject) => {
          try {
            webSocketServer.handleUpgrade(
              input.request,
              input.socket,
              input.head,
              resolve,
            );
          } catch (error) {
            reject(error);
          }
        });
      } catch {
        await rejectRealtimeUpgrade(
          input.context,
          input.socket,
          502,
          "Bad Gateway",
          "api_error",
          "Realtime WebSocket upgrade failed",
          "realtime_websocket_upgrade_failed",
          realtimeLocation("upstream_execution", "dispatch_direct_transport"),
        );
        return;
      }
      let resolveSession!: () => void;
      const completion = new Promise<void>((resolve) => {
        resolveSession = resolve;
      });
      const session: RealtimeWebSocketSession = {
        local,
        context: input.context,
        pending: [],
        pendingBytes: 0,
        localClosed: false,
        upstreamClosed: false,
        settled: false,
        upstreamOpened: false,
        dispatchCompleted: false,
        relayStarted: false,
        outcome: "success",
        resolve: resolveSession,
      };
      sessions.add(session);
      local.on("error", (error) =>
        session.upstreamClosed
          ? undefined
          : failSession(
              session,
              (error as { code?: string }).code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
                ? 1009
                : 1011,
              "local socket failed",
              "client_websocket_failed",
            ),
      );
      local.on("close", (code, reason) => {
        if (session.outcome === "success" && code !== 1000) {
          session.outcome = "aborted";
          session.closeReason = "client_websocket_closed_abnormally";
          markSessionFailure(
            session,
            "client_websocket_closed_abnormally",
            realtimeLocation("lane_response_processing", "preserve_realtime_close"),
            "client",
          );
        }
        session.localClosed = true;
        closePeer(session.upstream, code || 1000, reason.toString());
        if (session.upstream === undefined) session.upstreamClosed = true;
        armCloseFallback(session);
        settle(session);
      });
      local.on("message", (data, binary) => {
        const bytes = rawDataBuffer(data);
        if (bytes.byteLength > REALTIME_WS_MAX_MESSAGE_BYTES) {
          failSession(session, 1009, "message too large");
          return;
        }
        if (
          session.upstream === undefined ||
          session.upstream.readyState === WebSocket.CONNECTING
        ) {
          if (
            session.pending.length >= REALTIME_WS_PENDING_MAX_MESSAGES ||
            session.pendingBytes + bytes.byteLength > REALTIME_WS_PENDING_MAX_BYTES
          ) {
            failSession(session, 1009, "pending messages too large");
            return;
          }
          session.pending.push({ data: Buffer.from(bytes), binary });
          session.pendingBytes += bytes.byteLength;
          return;
        }
        if (session.upstream.readyState !== WebSocket.OPEN) {
          failSession(session, 1011, "upstream socket unavailable");
          return;
        }
        session.upstream.send(bytes, { binary }, (error) => {
          if (error) failSession(session, 1011, "upstream send failed");
        });
      });

      let upstream: WebSocket;
      const dispatchLocation = realtimeLocation(
        "upstream_execution",
        "dispatch_direct_transport",
      );
      observeRealtime(input.context, {
        kind: "step_entered",
        stepInstanceId: "p4.dispatch_direct_transport",
        location: dispatchLocation,
      });
      const completeDispatch = (completion: "success" | "failed" | "aborted"): void => {
        if (session.dispatchCompleted) return;
        session.dispatchCompleted = true;
        observeRealtime(input.context, {
          kind: "step_completed",
          stepInstanceId: "p4.dispatch_direct_transport",
          completion,
          location: dispatchLocation,
        });
      };
      try {
        upstream = connect(upstreamUrl, upstreamHeaders);
      } catch {
        session.upstreamClosed = true;
        completeDispatch("failed");
        failSession(
          session,
          1011,
          "upstream connection failed",
          "upstream_websocket_connection_failed",
        );
        await completion;
        return;
      }
      session.upstream = upstream;
      upstream.on("open", () => {
        session.upstreamOpened = true;
        completeDispatch("success");
        const relayLocation = realtimeLocation(
          "upstream_execution",
          "relay_realtime_frames",
        );
        session.relayStarted = true;
        observeRealtime(input.context, {
          kind: "step_entered",
          stepInstanceId: "p4.relay_realtime_frames",
          location: relayLocation,
        });
        for (const frame of session.pending.splice(0)) {
          upstream.send(frame.data, { binary: frame.binary }, (error) => {
            if (error) failSession(session, 1011, "upstream send failed");
          });
        }
        session.pendingBytes = 0;
      });
      upstream.on("message", (data, binary) => {
        const bytes = rawDataBuffer(data);
        if (bytes.byteLength > REALTIME_WS_MAX_MESSAGE_BYTES) {
          failSession(session, 1009, "message too large");
          return;
        }
        if (local.readyState !== WebSocket.OPEN) return;
        local.send(bytes, { binary }, (error) => {
          if (error) failSession(session, 1011, "local send failed");
        });
      });
      upstream.on("error", (error) => {
        if (session.localClosed) return;
        if (!session.upstreamOpened) completeDispatch("failed");
        failSession(
          session,
          (error as { code?: string }).code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
            ? 1009
            : 1011,
          "upstream connection failed",
          session.upstreamOpened
            ? "upstream_websocket_transport_failed"
            : "upstream_websocket_connection_failed",
        );
      });
      upstream.on("close", (code, reason) => {
        if (!session.upstreamOpened) {
          completeDispatch(session.localClosed ? "aborted" : "failed");
        }
        if (session.outcome === "success" && code !== 1000) {
          session.outcome = "failed";
          session.closeReason = "upstream_websocket_closed_abnormally";
          markSessionFailure(
            session,
            "upstream_websocket_closed_abnormally",
            realtimeLocation("lane_response_processing", "preserve_realtime_close"),
            "provider",
          );
        }
        session.upstreamClosed = true;
        closePeer(local, code || 1000, reason.toString());
        armCloseFallback(session);
        settle(session);
      });
      await completion;
    },
    closeAll(): void {
      for (const session of sessions) {
        markServerShutdown(session);
        closePeer(session.local, 1001, "server shutting down");
        closePeer(session.upstream, 1001, "server shutting down");
        armCloseFallback(session);
      }
    },
    terminateAll(): void {
      for (const session of sessions) {
        markServerShutdown(session);
        if (!session.localClosed) session.local.terminate();
        if (session.upstream === undefined) {
          session.upstreamClosed = true;
        } else if (!session.upstreamClosed) {
          session.upstream.terminate();
        }
        settle(session);
      }
    },
  });
}

/** Complete Direct Mode voice/realtime capability. Its HTTP and WebSocket
 * transports share only credentials and the protocol-owned lifecycle here. */
export function createCodexDirectRealtimeModule(
  options: CreateCodexDirectRealtimeOptions,
): CodexDirectRealtimeModule {
  return Object.freeze({
    httpHandlers: Object.freeze([
      createCodexDirectRealtimeCallsHandler(options),
      createCodexDirectLiveHandler(options),
    ] as const),
    webSocketUpgrade: createCodexDirectRealtimeWebSocketUpgradeHandler(options),
  });
}
