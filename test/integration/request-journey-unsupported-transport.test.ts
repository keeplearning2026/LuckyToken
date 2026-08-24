import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDiagnosticsAuthority,
  parseDiagnosticsConfiguration,
  type DiagnosticsAuthority,
  type DiagnosticsSubscription,
  type RequestJourneySummary,
} from "../../src/diagnostics/index.js";
import type { LuckyTokenRuntime } from "../../src/runtime.js";
import {
  startLuckyTokenHttpServer,
  type RunningLuckyTokenHttpServer,
} from "../../src/server.js";
import { createCodexDirectRealtimeModule } from "../../src/integrations/codex/local-realtime.js";

const REQUEST_ID = "68000000-0000-4000-8000-000000000001";
const PRIMARY_LOCATION = {
  phase: "protocol_ingress",
  step: "reject_transport",
} as const;
const PRESENTATION_LOCATION = {
  phase: "client_response_preparation",
  step: "render_transport_error",
} as const;
const WORK_OUTCOME_LOCATION = {
  phase: "outcome_commit",
  step: "commit_request_outcome",
} as const;
const HANDOFF_LOCATION = {
  phase: "http_handoff",
  step: "write_upgrade_response",
} as const;

interface RawHttpResponse {
  readonly statusLine: string;
  readonly headers: Headers;
  readonly body: Buffer;
}

function parseRawHttpResponse(bytes: Buffer): RawHttpResponse {
  const headerEnd = bytes.indexOf("\r\n\r\n");
  if (headerEnd < 0) throw new Error("Raw HTTP response has no header boundary");
  const lines = bytes.subarray(0, headerEnd).toString("ascii").split("\r\n");
  return Object.freeze({
    statusLine: lines[0]!,
    headers: new Headers(
      lines.slice(1).map<[string, string]>((line) => {
        const separator = line.indexOf(":");
        if (separator < 0) throw new Error("Raw HTTP response has an invalid header");
        return [line.slice(0, separator), line.slice(separator + 1).trim()];
      }),
    ),
    body: bytes.subarray(headerEnd + 4),
  });
}

async function exchangeWebSocketUpgrade(
  server: RunningLuckyTokenHttpServer,
  path = "/v1/responses",
): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const socket = net.connect(server.port, server.host);
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("end", finish);
    socket.once("close", finish);
    socket.once("error", fail);
    socket.once("connect", () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: ${server.host}:${server.port}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "",
          "",
        ].join("\r\n"),
      );
    });
  });
}

