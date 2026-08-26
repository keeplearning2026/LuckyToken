import type { FetchFunction } from "@earendil-works/pi-ai";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import type { CodexDirectModelSource } from "../../src/codex-direct-seam.js";
import {
  createOpenAIResponsesServingTestComposition,
  type OpenAIResponsesServingTestComposition,
} from "../support/openai-responses-serving.js";
import {
  startTokenHttpServer,
  type RunningTokenHttpServer,
} from "../../src/server.js";

function directModels(...ids: string[]): CodexDirectModelSource {
  const set = new Set(ids);
  return Object.freeze({
    has: (id: string) => set.has(id),
    models: () => Object.freeze([]),
  });
}

function responsesJson(model: string, text: string): Response {
  return new Response(
    JSON.stringify({
      id: "resp_native",
      object: "response",
      created_at: 1,
      status: "completed",
      model,
      output: [
        {
          type: "message",
          id: "msg_native",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ],
      usage: {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 2 },
        output_tokens: 4,
        output_tokens_details: { reasoning_tokens: 1 },
        total_tokens: 14,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

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
      "",
    ].join("\n"),
  );
}

function request(model: string, token: string, stream = false): Request {
  return new Request("http://Token.test/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "chatgpt-account-id": "acct-from-request",
      "x-client-request-id": "00000000-0000-4000-8000-000000000777",
      cookie: "caller=session",
      "x-api-key": "caller-api-key",
      "x-codex-future": "preserve-me",
      "accept-encoding": "gzip, br",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, input: "hello", ...(stream ? { stream: true } : {}) }),
  });
}

describe("Codex Direct Mode Responses routing", () => {
  const compositions: OpenAIResponsesServingTestComposition[] = [];
  const servers: RunningTokenHttpServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(compositions.splice(0).map((composition) => composition.close()));
  });

  async function start(options: {
    fetch: FetchFunction;
    modelId?: string;
  }) {
    const composition = await createOpenAIResponsesServingTestComposition({
      clientApiKey: "client-token",
      commandCodeApiKey: "provider-secret",
      commandCodeBaseUrl: "https://commandcode.test",
      modelId: options.modelId ?? "deepseek/deepseek-v4-flash",
      fetch: options.fetch,
      codexDirectModels: directModels("gpt-native"),
    });
    compositions.push(composition);
    return composition;
  }

  it("uses client-owned Codex auth and bypasses Alias/Pi for an authenticated bare native model", async () => {
    const calls: Request[] = [];
    const { runtime } = await start({
      fetch: async (input, init) => {
        const outbound = new Request(input, init);
        calls.push(outbound.clone());
        return responsesJson("gpt-native", "native answer");
      },
    });

    const response = await runtime.handle(request("gpt-native", "codex-token"));

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer codex-token");
    expect(calls[0]?.headers.get("chatgpt-account-id")).toBe("acct-from-request");
    expect(calls[0]?.headers.get("cookie")).toBe("caller=session");
    expect(calls[0]?.headers.get("x-api-key")).toBe("caller-api-key");
    expect(calls[0]?.headers.get("x-codex-future")).toBe("preserve-me");
    expect(calls[0]?.headers.get("accept-encoding")).toBe("gzip, br");
    await expect(calls[0]?.json()).resolves.toMatchObject({ model: "gpt-native" });
    await expect(response.json()).resolves.toMatchObject({
      object: "response",
      model: "gpt-native",
    });
  });

  it("accepts the zstd-compressed request bodies emitted by native Codex", async () => {
    const calls: Request[] = [];
    const { runtime } = await start({
      fetch: async (input, init) => {
        const outbound = new Request(input, init);
        calls.push(outbound.clone());
        return responsesJson("gpt-native", "native answer");
      },
    });
    const encoded = zstdCompressSync(
      Buffer.from(JSON.stringify({ model: "gpt-native", input: "compressed" })),
    );
    const response = await runtime.handle(
      new Request("http://Token.test/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer codex-token",
          "content-type": "application/json",
          "content-encoding": "zstd",
        },
        body: encoded,
      }),
    );

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get("content-encoding")).toBe("zstd");
    expect(
      Array.from(new Uint8Array(await calls[0]!.arrayBuffer())),
    ).toEqual(Array.from(encoded));
  });

  it("preserves the raw query when replacing the Responses URL", async () => {
    let upstreamUrl: string | undefined;
    const { runtime } = await start({
      fetch: async (input) => {
        upstreamUrl = String(input);
        return responsesJson("gpt-native", "native answer");
      },
    });

    await runtime.handle(
      new Request(
        "http://Token.test/v1/responses?bare&item=a%2Fb&item=two&token=query-secret",
        {
          method: "POST",
          headers: { authorization: "Bearer caller-token", "content-type": "application/json" },
          body: '{ "model": "gpt-native", "input": "hello" }',
        },
      ),
    );

    expect(upstreamUrl).toBe(
      "https://chatgpt.com/backend-api/codex/responses?bare&item=a%2Fb&item=two&token=query-secret",
    );
  });

  it("preserves a Direct Mode upstream status text through the Node handoff", async () => {
    const upstreamHeaders = new Headers({ "content-type": "text/plain" });
    upstreamHeaders.append("set-cookie", "first=1; Path=/");
    upstreamHeaders.append("set-cookie", "second=2; Path=/");
    const { runtime } = await start({
      fetch: async () => new Response("busy", {
        status: 429,
        statusText: "Codex Busy",
        headers: upstreamHeaders,
      }),
    });
    const server = await startTokenHttpServer({ runtime, port: 0 });
    servers.push(server);

    const response = await fetch(`${server.origin}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer caller-token",
        "content-type": "application/json",
      },
      body: '{"model":"gpt-native","input":"hello"}',
    });

    expect({
      status: response.status,
      statusText: response.statusText,
      setCookies: response.headers.getSetCookie(),
    }).toEqual({
      status: 429,
      statusText: "Codex Busy",
      setCookies: ["first=1; Path=/", "second=2; Path=/"],
    });
  });

  it("forwards caller auth after a direct model is claimed", async () => {
    const calls: Request[] = [];
    const { runtime } = await start({
      modelId: "gpt-native",
      fetch: async (input, init) => {
        calls.push(new Request(input, init));
        return commandCodeText("must not execute");
      },
    });

    const response = await runtime.handle(request("gpt-native", "not-a-token-owned-codex-token"));

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get("authorization")).toBe(
      "Bearer not-a-token-owned-codex-token",
    );
  });

  it("lets a Codex-authenticated request use an ordinary Pi model when its model is not native", async () => {
    const calls: Request[] = [];
    const { runtime } = await start({
      fetch: async (input, init) => {
        const outbound = new Request(input, init);
        calls.push(outbound.clone());
        return commandCodeText("pi answer");
      },
    });

    const response = await runtime.handle(
      request("commandcode-private/deepseek/deepseek-v4-flash", "codex-token"),
    );

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("commandcode.test");
    expect(calls[0]?.headers.get("authorization")).not.toBe("Bearer codex-token");
  });
});
