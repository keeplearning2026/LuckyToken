import type { FetchFunction } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";

import type { CodexNativeModelSource } from "../../src/codex-native-seam.js";
import type {
  RequestJourneyObservationAuthority,
  RequestJourneyObservationInput,
} from "../../src/diagnostics/contract.js";
import {
  startTokenHttpServer,
  type RunningTokenHttpServer,
} from "../../src/server.js";
import {
  createOpenAIResponsesServingTestComposition,
  type OpenAIResponsesServingTestComposition,
} from "../support/openai-responses-serving.js";

const noNativeModels: CodexNativeModelSource = Object.freeze({
  has: () => false,
});

describe("Codex Direct Mode images", () => {
  const compositions: OpenAIResponsesServingTestComposition[] = [];
  const servers: RunningTokenHttpServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(
      compositions.splice(0).map((composition) => composition.close()),
    );
  });

  it("forwards caller-owned image credentials with opaque bytes", async () => {
    const requestBytes = Uint8Array.from([0x00, 0xff, 0x28, 0xb5, 0x2f, 0xfd]);
    const responseBytes = Uint8Array.from([0x7b, 0x00, 0x80, 0xff, 0x7d]);
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
      codexNativeModels: noNativeModels,
    });
    compositions.push(composition);

    const response = await composition.runtime.handle(
      new Request("http://Token.test/v1/images/generations", {
        method: "POST",
        headers: {
          authorization: "Bearer caller-owned-token",
          "chatgpt-account-id": "acct-caller",
          "content-type": "application/octet-stream",
        },
        body: requestBytes,
      }),
    );

    expect({
      status: response.status,
      upstreamUrl: outbound?.url,
      authorization: outbound?.headers.get("authorization"),
      accountId: outbound?.headers.get("chatgpt-account-id"),
      upstreamBody:
        outbound === undefined
          ? undefined
          : Array.from(new Uint8Array(await outbound.arrayBuffer())),
      responseBody: Array.from(new Uint8Array(await response.arrayBuffer())),
    }).toEqual({
      status: 207,
      upstreamUrl:
        "https://chatgpt.com/backend-api/codex/images/generations",
      authorization: "Bearer caller-owned-token",
      accountId: "acct-caller",
      upstreamBody: Array.from(requestBytes),
      responseBody: Array.from(responseBytes),
    });
  });

  it("preserves an edits multipart envelope and caller end-to-end headers", async () => {
    const boundary = "Token-image-edit-boundary";
    const multipartBytes = new TextEncoder().encode(
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="prompt"',
        "",
        "add gold ink",
        `--${boundary}--`,
        "",
      ].join("\r\n"),
    );
    const body = gzipSync(multipartBytes);
    let outbound: Request | undefined;
    const composition = await createOpenAIResponsesServingTestComposition({
      clientApiKey: "client-token",
      commandCodeApiKey: "provider-secret",
      commandCodeBaseUrl: "https://commandcode.test",
      fetch: async (input, init) => {
        outbound = new Request(input, init);
        return new Response("edited", { status: 200 });
      },
      modelId: "deepseek/deepseek-v4-flash",
      codexNativeModels: noNativeModels,
    });
    compositions.push(composition);

    const response = await composition.runtime.handle(
      new Request("http://Token.test/v1/images/edits?quality=high%20fidelity", {
        method: "POST",
        headers: {
          authorization: "Bearer codex-token",
          "chatgpt-account-id": "untrusted-account",
          cookie: "untrusted-cookie",
          connection: "keep-alive, x-remove-me",
          "x-remove-me": "connection-only",
          authentication: "caller-authentication",
          "x-access-token": "caller-access-token",
          "x-auth": "caller-auth",
          "x-amz-security-token": "caller-security-token",
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-encoding": "gzip",
          "x-codex-image-extension": "preserve-me",
        },
        body,
      }),
    );

    expect({
      status: response.status,
      url: outbound?.url,
      body:
        outbound === undefined
          ? undefined
          : Array.from(new Uint8Array(await outbound.arrayBuffer())),
      contentType: outbound?.headers.get("content-type"),
      contentEncoding: outbound?.headers.get("content-encoding"),
      extension: outbound?.headers.get("x-codex-image-extension"),
      authorization: outbound?.headers.get("authorization"),
      accountId: outbound?.headers.get("chatgpt-account-id"),
      cookie: outbound?.headers.get("cookie"),
      connection: outbound?.headers.get("connection"),
      connectionNamed: outbound?.headers.get("x-remove-me"),
      authentication: outbound?.headers.get("authentication"),
      accessToken: outbound?.headers.get("x-access-token"),
      auth: outbound?.headers.get("x-auth"),
      securityToken: outbound?.headers.get("x-amz-security-token"),
      acceptEncoding: outbound?.headers.get("accept-encoding"),
      redirect: outbound?.redirect,
    }).toEqual({
      status: 200,
      url: "https://chatgpt.com/backend-api/codex/images/edits?quality=high%20fidelity",
      body: Array.from(body),
      contentType: `multipart/form-data; boundary=${boundary}`,
      contentEncoding: "gzip",
      extension: "preserve-me",
      authorization: "Bearer codex-token",
      accountId: "untrusted-account",
      cookie: "untrusted-cookie",
      connection: null,
      connectionNamed: null,
      authentication: "caller-authentication",
      accessToken: "caller-access-token",
      auth: "caller-auth",
      securityToken: "caller-security-token",
      acceptEncoding: "identity",
      redirect: "manual",
    });
  });

  it("keeps an auto-decoded upstream response representation consistent", async () => {
    const decoded = new TextEncoder().encode('{"data":[{"b64_json":"image"}]}');
    const compressedLength = gzipSync(decoded).byteLength;
    const composition = await createOpenAIResponsesServingTestComposition({
      clientApiKey: "client-token",
      commandCodeApiKey: "provider-secret",
      commandCodeBaseUrl: "https://commandcode.test",
      fetch: async () =>
        new Response(decoded, {
          headers: {
            "content-type": "application/json",
            "content-encoding": "x-gzip",
            "content-length": String(compressedLength),
          },
        }),
      modelId: "deepseek/deepseek-v4-flash",
      codexNativeModels: noNativeModels,
    });
    compositions.push(composition);

    const response = await composition.runtime.handle(
      new Request("http://Token.test/v1/images/generations", {
        method: "POST",
        headers: { authorization: "Bearer codex-token" },
        body: Uint8Array.from([1]),
      }),
    );

    expect({
      body: Array.from(new Uint8Array(await response.arrayBuffer())),
      contentEncoding: response.headers.get("content-encoding"),
      contentLength: response.headers.get("content-length"),
    }).toEqual({
      body: Array.from(decoded),
      contentEncoding: null,
      contentLength: null,
    });
  });

  it("preserves upstream auth failures while enforcing the local request-size limit", async () => {
    let upstreamCalls = 0;
    const composition = await createOpenAIResponsesServingTestComposition({
      clientApiKey: "client-token",
      commandCodeApiKey: "provider-secret",
      commandCodeBaseUrl: "https://commandcode.test",
      fetch: async () => {
        upstreamCalls += 1;
        return new Response("upstream denied", { status: 401 });
      },
      modelId: "deepseek/deepseek-v4-flash",
      codexNativeModels: noNativeModels,
      maxRequestBytes: 4,
    });
    compositions.push(composition);

    const unauthorized = await composition.runtime.handle(
      new Request("http://Token.test/v1/images/generations", {
        method: "POST",
        headers: { authorization: "Bearer wrong-token" },
        body: Uint8Array.from([1]),
      }),
    );
    const oversized = await composition.runtime.handle(
      new Request("http://Token.test/v1/images/edits", {
        method: "POST",
        headers: { authorization: "Bearer codex-token" },
        body: Uint8Array.from([1, 2, 3, 4, 5]),
      }),
    );

    expect([unauthorized.status, oversized.status, upstreamCalls]).toEqual([
      401,
      413,
      1,
    ]);
  });

  it("rejects a streamed request when its actual bytes exceed the limit", async () => {
    let upstreamCalls = 0;
    const composition = await createOpenAIResponsesServingTestComposition({
      clientApiKey: "client-token",
      commandCodeApiKey: "provider-secret",
      commandCodeBaseUrl: "https://commandcode.test",
      fetch: async () => {
        upstreamCalls += 1;
        return new Response("unexpected");
      },
      modelId: "deepseek/deepseek-v4-flash",
      codexNativeModels: noNativeModels,
      maxRequestBytes: 4,
    });
    compositions.push(composition);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2, 3]));
        controller.enqueue(Uint8Array.from([4, 5]));
        controller.close();
      },
    });

    const response = await composition.runtime.handle(
      new Request("http://Token.test/v1/images/generations", {
        method: "POST",
        headers: { authorization: "Bearer codex-token" },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );

    expect([response.status, upstreamCalls]).toEqual([413, 0]);
  });

  it("preserves upstream errors but maps transport and oversized responses to 502", async () => {
    let mode: "error-response" | "transport" | "oversized" = "error-response";
    const composition = await createOpenAIResponsesServingTestComposition({
      clientApiKey: "client-token",
      commandCodeApiKey: "provider-secret",
      commandCodeBaseUrl: "https://commandcode.test",
      fetch: async () => {
        if (mode === "transport") throw new Error("connection refused");
        if (mode === "oversized") {
          return new Response("short fixture", {
            status: 200,
            headers: { "content-length": String(100 * 1024 * 1024 + 1) },
          });
        }
        return new Response(Uint8Array.from([0xde, 0xad]), {
          status: 429,
          statusText: "Rate Limited",
          headers: {
            "content-type": "application/octet-stream",
            "x-safe-upstream": "preserve-me",
            "set-cookie": "secret=cookie",
            digest: "sha-256=:identity-representation:",
          },
        });
      },
      modelId: "deepseek/deepseek-v4-flash",
      codexNativeModels: noNativeModels,
    });
    compositions.push(composition);
    const request = () =>
      composition.runtime.handle(
        new Request("http://Token.test/v1/images/generations", {
          method: "POST",
          headers: { authorization: "Bearer codex-token" },
          body: Uint8Array.from([1]),
        }),
      );

    const upstreamError = await request();
    expect({
      status: upstreamError.status,
      statusText: upstreamError.statusText,
      body: Array.from(new Uint8Array(await upstreamError.arrayBuffer())),
      safe: upstreamError.headers.get("x-safe-upstream"),
      cookie: upstreamError.headers.get("set-cookie"),
      digest: upstreamError.headers.get("digest"),
    }).toEqual({
      status: 429,
      statusText: "Rate Limited",
      body: [0xde, 0xad],
      safe: "preserve-me",
      cookie: "secret=cookie",
      digest: "sha-256=:identity-representation:",
    });
    mode = "transport";
    expect((await request()).status).toBe(502);
    mode = "oversized";
    expect((await request()).status).toBe(502);
  });

  it("maps an upstream response read failure to 502", async () => {
    const observations: RequestJourneyObservationInput[] = [];
    const diagnostics: RequestJourneyObservationAuthority = {
      begin: (input) => ({
        requestId: input.requestId,
        observe: (observation) => observations.push(observation),
        close: () => undefined,
      }),
      observeRuntime: () => undefined,
    };
    const composition = await createOpenAIResponsesServingTestComposition({
      clientApiKey: "client-token",
      commandCodeApiKey: "provider-secret",
      commandCodeBaseUrl: "https://commandcode.test",
      fetch: async () =>
        new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new Error("upstream reset"));
          },
        })),
      modelId: "deepseek/deepseek-v4-flash",
      codexNativeModels: noNativeModels,
      diagnostics,
    });
    compositions.push(composition);

    const response = await composition.runtime.handle(
      new Request("http://Token.test/v1/images/generations", {
        method: "POST",
        headers: { authorization: "Bearer codex-token" },
        body: Uint8Array.from([1]),
      }),
    );

    expect({
      status: response.status,
      preserveCompletion: observations.find(
        (observation) =>
          observation.kind === "step_completed" &&
          observation.stepInstanceId === "p5.preserve_direct_response",
      ),
      primaryFailure: observations.find(
        (observation) =>
          observation.kind === "failure_detected" && observation.role === "primary",
      ),
    }).toMatchObject({
      status: 502,
      preserveCompletion: { kind: "step_completed", completion: "failed" },
      primaryFailure: {
        kind: "failure_detected",
        classification: "upstream_images_response_read_failed",
        role: "primary",
      },
    });
  });

  it("maps an actually oversized upstream response stream to 502", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let emitted = 0;
    const composition = await createOpenAIResponsesServingTestComposition({
      clientApiKey: "client-token",
      commandCodeApiKey: "provider-secret",
      commandCodeBaseUrl: "https://commandcode.test",
      fetch: async () =>
        new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            if (emitted >= 101) {
              controller.close();
              return;
            }
            emitted += 1;
            controller.enqueue(chunk);
          },
        })),
      modelId: "deepseek/deepseek-v4-flash",
      codexNativeModels: noNativeModels,
    });
    compositions.push(composition);

    const response = await composition.runtime.handle(
      new Request("http://Token.test/v1/images/generations", {
        method: "POST",
        headers: { authorization: "Bearer codex-token" },
        body: Uint8Array.from([1]),
      }),
    );

    expect(response.status).toBe(502);
  });

  it("aborts the same upstream request when the caller cancels", async () => {
    let dispatchStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      dispatchStarted = resolve;
    });
    let upstreamAborted = false;
    const composition = await createOpenAIResponsesServingTestComposition({
      clientApiKey: "client-token",
      commandCodeApiKey: "provider-secret",
      commandCodeBaseUrl: "https://commandcode.test",
      fetch: async (_input, init) => {
        dispatchStarted();
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            upstreamAborted = true;
            reject(init.signal?.reason);
          }, { once: true });
        });
      },
      modelId: "deepseek/deepseek-v4-flash",
      codexNativeModels: noNativeModels,
    });
    compositions.push(composition);
    const controller = new AbortController();
    const response = composition.runtime.handle(
      new Request("http://Token.test/v1/images/generations", {
        method: "POST",
        headers: { authorization: "Bearer codex-token" },
        body: Uint8Array.from([1]),
        signal: controller.signal,
      }),
    );
    await started;
    controller.abort(new Error("caller canceled"));

    await expect(response).rejects.toThrow("HTTP request is no longer writable");
    expect(upstreamAborted).toBe(true);
  });

  it("keeps the Images wire unchanged when diagnostics throws", async () => {
    const hostileDiagnostics: RequestJourneyObservationAuthority = {
      begin: (input) => ({
        requestId: input.requestId,
        observe: () => {
          throw new Error("diagnostics observe failed");
        },
        close: () => {
          throw new Error("diagnostics close failed");
        },
      }),
      observeRuntime: () => {
        throw new Error("diagnostics runtime failed");
      },
    };
    const requestBytes = Uint8Array.from([0x00, 0x80, 0xff]);
    let upstreamBytes: number[] | undefined;
    const composition = await createOpenAIResponsesServingTestComposition({
      clientApiKey: "client-token",
      commandCodeApiKey: "provider-secret",
      commandCodeBaseUrl: "https://commandcode.test",
      fetch: async (input, init) => {
        upstreamBytes = Array.from(
          new Uint8Array(await new Request(input, init).arrayBuffer()),
        );
        return new Response(Uint8Array.from([0xde, 0xad]), { status: 202 });
      },
      modelId: "deepseek/deepseek-v4-flash",
      codexNativeModels: noNativeModels,
      diagnostics: hostileDiagnostics,
    });
    compositions.push(composition);

    const response = await composition.runtime.handle(
      new Request("http://Token.test/v1/images/generations", {
        method: "POST",
        headers: { authorization: "Bearer codex-token" },
        body: requestBytes,
      }),
    );

    expect({
      status: response.status,
      upstreamBytes,
      responseBytes: Array.from(new Uint8Array(await response.arrayBuffer())),
    }).toEqual({
      status: 202,
      upstreamBytes: Array.from(requestBytes),
      responseBytes: [0xde, 0xad],
    });
  });

  it("preserves upstream status text and bytes through the real HTTP listener", async () => {
    const upstreamHeaders = new Headers({
      "content-type": "application/octet-stream",
    });
    upstreamHeaders.append("set-cookie", "first=one; Path=/");
    upstreamHeaders.append("set-cookie", "second=two; Path=/");
    const composition = await createOpenAIResponsesServingTestComposition({
      clientApiKey: "client-token",
      commandCodeApiKey: "provider-secret",
      commandCodeBaseUrl: "https://commandcode.test",
      fetch: async () =>
        new Response(Uint8Array.from([0xca, 0xfe]), {
          status: 299,
          statusText: "Image Preserved",
          headers: upstreamHeaders,
        }),
      modelId: "deepseek/deepseek-v4-flash",
      codexNativeModels: noNativeModels,
    });
    compositions.push(composition);
    const server = await startTokenHttpServer({
      runtime: composition.runtime,
      port: 0,
    });
    servers.push(server);

    const response = await fetch(`${server.origin}/v1/images/generations`, {
      method: "POST",
      headers: { authorization: "Bearer codex-token" },
      body: Uint8Array.from([0x00, 0xff]),
    });

    expect({
      status: response.status,
      statusText: response.statusText,
      bytes: Array.from(new Uint8Array(await response.arrayBuffer())),
      cookies: response.headers.getSetCookie(),
    }).toEqual({
      status: 299,
      statusText: "Image Preserved",
      bytes: [0xca, 0xfe],
      cookies: ["first=one; Path=/", "second=two; Path=/"],
    });
  });
});