describe("Request Journey unsupported HTTP transport", () => {
  const roots: string[] = [];
  const authorities: DiagnosticsAuthority[] = [];
  const subscriptions: DiagnosticsSubscription[] = [];
  const servers: RunningLuckyTokenHttpServer[] = [];

  afterEach(async () => {
    for (const subscription of subscriptions.splice(0)) {
      subscription.unsubscribe();
    }
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(
      authorities.splice(0).map((authority) => authority.close()),
    );
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("records a WebSocket upgrade rejection without changing the raw 426 wire", async () => {
    let runtimeCalls = 0;
    const runtime: LuckyTokenRuntime = Object.freeze({
      routes: Object.freeze([]),
      handle: async () => {
        runtimeCalls += 1;
        return new Response(null, { status: 204 });
      },
    });
    const baselineServer = await startLuckyTokenHttpServer({
      runtime,
      createRequestId: () => REQUEST_ID,
      port: 0,
    });
    servers.push(baselineServer);
    const baselineBytes = await exchangeWebSocketUpgrade(baselineServer);

    const root = await mkdtemp(join(tmpdir(), "luckytoken-upgrade-journey-"));
    roots.push(root);
    const authority = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration({ directory: root }, root),
    });
    authorities.push(authority);
    let publish!: (record: RequestJourneySummary) => void;
    const published = new Promise<RequestJourneySummary>((resolve) => {
      publish = resolve;
    });
    subscriptions.push(
      authority.subscribeRequestJourneys((record) => {
        if (record.requestId === REQUEST_ID) publish(record);
      }),
    );
    const observedServer = await startLuckyTokenHttpServer({
      runtime,
      diagnostics: authority,
      createRequestId: () => REQUEST_ID,
      port: 0,
      webSocketUpgrade: createCodexDirectRealtimeModule({
        fetch: globalThis.fetch,
        connectWebSocket: () => {
          throw new Error("unsupported route must not connect upstream");
        },
      }).webSocketUpgrade,
    });
    servers.push(observedServer);
    const observedBytes = await exchangeWebSocketUpgrade(observedServer);

    expect(observedBytes).toEqual(baselineBytes);
    const wire = parseRawHttpResponse(observedBytes);
    expect(wire.statusLine).toBe("HTTP/1.1 426 Upgrade Required");
    expect(wire.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(wire.headers.get("content-length")).toBe(String(wire.body.byteLength));
    expect(wire.headers.get("cache-control")).toBe("no-store");
    expect(wire.headers.get("connection")).toBe("close");
    expect(wire.headers.has("upgrade")).toBe(false);
    // This is the current wire contract. P0 owns the Journey request ID, but
    // the transport rejection does not add it to the existing 426 response.
    expect(wire.headers.has("x-luckytoken-request-id")).toBe(false);
    expect(JSON.parse(wire.body.toString("utf8"))).toEqual({
      error: {
        message:
          "LuckyToken supports HTTP transport only. Retry over HTTP instead of WebSocket.",
        type: "upgrade_required",
        code: "websocket_transport_not_supported",
        param: null,
      },
    });
    expect(runtimeCalls).toBe(0);

    // The Worker command is a FIFO barrier and keeps the initial Red finite
    // when the current upgrade path has not begun a Journey at all.
    const page = await authority.queryRequestJourneys({ limit: 10 });
    expect(page.records).toHaveLength(1);
    const publishedSummary = await published;
    expect(page.records).toEqual([publishedSummary]);
    expect(publishedSummary).toMatchObject({
      requestId: REQUEST_ID,
      operation: "unsupported_transport",
      outcome: "failed",
      primaryFailureLocation: PRIMARY_LOCATION,
    });
    expect(publishedSummary).not.toHaveProperty("protocol");
    expect(publishedSummary).not.toHaveProperty("lane");

    const detail = await authority.getRequestJourney({ requestId: REQUEST_ID });
    expect(detail.admission).toMatchObject({
      operationCandidate: "unsupported_transport",
      transport: "websocket",
      method: "GET",
      path: "/v1/responses",
    });
    expect(detail).not.toHaveProperty("protocol");
    expect(detail).not.toHaveProperty("lane");
    const observations = detail.timeline.map((event) => event.observation);
    expect(observations).toEqual(
      expect.arrayContaining([
        {
          kind: "step_entered",
          stepInstanceId: "p0.admit_http_request",
          location: {
            phase: "http_admission",
            step: "admit_http_request",
          },
        },
        {
          kind: "step_completed",
          stepInstanceId: "p0.admit_http_request",
          completion: "success",
          location: {
            phase: "http_admission",
            step: "admit_http_request",
          },
        },
        {
          kind: "step_entered",
          stepInstanceId: "p1.reject_transport",
          location: PRIMARY_LOCATION,
        },
        {
          kind: "step_completed",
          stepInstanceId: "p1.reject_transport",
          completion: "failed",
          operation: "unsupported_transport",
          location: PRIMARY_LOCATION,
        },
        {
          kind: "step_entered",
          stepInstanceId: "p6.render_transport_error",
          location: PRESENTATION_LOCATION,
        },
        {
          kind: "step_completed",
          stepInstanceId: "p6.render_transport_error",
          completion: "success",
          operation: "unsupported_transport",
          location: PRESENTATION_LOCATION,
        },
        {
          kind: "step_entered",
          stepInstanceId: "p8.write_upgrade_response",
          location: HANDOFF_LOCATION,
        },
        {
          kind: "step_completed",
          stepInstanceId: "p8.write_upgrade_response",
          completion: "success",
          location: HANDOFF_LOCATION,
        },
      ]),
    );

    const failures = observations.filter(
      (observation) => observation.kind === "failure_detected",
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      kind: "failure_detected",
      failureId: detail.incident?.primaryFailureId,
      role: "primary",
      classification: "unsupported_websocket_transport",
      origin: "client",
      originPrecision: "exact",
      location: PRIMARY_LOCATION,
    });
    expect(detail.incident?.failures).toEqual(failures);
    expect(detail.clientPresentation).toEqual({
      status: 426,
      mediaType: "application/json; charset=utf-8",
      location: PRESENTATION_LOCATION,
    });
    expect(detail.workOutcome).toEqual({
      outcome: "failed",
      terminalAuthority: "http_transport",
      location: WORK_OUTCOME_LOCATION,
    });
    expect(detail.handoffOutcome).toMatchObject({
      outcome: "finished",
      transport: "http",
      writableFinished: true,
      location: HANDOFF_LOCATION,
    });
  });

  it("closes the Journey when a matched Upgrade handler rejects", async () => {
    const runtime: LuckyTokenRuntime = Object.freeze({
      routes: Object.freeze([]),
      handle: async () => new Response(null, { status: 404 }),
    });
    const root = await mkdtemp(join(tmpdir(), "luckytoken-upgrade-failure-"));
    roots.push(root);
    const authority = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration({ directory: root }, root),
    });
    authorities.push(authority);
    let publish!: (record: RequestJourneySummary) => void;
    const published = new Promise<RequestJourneySummary>((resolve) => {
      publish = resolve;
    });
    subscriptions.push(authority.subscribeRequestJourneys(publish));
    const server = await startLuckyTokenHttpServer({
      runtime,
      diagnostics: authority,
      createRequestId: () => REQUEST_ID,
      port: 0,
      webSocketUpgrade: {
        matches: (_request, url) => url.pathname === "/v1/live",
        handleUpgrade: async () => {
          throw new Error("unexpected Upgrade failure");
        },
        closeAll: () => undefined,
        terminateAll: () => undefined,
      },
    });
    servers.push(server);

    expect(await exchangeWebSocketUpgrade(server, "/v1/live?model=gpt-live"))
      .toEqual(Buffer.alloc(0));
    await published;
    const detail = await authority.getRequestJourney({ requestId: REQUEST_ID });
    expect({
      outcome: detail.outcome,
      classification: detail.incident?.failures[0]?.classification,
      handoff: detail.handoffOutcome,
    }).toMatchObject({
      outcome: "failed",
      classification: "websocket_upgrade_handler_failed",
      handoff: { outcome: "failed", transport: "websocket" },
    });
  });
});
