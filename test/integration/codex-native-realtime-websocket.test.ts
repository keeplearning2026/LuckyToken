import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import {
  createDiagnosticsAuthority,
  parseDiagnosticsConfiguration,
  type RequestJourneySummary,
} from "../../src/diagnostics/index.js";
import {
  createCodexDirectRealtimeModule,
  type CodexRealtimeWebSocketConnect,
} from "../../src/integrations/codex/local-realtime.js";
import {
  startTokenHttpServer,
  type RunningTokenHttpServer,
} from "../../src/server.js";
import { startRunningDataPlaneListener } from "../../src/running-data-plane-listener.js";
import type { TokenRuntime } from "../../src/runtime.js";

const emptyRuntime: TokenRuntime = Object.freeze({
  routes: Object.freeze([]),
  handle: async () => new Response(null, { status: 404 }),
});

function createRealtimeUpgrade(options: {
  readonly connectWebSocket?: CodexRealtimeWebSocketConnect;
}) {
  return createCodexDirectRealtimeModule({
    ...options,
    fetch: globalThis.fetch,
  }).webSocketUpgrade;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Mock WSS did not bind a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function open(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function nextMessage(socket: WebSocket): Promise<{ bytes: Buffer; binary: boolean }> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data, binary) =>
      resolve({ bytes: Buffer.from(data as Buffer), binary }),
    );
    socket.once("error", reject);
    socket.once("close", (code, reason) =>
      reject(new Error(`Socket closed before message: ${code} ${reason.toString()}`)),
    );
  });
}

function within<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`Timed out while ${label}`)), 1_000),
    ),
  ]);
}

function closed(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) =>
      resolve({ code, reason: reason.toString() }),
    );
  });
}

