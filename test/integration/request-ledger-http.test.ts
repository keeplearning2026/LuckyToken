import type { FetchFunction, Model, Models } from "@earendil-works/pi-ai";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  connectControlPlane,
  createNodePipeTransport,
  nodePipeFallbackAccess,
  startControlPlane,
  type ControlPlaneClient,
  type ControlPlaneEndpoint,
  type RunningControlPlane,
} from "@luckytoken/application-control-plane/control-plane";
import type { PublicModelSource } from "../../src/public-model-seam.js";
import { HttpRequestAbortedError } from "../../src/http.js";
import type { InvocationDiagnosticsFactory } from "../../src/invocation-diagnostics/index.js";
import {
  createRequestLedgerStoreFactory,
  parseRequestLedgerConfiguration,
  type RequestLedgerRecord,
  type RequestLedgerStore,
} from "../../src/request-ledger/index.js";
import {
  createRuntimeDiagnosticsStoreFactory,
  parseRuntimeDiagnosticsConfiguration,
  type RuntimeDiagnosticRecord,
} from "../../src/runtime-diagnostics/index.js";
import { startLuckyTokenHttpServer } from "../../src/server.js";
import { createCommandCodeTestRuntime } from "../support/commandcode-serving.js";
import { createOpenAIResponsesServingTestComposition } from "../support/openai-responses-serving.js";
import {
  createAnthropicMessagesHandler,
} from "../../src/protocols/anthropic/handler.js";
import { handleHttpRequest } from "../../src/http.js";

/**
 * Ticket 18 public seam: the real Data Plane HTTP response, the permanent
 * Request Ledger store, and the additive Control Plane ledger query/event
 * surface are observed together. No observer internals or storage tables are
 * asserted.
 */

const fallbackSession = "00000000-0000-4000-8000-000000000020";
const primarySession = "00000000-0000-4000-8000-000000000021";

function commandCodeSuccess(text = "ok"): Response {
  return new Response(
    [
      JSON.stringify({ type: "text-start", id: "0" }),
      JSON.stringify({ type: "text-delta", id: "0", text }),
      JSON.stringify({ type: "text-end", id: "0" }),
      JSON.stringify({
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }),
      "",
    ].join("\n"),
    { status: 200 },
  );
}

interface LedgerHttpFixture {
  readonly runtime: ReturnType<typeof createCommandCodeTestRuntime>;
  readonly store: RequestLedgerStore;
  readonly host: RunningControlPlane;
  readonly client: ControlPlaneClient;
  readonly close: () => Promise<void>;
}

let ledgerRequestIdCounter = 0;

function deterministicRequestId(): string {
  ledgerRequestIdCounter += 1;
  const tail = String(ledgerRequestIdCounter).padStart(2, "0");
  return `10000000-0000-4000-8000-0000000000${tail}`;
}

