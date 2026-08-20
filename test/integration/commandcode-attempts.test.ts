import {
  createModels,
  type AssistantMessage,
  type Context,
  type FetchFunction,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import type { CommandCodeTraceContextCapability } from "../../packages/provider-commandcode-private/src/attempts.js";
import {
  commandCodePrivateApiId,
  commandCodePrivateProviderId,
  createCommandCodePrivateProvider,
  type CommandCodePrivateProviderOptions,
} from "../../packages/provider-commandcode-private/src/provider.js";
import { parseCommandCodeConfiguration } from "../../packages/provider-commandcode-private/src/configuration.js";
import { findUpstreamFailureFact } from "@luckytoken/provider-contract/diagnostics";

const sessionId = "00000000-0000-4000-8000-000000000100";
const context: Context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

function model(): Model<typeof commandCodePrivateApiId> {
  return {
    id: "model",
    name: "model",
    api: commandCodePrivateApiId,
    provider: commandCodePrivateProviderId,
    baseUrl: "https://fixture.test/prefix",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 100,
  };
}

function success(text: string, headers?: HeadersInit): Response {
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
    ].join("\n"),
    headers === undefined ? undefined : { headers },
  );
}

function attemptFacts(message: AssistantMessage): Array<Record<string, unknown>> {
  return (message.diagnostics ?? [])
    .filter((diagnostic) => diagnostic.type === "luckytoken.invocation_attempt.v1")
    .map((diagnostic) => diagnostic.details?.attempt as Record<string, unknown>);
}

function createRunner(
  fetch: FetchFunction | undefined,
  overrides: Partial<CommandCodePrivateProviderOptions> = {},
): {
  run(options?: SimpleStreamOptions): Promise<AssistantMessage>;
  runDirect(options?: SimpleStreamOptions): Promise<AssistantMessage>;
  selected: Model<typeof commandCodePrivateApiId>;
} {
  const selected = model();
  const provider = createCommandCodePrivateProvider({
    apiKey: "key",
    ...(fetch === undefined ? {} : { fetch }),
    model: selected,
    now: () => 1_000,
    ...overrides,
  });
  const models = createModels();
  models.setProvider(provider);
  return {
    selected,
    run: (options) =>
      models.completeSimple(selected, context, {
        maxTokens: 20,
        sessionId,
        ...options,
      }),
    runDirect: (options) =>
      provider
        .streamSimple(selected, context, {
          maxTokens: 20,
          sessionId,
          ...options,
        })
        .result(),
  };
}

