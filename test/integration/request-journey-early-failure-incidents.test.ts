import { createModels } from "@earendil-works/pi-ai";
import { mkdtemp, rm } from "node:fs/promises";
import { connect as connectSocket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDiagnosticsAuthority,
  parseDiagnosticsConfiguration,
  type DiagnosticsAuthority,
  type DiagnosticsSubscription,
  type RequestJourneyLocation,
  type RequestJourneySummary,
} from "../../src/diagnostics/index.js";
import type { PublicModelSource } from "../../src/public-model-seam.js";
import { createAnthropicMessagesHandler } from "../../src/protocols/anthropic/handler.js";
import { createOpenAIResponsesHandler } from "../../src/protocols/openai-responses/handler.js";
import { createLuckyTokenRuntime } from "../../src/runtime.js";
import {
  startLuckyTokenHttpServer,
  type RunningLuckyTokenHttpServer,
} from "../../src/server.js";

const MAX_REQUEST_BYTES = 96;

interface EarlyFailureCase {
  readonly name: string;
  readonly path: "/v1/messages" | "/v1/responses";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly status: number;
  readonly stepInstanceId: string;
  readonly location: RequestJourneyLocation;
  readonly classification: string;
}

const cases: readonly EarlyFailureCase[] = [
  {
    name: "Anthropic unsupported media type",
    path: "/v1/messages",
    headers: {
      "content-type": "text/plain",
      "anthropic-version": "2023-06-01",
    },
    body: "body must remain unread",
    status: 415,
    stepInstanceId: "p1.validate_media_and_encoding",
    location: {
      phase: "protocol_ingress",
      step: "validate_media_and_encoding",
    },
    classification: "unsupported_media_type",
  },
  {
    name: "Anthropic oversized request",
    path: "/v1/messages",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ padding: "x".repeat(MAX_REQUEST_BYTES) }),
    status: 413,
    stepInstanceId: "p1.read_and_decode_body",
    location: { phase: "protocol_ingress", step: "read_and_decode_body" },
    classification: "request_body_too_large",
  },
  {
    name: "Anthropic invalid JSON",
    path: "/v1/messages",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: "{",
    status: 400,
    stepInstanceId: "p1.read_and_decode_body",
    location: { phase: "protocol_ingress", step: "read_and_decode_body" },
    classification: "invalid_json",
  },
  {
    name: "Anthropic unknown model",
    path: "/v1/messages",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "unknown-model",
      max_tokens: 1,
      messages: [],
    }),
    status: 404,
    stepInstanceId: "p2.resolve_public_model",
    location: { phase: "request_resolution", step: "resolve_public_model" },
    classification: "unknown_model",
  },
  {
    name: "Anthropic unavailable model",
    path: "/v1/messages",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "unavailable-model",
      max_tokens: 1,
      messages: [],
    }),
    status: 502,
    stepInstanceId: "p2.resolve_public_model",
    location: { phase: "request_resolution", step: "resolve_public_model" },
    classification: "model_unavailable",
  },
  {
    name: "OpenAI unsupported media type",
    path: "/v1/responses",
    headers: { "content-type": "text/plain" },
    body: "body must remain unread",
    status: 415,
    stepInstanceId: "p1.validate_media_and_encoding",
    location: {
      phase: "protocol_ingress",
      step: "validate_media_and_encoding",
    },
    classification: "unsupported_media_type",
  },
  {
    name: "OpenAI unsupported content encoding",
    path: "/v1/responses",
    headers: {
      "content-type": "application/json",
      "content-encoding": "br",
    },
    body: JSON.stringify({ model: "unknown-model", input: "hello" }),
    status: 415,
    stepInstanceId: "p1.read_and_decode_body",
    location: { phase: "protocol_ingress", step: "read_and_decode_body" },
    classification: "unsupported_content_encoding",
  },
  {
    name: "OpenAI oversized request",
    path: "/v1/responses",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(MAX_REQUEST_BYTES) }),
    status: 413,
    stepInstanceId: "p1.read_and_decode_body",
    location: { phase: "protocol_ingress", step: "read_and_decode_body" },
    classification: "request_body_too_large",
  },
  {
    name: "OpenAI invalid JSON",
    path: "/v1/responses",
    headers: { "content-type": "application/json" },
    body: "{",
    status: 400,
    stepInstanceId: "p1.read_and_decode_body",
    location: { phase: "protocol_ingress", step: "read_and_decode_body" },
    classification: "invalid_json",
  },
  {
    name: "OpenAI unknown model",
    path: "/v1/responses",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "unknown-model", input: "hello" }),
    status: 400,
    stepInstanceId: "p2.resolve_public_model",
    location: { phase: "request_resolution", step: "resolve_public_model" },
    classification: "unknown_model",
  },
  {
    name: "OpenAI unavailable model",
    path: "/v1/responses",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "unavailable-model", input: "hello" }),
    status: 503,
    stepInstanceId: "p2.resolve_public_model",
    location: { phase: "request_resolution", step: "resolve_public_model" },
    classification: "model_unavailable",
  },
] as const;

function publicModels(): PublicModelSource {
  const unavailable = Object.freeze({
    providerId: "missing-provider",
    modelId: "missing-model",
  });
  return Object.freeze({
    requestSnapshot: async () =>
      Object.freeze({
        version: 1,
        endpoint: Object.freeze({ host: "127.0.0.1", port: 0 }),
        providers: Object.freeze([]),
        resolve: (alias: string) =>
          alias === "unavailable-model" ? unavailable : undefined,
        publishedModels: () => Object.freeze([]),
        favoriteModels: () => Object.freeze([]),
      }),
  });
}

