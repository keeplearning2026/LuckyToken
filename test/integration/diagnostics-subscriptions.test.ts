import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDiagnosticsAuthority,
  DiagnosticsUnavailableError,
  parseDiagnosticsConfiguration,
  type DiagnosticsAuthority,
  type RequestJourneySummary,
  type RuntimeEventRecord,
} from "../../src/diagnostics/index.js";
import type {
  DiagnosticsWorkerFactory,
  DiagnosticsWorkerSession,
} from "../../src/diagnostics/authority.js";
import {
  startTokenHttpServer,
  type RunningTokenHttpServer,
} from "../../src/server.js";
import { createCommandCodeTestRuntime } from "../support/commandcode-serving.js";

interface DiagnosticsSubscription {
  readonly unsubscribe: () => void;
}

interface DiagnosticsSubscriptions {
  subscribeRequestJourneys(
    listener: (record: RequestJourneySummary) => void | Promise<void>,
  ): DiagnosticsSubscription;
  subscribeRuntimeEvents(
    listener: (record: RuntimeEventRecord) => void | Promise<void>,
  ): DiagnosticsSubscription;
}

function subscriptions(
  authority: DiagnosticsAuthority,
): DiagnosticsAuthority & DiagnosticsSubscriptions {
  return authority as DiagnosticsAuthority & DiagnosticsSubscriptions;
}

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

interface WorkerAck {
  readonly type: "ack";
  readonly runtimeId: string;
  readonly requestId?: string;
  readonly recordId?: string;
  readonly sequence: number;
  readonly [key: string]: unknown;
}

function createRealWorkerAckGate(): Readonly<{
  factory: DiagnosticsWorkerFactory;
  nextAck: () => Promise<WorkerAck>;
  release: (ack: WorkerAck) => void;
}> {
  const acknowledgements: WorkerAck[] = [];
  const acknowledgementWaiters: Array<(ack: WorkerAck) => void> = [];
  const pendingAuthorityMessages: unknown[] = [];
  let authorityListener: ((message: unknown) => void) | undefined;

  const factory: DiagnosticsWorkerFactory = (input): DiagnosticsWorkerSession => {
    const worker = new Worker(input.source, {
      eval: true,
      workerData: input.workerData,
    });
    worker.on("message", (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "ack"
      ) {
        const ack = message as WorkerAck;
        const waiter = acknowledgementWaiters.shift();
        if (waiter === undefined) acknowledgements.push(ack);
        else waiter(ack);
        return;
      }
      if (authorityListener === undefined) {
        pendingAuthorityMessages.push(message);
      } else {
        authorityListener(message);
      }
    });
    return Object.freeze({
      postMessage: (message: object) => worker.postMessage(message),
      onMessage(listener: (message: unknown) => void) {
        authorityListener = listener;
        for (const message of pendingAuthorityMessages.splice(0)) {
          listener(message);
        }
      },
      onError: (listener: (error: Error) => void) =>
        worker.on("error", listener),
      onExit: (listener: (code: number) => void) =>
        worker.on("exit", listener),
      terminate: () => worker.terminate(),
    });
  };

  return Object.freeze({
    factory,
    nextAck: () => {
      const ack = acknowledgements.shift();
      if (ack !== undefined) return Promise.resolve(ack);
      return new Promise<WorkerAck>((resolve) => {
        acknowledgementWaiters.push(resolve);
      });
    },
    release: (ack) => authorityListener?.(ack),
  });
}

function beginAndClose(
  authority: DiagnosticsAuthority,
  requestId: string,
): void {
  const observer = authority.begin({
    requestId,
    operationCandidate: "unmatched_request",
    transport: "in_process",
    method: "GET",
    path: "/subscription-ack-probe",
    acceptedAt: 1_787_558_400_000,
    cancellation: { caller: "active", shutdown: "not_bound" },
  });
  expect(observer).not.toBeInstanceOf(Promise);
  expect(observer.close({ outcome: "success" })).toBeUndefined();
}

