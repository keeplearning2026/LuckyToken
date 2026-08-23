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
    codexLocalAuth?: CodexLocalCredentialAuthority;
  }) {
    const composition = await createOpenAIResponsesServingTestComposition({
      clientApiKey: "client-token",
      commandCodeApiKey: "provider-secret",
      commandCodeBaseUrl: "https://commandcode.test",
      modelId: options.modelId ?? "deepseek/deepseek-v4-flash",
      fetch: options.fetch,
      codexLocalAuth: options.codexLocalAuth ?? codexAuthority(),
      codexNativeModels: nativeModels("gpt-native"),
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
