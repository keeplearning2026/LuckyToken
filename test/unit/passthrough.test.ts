import type { FetchFunction, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { passthroughAnthropicRequest } from "../../src/protocols/anthropic/passthrough.js";

function model(baseUrl = "https://gateway.example.com"): Model<string> {
  const input: Array<"text" | "image"> = ["text"];
  return {
    id: "claude-sonnet",
    name: "claude-sonnet",
    api: "anthropic-messages",
    provider: "my-anthropic",
    baseUrl,
    reasoning: false,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 64000,
  };
}

describe("passthroughAnthropicRequest", () => {
  it("posts the raw body to {baseUrl}/v1/messages with x-api-key", async () => {
    const baseFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        void input;
        void init;
        return new Response('{"type":"message","content":[]}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    const rawBody = JSON.stringify({
      model: "claude-sonnet",
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
      top_p: 0.9,
    });

    const response = await passthroughAnthropicRequest({
      model: model(),
      rawBody,
      apiKey: "sk-gateway",
      signal: new AbortController().signal,
      fetch: baseFetch as unknown as FetchFunction,
    });

    expect(baseFetch).toHaveBeenCalledTimes(1);
    const firstCall = baseFetch.mock.calls[0] as
      | [RequestInfo | URL, RequestInit | undefined]
      | undefined;
    const input = firstCall?.[0];
    const init = firstCall?.[1];
    expect(String(input)).toBe("https://gateway.example.com/v1/messages");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("sk-gateway");
    expect(new Headers(init?.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(init?.body).toBe(rawBody);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(
      '{"type":"message","content":[]}',
    );
  });

  it("returns the upstream non-2xx response unchanged", async () => {
    const upstreamBody = '{"error":{"type":"rate_limit","message":"slow"}}';
    const baseFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        void input;
        void init;
        return new Response(upstreamBody, {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      },
    );

    const response = await passthroughAnthropicRequest({
      model: model(),
      rawBody: "{}",
      apiKey: "sk-gateway",
      signal: new AbortController().signal,
      fetch: baseFetch as unknown as FetchFunction,
    });

    expect(response.status).toBe(429);
    await expect(response.text()).resolves.toBe(upstreamBody);
  });

  it("requires an api key", async () => {
    await expect(
      passthroughAnthropicRequest({
        model: model(),
        rawBody: "{}",
        apiKey: undefined,
        signal: new AbortController().signal,
        fetch: (async () => new Response()) as unknown as FetchFunction,
      }),
    ).rejects.toThrow(/api key/i);
  });
});
