import type { FetchFunction } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { HttpRequestAbortedError } from "../../src/http.js";
import {
  createCommandCodeTestRuntime as createLuckyTokenRuntime,
  type CommandCodeServingTestOptions as LuckyTokenRuntimeOptions,
} from "../support/commandcode-serving.js";

const fallbackSession = "00000000-0000-4000-8000-000000000020";
const primarySession = "00000000-0000-4000-8000-000000000021";
const secondarySession = "00000000-0000-4000-8000-000000000022";

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

function runtimeOptions(
  fetch: FetchFunction,
  overrides?: Partial<LuckyTokenRuntimeOptions>,
): LuckyTokenRuntimeOptions {
  return {
    clientApiKey: "fixture-client-key",
    commandCodeApiKey: "fixture-commandcode-key",
    commandCodeBaseUrl: "https://fixture.commandcode.test",
    fetch,
    modelId: "claude-fixture",
    createMessageId: () => "msg_fixture",
    createSessionId: () => fallbackSession,
    now: () => 1_786_400_000_000,
    ...overrides,
  };
}

describe("HTTP and session lifecycle", () => {
  it("rejects edge-invalid requests without dispatching upstream", async () => {
    let fetchCalls = 0;
    const fixtureFetch: FetchFunction = async () => {
      fetchCalls += 1;
      return commandCodeSuccess();
    };
    const runtime = createLuckyTokenRuntime(
      runtimeOptions(fixtureFetch, { maxRequestBytes: 32 }),
    );

    const invalidBody = await runtime.handle(
      new Request("http://luckytoken.test/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer wrong",
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: "{}",
      }),
    );
    expect(invalidBody.status).toBe(400);

    const wrongRoute = await runtime.handle(
      new Request("http://luckytoken.test/not-messages", { method: "POST" }),
    );
    expect(wrongRoute.status).toBe(404);

    const wrongContentType = await runtime.handle(
      new Request("http://luckytoken.test/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer fixture-client-key",
          "content-type": "text/plain",
        },
        body: "{}",
      }),
    );
    expect(wrongContentType.status).toBe(415);

    const tooLarge = await runtime.handle(validRequest());
    expect(tooLarge.status).toBe(413);
    expect(fetchCalls).toBe(0);
  });

  it("uses request-session precedence and carries one identity to header and body", async () => {
    let upstreamRequest: Request | undefined;
    const fixtureFetch: FetchFunction = async (input, init) => {
      upstreamRequest = new Request(input, init);
      return commandCodeSuccess();
    };
    const createSessionId = vi.fn(() => fallbackSession);
    const runtime = createLuckyTokenRuntime(
      runtimeOptions(fixtureFetch, { createSessionId }),
    );

    const response = await runtime.handle(
      validRequest({
        "x-session-id": primarySession,
        "x-client-request-id": secondarySession,
      }),
    );

    expect(response.status).toBe(200);
    expect(createSessionId).not.toHaveBeenCalled();
    expect(upstreamRequest?.headers.get("x-session-id")).toBe(primarySession);
    const body: unknown = await upstreamRequest?.json();
    expect(body).toMatchObject({ threadId: primarySession });
  });

  it("lets disconnect win over a late terminal and never renders the late result", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    let upstreamSignal: AbortSignal | null | undefined;
    let markFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const fixtureFetch: FetchFunction = async (_input, init) => {
      upstreamSignal = init?.signal;
      markFetchStarted?.();
      return await new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    };
    const createMessageId = vi.fn(() => "msg_must_not_be_created");
    const runtime = createLuckyTokenRuntime(
      runtimeOptions(fixtureFetch, { createMessageId }),
    );
    const disconnect = new AbortController();

    const handling = runtime.handle(validRequest(undefined, disconnect.signal));
    await fetchStarted;
    disconnect.abort(new Error("client disconnected"));

    await expect(handling).rejects.toBeInstanceOf(HttpRequestAbortedError);
    expect(upstreamSignal?.aborted).toBe(true);
    expect(createMessageId).not.toHaveBeenCalled();

    resolveFetch?.(commandCodeSuccess("late"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(createMessageId).not.toHaveBeenCalled();
  });

  it("merges request timeout and shutdown into the same cancellation path", async () => {
    const neverFetch: FetchFunction = async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const rejectAborted = (): void => reject(signal?.reason);
        if (signal?.aborted === true) {
          rejectAborted();
          return;
        }
        signal?.addEventListener("abort", rejectAborted, { once: true });
      });
    const timedRuntime = createLuckyTokenRuntime(
      runtimeOptions(neverFetch, { requestTimeoutMs: 5 }),
    );
    await expect(timedRuntime.handle(validRequest())).rejects.toBeInstanceOf(
      HttpRequestAbortedError,
    );

    const shutdown = new AbortController();
    const shutdownRuntime = createLuckyTokenRuntime(
      runtimeOptions(neverFetch, { shutdownSignal: shutdown.signal }),
    );
    const handling = shutdownRuntime.handle(validRequest());
    shutdown.abort(new Error("server shutdown"));
    await expect(handling).rejects.toBeInstanceOf(HttpRequestAbortedError);
  });
});