describe("Codex Direct Mode realtime WebSocket", () => {
  const localServers: RunningTokenHttpServer[] = [];
  const upstreamHttpServers: Server[] = [];
  const upstreamWebSocketServers: WebSocketServer[] = [];
  const clients: WebSocket[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.terminate();
    await Promise.all(localServers.splice(0).map((server) => server.close()));
    await Promise.all(
      upstreamWebSocketServers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    await Promise.all(
      upstreamHttpServers.splice(0).map((server) => closeHttpServer(server)),
    );
  });

  it("relays standalone realtime text and binary messages through the real Upgrade seam", async () => {
    const upstreamHttp = createServer();
    upstreamHttpServers.push(upstreamHttp);
    const upstreamWss = new WebSocketServer({
      server: upstreamHttp,
      perMessageDeflate: false,
    });
    upstreamWebSocketServers.push(upstreamWss);
    const upstreamPort = await listen(upstreamHttp);
    let upstreamPath: string | undefined;
    let upstreamAuthorization: string | undefined;
    let resolveUpstreamConnection!: () => void;
    const upstreamConnection = new Promise<void>((resolve) => {
      resolveUpstreamConnection = resolve;
    });
    let resolveUpstreamMessage!: () => void;
    const upstreamMessage = new Promise<void>((resolve) => {
      resolveUpstreamMessage = resolve;
    });
    upstreamWss.on("connection", (socket, request) => {
      upstreamPath = request.url;
      upstreamAuthorization = request.headers.authorization;
      resolveUpstreamConnection();
      socket.on("message", (data, binary) => {
        resolveUpstreamMessage();
        socket.send(data, { binary });
      });
    });

    let requestedCanonicalUrl: string | undefined;
    let resolveConnectorMessage!: () => void;
    const connectorMessage = new Promise<void>((resolve) => {
      resolveConnectorMessage = resolve;
    });
    const webSocketUpgrade = createRealtimeUpgrade({
      connectWebSocket: (url, headers) => {
        requestedCanonicalUrl = url;
        const socket = new WebSocket(`ws://127.0.0.1:${upstreamPort}${new URL(url).pathname}${new URL(url).search}`, {
          headers,
          followRedirects: false,
          perMessageDeflate: false,
        });
        socket.once("message", resolveConnectorMessage);
        return socket;
      },
    });
    const local = await startTokenHttpServer({
      runtime: emptyRuntime,
      port: 0,
      webSocketUpgrade,
    });
    localServers.push(local);
    const client = new WebSocket(
      `ws://127.0.0.1:${local.port}/v1/realtime?intent=quicksilver&model=gpt-realtime-1.5`,
      { headers: { authorization: "Bearer codex-token" } },
    );
    clients.push(client);
    await within(open(client), "opening the local realtime socket");
    await within(upstreamConnection, "opening the upstream realtime socket");

    const textReceived = nextMessage(client);
    client.send("你好，realtime");
    await within(upstreamMessage, "forwarding the text frame upstream");
    await within(connectorMessage, "receiving the text frame from upstream");
    const text = await within(textReceived, "waiting for the text echo");
    const binaryReceived = nextMessage(client);
    client.send(Buffer.from([0x00, 0x80, 0xff, 0x41]), { binary: true });
    const binary = await within(binaryReceived, "waiting for the binary echo");

    expect({
      requestedCanonicalUrl,
      upstreamPath,
      upstreamAuthorization,
      text: text.bytes.toString("utf8"),
      textBinary: text.binary,
      binary: Array.from(binary.bytes),
      binaryBinary: binary.binary,
    }).toEqual({
      requestedCanonicalUrl:
        "wss://api.openai.com/v1/realtime?intent=quicksilver&model=gpt-realtime-1.5",
      upstreamPath:
        "/v1/realtime?intent=quicksilver&model=gpt-realtime-1.5",
      upstreamAuthorization: "Bearer codex-token",
      text: "你好，realtime",
      textBinary: false,
      binary: [0x00, 0x80, 0xff, 0x41],
      binaryBinary: true,
    });
  });

  it("maps every realtime route while preserving caller query and end-to-end headers", async () => {
    const upstreamHttp = createServer();
    upstreamHttpServers.push(upstreamHttp);
    const upstreamWss = new WebSocketServer({
      server: upstreamHttp,
      perMessageDeflate: false,
    });
    upstreamWebSocketServers.push(upstreamWss);
    const upstreamPort = await listen(upstreamHttp);
    const upstreamRequests: Array<{
      path: string | undefined;
      headers: NodeJS.Dict<string | string[]>;
    }> = [];
    upstreamWss.on("connection", (socket, request) => {
      upstreamRequests.push({ path: request.url, headers: request.headers });
      socket.on("message", (data, binary) => socket.send(data, { binary }));
    });

    const canonicalUrls: string[] = [];
    const webSocketUpgrade = createRealtimeUpgrade({
      connectWebSocket: (url, headers) => {
        canonicalUrls.push(url);
        const target = new URL(url);
        return new WebSocket(
          `ws://127.0.0.1:${upstreamPort}${target.pathname}${target.search}`,
          { headers, followRedirects: false, perMessageDeflate: false },
        );
      },
    });
    const local = await startTokenHttpServer({
      runtime: emptyRuntime,
      port: 0,
      webSocketUpgrade,
    });
    localServers.push(local);
    const inboundPaths = [
      "/v1/live/call_1",
      "/v1/realtime/calls/call-2",
      "/v1/realtime?call_id=call_3&ignored=x",
      "/v1/realtime?model=gpt-realtime&dup=1&api_key=bad&dup=2&bare&%61ccess_token=bad&encoded=a%2Fb",
      "/v1/live?model=gpt-live&token=bad&bare",
    ];
    for (const path of inboundPaths) {
      const client = new WebSocket(`ws://127.0.0.1:${local.port}${path}`, {
        headers: {
          authorization: "Bearer caller-owned-token",
          "chatgpt-account-id": "caller-account",
          "openai-alpha": "realtime=v1",
          "x-session-id": "session-1",
          "x-unknown": "preserve-me",
          cookie: "secret=cookie",
          "x-api-key": "caller-key",
        },
      });
      clients.push(client);
      await within(open(client), `opening ${path}`);
      const completion = closed(client);
      client.close(1000, "done");
      await within(completion, `closing ${path}`);
    }

    expect(canonicalUrls).toEqual([
      "wss://api.openai.com/v1/live/call_1",
      "wss://api.openai.com/v1/realtime/calls/call-2",
      "wss://api.openai.com/v1/realtime?intent=quicksilver&call_id=call_3&ignored=x",
      "wss://api.openai.com/v1/realtime?model=gpt-realtime&dup=1&api_key=bad&dup=2&bare&%61ccess_token=bad&encoded=a%2Fb",
      "wss://api.openai.com/v1/live?model=gpt-live&token=bad&bare",
    ]);
    expect(upstreamRequests.map(({ path }) => path)).toEqual(
      canonicalUrls.map((url) => `${new URL(url).pathname}${new URL(url).search}`),
    );
    for (const { headers } of upstreamRequests) {
      expect(headers.authorization).toBe("Bearer caller-owned-token");
      expect(headers["chatgpt-account-id"]).toBe("caller-account");
      expect(headers["openai-alpha"]).toBe("realtime=v1");
      expect(headers["x-session-id"]).toBe("session-1");
      expect(headers["x-unknown"]).toBe("preserve-me");
      expect(headers.cookie).toBe("secret=cookie");
      expect(headers["x-api-key"]).toBe("caller-key");
    }
  });

  it("forwards caller credentials and reports an upstream handshake failure as 1011", async () => {
    let upstreamConnections = 0;
    const webSocketUpgrade = createRealtimeUpgrade({
      connectWebSocket: () => {
        upstreamConnections += 1;
        throw new Error("must not connect");
      },
    });
    const local = await startTokenHttpServer({
      runtime: emptyRuntime,
      port: 0,
      webSocketUpgrade,
    });
    localServers.push(local);
    const client = new WebSocket(
      `ws://127.0.0.1:${local.port}/v1/realtime?model=gpt-realtime`,
      { headers: { authorization: "Bearer wrong-token" } },
    );
    clients.push(client);

    const completion = closed(client);
    await within(open(client), "opening before the upstream handshake failure");
    await expect(within(completion, "closing after upstream handshake failure"))
      .resolves.toMatchObject({ code: 1011 });
    expect(upstreamConnections).toBe(1);
  });

  it("keeps the realtime Journey open until the WebSocket session closes", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-realtime-ws-journey-"));
    const diagnostics = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration({ directory: root }, root),
    });
    const upstreamHttp = createServer();
    upstreamHttpServers.push(upstreamHttp);
    const upstreamWss = new WebSocketServer({
      server: upstreamHttp,
      perMessageDeflate: false,
    });
    upstreamWebSocketServers.push(upstreamWss);
    const upstreamPort = await listen(upstreamHttp);
    upstreamWss.on("connection", (socket) => {
      socket.on("message", (data, binary) => socket.send(data, { binary }));
    });
    const webSocketUpgrade = createRealtimeUpgrade({
      connectWebSocket: (url, headers) => {
        const target = new URL(url);
        return new WebSocket(
          `ws://127.0.0.1:${upstreamPort}${target.pathname}${target.search}`,
          { headers, followRedirects: false, perMessageDeflate: false },
        );
      },
    });
    const local = await startTokenHttpServer({
      runtime: emptyRuntime,
      port: 0,
      webSocketUpgrade,
      diagnostics,
      createRequestId: () => "11111111-1111-4111-8111-111111111111",
    });
    localServers.push(local);
    let publish!: (record: RequestJourneySummary) => void;
    const published = new Promise<RequestJourneySummary>((resolve) => {
      publish = resolve;
    });
    const subscription = diagnostics.subscribeRequestJourneys(publish);

    try {
      const client = new WebSocket(
        `ws://127.0.0.1:${local.port}/v1/realtime?model=gpt-realtime`,
        { headers: { authorization: "Bearer codex-token" } },
      );
      clients.push(client);
      await within(open(client), "opening the observed realtime socket");
      const completion = closed(client);
      client.close(1000, "complete");
      await within(completion, "closing the observed realtime socket");
      const summary = await within(published, "publishing the realtime Journey");
      const detail = await diagnostics.getRequestJourney({
        requestId: summary.requestId,
      });

      expect({
        operation: detail.operation,
        protocol: detail.protocol,
        lane: detail.lane,
        outcome: detail.outcome,
        transport: detail.admission.transport,
        handoffTransport: detail.handoffOutcome?.transport,
        terminalAuthority: detail.workOutcome?.terminalAuthority,
      }).toEqual({
        operation: "realtime_session",
        protocol: "codex-realtime",
        lane: "direct",
        outcome: "success",
        transport: "websocket",
        handoffTransport: "websocket",
        terminalAuthority: "codex_direct_realtime_websocket",
      });
    } finally {
      subscription.unsubscribe();
      await diagnostics.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records abnormal client close as an aborted P5 incident after relay", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-realtime-ws-abort-"));
    const diagnostics = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration({ directory: root }, root),
    });
    const upstreamHttp = createServer();
    upstreamHttpServers.push(upstreamHttp);
    const upstreamWss = new WebSocketServer({ server: upstreamHttp });
    upstreamWebSocketServers.push(upstreamWss);
    const upstreamPort = await listen(upstreamHttp);
    let upstreamConnected!: () => void;
    const upstreamConnection = new Promise<void>((resolve) => {
      upstreamConnected = resolve;
    });
    upstreamWss.once("connection", upstreamConnected);
    const webSocketUpgrade = createRealtimeUpgrade({
      connectWebSocket: (url, headers) => {
        const target = new URL(url);
        return new WebSocket(
          `ws://127.0.0.1:${upstreamPort}${target.pathname}${target.search}`,
          { headers, perMessageDeflate: false },
        );
      },
    });
    const local = await startTokenHttpServer({
      runtime: emptyRuntime,
      port: 0,
      webSocketUpgrade,
      diagnostics,
      createRequestId: () => "22222222-2222-4222-8222-222222222222",
    });
    localServers.push(local);
    let publish!: (record: RequestJourneySummary) => void;
    const published = new Promise<RequestJourneySummary>((resolve) => {
      publish = resolve;
    });
    const subscription = diagnostics.subscribeRequestJourneys(publish);

    try {
      const client = new WebSocket(
        `ws://127.0.0.1:${local.port}/v1/realtime?model=gpt-realtime`,
        { headers: { authorization: "Bearer codex-token" } },
      );
      clients.push(client);
      await within(open(client), "opening the abnormal realtime socket");
      await within(upstreamConnection, "connecting the observed upstream socket");
      await new Promise<void>((resolve) => setImmediate(resolve));
      client.terminate();
      const summary = await within(published, "publishing the aborted Journey");
      const detail = await diagnostics.getRequestJourney({
        requestId: summary.requestId,
      });
      const relayCompleted = detail.timeline.find(
        (event) =>
          event.observation.kind === "step_completed" &&
          event.observation.stepInstanceId === "p4.relay_realtime_frames",
      );
      const closeEntered = detail.timeline.find(
        (event) =>
          event.observation.kind === "step_entered" &&
          event.observation.stepInstanceId === "p5.preserve_realtime_close",
      );

      expect({
        outcome: detail.outcome,
        classification: detail.incident?.failures[0]?.classification,
        failurePhase: detail.incident?.failures[0]?.location.phase,
        ordered:
          relayCompleted !== undefined &&
          closeEntered !== undefined &&
          relayCompleted.sequence < closeEntered.sequence,
      }).toEqual({
        outcome: "aborted",
        classification: "client_websocket_closed_abnormally",
        failurePhase: "lane_response_processing",
        ordered: true,
      });
    } finally {
      subscription.unsubscribe();
      await diagnostics.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("closes with 1011 when the upstream WebSocket cannot be created", async () => {
    const webSocketUpgrade = createRealtimeUpgrade({
      connectWebSocket: () => {
        throw new Error("upstream unavailable");
      },
    });
    const local = await startTokenHttpServer({
      runtime: emptyRuntime,
      port: 0,
      webSocketUpgrade,
    });
    localServers.push(local);
    const client = new WebSocket(
      `ws://127.0.0.1:${local.port}/v1/realtime?model=gpt-realtime`,
      { headers: { authorization: "Bearer codex-token" } },
    );
    clients.push(client);
    const completion = closed(client);
    await within(open(client), "opening before the upstream failure");

    await expect(within(completion, "propagating the upstream failure")).resolves
      .toEqual({ code: 1011, reason: "upstream connection failed" });
  });

  it("enforces the pre-open 32-frame buffer limit with close code 1009", async () => {
    const upstreamHttp = createServer();
    upstreamHttpServers.push(upstreamHttp);
    const upstreamWss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
    });
    upstreamWebSocketServers.push(upstreamWss);
    upstreamHttp.on("upgrade", (request, socket, head) => {
      setTimeout(() => {
        if (socket.destroyed) return;
        upstreamWss.handleUpgrade(request, socket, head, (webSocket) => {
          upstreamWss.emit("connection", webSocket, request);
        });
      }, 200).unref();
    });
    const upstreamPort = await listen(upstreamHttp);
    const webSocketUpgrade = createRealtimeUpgrade({
      connectWebSocket: (url, headers) => {
        const target = new URL(url);
        return new WebSocket(
          `ws://127.0.0.1:${upstreamPort}${target.pathname}${target.search}`,
          { headers, followRedirects: false, perMessageDeflate: false },
        );
      },
    });
    const local = await startTokenHttpServer({
      runtime: emptyRuntime,
      port: 0,
      webSocketUpgrade,
    });
    localServers.push(local);
    const client = new WebSocket(
      `ws://127.0.0.1:${local.port}/v1/realtime?model=gpt-realtime`,
      { headers: { authorization: "Bearer codex-token" } },
    );
    clients.push(client);
    const completion = closed(client);
    await within(open(client), "opening the buffered realtime socket");
    for (let index = 0; index < 33; index += 1) client.send("x");

    await expect(within(completion, "enforcing the pending frame limit")).resolves
      .toEqual({ code: 1009, reason: "pending messages too large" });
  });

  it("enforces the pre-open cumulative byte limit with close code 1009", async () => {
    const upstreamHttp = createServer();
    upstreamHttpServers.push(upstreamHttp);
    const upstreamWss = new WebSocketServer({ noServer: true });
    upstreamWebSocketServers.push(upstreamWss);
    upstreamHttp.on("upgrade", (request, socket, head) => {
      setTimeout(() => {
        if (!socket.destroyed) {
          upstreamWss.handleUpgrade(request, socket, head, (webSocket) => {
            upstreamWss.emit("connection", webSocket, request);
          });
        }
      }, 200).unref();
    });
    const upstreamPort = await listen(upstreamHttp);
    const webSocketUpgrade = createRealtimeUpgrade({
      connectWebSocket: (url, headers) => {
        const target = new URL(url);
        return new WebSocket(
          `ws://127.0.0.1:${upstreamPort}${target.pathname}${target.search}`,
          { headers, perMessageDeflate: false },
        );
      },
    });
    const local = await startTokenHttpServer({
      runtime: emptyRuntime,
      port: 0,
      webSocketUpgrade,
    });
    localServers.push(local);
    const client = new WebSocket(
      `ws://127.0.0.1:${local.port}/v1/realtime?model=gpt-realtime`,
      { headers: { authorization: "Bearer codex-token" } },
    );
    clients.push(client);
    const completion = closed(client);
    await within(open(client), "opening the byte-bounded realtime socket");
    client.send(Buffer.alloc(600 * 1024));
    client.send(Buffer.alloc(600 * 1024));

    await expect(within(completion, "enforcing the pending byte limit")).resolves
      .toEqual({ code: 1009, reason: "pending messages too large" });
  });

  it("enforces the 50 MiB single-frame limit with close code 1009", async () => {
    const upstreamHttp = createServer();
    upstreamHttpServers.push(upstreamHttp);
    const upstreamWss = new WebSocketServer({ server: upstreamHttp });
    upstreamWebSocketServers.push(upstreamWss);
    const upstreamPort = await listen(upstreamHttp);
    const webSocketUpgrade = createRealtimeUpgrade({
      connectWebSocket: (url, headers) => {
        const target = new URL(url);
        return new WebSocket(
          `ws://127.0.0.1:${upstreamPort}${target.pathname}${target.search}`,
          { headers, perMessageDeflate: false },
        );
      },
    });
    const local = await startTokenHttpServer({
      runtime: emptyRuntime,
      port: 0,
      webSocketUpgrade,
    });
    localServers.push(local);
    const client = new WebSocket(
      `ws://127.0.0.1:${local.port}/v1/realtime?model=gpt-realtime`,
      { headers: { authorization: "Bearer codex-token" } },
    );
    clients.push(client);
    await within(open(client), "opening the frame-bounded realtime socket");
    const completion = closed(client);
    client.send(Buffer.alloc(50 * 1024 * 1024 + 1));

    const close = await Promise.race([
      completion,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("Timed out enforcing frame limit")), 5_000),
      ),
    ]);
    expect(close.code).toBe(1009);
  });

  it("propagates upstream close code and reason", async () => {
    const upstreamHttp = createServer();
    upstreamHttpServers.push(upstreamHttp);
    const upstreamWss = new WebSocketServer({ server: upstreamHttp });
    upstreamWebSocketServers.push(upstreamWss);
    const upstreamPort = await listen(upstreamHttp);
    upstreamWss.on("connection", (socket) => socket.close(4002, "voice complete"));
    const webSocketUpgrade = createRealtimeUpgrade({
      connectWebSocket: (url, headers) => {
        const target = new URL(url);
        return new WebSocket(
          `ws://127.0.0.1:${upstreamPort}${target.pathname}${target.search}`,
          { headers, perMessageDeflate: false },
        );
      },
    });
    const local = await startTokenHttpServer({
      runtime: emptyRuntime,
      port: 0,
      webSocketUpgrade,
    });
    localServers.push(local);
    const client = new WebSocket(
      `ws://127.0.0.1:${local.port}/v1/live?model=gpt-live`,
      { headers: { authorization: "Bearer codex-token" } },
    );
    clients.push(client);

    await expect(within(closed(client), "propagating upstream close")).resolves
      .toEqual({ code: 4002, reason: "voice complete" });
  });

  it("closes active sessions with 1001 and settles server close", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-realtime-ws-shutdown-"));
    const diagnostics = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration({ directory: root }, root),
    });
    const upstreamHttp = createServer();
    upstreamHttpServers.push(upstreamHttp);
    const upstreamWss = new WebSocketServer({
      server: upstreamHttp,
      perMessageDeflate: false,
    });
    upstreamWebSocketServers.push(upstreamWss);
    const upstreamPort = await listen(upstreamHttp);
    upstreamWss.on("connection", () => undefined);
    const webSocketUpgrade = createRealtimeUpgrade({
      connectWebSocket: (url, headers) => {
        const target = new URL(url);
        return new WebSocket(
          `ws://127.0.0.1:${upstreamPort}${target.pathname}${target.search}`,
          { headers, followRedirects: false, perMessageDeflate: false },
        );
      },
    });
    const local = await startTokenHttpServer({
      runtime: emptyRuntime,
      port: 0,
      webSocketUpgrade,
      diagnostics,
      createRequestId: () => "33333333-3333-4333-8333-333333333333",
    });
    localServers.push(local);
    let publish!: (record: RequestJourneySummary) => void;
    const published = new Promise<RequestJourneySummary>((resolve) => {
      publish = resolve;
    });
    const subscription = diagnostics.subscribeRequestJourneys(publish);
    const client = new WebSocket(
      `ws://127.0.0.1:${local.port}/v1/live?model=gpt-live`,
      { headers: { authorization: "Bearer codex-token" } },
    );
    clients.push(client);
    await within(open(client), "opening the shutdown realtime socket");
    const completion = closed(client);
    const closing = local.close();

    try {
      await expect(within(completion, "closing the realtime socket for shutdown"))
        .resolves.toEqual({ code: 1001, reason: "server shutting down" });
      await within(closing, "settling server close");
      const summary = await within(published, "publishing the shutdown Journey");
      const detail = await diagnostics.getRequestJourney({
        requestId: summary.requestId,
      });
      expect({
        outcome: detail.outcome,
        classification: detail.incident?.failures[0]?.classification,
        failurePhase: detail.incident?.failures[0]?.location.phase,
      }).toEqual({
        outcome: "aborted",
        classification: "server_shutdown",
        failurePhase: "lane_response_processing",
      });
    } finally {
      subscription.unsubscribe();
      await diagnostics.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("waits for active sessions during drain and terminates them after timeout", async () => {
    const upstreamHttp = createServer();
    upstreamHttpServers.push(upstreamHttp);
    const upstreamWss = new WebSocketServer({ server: upstreamHttp });
    upstreamWebSocketServers.push(upstreamWss);
    const upstreamPort = await listen(upstreamHttp);
    const webSocketUpgrade = createRealtimeUpgrade({
      connectWebSocket: (url, headers) => {
        const target = new URL(url);
        return new WebSocket(
          `ws://127.0.0.1:${upstreamPort}${target.pathname}${target.search}`,
          { headers, followRedirects: false, perMessageDeflate: false },
        );
      },
    });
    const local = await startTokenHttpServer({
      runtime: emptyRuntime,
      port: 0,
      webSocketUpgrade,
    });
    localServers.push(local);
    const client = new WebSocket(
      `ws://127.0.0.1:${local.port}/v1/realtime?model=gpt-realtime`,
      { headers: { authorization: "Bearer codex-token" } },
    );
    clients.push(client);
    await within(open(client), "opening the draining realtime socket");
    const completion = closed(client);

    await expect(within(local.drain(20), "timing out realtime drain")).resolves
      .toBe("timed_out");
    await expect(completion).resolves.toEqual({
      code: 1006,
      reason: "",
    });
  });

  it("finalizes the Data Plane only after active WebSocket sessions settle", async () => {
    const upstreamHttp = createServer();
    upstreamHttpServers.push(upstreamHttp);
    const upstreamWss = new WebSocketServer({ server: upstreamHttp });
    upstreamWebSocketServers.push(upstreamWss);
    const upstreamPort = await listen(upstreamHttp);
    const webSocketUpgrade = createRealtimeUpgrade({
      connectWebSocket: (url, headers) => {
        const target = new URL(url);
        return new WebSocket(
          `ws://127.0.0.1:${upstreamPort}${target.pathname}${target.search}`,
          { headers, followRedirects: false, perMessageDeflate: false },
        );
      },
    });
    const finalize = vi.fn(async () => undefined);
    const listener = await startRunningDataPlaneListener({
      host: "127.0.0.1",
      port: 0,
      shutdownController: new AbortController(),
      dataPlane: {
        runtime: emptyRuntime,
        webSocketUpgrade,
        close: finalize,
      },
    });
    const client = new WebSocket(
      `${listener.origin.replace("http://", "ws://")}/v1/live?model=gpt-live`,
      { headers: { authorization: "Bearer codex-token" } },
    );
    clients.push(client);
    try {
      await within(open(client), "opening the finalization realtime socket");
      const completion = closed(client);
      const closing = listener.close();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(finalize).not.toHaveBeenCalled();
      await within(completion, "settling the finalization realtime socket");
      await within(closing, "finalizing after realtime quiescence");
      expect(finalize).toHaveBeenCalledTimes(1);
    } finally {
      await listener.close();
    }
  });
});