describe("Request Journey early failure incidents", () => {
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

  it.each(cases)(
    "$name records one primary Incident before any lane commit",
    async (testCase) => {
      const root = await mkdtemp(join(tmpdir(), "luckytoken-early-incident-"));
      roots.push(root);
      const authority = await createDiagnosticsAuthority({
        configuration: parseDiagnosticsConfiguration(
          { directory: join(root, "diagnostics") },
          root,
        ),
      });
      authorities.push(authority);
      const requestId = `40000000-0000-4000-8000-${String(cases.indexOf(testCase) + 1).padStart(12, "0")}`;
      let publish!: (summary: RequestJourneySummary) => void;
      const published = new Promise<RequestJourneySummary>((resolve) => {
        publish = resolve;
      });
      subscriptions.push(
        authority.subscribeRequestJourneys((summary) => {
          if (summary.requestId === requestId) publish(summary);
        }),
      );

      const models = createModels();
      const source = publicModels();
      const runtime = createLuckyTokenRuntime({
        clientProtocols: [
          createAnthropicMessagesHandler({
            models,
            publicModels: source,
            maxRequestBytes: MAX_REQUEST_BYTES,
          }),
          createOpenAIResponsesHandler({
            models,
            publicModels: source,
            stateFile: join(root, "responses-state.json"),
            maxRequestBytes: MAX_REQUEST_BYTES,
          }),
        ],
      });
      const server = await startLuckyTokenHttpServer({
        runtime,
        diagnostics: authority,
        createRequestId: () => requestId,
        port: 0,
      });
      servers.push(server);

      const response = await fetch(`${server.origin}${testCase.path}`, {
        method: "POST",
        headers: testCase.headers,
        body: testCase.body,
      });
      await response.arrayBuffer();
      expect(response.status).toBe(testCase.status);

      const summary = await published;
      expect(summary).toMatchObject({ requestId, outcome: "failed" });
      expect(summary.primaryFailureLocation).toEqual(testCase.location);
      expect(summary).not.toHaveProperty("lane");

      const detail = await authority.getRequestJourney({ requestId });
      expect(detail.incident).toBeDefined();
      const primaryFailureId = detail.incident!.primaryFailureId;
      expect(detail.incident!.failures).toContainEqual(
        expect.objectContaining({
          kind: "failure_detected",
          failureId: primaryFailureId,
          role: "primary",
          classification: testCase.classification,
          location: testCase.location,
        }),
      );
      expect(detail.timeline.map((event) => event.observation)).toContainEqual(
        expect.objectContaining({
          kind: "step_completed",
          stepInstanceId: testCase.stepInstanceId,
          completion: "failed",
          location: testCase.location,
        }),
      );
      expect(
        detail.timeline.some(
          (event) => event.observation.kind === "lane_committed",
        ),
      ).toBe(false);
      expect(detail.workOutcome).toMatchObject({ outcome: "failed" });
    },
  );

  it("records server draining as the primary admission Incident without a lane", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-draining-incident-"));
    roots.push(root);
    const authority = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration(
        { directory: join(root, "diagnostics") },
        root,
      ),
    });
    authorities.push(authority);
    const firstRequestId = "50000000-0000-4000-8000-000000000001";
    const drainingRequestId = "50000000-0000-4000-8000-000000000002";
    const requestIds = [firstRequestId, drainingRequestId];
    let requestIdIndex = 0;
    let handlerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      handlerStarted = resolve;
    });
    let releaseHandler!: () => void;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const runtime = createLuckyTokenRuntime({
      clientProtocols: [
        {
          method: "GET",
          pathname: "/controlled",
          handle: async () => {
            handlerStarted();
            await handlerGate;
            return new Response("first");
          },
        },
      ],
    });
    let publish!: (summary: RequestJourneySummary) => void;
    const published = new Promise<RequestJourneySummary>((resolve) => {
      publish = resolve;
    });
    subscriptions.push(
      authority.subscribeRequestJourneys((summary) => {
        if (summary.requestId === drainingRequestId) publish(summary);
      }),
    );
    const server = await startLuckyTokenHttpServer({
      runtime,
      diagnostics: authority,
      createRequestId: () => requestIds[requestIdIndex++]!,
      port: 0,
    });
    servers.push(server);
    const socket = connectSocket(server.port, server.host);
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });

    socket.write(
      "GET /controlled HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n",
    );
    await started;
    const drain = server.drain(5_000);
    socket.write(
      "GET /controlled HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    );
    releaseHandler();
    await expect(drain).resolves.toBe("drained");
    const summary = await published;

    expect(Buffer.concat(chunks).toString("utf8")).toContain("503 Service Unavailable");
    expect(summary).toMatchObject({
      requestId: drainingRequestId,
      outcome: "failed",
      primaryFailureLocation: {
        phase: "http_admission",
        step: "reject_server_draining",
      },
    });
    expect(summary).not.toHaveProperty("lane");
    const detail = await authority.getRequestJourney({
      requestId: drainingRequestId,
    });
    expect(detail.incident).toMatchObject({
      failures: [
        expect.objectContaining({
          kind: "failure_detected",
          role: "primary",
          classification: "server_draining",
          origin: "luckytoken",
          location: {
            phase: "http_admission",
            step: "reject_server_draining",
          },
        }),
      ],
    });
    expect(
      detail.timeline.some(
        (event) => event.observation.kind === "lane_committed",
      ),
    ).toBe(false);
  });
});
