import type { FetchFunction } from "@earendil-works/pi-ai";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { createCodexLocalCredentialAuthority } from "../../src/integrations/codex/local-auth.js";

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

  it("attributes native Codex usage to its local provider and account Profile", async () => {
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
        providerId: "codex-local",
        realModelId: "gpt-native",
      },
    ]);
    expect(recorded.profiles).toEqual([
      {
        profileId:
          "codex-local:5f7693616d756e8790eaf918d349e8aa2f2804faef32c528a0070778ac472610",
        displayName: "Codex …-local",
      },
    ]);
    expect(JSON.stringify(recorded.profiles)).not.toContain("acct-local");
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

  it("splits the same native model across the current auth.json account Profiles", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "luckytoken-codex-profile-"));
    try {
      const authPath = join(codexHome, "auth.json");
      await writeFile(authPath, JSON.stringify({
        tokens: { access_token: "codex-token-a", account_id: "acct-111111" },
      }));
      const recorded = createRecordingRequestLedger();
      const { runtime } = await start({
        requestLedger: recorded.ledger,
        codexLocalAuth: createCodexLocalCredentialAuthority({ codexHome }),
        fetch: async () => responsesJson("gpt-native", "native answer"),
      });

      expect((await runtime.handle(request("gpt-native", "codex-token-a"))).status).toBe(200);
      await writeFile(authPath, JSON.stringify({
        tokens: { access_token: "codex-token-b", account_id: "acct-222222" },
      }));
      expect((await runtime.handle(request("gpt-native", "codex-token-b"))).status).toBe(200);

      expect(recorded.profiles).toEqual([
        {
          profileId:
            "codex-local:34e7a864b1ca64a2068df3f275a33850b8a8f4f21bdf9570eb2e3b86abea65a8",
          displayName: "Codex …111111",
        },
        {
          profileId:
            "codex-local:6aa0cdbebce613c00a5a1e91039b4d0f29bb401251992f6151caf76fbe034575",
          displayName: "Codex …222222",
        },
      ]);
      expect(new Set(recorded.models.map((model) => model.providerId))).toEqual(
        new Set(["codex-local"]),
      );
      expect(JSON.stringify(recorded.profiles)).not.toContain("acct-111111");
      expect(JSON.stringify(recorded.profiles)).not.toContain("acct-222222");
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
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
    const recorded = createRecordingRequestLedger();
    const { runtime } = await start({
      modelId: "gpt-native",
      requestLedger: recorded.ledger,
      fetch: async (input, init) => {
        calls.push(new Request(input, init));
        return commandCodeText("must not execute");
      },
    });

    const response = await runtime.handle(request("gpt-native", "not-the-local-codex-token"));

    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
    expect(recorded.models[0]?.providerId).toBe("codex-local");
    expect(recorded.profiles).toEqual([]);
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
