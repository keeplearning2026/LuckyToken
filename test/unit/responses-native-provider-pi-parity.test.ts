import {
  hasApi,
  normalizeContext,
  type AssistantMessageEventStream,
  type AuthResult,
  type FetchFunction,
  type Model,
} from "@earendil-works/pi-ai";
import { stream as streamAzureResponses } from "@earendil-works/pi-ai/api/azure-openai-responses";
import { stream as streamCodexResponses } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { stream as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { zstdDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { createProviderResponsesSender } from "../../src/provider-native-responses/index.js";
import { PROVIDER_NATIVE_RESPONSES_CERTIFIED } from "../../src/provider-native-responses/certification.js";
import { COMMANDCODE_GOAT_MODELS } from "../../packages/provider-commandcode-goat/src/models.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000123";
const CONTEXT = normalizeContext({ messages: [] });
const OPENAI_BASE_URLS: Readonly<Record<string, string>> = {
  openai: "https://api.openai.com/v1",
  xai: "https://api.x.ai/v1",
  opencode: "https://opencode.ai/zen/v1",
  "opencode-go": "https://opencode.ai/zen/go/v1",
  "cloudflare-ai-gateway": "https://gateway.example.com/openai",
  "github-copilot": "https://api.githubcopilot.com",
  "commandcode-goat": "https://api.commandcode.ai/provider/v1",
};
const OPENAI_CASES = PROVIDER_NATIVE_RESPONSES_CERTIFIED
  .filter((entry) => entry.transport === "openai" && entry.provider !== "commandcode-goat")
  .flatMap((entry) =>
    entry.authTypes.flatMap((authType) =>
      entry.operations.map((operation) => ({
        provider: entry.provider,
        api: entry.api,
        operation,
        authType,
        baseUrl: OPENAI_BASE_URLS[entry.provider],
      })),
    ),
  );
const GOAT_AUTH_TYPES = PROVIDER_NATIVE_RESPONSES_CERTIFIED.find(
  (entry) => entry.provider === "commandcode-goat",
)?.authTypes ?? [];
const AZURE_AUTH_TYPES = PROVIDER_NATIVE_RESPONSES_CERTIFIED.find(
  (entry) => entry.transport === "azure",
)?.authTypes ?? [];

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
  operation: "responses" | "compact" = "responses",
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
    ...(operation === "responses" ? { sessionId: SESSION_ID } : {}),
  });
  await sender!.send(operation, rawBody, AbortSignal.timeout(5_000));
  return captured!;
}

/**
 * The complete outbound header set, sorted so the comparison is order-free.
 * Provider Native parity is "the whole envelope matches Pi", not "a reviewed
 * subset matches", so no header may be excluded here.
 */
