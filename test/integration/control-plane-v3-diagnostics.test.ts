import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  connectControlPlane,
  controlPlaneVersion,
  createNodePipeTransport,
  nodePipeFallbackAccess,
  startControlPlane,
  type ControlPlaneEndpoint,
  type DiagnosticsSubscription,
  type PipeConnection,
  type RequestArtifactGetInput,
  type RequestArtifactReadResult,
  type RequestJourneyGetInput,
  type RequestJourneyQuery,
  type RequestJourneyRecord,
  type RequestJourneySubscriber,
  type RequestJourneySummary,
  type RunningControlPlane,
  type RuntimeEventQuery,
  type RuntimeEventRecord,
  type RuntimeEventSubscriber,
  type UnifiedDiagnosticsManagement,
} from "@token/application-control-plane/control-plane";
import { DiagnosticsUnavailableError } from "../../src/diagnostics/index.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return Object.freeze({
    promise,
    resolve: (value: T) => resolvePromise?.(value),
  });
}

let nextEndpointId = 0;
function endpoint(): ControlPlaneEndpoint {
  nextEndpointId += 1;
  return {
    address: `\\\\.\\pipe\\Token-v4-diagnostics-${process.pid}-${nextEndpointId}`,
    capability: "v4-diagnostics-capability-012345678901234567890123456789",
  };
}

function encodeRawFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

async function readExact(
  connection: PipeConnection,
  byteLength: number,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let received = 0;
  while (received < byteLength) {
    const chunk = await connection.read(byteLength - received);
    if (chunk === null) return null;
    chunks.push(chunk);
    received += chunk.length;
  }
  return Buffer.concat(chunks);
}

async function readRawFrame(connection: PipeConnection): Promise<unknown> {
  const header = await readExact(connection, 4);
  if (header === null) return undefined;
  const body = await readExact(connection, header.readUInt32BE(0));
  return body === null ? undefined : JSON.parse(body.toString("utf8"));
}

const JOURNEY_SUMMARY: RequestJourneySummary = Object.freeze({
  id: 1,
  runtimeId: "52000000-0000-4000-8000-000000000001",
  requestId: "52000000-0000-4000-8000-000000000002",
  operation: "model_generation",
  protocol: "anthropic-messages",
  lane: "semantic_conversion",
  outcome: "failed",
  completeness: "complete",
  createdAt: 1_787_558_400_000,
  closedAt: 1_787_558_400_100,
  usage: Object.freeze({
    terminalClass: "done",
    inputTokens: 11,
    cacheReadTokens: 3,
    outputTokens: 7,
    cacheHitRate: 3 / 14,
    outputTokensPerSecond: 7,
  }),
});

const JOURNEY_RECORD: RequestJourneyRecord = Object.freeze({
  ...JOURNEY_SUMMARY,
  admission: Object.freeze({
    operationCandidate: "model_generation",
    transport: "http",
    method: "POST",
    path: "/v1/messages",
    acceptedAt: 1_787_558_400_000,
    cancellation: Object.freeze({ caller: "active", shutdown: "not_bound" }),
  }),
  timeline: Object.freeze([]),
  artifacts: Object.freeze([
    Object.freeze({
      artifactId: "client-response-wire",
      artifactKind: "client_response_wire",
      state: "captured",
      mediaType: "application/json",
      capturedBytes: 4,
      originalBytes: 4,
      redaction: "not_required",
      truncated: false,
    }),
  ]),
});

const ARTIFACT: RequestArtifactReadResult = Object.freeze({
  requestId: JOURNEY_SUMMARY.requestId,
  artifactId: "client-response-wire",
  offset: 0,
  nextOffset: 4,
  complete: true,
  dataBase64: "c2FmZQ==",
});

const RUNTIME_EVENT: RuntimeEventRecord = Object.freeze({
  kind: "runtime_event",
  id: 2,
  runtimeId: JOURNEY_SUMMARY.runtimeId,
  recordId: "52000000-0000-4000-8000-000000000003",
  sequence: 0,
  time: 1_787_558_400_200,
  level: "warning",
  classification: "catalog_refresh_degraded",
  safeMessage: "One provider catalog could not be refreshed",
});