describe("CommandCode physical attempts", () => {
  it("rejects provider construction without any model contract", () => {
    expect(() =>
      createCommandCodePrivateProvider({
        now: () => 1_000,
      }),
    ).toThrow(/model/i);
  });

  it("reuses logical wire facts while refreshing attempts, traces, and callbacks", async () => {
    const requests: Request[] = [];
    const bodies: string[] = [];
    let attempt = 0;
    const requestFetch = vi.fn<FetchFunction>(async (input) => {
      const request = input as Request;
      requests.push(request);
      bodies.push(await request.clone().text());
      attempt += 1;
      return attempt === 1
        ? new Response("retry", {
            status: 503,
            headers: { "retry-after-ms": "0" },
          })
        : success("second");
    });
    const boundFetch = vi.fn<FetchFunction>(async () => success("wrong"));
    const payload = vi.fn((candidate: unknown) => ({
      ...(candidate as Record<string, unknown>),
      mode: "retry-stable",
    }));
    const onResponse = vi.fn<NonNullable<SimpleStreamOptions["onResponse"]>>(
      async () => undefined,
    );
    const sleep = vi.fn(async () => undefined);
    const spanIds = ["1111111111111111", "2222222222222222"];
    const resolveLogicalTraceId = vi.fn(
      () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    const traceContext: CommandCodeTraceContextCapability = {
      resolveLogicalTraceId,
      createSpanId: () => spanIds.shift() ?? "3333333333333333",
    };
    const { run } = createRunner(boundFetch, {
      traceContext,
      sleep,
    });
    const telemetryContext = {} as NonNullable<
      SimpleStreamOptions["telemetryContext"]
    >;

    const result = await run({
      fetch: requestFetch,
      maxRetries: 1,
      onPayload: payload,
      onResponse,
      telemetryContext,
    });

    expect(result).toMatchObject({ stopReason: "stop", content: [{ text: "second" }] });
    expect(attemptFacts(result)).toEqual([
      expect.objectContaining({
        attempt: 1,
        classification: "http",
        stage: "response_headers",
        status: 503,
        retryable: true,
      }),
      expect.objectContaining({
        attempt: 2,
        classification: "success",
        stage: "complete",
        status: 200,
      }),
    ]);
    expect(requestFetch).toHaveBeenCalledTimes(2);
    expect(boundFetch).not.toHaveBeenCalled();
    expect(payload).toHaveBeenCalledTimes(1);
    expect(resolveLogicalTraceId).toHaveBeenCalledTimes(1);
    expect(onResponse).toHaveBeenCalledTimes(2);
    expect(onResponse.mock.calls.map(([response]) => response.status)).toEqual([
      503,
      200,
    ]);
    expect(sleep).toHaveBeenCalledWith(0, expect.any(AbortSignal));
    expect(requests[0]).not.toBe(requests[1]);
    expect(requests[0]?.signal).not.toBe(requests[1]?.signal);
    expect(requests.map((request) => request.url)).toEqual([
      "https://fixture.test/alpha/generate",
      "https://fixture.test/alpha/generate",
    ]);
    expect(bodies[0]).toBe(bodies[1]);
    expect(JSON.parse(bodies[0] as string)).toMatchObject({
      mode: "retry-stable",
    });
    expect(requests.map((request) => request.headers.get("traceparent"))).toEqual([
      "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1111111111111111-01",
      "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-2222222222222222-01",
    ]);
    const ordinaryHeaders = requests.map((request) => {
      const entries = Object.fromEntries(request.headers.entries());
      delete entries.traceparent;
      return entries;
    });
    expect(ordinaryHeaders[0]).toEqual(ordinaryHeaders[1]);
  });

  it("bounds success attempt IDs before they enter Pi diagnostics", async () => {
    const oversizedId = "x".repeat(4_096);
    const { runDirect } = createRunner(async () =>
      success("done", { "x-request-id": oversizedId }),
    );

    const result = await runDirect();
    const attempts = attemptFacts(result);

    expect(attempts).toEqual([
      expect.objectContaining({
        classification: "success",
        safeIds: {
          "x-request-id": expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        },
      }),
    ]);
    expect(JSON.stringify(attempts)).not.toContain(oversizedId);
  });

  it("preserves a bounded HTTP failure fact on the Pi error terminal", async () => {
    const body = JSON.stringify({
      error: { message: "slow down", type: "rate_limit", code: "RATE_42" },
    });
    const fetch = vi.fn<FetchFunction>(async () =>
      new Response(body, {
        status: 429,
        statusText: "Rate Limited",
        headers: {
          "content-type": "application/json",
          "content-length": String(new TextEncoder().encode(body).byteLength),
          "retry-after": "2",
          "x-request-id": "req-http",
          authorization: "Bearer must-not-survive",
        },
      }),
    );
    const configuration = parseCommandCodeConfiguration({
      response: {
        errorCapture: {
          bodyReadTimeoutMs: 100,
          maxBodyBytes: 256,
          maxClientMessageChars: 64,
        },
      },
    });
    const { runDirect } = createRunner(fetch, { configuration });

    const message = await runDirect();
    const failure = findUpstreamFailureFact(message.diagnostics);

    expect(message.stopReason).toBe("error");
    expect(failure).toMatchObject({
      kind: "http",
      status: 429,
      statusText: "Rate Limited",
      providerType: "rate_limit",
      providerCode: "RATE_42",
      message: "slow down",
      headers: { "retry-after": "2", "x-request-id": "req-http" },
      retryable: true,
      attemptCount: 1,
      snapshot: {
        mediaType: "application/json",
        capturedBytes: new TextEncoder().encode(body).byteLength,
        totalBytes: new TextEncoder().encode(body).byteLength,
        truncated: false,
      },
    });
    expect(failure?.headers).not.toHaveProperty("authorization");
    expect(failure?.snapshot?.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("bounds HTTP error capture without turning capture truncation into another failure", async () => {
    const fetch = vi.fn<FetchFunction>(async () =>
      new Response("private-body-that-is-long", {
        status: 400,
        headers: { "content-length": "25" },
      }),
    );
    const configuration = parseCommandCodeConfiguration({
      response: {
        errorCapture: {
          bodyReadTimeoutMs: 100,
          maxBodyBytes: 8,
          maxClientMessageChars: 4,
        },
      },
    });
    const { runDirect } = createRunner(fetch, { configuration });

    const message = await runDirect();
    const failure = findUpstreamFailureFact(message.diagnostics);

    expect(failure).toMatchObject({
      kind: "http",
      status: 400,
      message: "priv",
      retryable: false,
      snapshot: { capturedBytes: 8, totalBytes: 25, truncated: true },
      truncated: true,
    });
  });

  it("applies the neutral diagnostic caps beneath broader Provider configuration", async () => {
    const source = "x".repeat(70_000);
    const configuration = parseCommandCodeConfiguration({
      response: {
        errorCapture: {
          bodyReadTimeoutMs: 100,
          maxBodyBytes: 16 * 1024 * 1024,
          maxClientMessageChars: 65_536,
        },
      },
    });
    const { runDirect } = createRunner(
      async () =>
        new Response(source, {
          status: 400,
          headers: { "content-length": "70000" },
        }),
      { configuration },
    );

    const message = await runDirect();
    const failure = findUpstreamFailureFact(message.diagnostics);

    expect(failure?.message).toHaveLength(1_024);
    expect(failure?.snapshot).toMatchObject({
      capturedBytes: 65_536,
      totalBytes: 70_000,
      truncated: true,
    });
  });

  it("preserves structured HTTP-200 stream error facts and rejects invalid status", async () => {
    const streamError = (statusCode: number): Response =>
      new Response(
        JSON.stringify({
          type: "error",
          isRetryable: true,
          error: {
            message: "stream failed",
            statusCode,
            isRetryable: true,
            type: "供应商 错误!",
            code: "代码: 7",
            body: { safeShape: true, secret: "not-retained" },
          },
        }),
      );
    const valid = createRunner(async () => streamError(503));
    const validMessage = await valid.runDirect();
    const validFailure = findUpstreamFailureFact(validMessage.diagnostics);
    expect(validFailure).toMatchObject({
      kind: "upstream_stream",
      status: 503,
      providerType: "供应商 错误!",
      providerCode: "代码: 7",
      message: "stream failed",
      retryable: true,
      attemptCount: 1,
      snapshot: {
        mediaType: "application/json",
        truncated: false,
      },
    });
    expect(JSON.stringify(validFailure)).not.toContain("not-retained");

    const invalid = createRunner(async () => streamError(200));
    const invalidMessage = await invalid.runDirect();
    const invalidFailure = findUpstreamFailureFact(invalidMessage.diagnostics);
    expect(invalidFailure?.kind).toBe("upstream_stream");
    expect(invalidFailure).not.toHaveProperty("status");
  });

  it("retries truncation with fresh state and leaks no failed-attempt text", async () => {
    let attempt = 0;
    const fetch: FetchFunction = async () => {
      attempt += 1;
      if (attempt === 1) {
        return new Response(
          [
            JSON.stringify({ type: "text-start", id: "0" }),
            JSON.stringify({ type: "text-delta", id: "0", text: "discard" }),
            JSON.stringify({ type: "text-end", id: "0" }),
          ].join("\n"),
        );
      }
      return success("committed");
    };
    const sleep = vi.fn(async () => undefined);
    const { run } = createRunner(fetch, { sleep });

    const result = await run({ maxRetries: 1 });

    expect(attempt).toBe(2);
    expect(sleep).toHaveBeenCalledWith(500, expect.any(AbortSignal));
    expect(result.content).toEqual([{ type: "text", text: "committed" }]);
  });

  it("classifies final unexpected EOF and records its physical attempt", async () => {
    const { runDirect } = createRunner(async () =>
      new Response(JSON.stringify({ type: "text-start", id: "0" })),
    );

    const result = await runDirect();
    const failure = findUpstreamFailureFact(result.diagnostics);

    expect(failure).toMatchObject({
      kind: "transport",
      phase: "unexpected_eof",
      retryable: true,
      attemptCount: 1,
    });
    expect(attemptFacts(result)).toEqual([
      expect.objectContaining({
        attempt: 1,
        classification: "transport",
        stage: "unexpected_eof",
        retryable: true,
      }),
    ]);
  });

  it("does not retry malformed protocol or an onResponse rejection", async () => {
    const malformedFetch = vi.fn<FetchFunction>(async () => new Response("not-json"));
    const malformed = createRunner(malformedFetch, {
      sleep: async () => undefined,
    });
    const malformedResult = await malformed.run({ maxRetries: 2 });
    expect(malformedResult.stopReason).toBe("error");
    expect(findUpstreamFailureFact(malformedResult.diagnostics)).toMatchObject({
      kind: "protocol",
      retryable: false,
      attemptCount: 1,
    });
    expect(malformedFetch).toHaveBeenCalledTimes(1);

    const callbackFetch = vi.fn<FetchFunction>(async () =>
      new Response("retry", { status: 503 }),
    );
    const callback = createRunner(callbackFetch, {
      sleep: async () => undefined,
    });
    const callbackResult = await callback.run({
      maxRetries: 2,
      onResponse: async () => {
        throw new Error("hook failed");
      },
    });
    expect(callbackResult.stopReason).toBe("error");
    expect(findUpstreamFailureFact(callbackResult.diagnostics)).toMatchObject({
      kind: "callback",
      phase: "response_headers",
      retryable: false,
      attemptCount: 1,
    });
    expect(callbackFetch).toHaveBeenCalledTimes(1);
  });

  it("distinguishes connect, response-body, and wire-abort terminal failures", async () => {
    const network = createRunner(async () => {
      throw new TypeError("connection reset");
    });
    const networkResult = await network.runDirect();
    expect(findUpstreamFailureFact(networkResult.diagnostics)).toMatchObject({
      kind: "transport",
      phase: "connect",
      retryable: true,
      attemptCount: 1,
    });

    const body = createRunner(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error("body reset"));
          },
        }),
      ),
    );
    const bodyResult = await body.runDirect();
    expect(findUpstreamFailureFact(bodyResult.diagnostics)).toMatchObject({
      kind: "transport",
      phase: "response_body",
      retryable: true,
      attemptCount: 1,
    });

    const wireAbort = createRunner(async () =>
      new Response(JSON.stringify({ type: "abort" })),
    );
    const abortResult = await wireAbort.runDirect();
    expect(abortResult.stopReason).toBe("error");
    expect(findUpstreamFailureFact(abortResult.diagnostics)).toMatchObject({
      kind: "upstream_stream",
      providerType: "abort",
      retryable: false,
      attemptCount: 1,
    });
  });

  it("retries network failures and explicitly retryable stream errors", async () => {
    let networkAttempt = 0;
    const networkFetch = vi.fn<FetchFunction>(async () => {
      networkAttempt += 1;
      if (networkAttempt === 1) throw new TypeError("connection reset");
      return success("network recovered");
    });
    const network = createRunner(networkFetch, {
      sleep: async () => undefined,
    });
    expect((await network.run({ maxRetries: 1 })).content).toEqual([
      { type: "text", text: "network recovered" },
    ]);
    expect(networkFetch).toHaveBeenCalledTimes(2);

    let streamAttempt = 0;
    const streamFetch = vi.fn<FetchFunction>(async () => {
      streamAttempt += 1;
      return streamAttempt === 1
        ? new Response(
            JSON.stringify({
              type: "error",
              isRetryable: true,
              error: { message: "please retry" },
            }),
          )
        : success("stream recovered");
    });
    const stream = createRunner(streamFetch, {
      sleep: async () => undefined,
    });
    expect((await stream.run({ maxRetries: 1 })).content).toEqual([
      { type: "text", text: "stream recovered" },
    ]);
    expect(streamFetch).toHaveBeenCalledTimes(2);
  });

  it("applies one timeout to fetch establishment", async () => {
    let attemptSignal: AbortSignal | undefined;
    const fetch: FetchFunction = async (_input, init) => {
      attemptSignal = init?.signal as AbortSignal | undefined;
      return await new Promise<Response>(() => undefined);
    };
    const { run } = createRunner(fetch);

    const result = await run({ timeoutMs: 20 });

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("timed out");
    expect(attemptSignal?.aborted).toBe(true);
    expect(findUpstreamFailureFact(result.diagnostics)).toMatchObject({
      kind: "timeout",
      phase: "connect",
      attemptCount: 1,
    });
    expect(attemptFacts(result)[0]).toMatchObject({ stage: "connect" });
  });

  it("keeps timeout authority through onResponse and cancels the body", async () => {
    let bodyCancelled = false;
    let rejectResponse: ((reason: Error) => void) | undefined;
    const responseCallback = new Promise<void>((_resolve, reject) => {
      rejectResponse = reject;
    });
    const fetch: FetchFunction = async () =>
      new Response(
        new ReadableStream({
          cancel: () => {
            bodyCancelled = true;
          },
        }),
      );
    const { run } = createRunner(fetch);

    const result = await run({
      timeoutMs: 20,
      onResponse: async () => await responseCallback,
    });

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("timed out");
    expect(bodyCancelled).toBe(true);
    expect(findUpstreamFailureFact(result.diagnostics)).toMatchObject({
      kind: "timeout",
      phase: "response_headers",
      attemptCount: 1,
    });
    expect(attemptFacts(result)[0]).toMatchObject({ stage: "response_headers" });
    rejectResponse?.(new Error("late onResponse rejection"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bodyCancelled).toBe(true);
  });

  it("keeps timeout authority through stalled body consumption", async () => {
    let bodyCancelled = false;
    const fetch: FetchFunction = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `${JSON.stringify({ type: "text-start", id: "0" })}\n`,
              ),
            );
          },
          cancel: () => {
            bodyCancelled = true;
          },
        }),
      );
    const { run } = createRunner(fetch);

    const result = await run({ timeoutMs: 20 });

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("timed out");
    expect(bodyCancelled).toBe(true);
    expect(findUpstreamFailureFact(result.diagnostics)).toMatchObject({
      kind: "timeout",
      phase: "response_body",
      attemptCount: 1,
    });
    expect(attemptFacts(result)[0]).toMatchObject({ stage: "response_body" });
  });

  it("keeps HTTP primary facts when bounded body instrumentation is hostile", async () => {
    const configurations = parseCommandCodeConfiguration({
      response: {
        errorCapture: {
          bodyReadTimeoutMs: 10,
          maxBodyBytes: 8,
          maxClientMessageChars: 64,
        },
      },
    });
    const responses = [
      new Response(
        new ReadableStream<Uint8Array>({
          start() {
            // Deliberately never resolves a read.
          },
          cancel: () => new Promise<void>(() => undefined),
        }),
        { status: 502, headers: { "x-request-id": "" } },
      ),
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error("reader exploded"));
          },
        }),
        { status: 502 },
      ),
      new Response("body-longer-than-declared", {
        status: 502,
        headers: { "content-length": "1" },
      }),
    ];

    for (const response of responses) {
      const { runDirect } = createRunner(async () => response, {
        configuration: configurations,
      });
      const message = await runDirect();
      const failure = findUpstreamFailureFact(message.diagnostics);
      expect(failure).toMatchObject({ kind: "http", status: 502, truncated: true });
      expect(failure?.headers).not.toHaveProperty("x-request-id");
      expect(failure?.snapshot?.capturedBytes ?? 0).toBeLessThanOrEqual(8);
    }
  });

  it("preserves known HTTP status when the attempt timer expires during capture", async () => {
    const configuration = parseCommandCodeConfiguration({
      response: {
        errorCapture: {
          bodyReadTimeoutMs: 30,
          maxBodyBytes: 8,
          maxClientMessageChars: 64,
        },
      },
    });
    const { runDirect } = createRunner(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start() {
              // Headers are available, but body capture stalls until its own deadline.
            },
          }),
          { status: 502 },
        ),
      { configuration },
    );

    const message = await runDirect({ timeoutMs: 10 });
    expect(findUpstreamFailureFact(message.diagnostics)).toMatchObject({
      kind: "http",
      status: 502,
      retryable: true,
      attemptCount: 1,
      truncated: true,
    });
  });

  it("isolates concurrent and sequential neutral failure facts", async () => {
    let releaseA: (() => void) | undefined;
    let releaseB: (() => void) | undefined;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const runnerA = createRunner(async () => {
      await gateA;
      return new Response(JSON.stringify({ error: { message: "alpha", code: "A" } }), {
        status: 429,
        headers: { "x-request-id": "request-a", "retry-after": "1" },
      });
    });
    const runnerB = createRunner(async () => {
      await gateB;
      return new Response(JSON.stringify({ error: { message: "beta", code: "B" } }), {
        status: 503,
        headers: { "x-request-id": "request-b", "retry-after": "2" },
      });
    });
    const pendingA = runnerA.runDirect();
    const pendingB = runnerB.runDirect();
    releaseB?.();
    releaseA?.();
    const [messageA, messageB] = await Promise.all([pendingA, pendingB]);
    const failureA = findUpstreamFailureFact(messageA.diagnostics);
    const failureB = findUpstreamFailureFact(messageB.diagnostics);

    expect(failureA).toMatchObject({
      status: 429,
      providerCode: "A",
      message: "alpha",
      headers: { "x-request-id": "request-a", "retry-after": "1" },
    });
    expect(failureB).toMatchObject({
      status: 503,
      providerCode: "B",
      message: "beta",
      headers: { "x-request-id": "request-b", "retry-after": "2" },
    });

    const configurationFailure = await runnerA.runDirect({ maxRetries: 101 });
    expect(findUpstreamFailureFact(configurationFailure.diagnostics)).toMatchObject({
      kind: "configuration",
      providerCode: "PROVIDER_CONFIGURATION_FAILURE",
      retryable: false,
    });
    expect(JSON.stringify(configurationFailure)).not.toContain("request-a");
    expect(JSON.stringify(configurationFailure)).not.toContain("alpha");
  });

  it("lets caller cancellation prevent the first attempt and stop retry sleep", async () => {
    const preCancelled = new AbortController();
    preCancelled.abort(new Error("pre-cancelled"));
    const noFetch = vi.fn<FetchFunction>(async () => success("wrong"));
    const payload = vi.fn(() => undefined);
    const first = createRunner(noFetch);

    const firstResult = await first.runDirect({
      signal: preCancelled.signal,
      onPayload: payload,
    });
    expect(firstResult.stopReason).toBe("aborted");
    expect(findUpstreamFailureFact(firstResult.diagnostics)).toMatchObject({
      kind: "caller_cancellation",
      retryable: false,
    });
    expect(attemptFacts(firstResult)).toEqual([]);
    expect(noFetch).not.toHaveBeenCalled();
    expect(payload).not.toHaveBeenCalled();

    const controller = new AbortController();
    let markSleeping: (() => void) | undefined;
    const sleeping = new Promise<void>((resolve) => {
      markSleeping = resolve;
    });
    const retryFetch = vi.fn<FetchFunction>(async () =>
      new Response("retry", { status: 503 }),
    );
    const second = createRunner(retryFetch, {
      sleep: async (_delay, signal) => {
        markSleeping?.();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(signal.reason),
            { once: true },
          );
        });
      },
    });
    const handling = second.run({ signal: controller.signal, maxRetries: 2 });
    await sleeping;
    controller.abort(new Error("cancel during retry delay"));
    const secondResult = await handling;

    expect(secondResult.stopReason).toBe("aborted");
    expect(retryFetch).toHaveBeenCalledTimes(1);
    expect(findUpstreamFailureFact(secondResult.diagnostics)).toMatchObject({
      kind: "caller_cancellation",
      retryable: false,
      attemptCount: 1,
    });
    expect(attemptFacts(secondResult)).toEqual([
      expect.objectContaining({ attempt: 1, classification: "http", status: 503 }),
    ]);
  });

  it("records active caller cancellation but does not relabel a committed wire abort", async () => {
    const activeController = new AbortController();
    let fetchStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    const active = createRunner(async () => {
      fetchStarted?.();
      return await new Promise<Response>(() => undefined);
    });
    const activeHandling = active.runDirect({ signal: activeController.signal });
    await started;
    activeController.abort(new Error("active caller cancellation"));
    const activeResult = await activeHandling;
    expect(activeResult.stopReason).toBe("aborted");
    expect(findUpstreamFailureFact(activeResult.diagnostics)).toMatchObject({
      kind: "caller_cancellation",
      attemptCount: 1,
    });
    expect(attemptFacts(activeResult)).toEqual([
      expect.objectContaining({
        attempt: 1,
        classification: "caller_cancellation",
        stage: "connect",
      }),
    ]);

    const racingController = new AbortController();
    const raced = createRunner(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(`${JSON.stringify({ type: "abort" })}\n`),
            );
          },
          cancel: () => {
            racingController.abort(new Error("late caller abort"));
          },
        }),
      ),
    );
    const racedResult = await raced.runDirect({ signal: racingController.signal });
    expect(racedResult.stopReason).toBe("error");
    expect(findUpstreamFailureFact(racedResult.diagnostics)).toMatchObject({
      kind: "upstream_stream",
      providerType: "abort",
      attemptCount: 1,
    });
  });
});
