import {
  createModels,
  type AssistantMessage,
  type Context,
  type FetchFunction,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import type { CommandCodeTraceContextCapability } from "../../src/providers/commandcode-private/attempts.js";
import {
  commandCodePrivateApiId,
  commandCodePrivateProviderId,
  createCommandCodePrivateProvider,
  type CommandCodePrivateProviderOptions,
} from "../../src/providers/commandcode-private/provider.js";
import { createEmptyServerConfig } from "../../src/providers/commandcode-private/project.js";

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

function success(text: string): Response {
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
  );
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
    projectSnapshot: { snapshot: async () => createEmptyServerConfig() },
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
    const snapshot = vi.fn(async () => createEmptyServerConfig());
    const payload = vi.fn(() => undefined);
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
      projectSnapshot: { snapshot },
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
      metadata: { projectDir: "/project" },
    });

    expect(result).toMatchObject({ stopReason: "stop", content: [{ text: "second" }] });
    expect(requestFetch).toHaveBeenCalledTimes(2);
    expect(boundFetch).not.toHaveBeenCalled();
    expect(payload).toHaveBeenCalledTimes(1);
    expect(snapshot).toHaveBeenCalledTimes(1);
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

  it("does not retry malformed protocol or an onResponse rejection", async () => {
    const malformedFetch = vi.fn<FetchFunction>(async () => new Response("not-json"));
    const malformed = createRunner(malformedFetch, {
      sleep: async () => undefined,
    });
    expect((await malformed.run({ maxRetries: 2 })).stopReason).toBe("error");
    expect(malformedFetch).toHaveBeenCalledTimes(1);

    const callbackFetch = vi.fn<FetchFunction>(async () =>
      new Response("retry", { status: 503 }),
    );
    const callback = createRunner(callbackFetch, {
      sleep: async () => undefined,
    });
    expect(
      (
        await callback.run({
          maxRetries: 2,
          onResponse: async () => {
            throw new Error("hook failed");
          },
        })
      ).stopReason,
    ).toBe("error");
    expect(callbackFetch).toHaveBeenCalledTimes(1);
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
  });

  it("lets caller cancellation prevent the first attempt and stop retry sleep", async () => {
    const preCancelled = new AbortController();
    preCancelled.abort(new Error("pre-cancelled"));
    const noFetch = vi.fn<FetchFunction>(async () => success("wrong"));
    const snapshot = vi.fn(async () => createEmptyServerConfig());
    const payload = vi.fn(() => undefined);
    const first = createRunner(noFetch, { projectSnapshot: { snapshot } });

    const firstResult = await first.runDirect({
      signal: preCancelled.signal,
      onPayload: payload,
      metadata: { projectDir: "/project" },
    });
    expect(firstResult.stopReason).toBe("aborted");
    expect(noFetch).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
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
  });
});
