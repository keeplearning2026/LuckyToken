import type { FetchFunction } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import type {
  CodexLocalCredentialAuthority,
  CodexNativeModelSource,
} from "../../src/codex-native-seam.js";
import {
  createOpenAIResponsesServingTestComposition,
  type OpenAIResponsesServingTestComposition,
} from "../support/openai-responses-serving.js";

function codexAuthority(): CodexLocalCredentialAuthority {
  return Object.freeze({
    resolveForwardAuth: async (headers: Headers) =>
      headers.get("authorization") === "Bearer codex-token"
        ? Object.freeze({
            authorization: "Bearer codex-token",
            accountId: "acct-local",
          })
        : undefined,
    scrub: (value: string) => value.replaceAll("codex-token", "[REDACTED]"),
  });
}

const noNativeModels: CodexNativeModelSource = Object.freeze({
  has: () => false,
});

describe("Codex Local Native web search", () => {
  const compositions: OpenAIResponsesServingTestComposition[] = [];

  afterEach(async () => {
    await Promise.all(
      compositions.splice(0).map((composition) => composition.close()),
    );
  });

  it("preserves opaque request and response body bytes", async () => {
    const requestBytes = Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0xff]);
    const responseBytes = Uint8Array.from([0x00, 0x80, 0xff, 0x41]);
    let outbound: Request | undefined;
    const fetch: FetchFunction = async (input, init) => {
      outbound = new Request(input, init);
      return new Response(responseBytes, {
        status: 207,
        headers: { "content-type": "application/octet-stream" },
      });
    };
    const composition = await createOpenAIResponsesServingTestComposition({
      clientApiKey: "client-token",
      commandCodeApiKey: "provider-secret",
      commandCodeBaseUrl: "https://commandcode.test",
      fetch,
      modelId: "deepseek/deepseek-v4-flash",
      codexLocalAuth: codexAuthority(),
      codexNativeModels: noNativeModels,
    });
    compositions.push(composition);

    const response = await composition.runtime.handle(
      new Request("http://luckytoken.test/v1/alpha/search", {
        method: "POST",
        headers: {
          authorization: "Bearer codex-token",
          "content-type": "application/octet-stream",
        },
        body: requestBytes,
      }),
    );

    expect({
      status: response.status,
      upstreamUrl: outbound?.url,
      upstreamBody:
        outbound === undefined
          ? undefined
          : Array.from(new Uint8Array(await outbound.arrayBuffer())),
      responseBody: Array.from(new Uint8Array(await response.arrayBuffer())),
    }).toEqual({
      status: 207,
      upstreamUrl: "https://chatgpt.com/backend-api/codex/alpha/search",
      upstreamBody: Array.from(requestBytes),
      responseBody: Array.from(responseBytes),
    });
  });

  it("preserves compressed request bytes with their content encoding", async () => {
    const compressed = Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x01]);
    let outbound: Request | undefined;
    const composition = await createOpenAIResponsesServingTestComposition({
      clientApiKey: "client-token",
      commandCodeApiKey: "provider-secret",
      commandCodeBaseUrl: "https://commandcode.test",
      fetch: async (input, init) => {
        outbound = new Request(input, init);
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      modelId: "deepseek/deepseek-v4-flash",
      codexLocalAuth: codexAuthority(),
      codexNativeModels: noNativeModels,
    });
    compositions.push(composition);

    await composition.runtime.handle(
      new Request("http://luckytoken.test/v1/alpha/search", {
        method: "POST",
        headers: {
          authorization: "Bearer codex-token",
          "content-type": "application/json",
          "content-encoding": "zstd",
        },
        body: compressed,
      }),
    );

    expect({
      contentEncoding: outbound?.headers.get("content-encoding"),
      bytes:
        outbound === undefined
          ? undefined
          : Array.from(new Uint8Array(await outbound.arrayBuffer())),
    }).toEqual({
      contentEncoding: "zstd",
      bytes: Array.from(compressed),
    });
  });

  it("preserves the search query string at the fixed Codex upstream", async () => {
    let upstreamUrl: string | undefined;
    const composition = await createOpenAIResponsesServingTestComposition({
      clientApiKey: "client-token",
      commandCodeApiKey: "provider-secret",
      commandCodeBaseUrl: "https://commandcode.test",
      fetch: async (input) => {
        upstreamUrl = String(input);
        return new Response("{}", { status: 200 });
      },
      modelId: "deepseek/deepseek-v4-flash",
      codexLocalAuth: codexAuthority(),
      codexNativeModels: noNativeModels,
    });
    compositions.push(composition);

    await composition.runtime.handle(
      new Request(
        "http://luckytoken.test/v1/alpha/search?query=hello%20world&limit=5",
        {
          method: "POST",
          headers: { authorization: "Bearer codex-token" },
          body: Uint8Array.from([0x7b, 0x7d]),
        },
      ),
    );

    expect(upstreamUrl).toBe(
      "https://chatgpt.com/backend-api/codex/alpha/search?query=hello%20world&limit=5",
    );
  });

  it("forwards end-to-end headers while rebuilding the credential envelope", async () => {
    let outbound: Request | undefined;
    const composition = await createOpenAIResponsesServingTestComposition({
      clientApiKey: "client-token",
      commandCodeApiKey: "provider-secret",
      commandCodeBaseUrl: "https://commandcode.test",
      fetch: async (input, init) => {
        outbound = new Request(input, init);
        return new Response("{}", { status: 200 });
      },
      modelId: "deepseek/deepseek-v4-flash",
      codexLocalAuth: codexAuthority(),
      codexNativeModels: noNativeModels,
    });
    compositions.push(composition);

    await composition.runtime.handle(
      new Request("http://luckytoken.test/v1/alpha/search", {
        method: "POST",
        headers: {
          authorization: "Bearer codex-token",
          "chatgpt-account-id": "acct-untrusted",
          cookie: "session=untrusted",
          "proxy-authorization": "Basic untrusted",
          connection: "keep-alive, x-remove-me",
          "x-remove-me": "connection-scoped",
          host: "untrusted.example",
          "content-type": "application/vnd.codex.search+json",
          "x-codex-future-feature": "preserve-me",
          "accept-language": "zh-CN",
        },
        body: Uint8Array.from([0x7b, 0x7d]),
      }),
    );

    expect({
      authorization: outbound?.headers.get("authorization"),
      accountId: outbound?.headers.get("chatgpt-account-id"),
      contentType: outbound?.headers.get("content-type"),
      future: outbound?.headers.get("x-codex-future-feature"),
      acceptLanguage: outbound?.headers.get("accept-language"),
      cookie: outbound?.headers.get("cookie"),
      proxyAuthorization: outbound?.headers.get("proxy-authorization"),
      connection: outbound?.headers.get("connection"),
      namedByConnection: outbound?.headers.get("x-remove-me"),
      host: outbound?.headers.get("host"),
      redirect: outbound?.redirect,
    }).toEqual({
      authorization: "Bearer codex-token",
      accountId: "acct-local",
      contentType: "application/vnd.codex.search+json",
      future: "preserve-me",
      acceptLanguage: "zh-CN",
      cookie: null,
      proxyAuthorization: null,
      connection: null,
      namedByConnection: null,
      host: null,
      redirect: "manual",
    });
  });

  it("preserves upstream error responses without exposing credential headers", async () => {
    const upstreamBody = Uint8Array.from([0x7b, 0x22, 0xff, 0x22, 0x7d]);
    const composition = await createOpenAIResponsesServingTestComposition({
      clientApiKey: "client-token",
      commandCodeApiKey: "provider-secret",
      commandCodeBaseUrl: "https://commandcode.test",
      fetch: async () =>
        new Response(upstreamBody, {
          status: 429,
          headers: {
            "content-type": "application/problem+json",
            "retry-after": "7",
            "set-cookie": "chatgpt-secret=do-not-forward",
            "www-authenticate": "Bearer upstream-secret",
          },
        }),
      modelId: "deepseek/deepseek-v4-flash",
      codexLocalAuth: codexAuthority(),
      codexNativeModels: noNativeModels,
    });
    compositions.push(composition);

    const response = await composition.runtime.handle(
      new Request("http://luckytoken.test/v1/alpha/search", {
        method: "POST",
        headers: { authorization: "Bearer codex-token" },
        body: Uint8Array.from([0x7b, 0x7d]),
      }),
    );

    expect({
      status: response.status,
      contentType: response.headers.get("content-type"),
      retryAfter: response.headers.get("retry-after"),
      setCookie: response.headers.get("set-cookie"),
      authenticate: response.headers.get("www-authenticate"),
      body: Array.from(new Uint8Array(await response.arrayBuffer())),
    }).toEqual({
      status: 429,
      contentType: "application/problem+json",
      retryAfter: "7",
      setCookie: null,
      authenticate: null,
      body: Array.from(upstreamBody),
    });
  });

  it("rejects an invalid local Codex bearer without contacting ChatGPT", async () => {
    let contacted = false;
    const composition = await createOpenAIResponsesServingTestComposition({
      clientApiKey: "client-token",
      commandCodeApiKey: "provider-secret",
      commandCodeBaseUrl: "https://commandcode.test",
      fetch: async () => {
        contacted = true;
        return new Response("must not execute", { status: 200 });
      },
      modelId: "deepseek/deepseek-v4-flash",
      codexLocalAuth: codexAuthority(),
      codexNativeModels: noNativeModels,
    });
    compositions.push(composition);

    const response = await composition.runtime.handle(
      new Request("http://luckytoken.test/v1/alpha/search", {
        method: "POST",
        headers: { authorization: "Bearer wrong-token" },
        body: Uint8Array.from([0x7b, 0x7d]),
      }),
    );

    expect({
      status: response.status,
      contentType: response.headers.get("content-type"),
      contacted,
      body: await response.json(),
    }).toEqual({
      status: 401,
      contentType: "application/json",
      contacted: false,
      body: {
        error: {
          type: "authentication_error",
          message: "Local Codex credential is unavailable",
        },
      },
    });
  });

  it("rejects an oversized opaque search body before upstream dispatch", async () => {
    let contacted = false;
    const composition = await createOpenAIResponsesServingTestComposition({
      clientApiKey: "client-token",
      commandCodeApiKey: "provider-secret",
      commandCodeBaseUrl: "https://commandcode.test",
      fetch: async () => {
        contacted = true;
        return new Response("must not execute", { status: 200 });
      },
      modelId: "deepseek/deepseek-v4-flash",
      maxRequestBytes: 4,
      codexLocalAuth: codexAuthority(),
      codexNativeModels: noNativeModels,
    });
    compositions.push(composition);

    const response = await composition.runtime.handle(
      new Request("http://luckytoken.test/v1/alpha/search", {
        method: "POST",
        headers: {
          authorization: "Bearer codex-token",
          "content-length": "5",
        },
        body: Uint8Array.from([1, 2, 3, 4, 5]),
      }),
    );

    expect({ status: response.status, contacted }).toEqual({
      status: 413,
      contacted: false,
    });
  });

  it("renders an upstream transport failure as a safe 502 response", async () => {
    const composition = await createOpenAIResponsesServingTestComposition({
      clientApiKey: "client-token",
      commandCodeApiKey: "provider-secret",
      commandCodeBaseUrl: "https://commandcode.test",
      fetch: async () => {
        throw new Error("socket failed with codex-token");
      },
      modelId: "deepseek/deepseek-v4-flash",
      codexLocalAuth: codexAuthority(),
      codexNativeModels: noNativeModels,
    });
    compositions.push(composition);

    const response = await composition.runtime.handle(
      new Request("http://luckytoken.test/v1/alpha/search", {
        method: "POST",
        headers: { authorization: "Bearer codex-token" },
        body: Uint8Array.from([0x7b, 0x7d]),
      }),
    );

    expect({
      status: response.status,
      body: await response.json(),
    }).toEqual({
      status: 502,
      body: {
        error: {
          type: "api_error",
          message: "Upstream search request failed",
        },
      },
    });
  });

  it("renders an upstream response-body failure as a safe 502 response", async () => {
    const composition = await createOpenAIResponsesServingTestComposition({
      clientApiKey: "client-token",
      commandCodeApiKey: "provider-secret",
      commandCodeBaseUrl: "https://commandcode.test",
      fetch: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new Error("upstream body failed with codex-token"));
            },
          }),
          { status: 200 },
        ),
      modelId: "deepseek/deepseek-v4-flash",
      codexLocalAuth: codexAuthority(),
      codexNativeModels: noNativeModels,
    });
    compositions.push(composition);

    const response = await composition.runtime.handle(
      new Request("http://luckytoken.test/v1/alpha/search", {
        method: "POST",
        headers: { authorization: "Bearer codex-token" },
        body: Uint8Array.from([0x7b, 0x7d]),
      }),
    );

    expect({
      status: response.status,
      body: await response.json(),
    }).toEqual({
      status: 502,
      body: {
        error: {
          type: "api_error",
          message: "Upstream search request failed",
        },
      },
    });
  });

  it("cancels an in-progress opaque body read when the client aborts", async () => {
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
        controller.enqueue(Uint8Array.from([0x7b]));
      },
    });
    const composition = await createOpenAIResponsesServingTestComposition({
      clientApiKey: "client-token",
      commandCodeApiKey: "provider-secret",
      commandCodeBaseUrl: "https://commandcode.test",
      fetch: async () => new Response("must not execute", { status: 200 }),
      modelId: "deepseek/deepseek-v4-flash",
      codexLocalAuth: codexAuthority(),
      codexNativeModels: noNativeModels,
    });
    compositions.push(composition);
    const controller = new AbortController();
    const request = new Request("http://luckytoken.test/v1/alpha/search", {
      method: "POST",
      headers: { authorization: "Bearer codex-token" },
      body,
      signal: controller.signal,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const handling = composition.runtime.handle(request).then(
      () => "resolved",
      (error: unknown) =>
        error instanceof Error ? error.name : "unknown rejection",
    );
    await Promise.resolve();
    controller.abort(new Error("client canceled search"));
    const observed = await Promise.race([
      handling,
      new Promise<"timed_out">((resolve) =>
        setTimeout(() => resolve("timed_out"), 100),
      ),
    ]);
    if (observed === "timed_out") {
      bodyController?.close();
      await handling;
    }

    expect(observed).toBe("HttpRequestAbortedError");
  });
});
