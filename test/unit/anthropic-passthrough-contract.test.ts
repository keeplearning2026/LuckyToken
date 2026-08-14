import type { FetchFunction, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import {
  isAnthropicNativePassthroughModel,
  passthroughAnthropicRequest,
  passthroughRequestHeaders,
} from "../../src/protocols/anthropic/passthrough.js";

function model(
  api = "anthropic-messages",
  baseUrl = "https://gateway.example.com",
): Model<string> {
  return {
    id: "claude",
    name: "claude",
    api,
    provider: "fixture-provider",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 64000,
  };
}

describe("11: native Anthropic passthrough contract", () => {
  it("selects on declared wire compatibility, not provider identity", () => {
    expect(isAnthropicNativePassthroughModel(model("anthropic-messages"))).toBe(
      true,
    );
    expect(
      isAnthropicNativePassthroughModel(model("openai-responses")),
    ).toBe(false);
    const anyProvider = model("anthropic-messages");
    anyProvider.provider = "some-other-vendor";
    expect(isAnthropicNativePassthroughModel(anyProvider)).toBe(true);
  });

  it("forwards only approved end-to-end request headers", () => {
    const headers = new Headers({
      authorization: "Bearer client-secret",
      cookie: "session=abc",
      "x-api-key": "client-key",
      "anthropic-beta": "tools-2025-04-14",
      "anthropic-user-profile-id": "profile_1",
      "content-length": "999",
      connection: "keep-alive",
    });
    const forwarded = passthroughRequestHeaders(
      new Request("http://lucky.test/v1/messages", { headers }),
    );
    expect(forwarded).toEqual({
      "anthropic-beta": "tools-2025-04-14",
      "anthropic-user-profile-id": "profile_1",
    });
    expect(forwarded).not.toHaveProperty("authorization");
    expect(forwarded).not.toHaveProperty("cookie");
    expect(forwarded).not.toHaveProperty("x-api-key");
    expect(forwarded).not.toHaveProperty("content-length");
    expect(forwarded).not.toHaveProperty("connection");
  });

  it("preserves status, body, and safe response headers; strips unsafe ones", async () => {
    const baseFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        void input;
        void init;
        return new Response('{"type":"message","content":[]}', {
          status: 200,
          headers: {
            "content-type": "application/json",
            "request-id": "req_ok",
            "set-cookie": "sid=1",
            "transfer-encoding": "chunked",
            "x-ratelimit-remaining": "42",
          },
        });
      },
    );
    const result = await passthroughAnthropicRequest({
      model: model(),
      rawBody: '{"model":"claude","max_tokens":1,"messages":[]}',
      apiKey: "upstream-key",
      signal: new AbortController().signal,
      fetch: baseFetch as unknown as FetchFunction,
    });
    expect(result.status).toBe(200);
    expect(new TextDecoder().decode(result.body)).toBe(
      '{"type":"message","content":[]}',
    );
    expect(result.headers).toEqual({
      "content-type": "application/json",
      "request-id": "req_ok",
      "x-ratelimit-remaining": "42",
    });
    expect(result.headers).not.toHaveProperty("set-cookie");
    expect(result.headers).not.toHaveProperty("transfer-encoding");
  });

  it("builds the configured base path endpoint and never forwards stale body headers", async () => {
    const baseFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        void init;
        return new Response("{}", { status: 200 });
      },
    );
    await passthroughAnthropicRequest({
      model: model(),
      rawBody: "raw",
      apiKey: "upstream-key",
      signal: new AbortController().signal,
      fetch: baseFetch as unknown as FetchFunction,
    });
    const call = baseFetch.mock.calls[0] as
      | [RequestInfo | URL, RequestInit | undefined]
      | undefined;
    expect(String(call?.[0])).toBe("https://gateway.example.com/v1/messages");
    const initHeaders = new Headers(call?.[1]?.headers);
    expect(initHeaders.get("x-api-key")).toBe("upstream-key");
    expect(initHeaders.get("anthropic-version")).toBe("2023-06-01");
    expect(initHeaders.get("content-type")).toBe("application/json");
    expect(initHeaders.has("content-length")).toBe(false);
    expect(call?.[1]?.body).toBe("raw");
  });

  it("aborts upstream work on cancellation", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | null | undefined;
    const baseFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        void input;
        observedSignal = init?.signal;
        controller.abort();
        throw new DOMException("Aborted", "AbortError");
      },
    );
    await expect(
      passthroughAnthropicRequest({
        model: model(),
        rawBody: "{}",
        apiKey: "upstream-key",
        signal: controller.signal,
        fetch: baseFetch as unknown as FetchFunction,
      }),
    ).rejects.toThrow(/Abort/u);
    expect(observedSignal).toBe(controller.signal);
  });

  it("requires an upstream credential before any transport work", async () => {
    const baseFetch = vi.fn(async () => new Response());
    await expect(
      passthroughAnthropicRequest({
        model: model(),
        rawBody: "{}",
        apiKey: undefined,
        signal: new AbortController().signal,
        fetch: baseFetch as unknown as FetchFunction,
      }),
    ).rejects.toThrow(/api key/i);
    expect(baseFetch).not.toHaveBeenCalled();
  });

  it("preserves a configured base-path prefix on the endpoint", async () => {
    const baseFetch = vi.fn(async (input: RequestInfo | URL) => {
      void input;
      return new Response("{}", { status: 200 });
    });
    await passthroughAnthropicRequest({
      model: model("anthropic-messages", "https://gateway.example.com/api"),
      rawBody: '{"model":"claude","max_tokens":1,"messages":[]}',
      apiKey: "upstream-key",
      signal: new AbortController().signal,
      fetch: baseFetch as unknown as FetchFunction,
    });
    const call = baseFetch.mock.calls[0] as
      | [RequestInfo | URL, RequestInit | undefined]
      | undefined;
    expect(String(call?.[0])).toBe(
      "https://gateway.example.com/api/v1/messages",
    );
  });

  it("rewrites a qualified Lucky selector to the registered model id", async () => {
    const baseFetch = vi.fn(async (input: RequestInfo | URL) => {
      void input;
      return new Response("{}", { status: 200 });
    });
    await passthroughAnthropicRequest({
      model: model(),
      rawBody: '{"model":"fixture-provider/claude","max_tokens":1,"messages":[]}',
      apiKey: "upstream-key",
      signal: new AbortController().signal,
      fetch: baseFetch as unknown as FetchFunction,
    });
    const call = baseFetch.mock.calls[0] as
      | [RequestInfo | URL, RequestInit | undefined]
      | undefined;
    expect(call?.[1]?.body).toBe(
      '{"model":"claude","max_tokens":1,"messages":[]}',
    );
  });

  it("keeps the raw body byte-identical when the selector already equals the model id", async () => {
    const rawBody = '{"model":"claude","max_tokens":1,"messages":[]}';
    const baseFetch = vi.fn(async (input: RequestInfo | URL) => {
      void input;
      return new Response("{}", { status: 200 });
    });
    await passthroughAnthropicRequest({
      model: model(),
      rawBody,
      apiKey: "upstream-key",
      signal: new AbortController().signal,
      fetch: baseFetch as unknown as FetchFunction,
    });
    const call = baseFetch.mock.calls[0] as
      | [RequestInfo | URL, RequestInit | undefined]
      | undefined;
    expect(call?.[1]?.body).toBe(rawBody);
  });
});