function validRequest(
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Request {
  const init: RequestInit = {
    method: "POST",
    headers: {
      authorization: "Bearer fixture-client-key",
      "content-type": "application/json; charset=utf-8",
      "anthropic-version": "2023-06-01",
      ...headers,
    },
    body: JSON.stringify({
      model: "claude-fixture",
      max_tokens: 64,
      messages: [{ role: "user", content: "Hello" }],
    }),
  };
  if (signal !== undefined) init.signal = signal;
  return new Request("http://luckytoken.test/v1/messages", init);
}

describe("Request Ledger through the real Data Plane and Control Plane (Ticket 18)", () => {
  const fixtures: Array<{ close: () => Promise<void> }> = [];
  const stores: Array<{ close(): void }> = [];
  const hosts: RunningControlPlane[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((host) => host.close()));
    stores.splice(0).forEach((store) => store.close());
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  let controlPlaneCounter = 0;
  let requestCounter = 0;

  async function openLedgerStore(now?: () => number): Promise<{
    store: RequestLedgerStore;
    root: string;
  }> {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-ledger-http-"));
    roots.push(root);
    const configuration = parseRequestLedgerConfiguration(
      { directory: root },
      root,
    );
    const store = await createRequestLedgerStoreFactory({
      configuration,
      now: now ?? (() => 1_786_400_000_000),
      scrub: (value) => value,
      createRequestId: deterministicRequestId,
    }).open();
    stores.push(store);
    return { store, root };
  }

  async function createLedgerHttpFixture(
    options: {
      fetch?: FetchFunction;
      now?: () => number;
      store?: RequestLedgerStore;
      publicModels?: PublicModelSource;
      sessionId?: () => string;
      maxRequestBytes?: number;
      invocationDiagnostics?: InvocationDiagnosticsFactory;
    } = {},
  ): Promise<LedgerHttpFixture> {
    const { store } =
      options.store === undefined
        ? await openLedgerStore(options.now)
        : { store: options.store };
    const runtime = createCommandCodeTestRuntime({
      clientApiKey: "fixture-client-key",
      commandCodeApiKey: "fixture-commandcode-key",
      commandCodeBaseUrl: "https://fixture.commandcode.test",
      fetch: options.fetch ?? (async () => commandCodeSuccess("fixture answer")),
      modelId: "claude-fixture",
      createMessageId: () => "msg_fixture",
      createSessionId: options.sessionId ?? (() => fallbackSession),
      now: options.now ?? (() => 1_786_400_000_000),
      ...(options.maxRequestBytes === undefined
        ? {}
        : { maxRequestBytes: options.maxRequestBytes }),
      requestLedger: store,
      ...(options.publicModels === undefined
        ? {}
        : { publicModels: options.publicModels }),
      ...(options.invocationDiagnostics === undefined
        ? {}
        : { invocationDiagnostics: options.invocationDiagnostics }),
    });
    const transport = createNodePipeTransport();
    const host = await startControlPlane({
      endpoint: endpoint(++controlPlaneCounter),
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
      requestLedger: store,
    });
    hosts.push(host);
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `cp-request-${++requestCounter}`,
      pipeConnector: transport,
    });
    await client.hello(1);
    return {
      runtime,
      store,
      host,
      client,
      close: async () => {
        await client.close();
      },
    };
  }

  it("observes one successful request through the response header, Control Plane query, and typed events", async () => {
    const now = advancingClock();
    const { runtime, client } = await createLedgerHttpFixture({ now });
    const events: unknown[] = [];
    await client.subscribeRequestLedger((event) => events.push(event.record));

    const response = await runtime.handle(validRequest());
    expect(response.status).toBe(200);

    // Every Data Plane response carries the ledger request ID.
    const headerRequestId = response.headers.get("x-luckytoken-request-id");
    expect(headerRequestId).toBe("10000000-0000-4000-8000-000000000001");

    await expect.poll(() => events).toHaveLength(8);
    const typedEvents = events as RequestLedgerRecord[];
    expect(typedEvents.map((record) => record.phase)).toEqual([
      "accepted",
      "accepted",
      "accepted",
      "execution",
      // Ticket 20: the terminal-usage snapshot persists as its own
      // transition at the Pi terminal, before the terminal outcome.
      "execution",
      "execution",
      "rendering",
      "terminal-preparation",
    ]);
    expect(
      typedEvents.every((record) => record.requestId === headerRequestId),
    ).toBe(true);
    expect(new Set(typedEvents.map((record) => record.outcome))).toEqual(
      new Set(["running", "success"]),
    );

    const query = await client.getRequestLedger(undefined);
    expect(query.records).toHaveLength(1);
    const record = query.records[0]!;
    expect(query.hasMore).toBe(false);
    expect(record).toMatchObject({
      requestId: headerRequestId,
      protocolId: "anthropic-messages",
      phase: "terminal-preparation",
      outcome: "success",
      externalAlias: "claude-fixture",
      providerId: "commandcode-private",
      realModelId: "claude-fixture",
    });
    // acceptedAt is handler acceptance; executionStartedAt is Pi invocation
    // start; terminalAt is the Pi terminal outcome; completedAt is terminal
    // response preparation — all strictly ordered on the deterministic clock.
    expect(record.acceptedAt).toBeLessThan(record.executionStartedAt!);
    expect(record.executionStartedAt!).toBeLessThan(record.terminalAt!);
    expect(record.terminalAt!).toBeLessThan(record.completedAt!);
    expect(record.clientSessionId).toBeUndefined();
    expect(record.effectiveSessionId).toBe(fallbackSession);

    // The committed-event record and the queried record are the same row.
    const terminalEvent = typedEvents.at(-1)!;
    expect(terminalEvent.id).toBe(record.id);
    expect(JSON.stringify(events)).not.toContain("fixture-commandcode-key");
    expect(JSON.stringify(events)).not.toContain("Hello");
  });

  it("records distinct client session and effective session identities without project context", async () => {
    const { runtime, store } = await createLedgerHttpFixture();
    const withClientId = await runtime.handle(
      validRequest({ "x-session-id": primarySession }),
    );
    expect(withClientId.status).toBe(200);
    const withoutClientId = await runtime.handle(validRequest());
    expect(withoutClientId.status).toBe(200);

    const query = store.query(undefined);
    expect(query.records).toHaveLength(2);
    // Newest-first: records[0] is the second (headerless) request.
    const [second, first] = query.records;
    // The client-supplied id is retained as the effective identity, and the
    // ledger stores each session identity under its own labeled field.
    expect(second).toMatchObject({
      effectiveSessionId: fallbackSession,
    });
    expect(second!.clientSessionId).toBeUndefined();
    expect(first).toMatchObject({
      clientSessionId: primarySession,
      effectiveSessionId: primarySession,
    });
    expect(JSON.stringify(query.records)).not.toContain("fixture-commandcode-key");
  });

  it("does not classify arbitrary Authorization headers as client-auth failures", async () => {
    const { runtime, store } = await createLedgerHttpFixture();
    const response = await runtime.handle(validRequest({ authorization: "Bearer ignored-token" }));
    expect(response.status).toBe(200);

    const query = store.query(undefined);
    expect(query.records).toHaveLength(1);
    expect(query.records[0]).toMatchObject({
      protocolId: "anthropic-messages",
      outcome: "success",
      clientHttpStatus: 200,
    });
    expect(query.records[0]?.outcome).not.toBe("rejected-auth");
  });

  it("classifies unknown and unavailable aliases into their terminal outcomes", async () => {
    const unknownSource: PublicModelSource = {
      requestSnapshot: async () =>
        snapshotResolving({
          "known-alias": {
            providerId: "commandcode-private",
            modelId: "claude-fixture",
          },
        }),
    };
    const { runtime: unknownRuntime, store: unknownStore } =
      await createLedgerHttpFixture({ publicModels: unknownSource });
    const unknown = await unknownRuntime.handle(
      requestBody({
        model: "missing-alias",
        max_tokens: 8,
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("x-luckytoken-request-id")).toBeTruthy();
    const unknownRows = unknownStore.query(undefined);
    expect(unknownRows.records).toHaveLength(1);
    expect(unknownRows.records[0]).toMatchObject({
      outcome: "unknown-alias",
      phase: "terminal-preparation",
      clientHttpStatus: 404,
      externalAlias: "missing-alias",
    });
    expect(unknownRows.records[0]!.providerId).toBeUndefined();
    expect(unknownRows.records[0]!.realModelId).toBeUndefined();

    const unavailableSource: PublicModelSource = {
      requestSnapshot: async () =>
        snapshotResolving({
          "known-alias": {
            providerId: "commandcode-private",
            modelId: "not-in-served-catalog",
          },
        }),
    };
    const { runtime, store } = await createLedgerHttpFixture({
      publicModels: unavailableSource,
    });
    const unavailable = await runtime.handle(
      requestBody({ model: "known-alias", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
    );
    expect(unavailable.status).toBe(502);
    expect(unavailable.headers.get("x-luckytoken-request-id")).toBeTruthy();
    const rows = store.query(undefined);
    expect(rows.records).toHaveLength(1);
    expect(rows.records[0]).toMatchObject({
      outcome: "unavailable-alias",
      phase: "terminal-preparation",
      clientHttpStatus: 502,
      externalAlias: "known-alias",
    });
    // The canonical target is never leaked into client-visible facts: the
    // ledger records only the external alias for this early failure.
    expect(rows.records[0]!.providerId).toBeUndefined();
    expect(rows.records[0]!.realModelId).toBeUndefined();
  });

  it("records an aborted request as a single terminal aborted row", async () => {
    const neverFetch: FetchFunction = async () =>
      await new Promise<Response>(() => {});
    const { runtime, store } = await createLedgerHttpFixture({
      fetch: neverFetch,
    });
    const disconnect = new AbortController();
    const handling = runtime.handle(validRequest(undefined, disconnect.signal));
    await new Promise((resolve) => setTimeout(resolve, 10));
    disconnect.abort(new Error("client disconnected"));
    await expect(handling).rejects.toBeInstanceOf(HttpRequestAbortedError);

    const query = store.query(undefined);
    expect(query.records).toHaveLength(1);
    const record = query.records[0]!;
    expect(record).toMatchObject({
      outcome: "aborted",
      phase: "execution",
    });
    expect(record.clientHttpStatus).toBeUndefined();
    expect(record.terminalAt).toBeDefined();
    // No response was prepared, so completedAt truthfully stays absent.
    expect(record.completedAt).toBeUndefined();
  });

  it("keeps the Anthropic error body request_id on failures and omits it from the strict success body", async () => {
    const { runtime, store } = await createLedgerHttpFixture();
    const malformed = await runtime.handle(
      new Request("http://luckytoken.test/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer fixture-client-key",
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: "{not json",
      }),
    );
    expect(malformed.status).toBe(400);
    const headerId = malformed.headers.get("x-luckytoken-request-id");
    expect(headerId).toBeTruthy();
    const errorBody = (await malformed.json()) as {
      request_id: string;
      error: { type: string };
    };
    expect(errorBody.request_id).toBe(headerId);
    expect(errorBody.error.type).toBe("invalid_request_error");

    const success = await runtime.handle(validRequest());
    expect(success.status).toBe(200);
    expect(success.headers.get("x-luckytoken-request-id")).toBeTruthy();
    const successBody = (await success.json()) as {
      request_id?: string;
      content: unknown;
    };
    // The success message schema is exact-field-enforced: header only.
    expect(successBody.request_id).toBeUndefined();
    expect(successBody.content).toBeDefined();

    const query = store.query(undefined);
    expect(query.records).toHaveLength(2);
    expect(query.records.map((record) => record.outcome)).toEqual([
      "success",
      "failed",
    ]);
    expect(query.records[1]).toMatchObject({
      clientHttpStatus: 400,
      phase: "terminal-preparation",
    });
  });

  it("keeps the strict OpenAI Responses error envelope body and uses the header for the request id", async () => {
    const { store } = await openLedgerStore();
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-ledger-resp-"));
    roots.push(directory);
    const composition = await createOpenAIResponsesServingTestComposition({
      clientApiKey: "client-token",
      commandCodeApiKey: "provider-secret",
      commandCodeBaseUrl: "https://commandcode.test",
      modelId: "deepseek/deepseek-v4-flash",
      fetch: async () => commandCodeSuccess("answered"),
      directory,
      requestLedger: store,
    });
    fixtures.push({ close: composition.close });
    const response = await composition.runtime.handle(
      new Request("http://luckytoken.test/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer client-token",
          "content-type": "application/json",
        },
        body: "{not json",
      }),
    );
    expect(response.status).toBe(400);
    const headerId = response.headers.get("x-luckytoken-request-id");
    expect(headerId).toBeTruthy();
    const body = (await response.json()) as {
      error: Record<string, unknown>;
      request_id?: string;
    };
    // The Responses error envelope is strict {error:{message,type,code,
    // param}}: the request id lives in the header only.
    expect(body.request_id).toBeUndefined();
    expect(Object.keys(body.error).sort()).toEqual(["code", "message", "param", "type"]);

    const rows = store.query(undefined);
    expect(rows.records).toHaveLength(1);
    expect(rows.records[0]).toMatchObject({
      protocolId: "openai-responses",
      outcome: "failed",
      clientHttpStatus: 400,
      phase: "terminal-preparation",
    });
    // A malformed body fails before model resolution: the alias snapshot
    // truthfully stays absent.
    expect(rows.records[0]!.externalAlias).toBeUndefined();
    expect(rows.records[0]!.executionStartedAt).toBeUndefined();
  });

  it("records passthrough rows without a rendering phase and with the upstream status", async () => {
    const { store } = await openLedgerStore();
    const upstreamRequests: Request[] = [];
    const passthroughFetch: FetchFunction = async (input, init) => {
      upstreamRequests.push(new Request(input, init));
      return new Response(
        '{"type":"message","content":[{"type":"text","text":"passthrough ok"}]}',
        {
          status: 200,
          headers: { "content-type": "application/json", "request-id": "upstream-42" },
        },
      );
    };
    const model: Model<string> = {
      id: "claude-sonnet",
      name: "claude-sonnet",
      api: "anthropic-messages",
      provider: "my-anthropic",
      baseUrl: "https://gateway.example.com",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 64000,
    };
    const models = {
      getModels: () => [model],
      getAuth: async () => ({ auth: { apiKey: "sk-gateway" } }),
    } as unknown as Models;
    const handler = createAnthropicMessagesHandler({
      models,
      maxRequestBytes: 1_000_000,
      passthroughFetch,
      requestLedger: store,
      now: () => 1_786_400_000_000,
    });
    const response = await handleHttpRequest(
      {
        clientProtocols: [handler],
        requestTimeoutMs: undefined,
        shutdownSignal: undefined,
      },
      new Request("http://luckytoken.test/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer fixture-client-key",
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "my-anthropic/claude-sonnet",
          max_tokens: 32,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    expect(response.status).toBe(200);
    // The ledger request id is additive and namespaced; the upstream
    // request-id header stays untouched.
    expect(response.headers.get("x-luckytoken-request-id")).toBeTruthy();
    expect(response.headers.get("request-id")).toBe("upstream-42");

    const rows = store.query(undefined);
    expect(rows.records).toHaveLength(1);
    const record = rows.records[0]!;
    expect(record).toMatchObject({
      outcome: "success",
      phase: "terminal-preparation",
      clientHttpStatus: 200,
      protocolId: "anthropic-messages",
      externalAlias: "my-anthropic/claude-sonnet",
      providerId: "my-anthropic",
      realModelId: "claude-sonnet",
    });
    // Passthrough rows honestly skip the rendering phase.
    expect(record.executionStartedAt).toBeDefined();
    expect(upstreamRequests).toHaveLength(1);
  });

  it("keeps the model response valid when the ledger store faults and emits a sanitized fallback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-ledger-fault-"));
    roots.push(directory);
    const diagnosticsConfiguration = parseRuntimeDiagnosticsConfiguration(
      { directory: join(directory, "diagnostics") },
      directory,
    );
    const diagnosticsStore = await createRuntimeDiagnosticsStoreFactory({
      configuration: diagnosticsConfiguration,
      now: () => 1_786_400_000_000,
      scrub: (value) => value,
    }).open();
    stores.push(diagnosticsStore);
    const ledgerDirectory = join(directory, "ledger");
    const ledgerConfiguration = parseRequestLedgerConfiguration(
      { directory: ledgerDirectory },
      directory,
    );
    // Poison every requests-table write AFTER the store opens (schema
    // validation, WAL pragmas and recovery run on open and must succeed).
    // The store prepares statements once at open, so the poison decision
    // happens at run() call time, not at prepare time.
    let poisonWrites = false;
    const databaseFactory = {
      open: (path: string) => {
        const inner = new DatabaseSync(path);
        return new Proxy(inner, {
          get(target, property) {
            if (property === "prepare") {
              return (sql: string) => {
                const statement = target.prepare(sql);
                return new Proxy(statement, {
                  get(statementTarget, statementProperty) {
                    if (
                      statementProperty === "run" &&
                      /^\s*(INSERT|UPDATE)\b/i.test(sql)
                    ) {
                      return (...args: unknown[]) => {
                        if (poisonWrites) {
                          throw new Error(
                            "ledger write denied canary-fault-secret-998877",
                          );
                        }
                        return statementTarget.run(
                          ...(args as Parameters<typeof statementTarget.run>),
                        );
                      };
                    }
                    const value = Reflect.get(
                      statementTarget,
                      statementProperty,
                      statementTarget,
                    );
                    return typeof value === "function"
                      ? value.bind(statementTarget)
                      : value;
                  },
                });
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    };
    const ledgerStore = await createRequestLedgerStoreFactory({
      configuration: ledgerConfiguration,
      now: () => 1_786_400_000_000,
      scrub: (value) => value,
      createRequestId: deterministicRequestId,
      databaseFactory,
      onPersistenceFailure: (failure) => {
        diagnosticsStore.append({
          level: "critical",
          text: "Request Ledger persistence failure",
          requestId: failure.requestId,
          details: { messageHash: failure.messageHash },
        });
      },
    }).open();
    stores.push(ledgerStore);
    poisonWrites = true;

    const { runtime } = await createLedgerHttpFixture({ store: ledgerStore });
    const response = await runtime.handle(validRequest());
    const headerRequestId = response.headers.get("x-luckytoken-request-id");
    expect(headerRequestId).toBeTruthy();
    // The ledger fault must not replace or change an otherwise valid model
    // response: same status, same body bytes, header still present.
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("fixture answer");

    const diagnostics = diagnosticsStore.query(undefined);
    expect(diagnostics.records).toHaveLength(1);
    const critical = diagnostics.records[0]! as RuntimeDiagnosticRecord;
    expect(critical.level).toBe("critical");
    expect(critical.text).toBe("Request Ledger persistence failure");
    const serialized = JSON.stringify(critical);
    // The fallback carries no fault text and no credential canary.
    expect(serialized).not.toContain("canary-fault-secret-998877");
    expect(serialized).not.toContain("ledger write denied");
    expect(serialized).toContain("messageHash");
    expect(critical.requestId).toBe(headerRequestId);
  });

  it("correlates a transport-synthesized timeout 500 with the exact ledger request id", async () => {
    const now = advancingClock();
    const { store } = await openLedgerStore(now);
    const runtime = createCommandCodeTestRuntime({
      clientApiKey: "fixture-client-key",
      commandCodeApiKey: "fixture-commandcode-key",
      commandCodeBaseUrl: "https://fixture.commandcode.test",
      fetch: async () => await new Promise<Response>(() => {}),
      modelId: "claude-fixture",
      createMessageId: () => "msg_fixture",
      createSessionId: () => fallbackSession,
      now,
      requestTimeoutMs: 40,
      requestLedger: store,
    });
    const server = await startLuckyTokenHttpServer({
      runtime,
      host: "127.0.0.1",
      port: 0,
    });
    try {
      const response = await fetch(`${server.origin}/v1/messages`, {
        method: "POST",
        headers: {
          authorization: "Bearer fixture-client-key",
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-fixture",
          max_tokens: 8,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      // The live client still receives a truthful 500 — with the exact
      // accepted request id of the persisted ledger row.
      expect(response.status).toBe(500);
      const headerRequestId = response.headers.get("x-luckytoken-request-id");
      expect(headerRequestId).toBeTruthy();
      await expect
        .poll(() => store.query(undefined).records[0]?.outcome)
        .toBe("aborted");
      const record = store.query(undefined).records[0]!;
      expect(record.requestId).toBe(headerRequestId);
      expect(record.outcome).toBe("aborted");
      // Cancellation produced no response bytes of the handler's own.
      expect(record.completedAt).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("correlates an unexpected handler failure 500 with the exact ledger request id", async () => {
    const { store } = await openLedgerStore();
    // A deterministic internal-seam fault: the diagnostics finalization
    // throws after the handler produced a valid response.
    const diagnostics: InvocationDiagnosticsFactory = {
      begin: () => ({
        requestId: "diag-fail-1",
        notice: () => undefined,
        attempt: () => undefined,
        checkpoint: () => undefined,
        succeed: async () => {
          throw new Error("diagnostics seam exploded canary-seam-fault-7711");
        },
        fail: async () => {
          throw new Error("diagnostics seam exploded");
        },
      }),
    };
    const { runtime } = await createLedgerHttpFixture({ store, invocationDiagnostics: diagnostics });
    const response = await runtime.handle(validRequest());
    expect(response.status).toBe(500);
    const headerRequestId = response.headers.get("x-luckytoken-request-id");
    expect(headerRequestId).toBeTruthy();
    await expect
      .poll(() => store.query(undefined).records[0]?.outcome)
      .toBe("failed");
    const record = store.query(undefined).records[0]!;
    expect(record.requestId).toBe(headerRequestId);
    expect(record).toMatchObject({
      outcome: "failed",
      clientHttpStatus: 500,
      phase: "rendering",
    });
    expect(record.completedAt).toBeUndefined();
    // The safe failure summary was recorded (hash only).
    expect(record.facts?.failure).toBeDefined();
    expect(JSON.stringify(record.facts)).not.toContain("canary-seam-fault-7711");
  });

  it("keeps the response and request id when the ledger's injected seams all throw", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-ledger-seams-"));
    roots.push(directory);
    const configuration = parseRequestLedgerConfiguration(
      { directory },
      directory,
    );
    const store = await createRequestLedgerStoreFactory({
      configuration,
      createRequestId: () => {
        throw new Error("idgen exploded canary-idgen-9988");
      },
      now: () => {
        throw new Error("clock exploded canary-clock-7766");
      },
      scrub: (value) => value,
      onPersistenceFailure: () => {
        throw new Error("callback exploded canary-callback-5544");
      },
    }).open();
    stores.push(store);
    const { runtime } = await createLedgerHttpFixture({ store });
    const response = await runtime.handle(validRequest());
    // The request path is untouched: valid model response, header present,
    // and the header is exactly the persisted accepted row's request id.
    expect(response.status).toBe(200);
    const headerRequestId = response.headers.get("x-luckytoken-request-id");
    expect(headerRequestId).toBeTruthy();
    await expect(response.text()).resolves.toContain("fixture answer");
    const records = store.query(undefined).records;
    expect(records).toHaveLength(1);
    expect(records[0]!.requestId).toBe(headerRequestId);
    expect(JSON.stringify(records)).not.toContain("canary-idgen-9988");
    expect(JSON.stringify(records)).not.toContain("canary-clock-7766");
  });

  it("records truthful terminals for early validation, upstream failure, and passthrough failure", async () => {
    // 415: wrong content type — header plus a failed 415 terminal.
    const { runtime, store } = await createLedgerHttpFixture();
    const unsupported = await runtime.handle(
      new Request("http://luckytoken.test/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer fixture-client-key",
          "content-type": "text/plain",
          "anthropic-version": "2023-06-01",
        },
        body: "{}",
      }),
    );
    expect(unsupported.status).toBe(415);
    expect(unsupported.headers.get("x-luckytoken-request-id")).toBeTruthy();
    await expect
      .poll(() => store.query(undefined).records[0]?.outcome)
      .toBe("failed");
    expect(store.query(undefined).records[0]).toMatchObject({
      clientHttpStatus: 415,
      phase: "terminal-preparation",
    });

    // 413: request body over the configured ceiling.
    const small = await createLedgerHttpFixture({ maxRequestBytes: 32 });
    const tooLarge = await small.runtime.handle(validRequest());
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.headers.get("x-luckytoken-request-id")).toBeTruthy();
    await expect
      .poll(() => small.store.query(undefined).records[0]?.outcome)
      .toBe("failed");
    expect(small.store.query(undefined).records[0]).toMatchObject({
      clientHttpStatus: 413,
      phase: "terminal-preparation",
    });
    await small.close();

    // Upstream 502 through the conversion path.
    const failing = await createLedgerHttpFixture({
      fetch: async () =>
        new Response("upstream boom", {
          status: 502,
          headers: { "content-type": "application/json" },
        }),
    });
    const upstreamFailure = await failing.runtime.handle(validRequest());
    expect(upstreamFailure.status).toBe(502);
    const upstreamHeader = upstreamFailure.headers.get("x-luckytoken-request-id");
    expect(upstreamHeader).toBeTruthy();
    const upstreamBody = (await upstreamFailure.json()) as {
      request_id: string;
    };
    expect(upstreamBody.request_id).toBe(upstreamHeader);
    await expect
      .poll(() => failing.store.query(undefined).records[0]?.outcome)
      .toBe("failed");
    expect(failing.store.query(undefined).records[0]).toMatchObject({
      clientHttpStatus: 502,
      phase: "terminal-preparation",
    });
    await failing.close();

    // Passthrough failure: the upstream 429 is passed through verbatim with
    // our additive request id; the row records the upstream status.
    const upstreamRequests: Request[] = [];
    const passthroughFetch: FetchFunction = async (input, init) => {
      upstreamRequests.push(new Request(input, init));
      return new Response("rate limited", {
        status: 429,
        headers: {
          "content-type": "application/json",
          "request-id": "upstream-rate-99",
        },
      });
    };
    const { store: passthroughStore } = await openLedgerStore();
    const passthroughModel: Model<string> = {
      id: "claude-sonnet",
      name: "claude-sonnet",
      api: "anthropic-messages",
      provider: "my-anthropic",
      baseUrl: "https://gateway.example.com",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 64000,
    };
    const passthroughHandler = createAnthropicMessagesHandler({
      models: {
        getModels: () => [passthroughModel],
        getAuth: async () => ({ auth: { apiKey: "sk-gateway" } }),
      } as unknown as Models,
      maxRequestBytes: 1_000_000,
      passthroughFetch,
      requestLedger: passthroughStore,
      now: () => 1_786_400_000_000,
    });
    const passthroughFailure = await handleHttpRequest(
      {
        clientProtocols: [passthroughHandler],
        requestTimeoutMs: undefined,
        shutdownSignal: undefined,
      },
      new Request("http://luckytoken.test/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer fixture-client-key",
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "my-anthropic/claude-sonnet",
          max_tokens: 32,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    expect(passthroughFailure.status).toBe(429);
    expect(
      passthroughFailure.headers.get("x-luckytoken-request-id"),
    ).toBeTruthy();
    expect(passthroughFailure.headers.get("request-id")).toBe("upstream-rate-99");
    await expect
      .poll(() => passthroughStore.query(undefined).records[0]?.outcome)
      .toBe("failed");
    expect(passthroughStore.query(undefined).records[0]).toMatchObject({
      clientHttpStatus: 429,
      phase: "terminal-preparation",
      protocolId: "anthropic-messages",
    });
    expect(upstreamRequests).toHaveLength(1);
  });
});

function requestBody(
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Request {
  return new Request("http://luckytoken.test/v1/messages", {
    method: "POST",
    headers: {
      authorization: "Bearer fixture-client-key",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function snapshotResolving(
  mappings: Readonly<Record<string, { providerId: string; modelId: string }>>,
) {
  return {
    version: 1,
    endpoint: { host: "127.0.0.1", port: 3000 },
    providers: [],
    resolve: (alias: string) => mappings[alias],
    publishedModels: () => [],
  };
}

function endpoint(index: number): ControlPlaneEndpoint {
  return {
    address: `\\\\.\\pipe\\ticket-18-cp-${process.pid}-${index}`,
    capability: `ticket-18-capability-${String(index).padStart(26, "0")}`,
  };
}

function advancingClock(): () => number {
  let elapsed = 0;
  return () => 1_786_400_000_000 + (elapsed += 1);
}