function createDiagnosticsFixture(): Readonly<{
  adapter: UnifiedDiagnosticsManagement;
  calls: string[];
  publishJourney: (record: RequestJourneySummary) => void;
  publishRuntime: (record: RuntimeEventRecord) => void;
  activeJourneySubscriptions: () => number;
  activeRuntimeSubscriptions: () => number;
}> {
  const calls: string[] = [];
  const journeySubscribers = new Set<RequestJourneySubscriber>();
  const runtimeSubscribers = new Set<RuntimeEventSubscriber>();
  const subscription = <T>(listeners: Set<T>, listener: T): DiagnosticsSubscription => {
    listeners.add(listener);
    return Object.freeze({ unsubscribe: () => listeners.delete(listener) });
  };
  return Object.freeze({
    calls,
    adapter: Object.freeze({
      queryRequestJourneys: async (query?: RequestJourneyQuery) => {
        calls.push(`query:${JSON.stringify(query ?? {})}`);
        return Object.freeze({ records: Object.freeze([JOURNEY_SUMMARY]), hasMore: false });
      },
      getRequestJourney: async (input: RequestJourneyGetInput) => {
        calls.push(`get:${input.requestId}`);
        return JOURNEY_RECORD;
      },
      getRequestArtifact: async (input: RequestArtifactGetInput) => {
        calls.push(`artifact:${input.requestId}:${input.artifactId}:${input.offset}:${input.limit}`);
        return ARTIFACT;
      },
      queryRuntimeEvents: async (query?: RuntimeEventQuery) => {
        calls.push(`runtime:${JSON.stringify(query ?? {})}`);
        return Object.freeze({ records: Object.freeze([RUNTIME_EVENT]), hasMore: false });
      },
      subscribeRequestJourneys: (listener: RequestJourneySubscriber) =>
        subscription(journeySubscribers, listener),
      subscribeRuntimeEvents: (listener: RuntimeEventSubscriber) =>
        subscription(runtimeSubscribers, listener),
    }),
    publishJourney: (record) => {
      for (const listener of [...journeySubscribers]) void listener(record);
    },
    publishRuntime: (record) => {
      for (const listener of [...runtimeSubscribers]) void listener(record);
    },
    activeJourneySubscriptions: () => journeySubscribers.size,
    activeRuntimeSubscriptions: () => runtimeSubscribers.size,
  });
}

function unavailableDiagnosticsAdapter(): UnifiedDiagnosticsManagement {
  const unavailable = () => Promise.reject(new DiagnosticsUnavailableError());
  return Object.freeze({
    queryRequestJourneys: unavailable,
    getRequestJourney: unavailable,
    getRequestArtifact: unavailable,
    queryRuntimeEvents: unavailable,
    subscribeRequestJourneys: () =>
      Object.freeze({ unsubscribe: () => undefined }),
    subscribeRuntimeEvents: () =>
      Object.freeze({ unsubscribe: () => undefined }),
  });
}

