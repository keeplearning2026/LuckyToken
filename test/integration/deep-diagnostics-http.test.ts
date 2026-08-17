import type { FetchFunction } from "@earendil-works/pi-ai";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
import type { CaptureQueryResult } from "@luckytoken/application-control-plane/control-plane";
import { HttpRequestAbortedError } from "../../src/http.js";
import {
  createDeepCaptureAuthority,
  createDeepCaptureStoreFactory,
  parseDeepDiagnosticsConfiguration,
  type DeepCaptureAuthority,
  type DeepCaptureStore,
} from "../../src/deep-diagnostics/index.js";
import {
  createRuntimeDiagnosticsStoreFactory,
  parseRuntimeDiagnosticsConfiguration,
  type RuntimeDiagnosticRecord,
} from "../../src/runtime-diagnostics/index.js";
import {
  createSettingsRegistry,
  type SettingsRegistry,
  type SettingsStore,
} from "../../src/settings/catalog.js";
import { createCommandCodeTestRuntime } from "../support/commandcode-serving.js";
import { createOpenAIResponsesServingTestComposition } from "../support/openai-responses-serving.js";

/**
 * Ticket 22 RED public seam: the real Data Plane HTTP response, the one
 * global capture authority, the bounded capture store, and the additive
 * Control Plane capture query/event surface are observed together.
 *
 * Every credential literal below is an independent canary that must never
 * appear in any persisted byte (database or WAL), in any Control Plane
 * frame, or in any capture event — while adjacent safe text survives.
 */

const DEEP_CAPTURE_SETTING = "diagnostics.deepCapture.enabled";

const CANARIES = [
  // Authorization channel: the live client token (must never survive).
  "fixture-client-key",
  // Independent credential header literal (rejected-auth request).
  "canary-x-api-key-4c8f1a62",
  // The rejected-auth bearer value.
  "wrong-token",
  // Independent credential cookie.
  "canary-cookie-value-6d1b7e93",
  // Query-parameter position inside the request body.
  "canary-query-param-5b2d8e71",
  // Credential-shaped text inside the request body.
  "canary-body-token-9f8e7d6c",
] as const;

function allPersistedBytes(root: string): Promise<string> {
  return readdir(root, { recursive: true }).then((entries) =>
    Promise.all(
      entries
        .filter((entry) => typeof entry === "string")
        .map((entry) => join(root, entry))
        .map(async (path) => {
          try {
            return await readFile(path, "utf8");
          } catch {
            return "";
          }
        }),
    ).then((chunks) => chunks.join("\n")),
  );
}

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

function validRequest(
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Request {
  const init: RequestInit = {
    method: "POST",
    headers: {
      // The auth boundary requires both credentials to agree when both are
      // present, so the x-api-key channel carries the same live token here;
      // its independent canary literal lives in the rejected-auth request.
      authorization: "Bearer fixture-client-key",
      "x-api-key": "fixture-client-key",
      "content-type": "application/json; charset=utf-8",
      "anthropic-version": "2023-06-01",
      cookie: "canary-cookie-value-6d1b7e93=1",
      ...headers,
    },
    body: JSON.stringify({
      model: "claude-fixture",
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: "Hello canary-safe-text-7d8e9f10",
        },
      ],
      // Credential-shaped text in a credential-bearing key position: the
      // key name names the secret, so the value must go wholesale.
      body_credential: "canary-body-token-9f8e7d6c",
      // Query-parameter position: the key name survives, the credential
      // value never does.
      query: "access_token=canary-query-param-5b2d8e71",
      // Adjacent safe text must survive redaction.
      note: "canary-safe-text-7d8e9f10",
    }),
  };
  if (signal !== undefined) init.signal = signal;
  return new Request("http://luckytoken.test/v1/messages", init);
}

function memoryStore(): SettingsStore {
  const values = new Map<string, unknown>();
  return {
    load: async () => Object.fromEntries(values),
    save: async (settings) => {
      values.clear();
      for (const [key, value] of Object.entries(settings)) {
        values.set(key, value);
      }
    },
  };
}

interface DeepCaptureHttpFixture {
  readonly runtime: ReturnType<typeof createCommandCodeTestRuntime>;
  readonly store: DeepCaptureStore;
  readonly registry: SettingsRegistry;
  readonly host: RunningControlPlane;
  readonly client: ControlPlaneClient;
  readonly root: string;
  readonly close: () => Promise<void>;
}