function fullHeaders(request: Request): Record<string, string> {
  return Object.fromEntries(
    [...request.headers.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

async function requestJson(request: Request): Promise<Record<string, unknown>> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  const text = request.headers.get("content-encoding") === "zstd"
    ? zstdDecompressSync(bytes).toString("utf8")
    : new TextDecoder().decode(bytes);
  return JSON.parse(text) as Record<string, unknown>;
}

describe("Provider Native Responses Pi HTTP parity", () => {
  it.each(GOAT_AUTH_TYPES)("matches pinned Pi for real CommandCode Goat Responses with %s auth", async () => {
    const selectedModel = COMMANDCODE_GOAT_MODELS.find(
      (entry) => entry.id === "deepseek/deepseek-v4.1-flash",
    );
    expect(selectedModel).toMatchObject({
      provider: "commandcode-goat",
      api: "openai-responses",
      baseUrl: "https://api.commandcode.ai/provider/v1",
    });
    if (selectedModel === undefined || !hasApi(selectedModel, "openai-responses")) {
      throw new Error("CommandCode Goat Responses parity model is unavailable");
    }
    const projectedBody = {
      model: selectedModel.id,
      input: "hello",
      stream: true,
      future_provider_field: { preserved: true },
    };
    const rawBody = JSON.stringify({
      ...projectedBody,
      model: "commandcode-goat/public-alias",
    });
    const pi = await capturePiRequest((fetch) =>
      streamOpenAIResponses(selectedModel, CONTEXT, {
        apiKey: "goat-key",
        fetch,
        sessionId: SESSION_ID,
        maxRetries: 0,
        onPayload: () => projectedBody,
      }),
    );
    const lucky = await captureTokenRequest(
      selectedModel,
      auth("goat-key"),
      rawBody,
    );
    expect(lucky.url).toBe(pi.url);
    expect(lucky.method).toBe(pi.method);
    expect(fullHeaders(lucky)).toEqual(fullHeaders(pi));
    await expect(requestJson(lucky)).resolves.toEqual(await requestJson(pi));
  });

  it.each(OPENAI_CASES.filter((entry) => entry.operation === "responses"))(
    "matches pinned Pi's complete $provider/$api/$operation/$authType envelope",
    async ({ provider, baseUrl }) => {
      if (baseUrl === undefined) throw new Error(`Missing parity URL for ${provider}`);
      const selectedModel = model(provider, "openai-responses", baseUrl);
      const projectedBody = {
        model: selectedModel.id,
        input: "hello",
        stream: true,
        future_provider_field: { enabled: true },
      };
      const rawBody = JSON.stringify({
        ...projectedBody,
        model: "public-alias",
      });
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
      expect(lucky.url).toBe(pi.url);
      expect(lucky.method).toBe(pi.method);
      expect(fullHeaders(lucky)).toEqual(fullHeaders(pi));
      await expect(requestJson(lucky)).resolves.toEqual(await requestJson(pi));
    },
  );

  it.each(OPENAI_CASES.filter((entry) => entry.operation === "compact"))(
    "matches Pi's SDK-owned header envelope for $provider/$api/$operation/$authType",
    async ({ provider, baseUrl }) => {
      if (baseUrl === undefined) throw new Error(`Missing parity URL for ${provider}`);
      const selectedModel = model(provider, "openai-responses", baseUrl);
      const compactBody = {
        model: selectedModel.id,
        input: [],
        future_provider_field: { compact: true },
      };
      const pi = await capturePiRequest((fetch) =>
        streamOpenAIResponses(selectedModel, CONTEXT, {
          apiKey: "provider-key",
          fetch,
          maxRetries: 0,
          onPayload: () => ({
            model: selectedModel.id,
            input: "header-reference",
            stream: true,
          }),
        }),
      );
      const lucky = await captureTokenRequest(
        selectedModel,
        auth("provider-key"),
        JSON.stringify({ ...compactBody, model: "public-alias" }),
        "compact",
      );

      expect(lucky.method).toBe(pi.method);
      expect(fullHeaders(lucky)).toEqual(fullHeaders(pi));
      expect(lucky.url).toBe(
        `${baseUrl.replace(/\/+$/u, "")}/responses/compact`,
      );
      await expect(requestJson(lucky)).resolves.toEqual(compactBody);
    },
  );

  it.each(AZURE_AUTH_TYPES)("matches Pi's Azure SDK URL, auth, API version, and body shape with %s auth", async () => {
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
    expect(lucky.url).toBe(pi.url);
    expect(lucky.method).toBe(pi.method);
    expect(fullHeaders(lucky)).toEqual(fullHeaders(pi));
    await expect(requestJson(lucky)).resolves.toEqual(await requestJson(pi));
  });

  it.each(AZURE_AUTH_TYPES)("matches the pinned Azure SDK-owned header envelope for compact with %s auth", async () => {
    const selectedModel = model(
      "azure-openai-responses",
      "azure-openai-responses",
      "https://my-resource.openai.azure.com/openai/v1",
    );
    const pi = await capturePiRequest((fetch) =>
      streamAzureResponses(selectedModel, CONTEXT, {
        apiKey: "azure-key",
        fetch,
        maxRetries: 0,
        onPayload: () => ({
          model: selectedModel.id,
          input: "header-reference",
          stream: true,
        }),
      }),
    );
    const compactBody = {
      model: selectedModel.id,
      input: [],
      future_provider_field: { compact: true },
    };
    const lucky = await captureTokenRequest(
      selectedModel,
      auth("azure-key"),
      JSON.stringify({ ...compactBody, model: "public-alias" }),
      "compact",
    );

    expect(lucky.method).toBe(pi.method);
    expect(fullHeaders(lucky)).toEqual(fullHeaders(pi));
    expect(lucky.url).toBe(
      "https://my-resource.openai.azure.com/openai/v1/responses/compact?api-version=v1",
    );
    await expect(requestJson(lucky)).resolves.toEqual(compactBody);
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
    expect(lucky.url).toBe(pi.url);
    expect(lucky.method).toBe(pi.method);
    expect(fullHeaders(lucky)).toEqual(fullHeaders(pi));
    await expect(requestJson(lucky)).resolves.toEqual(await requestJson(pi));
  });

  it("keeps the pinned Pi Codex identity envelope on compact without Responses-only headers", async () => {
    const selectedModel = model(
      "openai-codex",
      "openai-codex-responses",
      "https://chatgpt.com/backend-api",
    );
    const token = codexToken("acct-compact-parity");
    const pi = await capturePiRequest((fetch) =>
      streamCodexResponses(selectedModel, CONTEXT, {
        apiKey: token,
        fetch,
        sessionId: SESSION_ID,
        maxRetries: 0,
        transport: "sse",
        onPayload: () => ({
          model: selectedModel.id,
          input: "header-reference",
          stream: true,
        }),
      }),
    );
    const compactBody = {
      model: selectedModel.id,
      input: [],
      future_provider_field: { compact: true },
    };
    const lucky = await captureTokenRequest(
      selectedModel,
      auth(token),
      JSON.stringify({ ...compactBody, model: "public-alias" }),
      "compact",
    );

    expect(lucky.method).toBe(pi.method);
    expect(lucky.url).toBe(
      "https://chatgpt.com/backend-api/codex/responses/compact",
    );
    expect(fullHeaders(lucky)).toEqual({
      accept: "application/json",
      authorization: pi.headers.get("authorization")!,
      "chatgpt-account-id": pi.headers.get("chatgpt-account-id")!,
      "content-type": "application/json",
      originator: pi.headers.get("originator")!,
      "user-agent": pi.headers.get("user-agent")!,
      "x-provider-static": "provider-value",
    });
    await expect(requestJson(lucky)).resolves.toEqual(compactBody);
  });
});