describe("Application Control Plane v4 unified diagnostics", () => {
  const hosts: RunningControlPlane[] = [];
  const clients: Array<{ close(): Promise<void> }> = [];
  const transport = createNodePipeTransport();

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await Promise.all(hosts.splice(0).map((host) => host.close()));
  });

  it("negotiates only v4 and round-trips unified diagnostics reads with typed unavailability", async () => {
    expect(controlPlaneVersion).toBe(4);
    const fixture = createDiagnosticsFixture();
    const target = endpoint();
    const host = await startControlPlane({
      endpoint: target,
      application: { id: "Token", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
      diagnostics: fixture.adapter,
    });
    hosts.push(host);
    const connected = await connectControlPlane(host.endpoint, {
      createRequestId: randomUUID,
      pipeConnector: transport,
    });
    clients.push(connected);

    await expect(connected.hello(2)).resolves.toEqual({
      type: "incompatible",
      requestedVersion: 2,
      supportedVersions: [4],
    });
    await expect(connected.hello(4)).resolves.toMatchObject({
      type: "compatible",
      contractVersion: 4,
    });
    await expect(connected.queryRequestJourneys({ limit: 10 })).resolves.toEqual({
      outcome: "ok",
      result: { records: [JOURNEY_SUMMARY], hasMore: false },
    });
    await expect(
      connected.getRequestJourney({ requestId: JOURNEY_SUMMARY.requestId }),
    ).resolves.toEqual({ outcome: "ok", result: JOURNEY_RECORD });
    await expect(
      connected.getRequestArtifact({
        requestId: JOURNEY_SUMMARY.requestId,
        artifactId: ARTIFACT.artifactId,
        offset: 0,
        limit: 256,
      }),
    ).resolves.toEqual({ outcome: "ok", result: ARTIFACT });
    await expect(connected.queryRuntimeEvents({ afterId: 1, limit: 10 })).resolves.toEqual({
      outcome: "ok",
      result: { records: [RUNTIME_EVENT], hasMore: false },
    });
    expect(fixture.calls).toEqual([
      "query:{\"limit\":10}",
      `get:${JOURNEY_SUMMARY.requestId}`,
      `artifact:${JOURNEY_SUMMARY.requestId}:${ARTIFACT.artifactId}:0:256`,
      "runtime:{\"afterId\":1,\"limit\":10}",
    ]);

    expect("getDiagnostics" in connected).toBe(false);
    expect("subscribeDiagnostics" in connected).toBe(false);
    expect("getRequestLedger" in connected).toBe(false);
    expect("subscribeRequestLedger" in connected).toBe(false);
    expect("getCapture" in connected).toBe(false);
    expect("subscribeCapture" in connected).toBe(false);
    const raw = await transport.connect(target.address);
    await raw.write(
      encodeRawFrame({
        type: "hello",
        requestId: "v4-raw-hello",
        contractVersion: 4,
        capability: target.capability,
      }),
    );
    expect(await readRawFrame(raw)).toMatchObject({
      type: "hello_result",
      result: { type: "compatible", contractVersion: 4 },
    });
    for (const [type, requestId] of [
      ["get_diagnostics", "legacy-diagnostics"],
      ["diagnostics_subscribe", "legacy-diagnostics-subscribe"],
      ["diagnostics_unsubscribe", "legacy-diagnostics-unsubscribe"],
      ["get_request_ledger", "legacy-ledger"],
      ["ledger_subscribe", "legacy-ledger-subscribe"],
      ["ledger_unsubscribe", "legacy-ledger-unsubscribe"],
      ["get_capture", "legacy-capture"],
      ["capture_subscribe", "legacy-capture-subscribe"],
      ["capture_unsubscribe", "legacy-capture-unsubscribe"],
    ] as const) {
      await raw.write(encodeRawFrame({ type, requestId }));
      expect(await readRawFrame(raw)).toEqual({
        type: "error",
        requestId,
        code: "unknown_command",
      });
    }
    await raw.write(
      encodeRawFrame({
        type: "query_request_journeys",
        requestId: "strict-query",
        query: { limit: 10, unknown: true },
      }),
    );
    expect(await readRawFrame(raw)).toEqual({
      type: "error",
      requestId: "strict-query",
      code: "invalid_request",
    });
    await raw.close();

    const unavailableHost = await startControlPlane({
      endpoint: endpoint(),
      application: { id: "Token", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
      diagnostics: unavailableDiagnosticsAdapter(),
      analyticsHandler: async () => {
        throw new DiagnosticsUnavailableError();
      },
      historyCommandHandler: async () => {
        throw new DiagnosticsUnavailableError();
      },
      backupCommandHandler: async () => {
        throw new DiagnosticsUnavailableError();
      },
    });
    hosts.push(unavailableHost);
    const unavailableClient = await connectControlPlane(unavailableHost.endpoint, {
      createRequestId: randomUUID,
      pipeConnector: transport,
    });
    clients.push(unavailableClient);
    await unavailableClient.hello(4);
    const typedUnavailable = {
      outcome: "unavailable",
      error: {
        code: "diagnostics_unavailable",
        classification: "diagnostics_storage_unavailable",
        message: "Diagnostics storage is unavailable",
      },
    } as const;
    await expect(
      unavailableClient.queryRequestJourneys({ limit: 10 }),
    ).resolves.toEqual(typedUnavailable);
    await expect(
      unavailableClient.getRequestJourney({ requestId: JOURNEY_SUMMARY.requestId }),
    ).resolves.toEqual(typedUnavailable);
    await expect(
      unavailableClient.getRequestArtifact({
        requestId: JOURNEY_SUMMARY.requestId,
        artifactId: ARTIFACT.artifactId,
        offset: 0,
        limit: 256,
      }),
    ).resolves.toEqual(typedUnavailable);
    await expect(
      unavailableClient.queryRuntimeEvents({ limit: 10 }),
    ).resolves.toEqual(typedUnavailable);
    await expect(
      unavailableClient.getAnalytics({
        version: 3,
        command: "summary",
        from: 0,
        to: 1,
      }),
    ).resolves.toEqual(typedUnavailable);
    await expect(unavailableClient.queryHistory("all")).resolves.toEqual(
      typedUnavailable,
    );
    await expect(
      unavailableClient.executeBackup({
        mode: "ordinary",
        destinationPath: "D:\\typed-unavailable-backup.json",
        overwrite: false,
      }),
    ).resolves.toEqual(typedUnavailable);
  });

  it("round-trips both unified subscriptions and contains one client's listener failure", async () => {
    expect(controlPlaneVersion).toBe(4);
    const fixture = createDiagnosticsFixture();
    const host = await startControlPlane({
      endpoint: endpoint(),
      application: { id: "Token", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
      diagnostics: fixture.adapter,
    });
    hosts.push(host);
    const first = await connectControlPlane(host.endpoint, {
      createRequestId: randomUUID,
      pipeConnector: transport,
    });
    const second = await connectControlPlane(host.endpoint, {
      createRequestId: randomUUID,
      pipeConnector: transport,
    });
    clients.push(first, second);
    await first.hello(4);
    await second.hello(4);

    const journeyDelivered = deferred<void>();
    const runtimeDelivered = deferred<void>();
    const secondJourneys: RequestJourneySummary[] = [];
    const secondRuntime: RuntimeEventRecord[] = [];
    const unsubscribers = await Promise.all([
      first.subscribeRequestJourneys(() => {
        throw new Error("control-plane-subscriber-canary");
      }),
      first.subscribeRuntimeEvents(() =>
        Promise.reject(new Error("control-plane-subscriber-canary")),
      ),
      second.subscribeRequestJourneys((record) => {
        secondJourneys.push(record);
        journeyDelivered.resolve();
      }),
      second.subscribeRuntimeEvents((record) => {
        secondRuntime.push(record);
        runtimeDelivered.resolve();
      }),
    ]);

    fixture.publishJourney(JOURNEY_SUMMARY);
    fixture.publishRuntime(RUNTIME_EVENT);
    await Promise.all([journeyDelivered.promise, runtimeDelivered.promise]);
    expect(secondJourneys).toEqual([JOURNEY_SUMMARY]);
    expect(secondRuntime).toEqual([RUNTIME_EVENT]);
    await expect(first.queryRequestJourneys({ limit: 10 })).resolves.toMatchObject({
      outcome: "ok",
    });

    expect(fixture.activeJourneySubscriptions()).toBe(2);
    expect(fixture.activeRuntimeSubscriptions()).toBe(2);
    await first.close();
    await expect.poll(fixture.activeJourneySubscriptions).toBe(1);
    await expect.poll(fixture.activeRuntimeSubscriptions).toBe(1);
    await Promise.all([unsubscribers[2]!(), unsubscribers[3]!()]);
    expect(fixture.activeJourneySubscriptions()).toBe(0);
    expect(fixture.activeRuntimeSubscriptions()).toBe(0);
  });
});