function commandCodeSuccess(): Response {
  return new Response(
    [
      JSON.stringify({ type: "text-start", id: "0" }),
      JSON.stringify({ type: "text-delta", id: "0", text: "subscriber safe" }),
      JSON.stringify({ type: "text-end", id: "0" }),
      JSON.stringify({
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
      }),
      "",
    ].join("\n"),
  );
}

function createRuntime() {
  return createCommandCodeTestRuntime({
    clientApiKey: "fixture-client-key",
    commandCodeApiKey: "fixture-provider-key",
    commandCodeBaseUrl: "https://fixture.commandcode.test",
    fetch: async () => commandCodeSuccess(),
    modelId: "claude-fixture",
    createMessageId: () => "msg_subscription_containment",
    createSessionId: () => "51000000-0000-4000-8000-000000000001",
    now: () => 1_787_558_400_000,
  });
}

describe("Diagnostics durable subscriptions", () => {
  const roots: string[] = [];
  const authorities: DiagnosticsAuthority[] = [];
  const servers: RunningTokenHttpServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(
      authorities.splice(0).map((authority) => authority.close()),
    );
    await Promise.all(
      roots.splice(0).map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
  });

  it("projects trustworthy row usage identically through query and durable subscription", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-subscriptions-usage-"));
    roots.push(root);
    let clock = 1_787_558_400_000;
    const authority = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration({ directory: root }, root),
      runtimeId: "51000000-0000-4000-8000-000000000010",
      now: () => clock,
    });
    authorities.push(authority);
    const management = subscriptions(authority);
    const completeDelivered = deferred<RequestJourneySummary>();
    const incompleteDelivered = deferred<RequestJourneySummary>();
    const published: RequestJourneySummary[] = [];
    const subscription = management.subscribeRequestJourneys((record) => {
      published.push(record);
      if (record.requestId.endsWith("11") && record.outcome !== "running") {
        completeDelivered.resolve(record);
      }
      if (record.requestId.endsWith("12") && record.outcome !== "running") {
        incompleteDelivered.resolve(record);
      }
    });

    const requestId = "51000000-0000-4000-8000-000000000011";
    const observer = authority.begin({
      requestId,
      operationCandidate: "model_generation",
      transport: "in_process",
      method: "POST",
      path: "/v1/messages",
      acceptedAt: clock,
      cancellation: { caller: "active", shutdown: "not_bound" },
    });
    observer.observe({
      kind: "request_identity_established",
      clientSessionId: "session-client-1",
      effectiveSessionId: "session-effective-1",
      location: {
        phase: "protocol_ingress",
        step: "establish_request_identity",
      },
    });
    observer.observe({
      kind: "model_resolved",
      requestedModel: "commandcode-goat/deepseek-v4-pro",
      providerId: "commandcode-goat",
      modelId: "deepseek/deepseek-v4-pro",
      location: {
        phase: "request_resolution",
        step: "resolve_public_model",
      },
    });
    observer.observe({
      kind: "profile_attributed",
      profileId: "credential-production",
      displayName: "Production",
      location: {
        phase: "lane_request_preparation",
        lane: "provider_native",
        step: "capture_provider_profile",
      },
    });
    observer.observe({
      kind: "step_entered",
      stepInstanceId: "provider-dispatch",
      location: {
        phase: "upstream_execution",
        lane: "provider_native",
        step: "dispatch_provider_native",
      },
    });
    clock += 1_000;
    observer.observe({
      kind: "terminal_usage_observed",
      usage: {
        input: 11,
        cacheRead: 3,
        output: 7,
        terminalClass: "done",
      },
      location: {
        phase: "upstream_execution",
        lane: "provider_native",
        step: "observe_provider_native_usage",
        subject: "usage",
      },
    });
    observer.observe({
      kind: "work_outcome_committed",
      outcome: "success",
      requestOutcome: "success",
      terminalAuthority: "provider_native_lane",
      location: {
        phase: "outcome_commit",
        lane: "provider_native",
        step: "commit_request_outcome",
      },
    });
    observer.observe({
      kind: "client_response_prepared",
      status: 200,
      mediaType: "application/json",
      location: {
        phase: "client_response_preparation",
        lane: "provider_native",
        step: "render_client_response",
      },
    });
    observer.close({ outcome: "success" });

    const page = await authority.queryRequestJourneys({ limit: 10 });
    const expectedUsage = {
      terminalClass: "done",
      inputTokens: 11,
      cacheReadTokens: 3,
      outputTokens: 7,
      cacheHitRate: 3 / 14,
      outputTokensPerSecond: 7,
    } as const;
    expect(page.records).toHaveLength(1);
    expect(page.records[0]).toMatchObject({
      requestId,
      requestedModel: "commandcode-goat/deepseek-v4-pro",
      providerId: "commandcode-goat",
      realModelId: "deepseek/deepseek-v4-pro",
      clientSessionId: "session-client-1",
      effectiveSessionId: "session-effective-1",
      profileId: "credential-production",
      profileDisplayName: "Production",
      httpStatus: 200,
      usage: expectedUsage,
    });
    await expect(completeDelivered.promise).resolves.toMatchObject({
      requestId,
      usage: expectedUsage,
    });

    clock += 1;
    const partialRequestId = "51000000-0000-4000-8000-000000000012";
    const partialObserver = authority.begin({
      requestId: partialRequestId,
      operationCandidate: "model_generation",
      transport: "in_process",
      method: "POST",
      path: "/v1/messages",
      acceptedAt: clock,
      cancellation: { caller: "active", shutdown: "not_bound" },
    });
    partialObserver.observe({
      kind: "terminal_usage_observed",
      usage: {
        input: 99,
        cacheRead: 88,
        output: 66,
        terminalClass: "failed",
      },
      location: {
        phase: "upstream_execution",
        lane: "semantic_conversion",
        step: "normalize_terminal_usage",
        subject: "usage",
      },
    });
    partialObserver.close({ outcome: "success" });

    const updatedPage = await authority.queryRequestJourneys({ limit: 10 });
    const expectedPartialUsage = {
      terminalClass: "failed",
      inputTokens: 99,
      cacheReadTokens: 88,
      outputTokens: 66,
      cacheHitRate: 88 / 187,
    } as const;
    expect(updatedPage.records).toContainEqual(expect.objectContaining({
      requestId: partialRequestId,
      usage: expectedPartialUsage,
    }));
    await expect(incompleteDelivered.promise).resolves.toMatchObject({
      requestId: partialRequestId,
      usage: expectedPartialUsage,
    });
    subscription.unsubscribe();
  });

  it("publishes typed records only after their durable ACK, in records order, and honors unsubscribe", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-subscriptions-ack-"));
    roots.push(root);
    const gate = createRealWorkerAckGate();
    const authority = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration({ directory: root }, root),
      runtimeId: "51000000-0000-4000-8000-000000000002",
      now: () => 1_787_558_400_000,
      workerFactory: gate.factory,
    });
    authorities.push(authority);
    const management = subscriptions(authority);

    const journeyRecords: RequestJourneySummary[] = [];
    const runtimeRecords: RuntimeEventRecord[] = [];
    const firstJourneyDelivered = deferred<void>();
    const secondJourneyDelivered = deferred<void>();
    const firstRuntimeDelivered = deferred<void>();
    const secondRuntimeDelivered = deferred<void>();
    const journeySubscription = management.subscribeRequestJourneys((record) => {
      journeyRecords.push(record);
      if (journeyRecords.length === 1) firstJourneyDelivered.resolve();
      if (journeyRecords.length === 2) secondJourneyDelivered.resolve();
    });
    const runtimeSubscription = management.subscribeRuntimeEvents((record) => {
      runtimeRecords.push(record);
      if (runtimeRecords.length === 1) firstRuntimeDelivered.resolve();
      if (runtimeRecords.length === 2) secondRuntimeDelivered.resolve();
    });
    expect(typeof journeySubscription.unsubscribe).toBe("function");
    expect(typeof runtimeSubscription.unsubscribe).toBe("function");

    const unsubscribedJourneyRecords: RequestJourneySummary[] = [];
    const oneJourneySubscription = management.subscribeRequestJourneys((record) => {
      unsubscribedJourneyRecords.push(record);
    });

    const firstRequestId = "51000000-0000-4000-8000-000000000003";
    beginAndClose(authority, firstRequestId);
    const firstBeginAck = await gate.nextAck();
    const firstCloseAck = await gate.nextAck();
    expect(journeyRecords).toEqual([]);
    const durableFirstJourney = await authority.queryRequestJourneys({ limit: 10 });
    expect(durableFirstJourney.records).toContainEqual(
      expect.objectContaining({ requestId: firstRequestId, outcome: "success" }),
    );
    expect(journeyRecords).toEqual([]);
    gate.release(firstBeginAck);
    expect(journeyRecords).toEqual([]);
    gate.release(firstCloseAck);
    await firstJourneyDelivered.promise;
    expect(journeyRecords[0]).toMatchObject({
      requestId: firstRequestId,
      outcome: "success",
    });
    expect(unsubscribedJourneyRecords).toHaveLength(1);
    oneJourneySubscription.unsubscribe();
    oneJourneySubscription.unsubscribe();

    const firstRuntimeInput = Object.freeze({
      level: "warning" as const,
      classification: "subscription_runtime_first",
      safeMessage: "First durable Runtime Event",
    });
    expect(authority.observeRuntime(firstRuntimeInput)).toBeUndefined();
    const firstRuntimeAck = await gate.nextAck();
    expect(runtimeRecords).toEqual([]);
    const durableFirstRuntime = await authority.queryRuntimeEvents({ limit: 10 });
    expect(durableFirstRuntime.records).toContainEqual(
      expect.objectContaining(firstRuntimeInput),
    );
    expect(runtimeRecords).toEqual([]);
    gate.release(firstRuntimeAck);
    await firstRuntimeDelivered.promise;

    const secondRequestId = "51000000-0000-4000-8000-000000000004";
    beginAndClose(authority, secondRequestId);
    const secondBeginAck = await gate.nextAck();
    const secondCloseAck = await gate.nextAck();
    gate.release(secondBeginAck);
    gate.release(secondCloseAck);
    await secondJourneyDelivered.promise;

    const secondRuntimeInput = Object.freeze({
      level: "info" as const,
      classification: "subscription_runtime_second",
      safeMessage: "Second durable Runtime Event",
    });
    expect(authority.observeRuntime(secondRuntimeInput)).toBeUndefined();
    const secondRuntimeAck = await gate.nextAck();
    gate.release(secondRuntimeAck);
    await secondRuntimeDelivered.promise;

    expect(journeyRecords.map((record) => record.requestId)).toEqual([
      firstRequestId,
      secondRequestId,
    ]);
    expect(journeyRecords[0]!.id).toBeLessThan(journeyRecords[1]!.id);
    expect(runtimeRecords.map((record) => record.classification)).toEqual([
      firstRuntimeInput.classification,
      secondRuntimeInput.classification,
    ]);
    expect(runtimeRecords[0]!.id).toBeLessThan(runtimeRecords[1]!.id);
    expect(unsubscribedJourneyRecords).toHaveLength(1);

    journeySubscription.unsubscribe();
    runtimeSubscription.unsubscribe();
  });

  it("contains throwing and rejected listeners without affecting peers, real HTTP, observations, or close", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "Token-subscriptions-containment-"),
    );
    roots.push(root);
    const authority = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration({ directory: root }, root),
      runtimeId: "51000000-0000-4000-8000-000000000005",
    });
    authorities.push(authority);
    const management = subscriptions(authority);
    const requestRecords: RequestJourneySummary[] = [];
    const runtimeRecords: RuntimeEventRecord[] = [];
    const listenerCanary = "subscription-listener-canary";
    const subscriptionsToClose = [
      management.subscribeRequestJourneys(() => {
        throw new Error(listenerCanary);
      }),
      management.subscribeRequestJourneys(() =>
        Promise.reject(new Error(listenerCanary)),
      ),
      management.subscribeRequestJourneys((record) => {
        requestRecords.push(record);
      }),
      management.subscribeRuntimeEvents(() => {
        throw new Error(listenerCanary);
      }),
      management.subscribeRuntimeEvents(() =>
        Promise.reject(new Error(listenerCanary)),
      ),
      management.subscribeRuntimeEvents((record) => {
        runtimeRecords.push(record);
      }),
    ];

    expect(
      authority.observeRuntime({
        level: "info",
        classification: "subscription_containment_probe",
        safeMessage: "Subscription containment probe",
      }),
    ).toBeUndefined();
    const runtimePage = await authority.queryRuntimeEvents({ limit: 10 });
    expect(runtimePage.records).toHaveLength(1);
    expect(runtimeRecords).toEqual(runtimePage.records);

    const server = await startTokenHttpServer({
      runtime: createRuntime(),
      diagnostics: authority,
      createRequestId: () => "51000000-0000-4000-8000-000000000006",
      port: 0,
    });
    servers.push(server);
    const response = await fetch(`${server.origin}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer fixture-client-key",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-fixture",
        max_tokens: 32,
        messages: [{ role: "user", content: "subscriber containment" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: "msg_subscription_containment",
      content: [{ type: "text", text: "subscriber safe" }],
    });
    const journeyPage = await authority.queryRequestJourneys({ limit: 10 });
    expect(journeyPage.records).toHaveLength(1);
    expect(requestRecords).toEqual(journeyPage.records);

    for (const subscription of subscriptionsToClose) subscription.unsubscribe();
    await expect(authority.close()).resolves.toBeUndefined();
    authorities.splice(authorities.indexOf(authority), 1);
  });

  it("allows silent subscriptions when storage is unavailable without fabricating records", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "Token-subscriptions-unavailable-"),
    );
    roots.push(root);
    const database = new DatabaseSync(join(root, "diagnostics-v2.sqlite3"));
    database.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value NOT NULL);
      INSERT INTO meta (key, value) VALUES ('schema_name', 'foreign_diagnostics');
      INSERT INTO meta (key, value) VALUES ('schema_version', 99);
    `);
    database.close();
    const authority = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration({ directory: root }, root),
      runtimeId: randomUUID(),
    });
    authorities.push(authority);
    const requestRecords: RequestJourneySummary[] = [];
    const runtimeRecords: RuntimeEventRecord[] = [];
    const management = subscriptions(authority);

    const requestSubscription = management.subscribeRequestJourneys((record) => {
      requestRecords.push(record);
    });
    const runtimeSubscription = management.subscribeRuntimeEvents((record) => {
      runtimeRecords.push(record);
    });
    expect(typeof requestSubscription.unsubscribe).toBe("function");
    expect(typeof runtimeSubscription.unsubscribe).toBe("function");
    expect(() =>
      beginAndClose(
        authority,
        "51000000-0000-4000-8000-000000000007",
      ),
    ).not.toThrow();
    expect(() =>
      authority.observeRuntime({
        level: "critical",
        classification: "diagnostics_storage_unavailable",
        safeMessage: "Diagnostics storage is unavailable",
      }),
    ).not.toThrow();

    await expect(authority.queryRuntimeEvents({ limit: 10 })).rejects.toBeInstanceOf(
      DiagnosticsUnavailableError,
    );
    expect(requestRecords).toEqual([]);
    expect(runtimeRecords).toEqual([]);
    requestSubscription.unsubscribe();
    runtimeSubscription.unsubscribe();
  });
});
