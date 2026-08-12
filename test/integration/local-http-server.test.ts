import type { FetchFunction } from "@earendil-works/pi-ai";
import Anthropic from "@anthropic-ai/sdk";
import { request as nodeHttpRequest } from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import type { LuckyTokenRuntime } from "../../src/runtime.js";
import {
  startLuckyTokenHttpServer,
  type RunningLuckyTokenHttpServer,
} from "../../src/server.js";
import { createCommandCodeTestRuntime as createLuckyTokenRuntime } from "../support/commandcode-serving.js";

function commandCodeText(text: string): Response {
  return new Response(
    [
      JSON.stringify({ type: "text-start", id: "0" }),
      JSON.stringify({ type: "text-delta", id: "0", text }),
      JSON.stringify({ type: "text-end", id: "0" }),
      JSON.stringify({
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      }),
    ].join("\n"),
  );
}

describe("local Anthropic HTTP server", () => {
  let server: RunningLuckyTokenHttpServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("uses the bound origin and transfers status, headers, and bytes mechanically", async () => {
    let receivedUrl: string | undefined;
    const responseBytes = Uint8Array.from([0, 1, 127, 128, 255]);
    const runtime: LuckyTokenRuntime = {
      handle: async (request) => {
        receivedUrl = request.url;
        return new Response(responseBytes, {
          status: 207,
          headers: {
            "content-type": "application/octet-stream",
            "x-luckytoken-boundary": "mechanical",
          },
        });
      },
    };
    server = await startLuckyTokenHttpServer({ runtime, port: 0 });

    const received = await new Promise<{
      status: number | undefined;
      boundary: string | string[] | undefined;
      body: Buffer;
    }>((resolve, reject) => {
      const request = nodeHttpRequest(
        {
          hostname: server?.host,
          port: server?.port,
          method: "GET",
          path: "/opaque?value=1",
          headers: { host: "untrusted-client-host.invalid:9999" },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.once("end", () => {
            resolve({
              status: response.statusCode,
              boundary: response.headers["x-luckytoken-boundary"],
              body: Buffer.concat(chunks),
            });
          });
        },
      );
      request.once("error", reject);
      request.end();
    });

    expect(receivedUrl).toBe(`${server.origin}/opaque?value=1`);
    expect(received.status).toBe(207);
    expect(received.boundary).toBe("mechanical");
    expect(received.body).toEqual(Buffer.from(responseBytes));
  });

  it("serves one Anthropic message through a real loopback TCP connection", async () => {
    const upstream: FetchFunction = async () => commandCodeText("over TCP");
    const runtime = createLuckyTokenRuntime({
      clientApiKey: "local-client-key",
      commandCodeApiKey: "provider-key",
      commandCodeBaseUrl: "https://commandcode.fixture.test",
      fetch: upstream,
      modelId: "model",
      createMessageId: () => "msg_tcp",
    });
    server = await startLuckyTokenHttpServer({
      runtime,
      host: "127.0.0.1",
      port: 0,
    });

    const response = await fetch(`${server.origin}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer local-client-key",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "model",
        max_tokens: 32,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(response.status).toBe(200);
    expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/u);
    await expect(response.json()).resolves.toMatchObject({
      id: "msg_tcp",
      model: "model",
      content: [{ type: "text", text: "over TCP" }],
      stop_reason: "end_turn",
    });
  });

  it("is consumable through the official Anthropic SDK over TCP", async () => {
    const runtime = createLuckyTokenRuntime({
      clientApiKey: "sdk-client-key",
      commandCodeApiKey: "provider-key",
      commandCodeBaseUrl: "https://commandcode.fixture.test",
      fetch: async () => commandCodeText("official SDK"),
      modelId: "model",
      createMessageId: () => "msg_sdk_tcp",
    });
    server = await startLuckyTokenHttpServer({ runtime, port: 0 });
    const client = new Anthropic({
      apiKey: "sdk-client-key",
      baseURL: server.origin,
      maxRetries: 0,
    });

    const message = await client.messages.create({
      model: "model",
      max_tokens: 32,
      messages: [{ role: "user", content: "hello" }],
    });

    expect(message).toMatchObject({
      id: "msg_sdk_tcp",
      model: "model",
      content: [{ type: "text", text: "official SDK" }],
      stop_reason: "end_turn",
    });
  });

  it("delivers Atomic SSE through the official Anthropic SDK over TCP", async () => {
    const runtime = createLuckyTokenRuntime({
      clientApiKey: "sse-client-key",
      commandCodeApiKey: "provider-key",
      commandCodeBaseUrl: "https://commandcode.fixture.test",
      fetch: async () => commandCodeText("atomic SSE over TCP"),
      modelId: "model",
      createMessageId: () => "msg_sse_tcp",
    });
    server = await startLuckyTokenHttpServer({ runtime, port: 0 });
    const client = new Anthropic({
      apiKey: "sse-client-key",
      baseURL: server.origin,
      maxRetries: 0,
    });

    const stream = client.messages.stream({
      model: "model",
      max_tokens: 32,
      messages: [{ role: "user", content: "hello" }],
    });
    const message = await stream.finalMessage();

    expect(message).toMatchObject({
      id: "msg_sse_tcp",
      model: "model",
      content: [{ type: "text", text: "atomic SSE over TCP" }],
      stop_reason: "end_turn",
    });
  });

  it("aborts only a disconnected request and remains usable", async () => {
    let markUpstreamStarted: (() => void) | undefined;
    let markUpstreamAborted: (() => void) | undefined;
    const upstreamStarted = new Promise<void>((resolve) => {
      markUpstreamStarted = resolve;
    });
    const upstreamAborted = new Promise<void>((resolve) => {
      markUpstreamAborted = resolve;
    });
    let calls = 0;
    const upstream: FetchFunction = async (input, init) => {
      calls += 1;
      if (calls > 1) return commandCodeText("recovered");
      const signal = new Request(input, init).signal;
      markUpstreamStarted?.();
      return await new Promise<Response>((_resolve, reject) => {
        const onAbort = (): void => {
          markUpstreamAborted?.();
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
    };
    const runtime = createLuckyTokenRuntime({
      clientApiKey: "abort-client-key",
      commandCodeApiKey: "provider-key",
      commandCodeBaseUrl: "https://commandcode.fixture.test",
      fetch: upstream,
      modelId: "model",
    });
    server = await startLuckyTokenHttpServer({ runtime, port: 0 });
    const controller = new AbortController();
    const disconnected = fetch(`${server.origin}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer abort-client-key",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "model",
        max_tokens: 8,
        messages: [{ role: "user", content: "wait" }],
      }),
      signal: controller.signal,
    });
    await upstreamStarted;
    controller.abort(new Error("fixture client disconnected"));

    await expect(disconnected).rejects.toThrow();
    await upstreamAborted;
    const recovered = await fetch(`${server.origin}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer abort-client-key",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "model",
        max_tokens: 8,
        messages: [{ role: "user", content: "recover" }],
      }),
    });

    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toMatchObject({
      content: [{ type: "text", text: "recovered" }],
    });
  }, 5_000);

  it("cancels upstream when a real TCP client disconnects mid-response (Ctrl+C)", async () => {
    let markUpstreamStarted: (() => void) | undefined;
    let markUpstreamAborted: (() => void) | undefined;
    const upstreamStarted = new Promise<void>((resolve) => {
      markUpstreamStarted = resolve;
    });
    const upstreamAborted = new Promise<void>((resolve) => {
      markUpstreamAborted = resolve;
    });
    let calls = 0;
    const upstream: FetchFunction = async (input, init) => {
      calls += 1;
      if (calls > 1) return commandCodeText("recovered-after-tcp-drop");
      const signal = new Request(input, init).signal;
      markUpstreamStarted?.();
      return await new Promise<Response>((_resolve, reject) => {
        const onAbort = (): void => {
          markUpstreamAborted?.();
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
    };
    const runtime = createLuckyTokenRuntime({
      clientApiKey: "tcp-abort-client-key",
      commandCodeApiKey: "provider-key",
      commandCodeBaseUrl: "https://commandcode.fixture.test",
      fetch: upstream,
      modelId: "model",
    });
    server = await startLuckyTokenHttpServer({ runtime, port: 0 });

    // Send a real HTTP request over a raw TCP socket, then destroy the socket
    // while the upstream is still pending — the exact shape of a Ctrl+C.
    const requestBody = JSON.stringify({
      model: "model",
      max_tokens: 8,
      messages: [{ role: "user", content: "wait" }],
    });
    const socket = net.connect(server?.port ?? 0, server?.host ?? "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(
      `POST /v1/messages HTTP/1.1\r\n` +
        `Host: ${server?.host ?? "127.0.0.1"}\r\n` +
        `Content-Type: application/json\r\n` +
        `Authorization: Bearer tcp-abort-client-key\r\n` +
        `Anthropic-Version: 2023-06-01\r\n` +
        `Content-Length: ${Buffer.byteLength(requestBody)}\r\n` +
        `Connection: close\r\n` +
        `\r\n` +
        requestBody,
    );

    await upstreamStarted;
    // Simulate Ctrl+C: destroy the TCP connection while upstream is pending.
    socket.destroy();
    await upstreamAborted;

    // The server must remain usable after the dropped connection.
    const recovered = await fetch(`${server?.origin}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer tcp-abort-client-key",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "model",
        max_tokens: 8,
        messages: [{ role: "user", content: "recover" }],
      }),
    });
    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toMatchObject({
      content: [{ type: "text", text: "recovered-after-tcp-drop" }],
    });
  }, 5_000);

  it("never dispatches upstream when a TCP client disconnects mid-body", async () => {
    let calls = 0;
    const upstream: FetchFunction = async () => {
      calls += 1;
      return commandCodeText("recovered-after-midbody-drop");
    };
    const runtime = createLuckyTokenRuntime({
      clientApiKey: "tcp-midbody-client-key",
      commandCodeApiKey: "provider-key",
      commandCodeBaseUrl: "https://commandcode.fixture.test",
      fetch: upstream,
      modelId: "model",
    });
    server = await startLuckyTokenHttpServer({ runtime, port: 0 });

    // Start sending a large body but never finish it; the client then drops
    // the connection (Ctrl+C mid-upload).
    const socket = net.connect(server?.port ?? 0, server?.host ?? "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(
      `POST /v1/messages HTTP/1.1\r\n` +
        `Host: ${server?.host ?? "127.0.0.1"}\r\n` +
        `Content-Type: application/json\r\n` +
        `Authorization: Bearer tcp-midbody-client-key\r\n` +
        `Anthropic-Version: 2023-06-01\r\n` +
        `Content-Length: 1000000\r\n` +
        `Connection: close\r\n` +
        `\r\n` +
        `{"model":"model","max_tokens":8,"messages":[{"role":"user","content":"`,
    );
    // Give the server a moment to start reading the body, then drop.
    await new Promise((resolve) => setTimeout(resolve, 300));
    socket.destroy();
    // Let the server process the abort and close the request cleanly.
    await new Promise((resolve) => setTimeout(resolve, 300));
    // An incomplete request body must never reach the upstream provider.
    expect(calls).toBe(0);

    // The server must remain usable after the mid-body drop.
    const recovered = await fetch(`${server?.origin}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer tcp-midbody-client-key",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "model",
        max_tokens: 8,
        messages: [{ role: "user", content: "recover" }],
      }),
    });
    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toMatchObject({
      content: [{ type: "text", text: "recovered-after-midbody-drop" }],
    });
  }, 5_000);

  it("keeps concurrent requests isolated", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const upstream: FetchFunction = async () => {
      calls += 1;
      const call = calls;
      if (call === 1) await firstMayFinish;
      else releaseFirst?.();
      return commandCodeText(call === 1 ? "first response" : "second response");
    };
    const runtime = createLuckyTokenRuntime({
      clientApiKey: "concurrent-client-key",
      commandCodeApiKey: "provider-key",
      commandCodeBaseUrl: "https://commandcode.fixture.test",
      fetch: upstream,
      modelId: "model",
      createMessageId: (() => {
        let id = 0;
        return () => `msg_concurrent_${++id}`;
      })(),
    });
    server = await startLuckyTokenHttpServer({ runtime, port: 0 });
    const send = async (sessionId: string, content: string): Promise<Record<string, unknown>> => {
      const response = await fetch(`${server?.origin}/v1/messages`, {
        method: "POST",
        headers: {
          authorization: "Bearer concurrent-client-key",
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-session-id": sessionId,
        },
        body: JSON.stringify({
          model: "model",
          max_tokens: 8,
          messages: [{ role: "user", content }],
        }),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as Record<string, unknown>;
    };

    const [first, second] = await Promise.all([
      send("00000000-0000-4000-8000-000000000231", "first"),
      send("00000000-0000-4000-8000-000000000232", "second"),
    ]);

    expect(first.content).toMatchObject([{ type: "text", text: "first response" }]);
    expect(second.content).toMatchObject([{ type: "text", text: "second response" }]);
    expect(calls).toBe(2);
  });

  it("keeps a concurrent healthy request unaffected when another client disconnects", async () => {
    let releaseSecond: (() => void) | undefined;
    let markSecondStarted: (() => void) | undefined;
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    const secondMayFinish = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let calls = 0;
    const upstream: FetchFunction = async (input, init) => {
      calls += 1;
      const call = calls;
      const signal = new Request(input, init).signal;
      if (call === 1) {
        // First request: hold upstream open until the client disconnects.
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      }
      markSecondStarted?.();
      await secondMayFinish;
      return commandCodeText("healthy-concurrent-response");
    };
    const runtime = createLuckyTokenRuntime({
      clientApiKey: "disconnect-concurrent-key",
      commandCodeApiKey: "provider-key",
      commandCodeBaseUrl: "https://commandcode.fixture.test",
      fetch: upstream,
      modelId: "model",
    });
    server = await startLuckyTokenHttpServer({ runtime, port: 0 });

    // Request 1 over a raw TCP socket, held open upstream.
    const requestBody = JSON.stringify({
      model: "model",
      max_tokens: 8,
      messages: [{ role: "user", content: "wait" }],
    });
    const socket = net.connect(server?.port ?? 0, server?.host ?? "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(
      `POST /v1/messages HTTP/1.1\r\n` +
        `Host: ${server?.host ?? "127.0.0.1"}\r\n` +
        `Content-Type: application/json\r\n` +
        `Authorization: Bearer disconnect-concurrent-key\r\n` +
        `Anthropic-Version: 2023-06-01\r\n` +
        `Content-Length: ${Buffer.byteLength(requestBody)}\r\n` +
        `Connection: close\r\n` +
        `\r\n` +
        requestBody,
    );

    // Request 2 via fetch, must complete despite request 1 disconnecting.
    const healthy = fetch(`${server?.origin}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer disconnect-concurrent-key",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "model",
        max_tokens: 8,
        messages: [{ role: "user", content: "healthy" }],
      }),
    });
    await secondStarted;

    // Now the first client disconnects (Ctrl+C).
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 300));

    releaseSecond?.();
    const healthyResponse = await healthy;
    expect(healthyResponse.status).toBe(200);
    await expect(healthyResponse.json()).resolves.toMatchObject({
      content: [{ type: "text", text: "healthy-concurrent-response" }],
    });
    expect(calls).toBe(2);
  }, 5_000);

  it("aborts active requests during idempotent server shutdown", async () => {
    let markUpstreamStarted: (() => void) | undefined;
    let markUpstreamAborted: (() => void) | undefined;
    const upstreamStarted = new Promise<void>((resolve) => {
      markUpstreamStarted = resolve;
    });
    const upstreamAborted = new Promise<void>((resolve) => {
      markUpstreamAborted = resolve;
    });
    const upstream: FetchFunction = async (input, init) => {
      const signal = new Request(input, init).signal;
      markUpstreamStarted?.();
      return await new Promise<Response>((_resolve, reject) => {
        const onAbort = (): void => {
          markUpstreamAborted?.();
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
    };
    const runtime = createLuckyTokenRuntime({
      clientApiKey: "shutdown-client-key",
      commandCodeApiKey: "provider-key",
      commandCodeBaseUrl: "https://commandcode.fixture.test",
      fetch: upstream,
      modelId: "model",
    });
    server = await startLuckyTokenHttpServer({ runtime, port: 0 });
    const origin = server.origin;
    const pending = fetch(`${origin}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer shutdown-client-key",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "model",
        max_tokens: 8,
        messages: [{ role: "user", content: "wait" }],
      }),
    });
    await upstreamStarted;

    const firstClose = server.close();
    const secondClose = server.close();
    await upstreamAborted;
    await Promise.all([firstClose, secondClose]);
    await expect(pending).rejects.toThrow();
    await expect(server.close()).resolves.toBeUndefined();
    await expect(fetch(`${origin}/v1/messages`)).rejects.toThrow();
  }, 5_000);
});
