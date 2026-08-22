import type { FetchFunction } from "@earendil-works/pi-ai";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import type {
  CodexLocalCredentialAuthority,
  CodexNativeModelSource,
} from "../../src/codex-native-seam.js";
import {
  createOpenAIResponsesServingTestComposition,
  type OpenAIResponsesServingTestComposition,
} from "../support/openai-responses-serving.js";
import { createRecordingRequestLedger } from "../support/recording-request-ledger.js";
import type { RequestLedger } from "../../src/request-ledger/index.js";

function codexAuthority(token = "codex-token"): CodexLocalCredentialAuthority {
  return Object.freeze({
    isAvailable: async () => true,
    authorizeToken: async (candidate: string) =>
      candidate === token ? Object.freeze({}) : undefined,
    resolveForwardAuth: async (headers: Headers) =>
      headers.get("authorization") === `Bearer ${token}`
        ? Object.freeze({
            authorization: `Bearer ${token}`,
            accountId: "acct-local",
          })
        : undefined,
    scrub: (value: string) => value.split(token).join("[REDACTED]"),
  });
}

function nativeModels(...ids: string[]): CodexNativeModelSource {
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
  return new Request("http://luckytoken.test/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "chatgpt-account-id": "acct-from-request",
      "x-client-request-id": "00000000-0000-4000-8000-000000000777",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, input: "hello", ...(stream ? { stream: true } : {}) }),
  });
}

describe("Codex-native Responses routing", () => {
  const compositions: OpenAIResponsesServingTestComposition[] = [];
  afterEach(async () => {
    await Promise.all(compositions.splice(0).map((composition) => composition.close()));
  });

  async function start(options: {
    fetch: FetchFunction;
    modelId?: string;
    requestLedger?: RequestLedger;
  }) {
    const composition = await createOpenAIResponsesServingTestComposition({
      clientApiKey: "client-token",
      commandCodeApiKey: "provider-secret",
      commandCodeBaseUrl: "https://commandcode.test",
      modelId: options.modelId ?? "deepseek/deepseek-v4-flash",
      fetch: options.fetch,
      codexLocalAuth: codexAuthority(),
      codexNativeModels: nativeModels("gpt-native"),
      ...(options.requestLedger === undefined
        ? {}
        : { requestLedger: options.requestLedger }),
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
    await expect(calls[0]?.json()).resolves.toMatchObject({ model: "gpt-native" });
    await expect(response.json()).resolves.toMatchObject({
      object: "response",
      model: "gpt-native",
    });
  });

  it("records native Codex passthrough usage through the shared Request Ledger contract", async () => {
    const recorded = createRecordingRequestLedger();
    const { runtime } = await start({
      requestLedger: recorded.ledger,
      fetch: async () => responsesJson("gpt-native", "native answer"),
    });

    const response = await runtime.handle(request("gpt-native", "codex-token"));

    expect(response.status).toBe(200);
    expect(recorded.models).toEqual([
      {
        externalAlias: "gpt-native",
        providerId: "openai-codex",
        realModelId: "gpt-native",
      },
    ]);
    expect(recorded.terminalUsage).toHaveLength(1);
    expect(recorded.terminalUsage[0]).toMatchObject({
      api: "openai-codex-responses",
      completeness: "complete",
      input: 8,
      cacheRead: 2,
      cacheWrite: 0,
      output: 4,
      reasoning: 1,
      normalizedTotal: 14,
    });
  });

  it("records streamed usage when the successful Codex upstream omits Content-Type", async () => {
    const recorded = createRecordingRequestLedger();
    const terminal = JSON.stringify({
      type: "response.completed",
      response: {
        status: "completed",
        model: "gpt-native",
        usage: {
          input_tokens: 11,
          input_tokens_details: { cached_tokens: 3 },
          output_tokens: 7,
          output_tokens_details: { reasoning_tokens: 2 },
          total_tokens: 18,
        },
      },
    });
    const upstreamBody = `event: response.completed\ndata: ${terminal}\n\n`;
    const { runtime } = await start({
      requestLedger: recorded.ledger,
      fetch: async () =>
        new Response(new TextEncoder().encode(upstreamBody), { status: 200 }),
    });

    const response = await runtime.handle(
      request("gpt-native", "codex-token", true),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBeNull();
    await expect(response.text()).resolves.toBe(upstreamBody);
    expect(recorded.terminalUsage).toEqual([
      expect.objectContaining({
        api: "openai-codex-responses",
        completeness: "complete",
        input: 8,
        cacheRead: 3,
        output: 7,
        reasoning: 2,
        normalizedTotal: 18,
      }),
    ]);
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
      new Request("http://luckytoken.test/v1/responses", {
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
    expect(calls[0]?.headers.get("content-encoding")).toBeNull();
    await expect(calls[0]?.json()).resolves.toEqual({
      model: "gpt-native",
      input: "compressed",
    });
  });

  it("does not fall through when a local native model is claimed but its credential is unavailable", async () => {
    const calls: Request[] = [];
    const { runtime } = await start({
      modelId: "gpt-native",
      fetch: async (input, init) => {
        calls.push(new Request(input, init));
        return commandCodeText("must not execute");
      },
    });

    const response = await runtime.handle(request("gpt-native", "not-the-local-codex-token"));

    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "authentication_error" },
    });
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
