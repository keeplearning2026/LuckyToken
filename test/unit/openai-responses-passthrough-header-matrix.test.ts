import type { FetchFunction, Model, Models } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { bufferNativeResponsesResponse } from "../../src/protocols/openai-responses/native-response.js";
import { createProviderNativeResponses } from "../../src/provider-native-responses/index.js";

function model(): Model<string> {
  return {
    id: "gpt-5",
    name: "gpt-5",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64_000,
  };
}

describe("Provider Native Responses header boundary", () => {
  it("strips hop-by-hop, credential, cookie, and stale body headers from upstream responses", async () => {
    const result = await bufferNativeResponsesResponse(
      new Response("{}", {
        status: 200,
        headers: {
          connection: "keep-alive",
          "keep-alive": "timeout=5",
          "proxy-authenticate": 'Basic realm="x"',
          "proxy-authorization": "Basic abc",
          te: "trailers",
          trailer: "x-checksum",
          "transfer-encoding": "chunked",
          upgrade: "websocket",
          host: "upstream.example.com",
          "content-length": "123",
          "content-encoding": "gzip",
          "set-cookie": "sid=1",
          cookie: "session=abc",
          authorization: "Bearer upstream",
          "www-authenticate": "Bearer",
          "x-api-key": "sk-upstream",
          "request-id": "req-safe",
          "x-ratelimit-remaining": "7",
          "content-type": "application/json",
        },
      }),
      new AbortController().signal,
    );

    expect(result.headers).toEqual({
      "content-type": "application/json",
      "request-id": "req-safe",
      "x-ratelimit-remaining": "7",
    });
  });

  it("builds Provider headers from Pi-owned facts without inheriting client transport identity", async () => {
    const captured: Request[] = [];
    const fetch: FetchFunction = async (input, init) => {
      captured.push(new Request(input, init));
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const models = {
      getAuth: async () => ({ auth: { apiKey: "sk-provider" } }),
    } as unknown as Pick<Models, "getAuth">;
    const lane = createProviderNativeResponses({ models, fetch });
    const request = new Request("http://luckytoken.test/v1/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer client-secret",
        cookie: "session=abc",
        "x-api-key": "client-key",
        "x-stainless-retry-count": "2",
        "openai-beta": "client-beta",
        "content-length": "999",
        "content-encoding": "gzip",
      },
    });

    await lane.execute({
      model: model(),
      rawBody: JSON.stringify({ model: "openai/gpt-5", input: "hi" }),
      signal: request.signal,
      sessionId: "00000000-0000-4000-8000-000000000123",
      operation: "responses",
    });

    expect(captured).toHaveLength(1);
    const outbound = captured[0]!;
    expect(outbound.headers.get("authorization")).toBe("Bearer sk-provider");
    expect(outbound.headers.has("x-stainless-retry-count")).toBe(false);
    expect(outbound.headers.get("session_id")).toBe(
      "00000000-0000-4000-8000-000000000123",
    );
    expect(outbound.headers.get("x-client-request-id")).toBe(
      "00000000-0000-4000-8000-000000000123",
    );
    expect(outbound.headers.has("cookie")).toBe(false);
    expect(outbound.headers.has("x-api-key")).toBe(false);
    expect(outbound.headers.has("openai-beta")).toBe(false);
    expect(outbound.headers.has("content-encoding")).toBe(false);
  });
});
