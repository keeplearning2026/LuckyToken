import type { Api, AuthResult, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { zstdDecompressSync } from "node:zlib";
import { createProviderResponsesSender } from "../../src/provider-native-responses/index.js";
import { anthropicRequestParams, createAnthropicSdkClient } from "../../src/provider-native-anthropic/envelope.js";
import { runShieldedAnthropicRequest } from "../../src/provider-native-anthropic/sdk-dispatch.js";

function model(api: Api, provider: string): Model<Api> {
  return { id: "native-model", name: "Native", api, provider, baseUrl: "https://upstream.example/v1",
    reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 };
}

describe("copied Pi envelopes with Native body and raw response ownership", () => {
  it.each([
    { api: "openai-responses", provider: "openai", key: "sk-test" },
    { api: "azure-openai-responses", provider: "azure-openai-responses", key: "test" },
    { api: "openai-codex-responses", provider: "openai-codex", key: `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.signature` },
  ] as const)("keeps unknown body fields and an unread non-2xx response for $api", async ({ api, provider, key }) => {
    const upstream = new Response("private provider error", { status: 429, headers: { "x-upstream": "retained" } });
    let request: Request | undefined;
    const auth: AuthResult = { auth: { apiKey: key } };
    const sender = createProviderResponsesSender({ model: model(api, provider), auth, sessionId: "test-session",
      fetch: async (input, init) => { request = new Request(input, init); return upstream; } });
    const raw = { model: "alias", input: "hi", stream: true, provider_private_field: { future: [1, "two"] } };
    const response = await sender!.send("responses", JSON.stringify(raw), new AbortController().signal);
    const sent = request!.headers.get("content-encoding") === "zstd"
      ? JSON.parse(zstdDecompressSync(new Uint8Array(await request!.arrayBuffer())).toString("utf8"))
      : await request!.json();
    expect(sent).toEqual({ ...raw, model: "native-model" });
    expect(response).toBe(upstream);
    expect(response.bodyUsed).toBe(false);
    expect(await response.text()).toBe("private provider error");
  });

  it("uses copied Anthropic construction without consuming the real response or filtering private body fields", async () => {
    const upstream = new Response("unparsed provider response", { status: 503 });
    let request: Request | undefined;
    const raw = JSON.stringify({ model: "native-model", max_tokens: 16, messages: [], stream: true, provider_private_field: "future" });
    const facts = { model: model("anthropic-messages", "anthropic"), apiKey: "test-key", authMode: "api_key" as const, sessionId: undefined, composedHeaders: undefined };
    const response = await runShieldedAnthropicRequest({ signal: new AbortController().signal,
      fetch: async (input, init) => { request = new Request(input, init); return upstream; },
    }, async (fetch) => {
      const client = createAnthropicSdkClient(facts, raw, fetch);
      await client.beta.messages.create(anthropicRequestParams(facts, raw), { maxRetries: 0 });
    });
    expect(await request!.json()).toEqual(JSON.parse(raw));
    expect(response).toBe(upstream);
    expect(response.bodyUsed).toBe(false);
    expect(await response.text()).toBe("unparsed provider response");
  });
});
