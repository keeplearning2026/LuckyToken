import type { FetchFunction, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import {
  passthroughResponsesRequest,
  passthroughResponsesRequestHeaders,
} from "../../src/protocols/openai-responses/passthrough.js";

function model(
  api = "openai-responses",
  baseUrl = "https://responses.example.com",
): Model<string> {
  return {
    id: "gpt-5",
    name: "gpt-5",
    api,
    provider: "my-responses",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 64000,
  };
}

describe("19: native Responses passthrough header boundary matrix", () => {
  it("strips every hop-by-hop, cookie, auth, and stale body header from upstream responses", async () => {
    const result = await passthroughResponsesRequest({
      model: model(),
      rawBody: "{}",
      apiKey: "sk-upstream",
      signal: new AbortController().signal,
      fetch: (async () =>
        new Response("{}", {
          status: 200,
          headers: {
            "connection": "keep-alive",
            "keep-alive": "timeout=5",
            "proxy-authenticate": 'Basic realm="x"',
            "proxy-authorization": "Basic abc",
            "te": "trailers",
            "trailer": "x-checksum",
            "transfer-encoding": "chunked",
            "upgrade": "websocket",
            "host": "upstream.example.com",
            "content-length": "123",
            "content-encoding": "gzip",
            "set-cookie": "sid=1",
            "cookie": "session=abc",
            "authorization": "Bearer upstream",
            "www-authenticate": "Bearer",
            "x-api-key": "sk-upstream",
          },
        })) as unknown as FetchFunction,
    });
    for (const name of [
      "connection",
      "keep-alive",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
      "host",
      "content-length",
      "content-encoding",
      "set-cookie",
      "cookie",
      "authorization",
      "www-authenticate",
      "x-api-key",
    ]) {
      expect(result.headers).not.toHaveProperty(name);
    }
  });

  it("never forwards stale content-length/content-encoding on the upstream request", async () => {
    const baseFetch = vi.fn(
      async (input: RequestInfo | URL) => {
        void input;
        return new Response("{}", { status: 200 });
      },
    );
    const headers = new Headers({
      "content-length": "999",
      "content-encoding": "gzip",
      "x-stainless-retry-count": "2",
    });
    await passthroughResponsesRequest({
      model: model(),
      rawBody: "raw",
      apiKey: "upstream-key",
      signal: new AbortController().signal,
      fetch: baseFetch as unknown as FetchFunction,
      upstreamHeaders: passthroughResponsesRequestHeaders(
        new Request("http://lucky.test/v1/responses", { headers }),
      ),
    });
    const call = baseFetch.mock.calls[0] as
      | [RequestInfo | URL, RequestInit | undefined]
      | undefined;
    const initHeaders = new Headers(call?.[1]?.headers);
    expect(initHeaders.has("content-length")).toBe(false);
    expect(initHeaders.has("content-encoding")).toBe(false);
    expect(initHeaders.get("x-stainless-retry-count")).toBe("2");
  });
});