describe("Deep Diagnostics capture through the real Data Plane and Control Plane (Ticket 22)", () => {
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

  async function openCaptureStore(options: {
    now?: () => number;
    scrub?: (value: string) => string;
    maxCaptures?: number;
    retentionAgeMs?: number;
    maxCaptureBytes?: number;
  } = {}): Promise<{ store: DeepCaptureStore; root: string }> {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-capture-http-"));
    roots.push(root);
    const configuration = parseDeepDiagnosticsConfiguration(
      {
        directory: root,
        ...(options.maxCaptures === undefined
          ? {}
          : { maxCaptures: options.maxCaptures }),
        ...(options.retentionAgeMs === undefined
          ? {}
          : { retentionAgeMs: options.retentionAgeMs }),
        ...(options.maxCaptureBytes === undefined
          ? {}
          : { maxCaptureBytes: options.maxCaptureBytes }),
      },
      root,
    );
    const store = await createDeepCaptureStoreFactory({
      configuration,
      now: options.now ?? (() => 1_786_400_000_000),
      scrub: options.scrub ?? ((value) => value),
    }).open();
    stores.push(store);
    return { store, root };
  }

  async function createCaptureHttpFixture(options: {
    fetch?: FetchFunction;
    now?: () => number;
    store?: DeepCaptureStore;
    scrub?: (value: string) => string;
    maxCaptures?: number;
    retentionAgeMs?: number;
    maxCaptureBytes?: number;
  } = {}): Promise<DeepCaptureHttpFixture> {
    const { store, root } =
      options.store === undefined
        ? await openCaptureStore(options)
        : { store: options.store, root: "" };
    const now = options.now ?? (() => 1_786_400_000_000);
    const registry = createSettingsRegistry(memoryStore(), {
      initial: { [DEEP_CAPTURE_SETTING]: false },
    });
    await registry.load();
    const capture = createDeepCaptureAuthority({
      store,
      now,
      readEnabled: () =>
        registry.query([DEEP_CAPTURE_SETTING])[DEEP_CAPTURE_SETTING]?.value ===
        true,
    });
    const runtime = createCommandCodeTestRuntime({
      clientApiKey: "fixture-client-key",
      commandCodeApiKey: "fixture-commandcode-key",
      commandCodeBaseUrl: "https://fixture.commandcode.test",
      fetch:
        options.fetch ?? (async () => commandCodeSuccess("fixture answer")),
      modelId: "claude-fixture",
      createMessageId: () => "msg_fixture",
      createSessionId: () => "00000000-0000-4000-8000-000000000020",
      now,
      deepCapture: capture,
    });
    const transport = createNodePipeTransport();
    const host = await startControlPlane({
      endpoint: endpoint(++controlPlaneCounter),
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
      capture: store,
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
      registry,
      host,
      client,
      root,
      close: async () => {
        await client.close();
      },
    };
  }

  it("captures only requests accepted while enabled and keeps the acceptance-time decision for in-flight requests, linked to the Ticket 18 request id", async () => {
    const now = advancingClock();
    const { runtime, store, registry } = await createCaptureHttpFixture({
      now,
    });

    // 1. Accepted while disabled: no capture row, no tombstone.
    const before = await runtime.handle(validRequest());
    expect(before.status).toBe(200);
    const beforeRequestId = before.headers.get("x-luckytoken-request-id");
    expect(beforeRequestId).toBeTruthy();
    await expect
      .poll(() => store.query({ requestId: beforeRequestId! }))
      .toMatchObject({ state: "no-capture" });

    // 2. Enable; accept a request that stays in flight across the disable.
    const enableResult = await registry.set(
      DEEP_CAPTURE_SETTING,
      true,
      undefined,
    );
    expect(enableResult.outcome).toBe("applied");

    let release: (() => void) | undefined;
    void new Promise<Response>((resolve) => {
      release = () => resolve(commandCodeSuccess("answered after disable"));
    });
    const inFlight = runtime.handle(validRequest());
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The request is accepted and executing while enabled; disable now.
    const disableResult = await registry.set(
      DEEP_CAPTURE_SETTING,
      false,
      undefined,
    );
    expect(disableResult.outcome).toBe("applied");
    const disabledAt = now();
    release!();
    const response = await inFlight;
    expect(response.status).toBe(200);
    const requestId = response.headers.get("x-luckytoken-request-id");
    expect(requestId).toBeTruthy();

    // The in-flight request keeps its acceptance-time decision: its capture
    // completes even though the toggle flipped before finalization, and its
    // acceptedAt is the acceptance-time snapshot (strictly before the
    // disable) on the deterministic clock.
    await expect
      .poll(() => store.query({ requestId: requestId! }))
      .toMatchObject({ state: "captured" });
    const record = store.query({ requestId: requestId! }).record;
    expect(record).toBeDefined();
    expect(record!.acceptedAt).toBeLessThan(disabledAt);
    expect(record!.state).toBe("captured");
    // The capture is linked to the Ticket 18 request id: the same id the
    // response header carries.
    expect(record!.requestId).toBe(requestId);

    // 3. Accepted after disable: no capture row.
    const after = await runtime.handle(validRequest());
    expect(after.status).toBe(200);
    const afterRequestId = after.headers.get("x-luckytoken-request-id");
    expect(afterRequestId).toBeTruthy();
    await expect
      .poll(() => store.query({ requestId: afterRequestId! }))
      .toMatchObject({ state: "no-capture" });

    // The persisted capture carries the ordered timing of the acceptance
    // snapshot, the body-read, the response, and the finalize.
    const persisted = store.query({ requestId: requestId! }).record!;
    expect(persisted.timing!.map((entry) => entry.stage)).toEqual([
      "accepted",
      "request-body",
      "response",
      "finalize",
    ]);
    expect(persisted.timing![0]!.time).toBe(record!.acceptedAt);
  });

  it("queries one persisted capture through the Control Plane and proves every credential canary is absent while adjacent safe text remains", async () => {
    const { runtime, store, registry, client, root } =
      await createCaptureHttpFixture();
    const events: unknown[] = [];
    await client.subscribeCapture((event) => events.push(event.fact));
    await registry.set(DEEP_CAPTURE_SETTING, true, undefined);

    const response = await runtime.handle(validRequest());
    expect(response.status).toBe(200);
    const requestId = response.headers.get("x-luckytoken-request-id");
    expect(requestId).toBeTruthy();

    await expect
      .poll(() => store.query({ requestId: requestId! }).state)
      .toBe("captured");

    // The Control Plane serves the sanitized committed record by request id.
    const result: CaptureQueryResult = await client.getCapture({
      requestId: requestId!,
    });
    expect(result.state).toBe("captured");
    expect(result.record).toBeDefined();
    expect(result.record!.requestId).toBe(requestId);
    expect(result.record!.protocolId).toBe("anthropic-messages");

    // The request body survives structurally with its safe fields...
    const body = JSON.parse(result.record!.requestBody!) as Record<
      string,
      unknown
    >;
    expect(body.note).toBe("canary-safe-text-7d8e9f10");
    expect(JSON.stringify(body.messages)).toContain("canary-safe-text-7d8e9f10");
    // ...while the query-parameter credential is removed wholesale and the
    // credential-bearing key keeps its name but never its value.
    expect(body.query).toBe("[REDACTED]");
    expect(body.body_credential).toBe("[REDACTED]");
    // The response body survives as the bytes the client received.
    expect(result.record!.responseBody).toContain("fixture answer");
    // The credential headers keep their names but never their values.
    expect(result.record!.requestHeaders!["authorization"]).toBe("[REDACTED]");
    expect(result.record!.requestHeaders!["x-api-key"]).toBe("[REDACTED]");
    expect(result.record!.requestHeaders!["cookie"]).toBe("[REDACTED]");
    expect(result.record!.requestHeaders!["content-type"]).toBe(
      "application/json; charset=utf-8",
    );
    // The captured response is the exact response the client received: it
    // carries the additive request-id header as a safe correlation fact,
    // never treated as a client credential.
    expect(result.record!.responseHeaders!["x-luckytoken-request-id"]).toBe(
      requestId,
    );

    // The typed capture event is delivered to capture subscribers only and
    // never carries response bytes.
    await expect.poll(() => events).toHaveLength(1);
    const fact = events[0] as { requestId: string; state: string };
    expect(fact.requestId).toBe(requestId);
    expect(fact.state).toBe("captured");
    expect(JSON.stringify(events)).not.toContain("fixture answer");

    // Every canary is absent from the Control Plane frames and from every
    // persisted byte of the capture store (database + WAL + SHM); safe text
    // survives in both.
    const wire = JSON.stringify(result);
    const persistedBytes = await allPersistedBytes(root);
    for (const canary of CANARIES) {
      expect(wire).not.toContain(canary);
      expect(persistedBytes).not.toContain(canary);
    }
    expect(persistedBytes).toContain("canary-safe-text-7d8e9f10");
    expect(persistedBytes).toContain("fixture answer");
  });

  it("keeps the model response and request id valid when the capture store write fails, and reports a sanitized critical diagnostic", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-capture-fault-"));
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
    const captureConfiguration = parseDeepDiagnosticsConfiguration(
      { directory: join(directory, "capture") },
      directory,
    );
    // Poison every captures-table write AFTER the store opens (schema
    // validation, WAL pragmas and the open-time sweep must succeed).
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
                      /^\s*INSERT INTO captures\b/i.test(sql)
                    ) {
                      return (...args: unknown[]) => {
                        if (poisonWrites) {
                          throw new Error(
                            "capture write denied canary-fault-secret-112233",
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
    const captureStore = await createDeepCaptureStoreFactory({
      configuration: captureConfiguration,
      now: () => 1_786_400_000_000,
      scrub: (value) => value,
      databaseFactory,
    }).open();
    stores.push(captureStore);
    const registry = createSettingsRegistry(memoryStore(), {
      initial: { [DEEP_CAPTURE_SETTING]: true },
    });
    await registry.load();
    const recoveries: string[] = [];
    const capture = createDeepCaptureAuthority({
      store: captureStore,
      now: () => 1_786_400_000_000,
      readEnabled: () =>
        registry.query([DEEP_CAPTURE_SETTING])[DEEP_CAPTURE_SETTING]?.value ===
        true,
      onWriteFailure: (failure) => {
        diagnosticsStore.append({
          level: "critical",
          text: "Deep Diagnostics capture failure",
          requestId: failure.requestId,
          details: { code: failure.code },
        });
      },
      onWriteRecovery: (fact) => recoveries.push(fact.requestId),
    });
    poisonWrites = true;
    const runtime = createCommandCodeTestRuntime({
      clientApiKey: "fixture-client-key",
      commandCodeApiKey: "fixture-commandcode-key",
      commandCodeBaseUrl: "https://fixture.commandcode.test",
      fetch: async () => commandCodeSuccess("fixture answer"),
      modelId: "claude-fixture",
      createMessageId: () => "msg_fixture",
      createSessionId: () => "00000000-0000-4000-8000-000000000020",
      now: () => 1_786_400_000_000,
      deepCapture: capture,
    });
    const response = await runtime.handle(validRequest());
    expect(response.status).toBe(200);
    const headerRequestId = response.headers.get("x-luckytoken-request-id");
    expect(headerRequestId).toBeTruthy();
    // The capture write fault must not replace or change an otherwise valid
    // model response: same status, same body bytes, header still present.
    expect(await response.text()).toContain("fixture answer");

    // The sanitized critical diagnostic carries the correlation and never
    // the fault text or any credential canary.
    await expect
      .poll(() => diagnosticsStore.query(undefined).records)
      .toHaveLength(1);
    const critical = diagnosticsStore.query(undefined)
      .records[0]! as RuntimeDiagnosticRecord;
    expect(critical.level).toBe("critical");
    expect(critical.text).toBe("Deep Diagnostics capture failure");
    expect(critical.requestId).toBe(headerRequestId);
    const serialized = JSON.stringify(critical);
    expect(serialized).not.toContain("canary-fault-secret-112233");
    expect(serialized).not.toContain("capture write denied");
    expect(serialized).toContain("capture-write-failed");

    poisonWrites = false;
    const recoveredResponse = await runtime.handle(validRequest());
    expect(recoveredResponse.status).toBe(200);
    await recoveredResponse.text();
    await expect.poll(() => recoveries).toHaveLength(1);
  });

  it("records partial captures for a rejected-auth request and an aborted request, and reports them through the Control Plane query", async () => {
    const { runtime, store, registry, client } =
      await createCaptureHttpFixture();
    await registry.set(DEEP_CAPTURE_SETTING, true, undefined);

    // 401: accepted while enabled, no body read, error envelope response.
    // The independent x-api-key canary rides this request: both credentials
    // differ, so auth truthfully rejects.
    const rejected = await runtime.handle(
      new Request("http://luckytoken.test/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer wrong-token",
          "x-api-key": "canary-x-api-key-4c8f1a62",
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-fixture",
          max_tokens: 8,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    expect(rejected.status).toBe(401);
    const rejectedId = rejected.headers.get("x-luckytoken-request-id");
    await expect
      .poll(() => store.query({ requestId: rejectedId! }))
      .toMatchObject({ state: "partial" });
    const rejectedResult = await client.getCapture({
      requestId: rejectedId!,
    });
    expect(rejectedResult.state).toBe("partial");
    expect(rejectedResult.record!.requestBody).toBeUndefined();
    expect(rejectedResult.record!.clientHttpStatus).toBe(401);
    expect(
      JSON.stringify(rejectedResult.record!.requestHeaders),
    ).toContain("[REDACTED]");
    // The independent x-api-key canary never survives in the persisted
    // partial capture or its wire projection.
    const rejectedWire = JSON.stringify(rejectedResult);
    expect(rejectedWire).not.toContain("canary-x-api-key-4c8f1a62");
    expect(rejectedWire).not.toContain("wrong-token");
    expect(rejectedResult.record!.requestHeaders!["x-api-key"]).toBe(
      "[REDACTED]",
    );

    // Abort mid-execution: request body present, response absent.
    const neverFetch: FetchFunction = async () =>
      await new Promise<Response>(() => {});
    const {
      runtime: abortRuntime,
      store: abortStore,
      registry: abortRegistry,
    } = await createCaptureHttpFixture({ fetch: neverFetch });
    await abortRegistry.set(DEEP_CAPTURE_SETTING, true, undefined);
    const abort = new AbortController();
    const handling = abortRuntime.handle(validRequest(undefined, abort.signal));
    await new Promise((resolve) => setTimeout(resolve, 10));
    abort.abort(new Error("client disconnected"));
    const failure = await handling.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HttpRequestAbortedError);
    const abortedId = (failure as HttpRequestAbortedError).requestId;
    expect(abortedId).toBeTruthy();
    await expect
      .poll(() => abortStore.query({ requestId: abortedId! }))
      .toMatchObject({ state: "partial" });
    const abortedResult = abortStore.query({ requestId: abortedId! }).record!;
    expect(abortedResult.requestBody).toContain("claude-fixture");
    expect(abortedResult.responseBody).toBeUndefined();
    expect(abortedResult.failure).toBe("aborted");
  });

  it("marks capture as expired after capacity eviction while the remaining captures stay intact", async () => {
    const now = advancingClock();
    const { runtime, store, registry } = await createCaptureHttpFixture({
      maxCaptures: 2,
      now,
    });
    await registry.set(DEEP_CAPTURE_SETTING, true, undefined);

    const first = await runtime.handle(validRequest());
    const second = await runtime.handle(validRequest());
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstId = first.headers.get("x-luckytoken-request-id")!;
    const secondId = second.headers.get("x-luckytoken-request-id")!;
    await expect
      .poll(() => store.query({ requestId: firstId }).state)
      .toBe("captured");

    const third = await runtime.handle(validRequest());
    const thirdId = third.headers.get("x-luckytoken-request-id")!;
    expect(third.status).toBe(200);
    // Capacity 2: the oldest capture (first) is evicted; second and third
    // remain; the evicted request is reported as expired, never deleted.
    await expect
      .poll(() => store.query({ requestId: firstId }).state)
      .toBe("expired");
    expect(store.query({ requestId: firstId }).evictionReason).toBe(
      "capacity",
    );
    expect(store.query({ requestId: secondId }).state).toBe("captured");
    expect(store.query({ requestId: thirdId }).state).toBe("captured");
  });

  it("keeps per-request acceptance decisions consistent for simultaneous in-flight requests across a mid-flight toggle", async () => {
    const { store, registry } = await createCaptureHttpFixture();
    await registry.set(DEEP_CAPTURE_SETTING, true, undefined);

    // Two requests in flight at once; the toggle flips between their
    // acceptances. Each request keeps its own acceptance-time snapshot.
    let releaseA: (() => void) | undefined;
    const gateA = new Promise<Response>((resolve) => {
      releaseA = () => resolve(commandCodeSuccess("a"));
    });
    let releaseB: (() => void) | undefined;
    const gateB = new Promise<Response>((resolve) => {
      releaseB = () => resolve(commandCodeSuccess("b"));
    });
    let fetchCalls = 0;
    const fetch: FetchFunction = async () => {
      fetchCalls += 1;
      return fetchCalls === 1 ? gateA : gateB;
    };
    // The fixture created above uses its own fetch; build a second runtime
    // sharing the same store and registry with the gated fetch.
    const secondRuntime = createCommandCodeTestRuntime({
      clientApiKey: "fixture-client-key",
      commandCodeApiKey: "fixture-commandcode-key",
      commandCodeBaseUrl: "https://fixture.commandcode.test",
      fetch,
      modelId: "claude-fixture",
      createMessageId: () => "msg_fixture",
      createSessionId: () => "00000000-0000-4000-8000-000000000020",
      now: () => 1_786_400_000_000,
      deepCapture: createDeepCaptureAuthority({
        store,
        now: () => 1_786_400_000_000,
        readEnabled: () =>
          registry.query([DEEP_CAPTURE_SETTING])[DEEP_CAPTURE_SETTING]?.value ===
          true,
      }),
    });
    fixtures.push({ close: async () => undefined });

    const handlingA = secondRuntime.handle(validRequest());
    await new Promise((resolve) => setTimeout(resolve, 10));
    // A is accepted and executing while enabled; disable now.
    await registry.set(DEEP_CAPTURE_SETTING, false, undefined);
    const handlingB = secondRuntime.handle(validRequest());
    await new Promise((resolve) => setTimeout(resolve, 10));
    // B is accepted while disabled; release both.
    releaseA!();
    releaseB!();
    const [responseA, responseB] = await Promise.all([
      handlingA,
      handlingB,
    ]);
    const idA = responseA.headers.get("x-luckytoken-request-id")!;
    const idB = responseB.headers.get("x-luckytoken-request-id")!;
    expect(idA).not.toBe(idB);
    await expect
      .poll(() => store.query({ requestId: idA }).state)
      .toBe("captured");
    await expect
      .poll(() => store.query({ requestId: idB }).state)
      .toBe("no-capture");
  });

  it("captures an OpenAI Responses request through the real Responses handler", async () => {
    const { store, root } = await openCaptureStore();
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-capture-resp-"));
    roots.push(directory);
    const registry = createSettingsRegistry(memoryStore(), {
      initial: { [DEEP_CAPTURE_SETTING]: true },
    });
    await registry.load();
    const composition = await createOpenAIResponsesServingTestComposition({
      clientApiKey: "client-token",
      commandCodeApiKey: "provider-secret",
      commandCodeBaseUrl: "https://commandcode.test",
      modelId: "deepseek/deepseek-v4-flash",
      fetch: async () => commandCodeSuccess("answered"),
      directory,
      deepCapture: createDeepCaptureAuthority({
        store,
        now: () => 1_786_400_000_000,
        readEnabled: () =>
          registry.query([DEEP_CAPTURE_SETTING])[DEEP_CAPTURE_SETTING]?.value ===
          true,
      }),
    });
    fixtures.push({ close: composition.close });
    const response = await composition.runtime.handle(
      new Request("http://luckytoken.test/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer client-token",
          "content-type": "application/json",
          "x-api-key": "client-token",
          cookie: "canary-cookie-value-6d1b7e93=1",
        },
        body: JSON.stringify({
          model: "deepseek/deepseek-v4-flash",
          input: [{ role: "user", content: "canary-safe-text-7d8e9f10" }],
          query: "access_token=canary-query-param-5b2d8e71",
        }),
      }),
    );
    expect(response.status).toBe(200);
    const requestId = response.headers.get("x-luckytoken-request-id");
    expect(requestId).toBeTruthy();
    await expect
      .poll(() => store.query({ requestId: requestId! }))
      .toMatchObject({ state: "captured" });
    const record = store.query({ requestId: requestId! }).record!;
    expect(record.protocolId).toBe("openai-responses");
    expect(record.requestBody).toContain("canary-safe-text-7d8e9f10");
    expect(record.requestBody).not.toContain("canary-query-param-5b2d8e71");
    expect(record.responseBody).toContain("answered");
    const persisted = await allPersistedBytes(root);
    expect(persisted).toContain("canary-safe-text-7d8e9f10");
    for (const canary of [
      "canary-query-param-5b2d8e71",
      "canary-cookie-value-6d1b7e93",
      "provider-secret",
    ]) {
      expect(persisted).not.toContain(canary);
    }
  });

  it("keeps the model response byte-identical when the response clone/read fails, recording a partial capture instead", async () => {
    const { runtime, store, registry, client } =
      await createCaptureHttpFixture();
    await registry.set(DEEP_CAPTURE_SETTING, true, undefined);

    // Fault-inject the response clone used only by the capture path: the
    // delivered model response must remain byte-identical.
    const originalClone = Response.prototype.clone;
    Response.prototype.clone = function clone() {
      throw new Error("capture clone canary-fault-889900");
    } as typeof originalClone;
    let response: Response;
    try {
      response = await runtime.handle(validRequest());
    } finally {
      Response.prototype.clone = originalClone;
    }
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("fixture answer");
    const requestId = response.headers.get("x-luckytoken-request-id")!;
    // The capture degrades truthfully to partial with the fault fact; the
    // fault text never reaches any surface.
    await expect
      .poll(() => store.query({ requestId }))
      .toMatchObject({ state: "partial" });
    const record = store.query({ requestId }).record!;
    expect(record.failure).toBe("response-capture-failed");
    expect(record.responseBody).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain("canary-fault-889900");
    const wire = JSON.stringify(await client.getCapture({ requestId }));
    expect(wire).not.toContain("canary-fault-889900");
  });

  it("initiates no response-body clone or read while capture is disabled", async () => {
    const { runtime, store } = await createCaptureHttpFixture();
    // Registry starts disabled; any clone/read attempt would throw and, if
    // not isolated, would break the response.
    const originalClone = Response.prototype.clone;
    const originalArrayBuffer = Response.prototype.arrayBuffer;
    Response.prototype.clone = function clone() {
      throw new Error("clone must not run while disabled");
    } as typeof originalClone;
    Response.prototype.arrayBuffer = function arrayBuffer() {
      throw new Error("arrayBuffer must not run while disabled");
    } as typeof originalArrayBuffer;
    let response: Response;
    try {
      response = await runtime.handle(validRequest());
    } finally {
      Response.prototype.clone = originalClone;
      Response.prototype.arrayBuffer = originalArrayBuffer;
    }
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("fixture answer");
    const requestId = response.headers.get("x-luckytoken-request-id")!;
    // No capture row exists (no body read was ever initiated).
    expect(store.query({ requestId }).state).toBe("no-capture");
  });

  it("isolates a throwing capture authority so the request path stays byte-identical", async () => {
    const throwingCapture: DeepCaptureAuthority = {
      begin: () => {
        throw new Error("capture begin canary-112233");
      },
    };
    const runtime = createCommandCodeTestRuntime({
      clientApiKey: "fixture-client-key",
      commandCodeApiKey: "fixture-commandcode-key",
      commandCodeBaseUrl: "https://fixture.commandcode.test",
      fetch: async () => commandCodeSuccess("fixture answer"),
      modelId: "claude-fixture",
      createMessageId: () => "msg_fixture",
      createSessionId: () => "00000000-0000-4000-8000-000000000020",
      now: () => 1_786_400_000_000,
      deepCapture: throwingCapture,
    });
    const response = await runtime.handle(validRequest());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("fixture answer");
    expect(response.headers.get("x-luckytoken-request-id")).toBeTruthy();

    // A hostile authority whose entry methods all throw: the request path
    // still completes byte-identically.
    const hostileEntryCapture: DeepCaptureAuthority = {
      begin: () => {
        const entry = {
          requestId: "ignored",
          decision: { enabled: true, acceptedAt: 0 },
          requestBody: () => {
            throw new Error("capture body canary-445566");
          },
          response: () => {
            throw new Error("capture response canary-445566");
          },
          fail: () => {
            throw new Error("capture fail canary-445566");
          },
          finalize: () => {
            throw new Error("capture finalize canary-445566");
          },
        };
        return entry;
      },
    };
    const hostileRuntime = createCommandCodeTestRuntime({
      clientApiKey: "fixture-client-key",
      commandCodeApiKey: "fixture-commandcode-key",
      commandCodeBaseUrl: "https://fixture.commandcode.test",
      fetch: async () => commandCodeSuccess("fixture answer"),
      modelId: "claude-fixture",
      createMessageId: () => "msg_fixture",
      createSessionId: () => "00000000-0000-4000-8000-000000000020",
      now: () => 1_786_400_000_000,
      deepCapture: hostileEntryCapture,
    });
    const hostile = await hostileRuntime.handle(validRequest());
    expect(hostile.status).toBe(200);
    expect(await hostile.text()).toContain("fixture answer");
    expect(hostile.headers.get("x-luckytoken-request-id")).toBeTruthy();
  });

  it("queries a maximum-budget record through the real framed Control Plane seam", async () => {
    const { store, registry, client } = await createCaptureHttpFixture({
      maxCaptureBytes: 64 * 1024 * 1024,
    });
    await registry.set(DEEP_CAPTURE_SETTING, true, undefined);
    // The configured maximum (64 MiB) is legally accepted; the record is
    // budgeted below the 1 MiB frame ceiling so the real query succeeds.
    const requestId = "10000000-0000-4000-8000-000000000077";
    const multibyte = "日本語安全ログ".repeat(10_000);
    const escaping = '"\\\u0001\u001f'.repeat(60_000);
    // Many redactor-capped multibyte fields: the total sanitized payload
    // exceeds the frame-safe budget, so the store's deterministic halving
    // must bring the complete record under it.
    const manyFields = Object.fromEntries(
      Array.from({ length: 120 }, (_, index) => [`field-${index}`, multibyte]),
    );
    store.append({
      requestId,
      protocolId: "anthropic-messages",
      acceptedAt: 1_786_400_000_000,
      clientHttpStatus: 200,
      requestBody: JSON.stringify({
        note: "safe-multibyte",
        ...manyFields,
      }),
      responseBody: JSON.stringify({ escaping, ...manyFields }),
      requestHeaders: Object.fromEntries(
        Array.from({ length: 100 }, (_, index) => [
          `x-safe-${index}`,
          `value-${index}-${multibyte.slice(0, 200)}`,
        ]),
      ),
      responseHeaders: { "content-type": "application/json" },
      timing: Array.from({ length: 64 }, (_, index) => ({
        stage: `stage-${index}`,
        time: 1_786_400_000_000 + index,
      })),
      complete: true,
    });
    // The query succeeds through the real framed node-pipe transport — if
    // the record exceeded the frame ceiling, the host write would fail.
    const result = await client.getCapture({ requestId });
    expect(result.state).toBe("captured");
    expect(result.record).toBeDefined();
    // The serialized record is bounded below the frame ceiling.
    const serialized = Buffer.byteLength(JSON.stringify(result.record), "utf8");
    expect(serialized).toBeLessThan(1_048_576);
    // Oversized artifacts carry the explicit marker; safe small facts
    // survive.
    const record = result.record!;
    expect(record.requestBody!.endsWith("…")).toBe(true);
    expect(record.responseBody!.endsWith("…")).toBe(true);
    expect(record.requestHeaders!["x-safe-0"]).toContain("value-0");
    expect(record.timing!.length).toBeGreaterThan(0);
    // Multibyte text was byte-budgeted, never silently dropped mid-character
    // in a way that corrupts the frame.
    expect(JSON.stringify(result)).toContain("safe-multibyte");
  });

  it("serves capture commands only when a capture store is wired, and keeps capture events off status and ledger subscribers", async () => {
    // A host without capture ownership answers unknown_command.
    const transport = createNodePipeTransport();
    const host = await startControlPlane({
      endpoint: endpoint(++controlPlaneCounter),
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
    });
    hosts.push(host);
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `cp-request-${++requestCounter}`,
      pipeConnector: transport,
    });
    await client.hello(1);
    await expect(
      client.getCapture({ requestId: "10000000-0000-4000-8000-000000000099" }),
    ).rejects.toThrow(/unknown_command/u);
    await client.close();

    // A wired host rejects malformed queries and never leaks capture events
    // to status subscribers.
    const { store: wiredStore } = await openCaptureStore();
    const wiredHost = await startControlPlane({
      endpoint: endpoint(++controlPlaneCounter),
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
      capture: wiredStore,
    });
    hosts.push(wiredHost);
    const wiredClient = await connectControlPlane(wiredHost.endpoint, {
      createRequestId: () => `cp-request-${++requestCounter}`,
      pipeConnector: transport,
    });
    await wiredClient.hello(1);
    const statusEvents: unknown[] = [];
    await wiredClient.subscribe((event) => statusEvents.push(event));
    await wiredClient.subscribeCapture(() => undefined);
    wiredStore.append({
      requestId: "10000000-0000-4000-8000-000000000098",
      protocolId: "anthropic-messages",
      acceptedAt: 1_786_400_000_000,
      requestBody: "{}",
      complete: true,
    });
    await expect
      .poll(() => wiredStore.query({ requestId: "10000000-0000-4000-8000-000000000098" }).state)
      .toBe("captured");
    // Status subscribers never see the capture event; the capture query
    // still serves the committed record.
    expect(statusEvents).toHaveLength(0);
    const queried = await wiredClient.getCapture({
      requestId: "10000000-0000-4000-8000-000000000098",
    });
    expect(queried.state).toBe("captured");
    await wiredClient.close();
  });
});

function endpoint(index: number): ControlPlaneEndpoint {
  return {
    pipeName: `\\\\.\\pipe\\ticket-22-cp-${process.pid}-${index}`,
    capability: `ticket-22-capability-${String(index).padStart(26, "0")}`,
  };
}

function advancingClock(): () => number {
  let elapsed = 0;
  return () => 1_786_400_000_000 + (elapsed += 1);
}
