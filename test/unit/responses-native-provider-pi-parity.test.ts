import type {
  AssistantMessageEventStream,
  AuthResult,
  Context,
  FetchFunction,
  Model,
} from "@earendil-works/pi-ai";
import { stream as streamAzureResponses } from "@earendil-works/pi-ai/api/azure-openai-responses";
import { stream as streamCodexResponses } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { stream as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { zstdDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { createProviderResponsesSender } from "../../src/provider-native-responses/index.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000123";
const CONTEXT: Context = { messages: [] };

function model<TApi extends string>(
  provider: string,
  api: TApi,
  baseUrl: string,
): Model<TApi> {
  return {
    id: "real-model",
    name: "real-model",
    provider,
    api,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 10_000,
    headers: { "x-provider-static": "provider-value" },
  };
}

function auth(apiKey: string): AuthResult {
  return { auth: { apiKey } };
}

function codexToken(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

async function drain(stream: AssistantMessageEventStream): Promise<void> {
  for await (const event of stream) {
    // The capture fetch intentionally returns an error response after recording the request.
    void event;
  }
}

async function capturePiRequest(
  start: (fetch: FetchFunction) => AssistantMessageEventStream,
): Promise<Request> {
  let resolveRequest: ((request: Request) => void) | undefined;
  let rejectRequest: ((error: unknown) => void) | undefined;
  const captured = new Promise<Request>((resolve, reject) => {
    resolveRequest = resolve;
    rejectRequest = reject;
  });
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      resolveRequest!(new Request(input, init));
    } catch (error) {
      rejectRequest!(error);
    }
    return new Response("request captured", { status: 400 });
  }) as FetchFunction;
  void drain(start(fetch));
  return captured;
}

async function captureTokenRequest(
  selectedModel: Model<string>,
  selectedAuth: AuthResult,
  rawBody: string,
): Promise<Request> {
  let captured: Request | undefined;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured = new Request(input, init);
    return new Response("request captured", { status: 400 });
  }) as FetchFunction;
  const sender = createProviderResponsesSender({
    model: selectedModel,
    auth: selectedAuth,
    fetch,
    sessionId: SESSION_ID,
  });
  await sender!.send("responses", rawBody, AbortSignal.timeout(5_000));
  return captured!;
}

function selectedHeaders(request: Request, names: readonly string[]): Record<string, string | null> {
  return Object.fromEntries(names.map((name) => [name, request.headers.get(name)]));
}

async function requestJson(request: Request): Promise<Record<string, unknown>> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  const text = request.headers.get("content-encoding") === "zstd"
    ? zstdDecompressSync(bytes).toString("utf8")
    : new TextDecoder().decode(bytes);
  return JSON.parse(text) as Record<string, unknown>;
}

describe("Provider Native Responses Pi HTTP parity", () => {
  it("matches Pi's OpenAI SDK URL, stable headers, session affinity, and body shape", async () => {
    const selectedModel = model("openai", "openai-responses", "https://api.openai.com/v1");
    const projectedBody = {
      model: selectedModel.id,
      input: "hello",
      stream: true,
      future_provider_field: { enabled: true },
    };
    const rawBody = JSON.stringify({ ...projectedBody, model: "public-alias" });
    const pi = await capturePiRequest((fetch) =>
      streamOpenAIResponses(selectedModel, CONTEXT, {
        apiKey: "provider-key",
        fetch,
        sessionId: SESSION_ID,
        maxRetries: 0,
        onPayload: () => projectedBody,
      }),
    );
    const lucky = await captureTokenRequest(
      selectedModel,
      auth("provider-key"),
      rawBody,
    );
    const stableHeaders = [
      "accept",
      "authorization",
      "content-type",
      "session_id",
      "x-client-request-id",
      "x-provider-static",
    ] as const;

    expect(lucky.url).toBe(pi.url);
    expect(lucky.method).toBe(pi.method);
    expect(selectedHeaders(lucky, stableHeaders)).toEqual(selectedHeaders(pi, stableHeaders));
    await expect(requestJson(lucky)).resolves.toEqual(await requestJson(pi));
    expect(lucky.headers.has("x-stainless-retry-count")).toBe(false);
  });

  it("matches Pi's Azure SDK URL, auth, API version, and body shape", async () => {
    const selectedModel = model(
      "azure-openai-responses",
      "azure-openai-responses",
      "https://my-resource.openai.azure.com/openai/v1",
    );
    const projectedBody = {
      model: selectedModel.id,
      input: "hello",
      stream: true,
      future_provider_field: 42,
    };
    const rawBody = JSON.stringify({ ...projectedBody, model: "public-alias" });
    const pi = await capturePiRequest((fetch) =>
      streamAzureResponses(selectedModel, CONTEXT, {
        apiKey: "azure-key",
        fetch,
        sessionId: SESSION_ID,
        maxRetries: 0,
        onPayload: () => projectedBody,
      }),
    );
    const lucky = await captureTokenRequest(selectedModel, auth("azure-key"), rawBody);
    const stableHeaders = ["accept", "api-key", "content-type", "x-provider-static"] as const;

    expect(lucky.url).toBe(pi.url);
    expect(lucky.method).toBe(pi.method);
    expect(selectedHeaders(lucky, stableHeaders)).toEqual(selectedHeaders(pi, stableHeaders));
    await expect(requestJson(lucky)).resolves.toEqual(await requestJson(pi));
    expect(lucky.headers.has("authorization")).toBe(false);
  });

  it("matches Pi's Codex SSE URL, identity headers, session, zstd, and body shape", async () => {
    const selectedModel = model(
      "openai-codex",
      "openai-codex-responses",
      "https://chatgpt.com/backend-api",
    );
    const token = codexToken("acct-parity");
    const projectedBody = {
      model: selectedModel.id,
      input: "hello",
      stream: true,
      future_provider_field: ["preserved"],
    };
    const rawBody = JSON.stringify({ ...projectedBody, model: "public-alias" });
    const pi = await capturePiRequest((fetch) =>
      streamCodexResponses(selectedModel, CONTEXT, {
        apiKey: token,
        fetch,
        sessionId: SESSION_ID,
        maxRetries: 0,
        transport: "sse",
        onPayload: () => projectedBody,
      }),
    );
    const lucky = await captureTokenRequest(selectedModel, auth(token), rawBody);
    const stableHeaders = [
      "accept",
      "authorization",
      "chatgpt-account-id",
      "content-encoding",
      "content-type",
      "openai-beta",
      "originator",
      "session-id",
      "user-agent",
      "x-client-request-id",
      "x-provider-static",
    ] as const;

    expect(lucky.url).toBe(pi.url);
    expect(lucky.method).toBe(pi.method);
    expect(selectedHeaders(lucky, stableHeaders)).toEqual(selectedHeaders(pi, stableHeaders));
    await expect(requestJson(lucky)).resolves.toEqual(await requestJson(pi));
  });
});
