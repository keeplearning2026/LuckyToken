import type { FetchFunction, Model, Models } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import type { Auth } from "../../src/auth.js";
import { handleHttpRequest, type HttpBoundaryDependencies } from "../../src/http.js";
import {
  createAnthropicMessagesHandler,
  type AnthropicMessagesHandlerOptions,
} from "../../src/protocols/anthropic/handler.js";
import {
  passthroughAnthropicRequest,
  passthroughRequestHeaders,
} from "../../src/protocols/anthropic/passthrough.js";
import { defaultAnthropicModelValidityPolicy } from "../../src/protocols/anthropic/representability.js";

function request(
  body: string,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://luckytoken.test/v1/messages", {
    method: "POST",
    headers: {
      authorization: "Bearer client",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...headers,
    },
    body,
  });
}

function dependencies(
  models: Models,
  extra: Partial<AnthropicMessagesHandlerOptions> = {},
  passthroughFetch?: FetchFunction,
): HttpBoundaryDependencies {
  const auth: Auth = {
    resolve: async () => ({ authorized: true, sessionId: "session" }),
  };
  const options: AnthropicMessagesHandlerOptions = {
    models,
    auth,
    modelValidityPolicy: defaultAnthropicModelValidityPolicy,
    createMessageId: () => "msg_client",
    maxRequestBytes: 1_000_000,
    routerDefaults: {},
    now: () => 1,
    ...extra,
    ...(passthroughFetch === undefined ? {} : { passthroughFetch }),
  };
  const anthropic = createAnthropicMessagesHandler(options);
  return {
    clientProtocols: [anthropic],
    requestTimeoutMs: undefined,
    shutdownSignal: undefined,
  };
}

function passthroughModels(
  model: Model<string>,
  authResult: unknown = { auth: { apiKey: "sk-gateway" } },
): Models {
  return {
    getModels: () => [model],
    getAuth: async () => authResult,
  } as unknown as Models;
}

function captureFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): { restore: () => void; passthroughFetch: FetchFunction } {
  return {
    restore: () => undefined,
    passthroughFetch: impl as FetchFunction,
  };
}

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

describe("11: native Anthropic passthrough header boundary matrix", () => {
  it("never forwards the upstream x-api-key credential in response headers", async () => {
    const result = await passthroughAnthropicRequest({
      model: model(),
      rawBody: "{}",
      apiKey: "sk-upstream",
      signal: new AbortController().signal,
      fetch: (async () =>
        new Response("{}", {
          status: 200,
          headers: { "x-api-key": "sk-upstream" },
        })) as unknown as FetchFunction,
    });
    expect(result.headers).not.toHaveProperty("x-api-key");
  });

  it("strips every hop-by-hop, cookie, auth, and stale body header from upstream responses", async () => {
    const result = await passthroughAnthropicRequest({
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
      "anthropic-beta": "tools-2025-04-14",
    });
    await passthroughAnthropicRequest({
      model: model(),
      rawBody: "raw",
      apiKey: "upstream-key",
      signal: new AbortController().signal,
      fetch: baseFetch as unknown as FetchFunction,
      upstreamHeaders: passthroughRequestHeaders(
        new Request("http://lucky.test/v1/messages", { headers }),
      ),
    });
    const call = baseFetch.mock.calls[0] as
      | [RequestInfo | URL, RequestInit | undefined]
      | undefined;
    const initHeaders = new Headers(call?.[1]?.headers);
    expect(initHeaders.has("content-length")).toBe(false);
    expect(initHeaders.has("content-encoding")).toBe(false);
    expect(initHeaders.get("anthropic-beta")).toBe("tools-2025-04-14");
  });
});

describe("11: native Anthropic passthrough pre-commit transport failure", () => {
  it("renders a legal Anthropic error when the upstream fetch rejects (pre-commit network failure)", async () => {
    const passthroughModel = model();
    const { restore, passthroughFetch } = captureFetch(async () => {
      throw new TypeError("fetch failed: connection refused");
    });
    try {
      const response = await handleHttpRequest(
        dependencies(passthroughModels(passthroughModel), {}, passthroughFetch),
        request(
          JSON.stringify({
            model: "fixture-provider/claude",
            max_tokens: 32,
            messages: [{ role: "user", content: "hi" }],
          }),
        ),
      );
      expect(response.status).toBeGreaterThanOrEqual(500);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.type).toBe("error");
      const error = body.error as Record<string, unknown>;
      expect(["api_error", "overloaded_error"]).toContain(error.type);
      // The message must reflect the upstream failure, never a generic
      // "Internal server error" that hides the transport failure.
      expect(String(error.message)).toContain("fetch failed");
    } finally {
      restore();
    }
  });
});
