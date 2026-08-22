import type { AuthResult, FetchFunction, Model } from "@earendil-works/pi-ai";
import { zstdDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  createProviderResponsesSender,
  type CreateProviderResponsesSenderOptions,
  supportsProviderNativeResponses,
} from "../../src/provider-native-responses/index.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000123";

function createResponsesNativeSender(
  options: Omit<CreateProviderResponsesSenderOptions, "sessionId"> & {
    readonly sessionId?: string;
  },
) {
  return createProviderResponsesSender({
    ...options,
    sessionId: options.sessionId ?? SESSION_ID,
  });
}

function model(
  provider: string,
  api: string,
  baseUrl: string,
  headers?: Record<string, string>,
): Model<string> {
  return {
    id: "real-model",
    name: "real-model",
    provider,
    api,
    baseUrl,
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 10_000,
    ...(headers === undefined ? {} : { headers }),
  };
}

function auth(
  value: AuthResult["auth"],
  env?: AuthResult["env"],
): AuthResult {
  return {
    auth: value,
    ...(env === undefined ? {} : { env }),
  };
}

function capture(): {
  readonly requests: Request[];
  readonly fetch: FetchFunction;
} {
  const requests: Request[] = [];
  return {
    requests,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as FetchFunction,
  };
}

async function requestJson(request: Request): Promise<Record<string, unknown>> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  const decoded =
    request.headers.get("content-encoding") === "zstd"
      ? zstdDecompressSync(bytes).toString("utf8")
      : new TextDecoder().decode(bytes);
  return JSON.parse(decoded) as Record<string, unknown>;
}

function codexToken(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

describe("Responses native provider sender", () => {
  it("preserves the raw request bytes exactly when the selected model already matches", async () => {
    const captured = capture();
    const sender = createResponsesNativeSender({
      model: model("openai", "openai-responses", "https://api.openai.com/v1"),
      auth: auth({ apiKey: "sk-openai" }),
      fetch: captured.fetch,
    });
    const raw = '{\n  "model" : "real-model",  "future_number":9007199254740993, "negative_zero":-0, "scientific":1e+30\n}';

    await sender!.send("responses", raw, AbortSignal.timeout(5_000));

    await expect(captured.requests[0]!.text()).resolves.toBe(raw);
  });

  it("patches only the top-level model literal without normalizing unrelated JSON tokens", async () => {
    const captured = capture();
    const sender = createResponsesNativeSender({
      model: model("openai", "openai-responses", "https://api.openai.com/v1"),
      auth: auth({ apiKey: "sk-openai" }),
      fetch: captured.fetch,
    });
    const raw = '{\n "model" : "alias", "future_number":9007199254740993, "negative_zero":-0, "scientific":1e+30, "nested":{"model":"leave-me"}\n}';
    const expected = raw.replace('"alias"', '"real-model"');

    await sender!.send("responses", raw, AbortSignal.timeout(5_000));

    await expect(captured.requests[0]!.text()).resolves.toBe(expected);
  });
  it("returns raw non-2xx upstream Responses instead of converting them into transport errors", async () => {
    const requests: Request[] = [];
    const fetch: FetchFunction = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return new Response("RAW_UPSTREAM_ERROR", {
        status: 429,
        headers: { "content-type": "text/plain", "x-upstream": "kept" },
      });
    }) as FetchFunction;
    const sender = createResponsesNativeSender({
      model: model("openai", "openai-responses", "https://api.openai.com/v1"),
      auth: auth({ apiKey: "sk-openai" }),
      fetch,
    });

    const response = await sender!.send(
      "responses",
      JSON.stringify({ model: "alias", input: "hello" }),
      AbortSignal.timeout(5_000),
    );

    expect(requests).toHaveLength(1);
    expect(response.status).toBe(429);
    await expect(response.text()).resolves.toBe("RAW_UPSTREAM_ERROR");
    expect(response.headers.get("x-upstream")).toBe("kept");
  });

  it("uses OpenAI baseURL semantics and preserves unknown body fields", async () => {
    const captured = capture();
    const sender = createResponsesNativeSender({
      model: model("openai", "openai-responses", "https://api.openai.com/v1"),
      auth: auth({ apiKey: "sk-openai" }),
      fetch: captured.fetch,
    });

    expect(sender).toBeDefined();
    await sender!.send(
      "responses",
      JSON.stringify({
        model: "client-alias",
        input: "hello",
        stream: false,
        future_field: { opaque: true },
      }),
      AbortSignal.timeout(5_000),
    );

    expect(captured.requests).toHaveLength(1);
    expect(captured.requests[0]?.url).toBe("https://api.openai.com/v1/responses");
    expect(captured.requests[0]?.headers.get("authorization")).toBe(
      "Bearer sk-openai",
    );
    expect(await requestJson(captured.requests[0]!)).toEqual({
      model: "real-model",
      input: "hello",
      stream: false,
      future_field: { opaque: true },
    });
  });

  it.each([
    ["xai", "https://api.x.ai/v1", "https://api.x.ai/v1/responses"],
    ["opencode", "https://opencode.ai/zen/v1", "https://opencode.ai/zen/v1/responses"],
    ["opencode-go", "https://opencode.ai/zen/go/v1", "https://opencode.ai/zen/go/v1/responses"],
  ])("uses the shared OpenAI Responses transport for %s", async (provider, baseUrl, expectedUrl) => {
    const captured = capture();
    const sender = createResponsesNativeSender({
      model: model(provider, "openai-responses", baseUrl),
      auth: auth({ apiKey: "provider-key" }),
      fetch: captured.fetch,
    });

    await sender!.send(
      "responses",
      JSON.stringify({ model: "alias", input: "hello" }),
      AbortSignal.timeout(5_000),
    );

    expect(captured.requests[0]?.url).toBe(expectedUrl);
    expect(captured.requests[0]?.headers.get("authorization")).toBe(
      "Bearer provider-key",
    );
  });

  it.each([
    ["openai", undefined, "session_id", true, false],
    ["xai", "openai-nosession", "session_id", false, false],
    ["xai", undefined, "x-session-id", true, true],
  ] as const)(
    "mirrors Pi %s session affinity headers",
    async (
      provider,
      sessionAffinityFormat,
      primaryHeader,
      primaryPresent,
      openRouterEndpoint,
    ) => {
      const captured = capture();
      const candidate = model(
        provider,
        "openai-responses",
        openRouterEndpoint
          ? "https://openrouter.ai/api/v1"
          : "https://responses.example.com/v1",
      );
      if (sessionAffinityFormat !== undefined) {
        (candidate as Model<"openai-responses">).compat = {
          sessionAffinityFormat,
        };
      }
      const sender = createResponsesNativeSender({
        model: candidate,
        auth: auth({ apiKey: "provider-key" }),
        fetch: captured.fetch,
      });

      await sender!.send(
        "responses",
        JSON.stringify({ model: "alias", input: "hello" }),
        AbortSignal.timeout(5_000),
      );

      const headers = captured.requests[0]!.headers;
      expect(headers.has(primaryHeader)).toBe(primaryPresent);
      if (primaryPresent) expect(headers.get(primaryHeader)).toBe(SESSION_ID);
      expect(headers.get("x-client-request-id")).toBe(
        openRouterEndpoint ? null : SESSION_ID,
      );
    },
  );

  it("does not extend ordinary Responses session affinity to Compact", async () => {
    const captured = capture();
    const sender = createResponsesNativeSender({
      model: model("openai", "openai-responses", "https://api.openai.com/v1"),
      auth: auth({ apiKey: "provider-key" }),
      fetch: captured.fetch,
    });

    await sender!.send(
      "compact",
      JSON.stringify({ model: "alias", input: [] }),
      AbortSignal.timeout(5_000),
    );

    const headers = captured.requests[0]!.headers;
    expect(headers.has("session_id")).toBe(false);
    expect(headers.has("x-client-request-id")).toBe(false);
    expect(headers.has("x-session-id")).toBe(false);
  });

  it("uses Cloudflare header-owned auth and materializes its gateway base URL", async () => {
    const captured = capture();
    const sender = createResponsesNativeSender({
      model: model(
        "cloudflare-ai-gateway",
        "openai-responses",
        "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/openai",
      ),
      auth: auth(
        {
          headers: {
            "cf-aig-authorization": "Bearer cf-secret",
            Authorization: null,
            "x-api-key": null,
          },
        },
        {
          CLOUDFLARE_ACCOUNT_ID: "account",
          CLOUDFLARE_GATEWAY_ID: "gateway",
        },
      ),
      fetch: captured.fetch,
    });

    await sender!.send(
      "responses",
      JSON.stringify({ model: "alias", input: "hello" }),
      AbortSignal.timeout(5_000),
    );

    expect(captured.requests[0]?.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/account/gateway/openai/responses",
    );
    expect(captured.requests[0]?.headers.get("cf-aig-authorization")).toBe(
      "Bearer cf-secret",
    );
    expect(captured.requests[0]?.headers.has("authorization")).toBe(false);
    expect(captured.requests[0]?.headers.has("x-api-key")).toBe(false);
  });

  it("adds Copilot dynamic Responses headers from the raw body", async () => {
    const captured = capture();
    const sender = createResponsesNativeSender({
      model: model(
        "github-copilot",
        "openai-responses",
        "https://api.individual.githubcopilot.com",
        { "Editor-Version": "vscode/test" },
      ),
      auth: auth({
        apiKey: "copilot-token",
        baseUrl: "https://api.enterprise.githubcopilot.example",
      }),
      fetch: captured.fetch,
    });

    await sender!.send(
      "responses",
      JSON.stringify({
        model: "alias",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "what is this" },
              { type: "input_image", image_url: "data:image/png;base64,AA==" },
            ],
          },
        ],
      }),
      AbortSignal.timeout(5_000),
    );

    expect(captured.requests[0]?.url).toBe(
      "https://api.enterprise.githubcopilot.example/responses",
    );
    expect(captured.requests[0]?.headers.get("editor-version")).toBe("vscode/test");
    expect(captured.requests[0]?.headers.get("x-initiator")).toBe("user");
    expect(captured.requests[0]?.headers.get("openai-intent")).toBe(
      "conversation-edits",
    );
    expect(captured.requests[0]?.headers.get("copilot-vision-request")).toBe(
      "true",
    );
  });

  it("builds the ChatGPT Codex SSE request from the OAuth token", async () => {
    const captured = capture();
    const sender = createResponsesNativeSender({
      model: model(
        "openai-codex",
        "openai-codex-responses",
        "https://chatgpt.com/backend-api",
      ),
      auth: auth({ apiKey: codexToken("acct_123") }),
      fetch: captured.fetch,
    });

    await sender!.send(
      "responses",
      JSON.stringify({ model: "alias", input: "hello", stream: true }),
      AbortSignal.timeout(5_000),
    );

    expect(captured.requests[0]?.url).toBe(
      "https://chatgpt.com/backend-api/codex/responses",
    );
    expect(captured.requests[0]?.headers.get("chatgpt-account-id")).toBe(
      "acct_123",
    );
    expect(captured.requests[0]?.headers.get("openai-beta")).toBe(
      "responses=experimental",
    );
    expect(captured.requests[0]?.headers.get("accept")).toBe("text/event-stream");
    expect(await requestJson(captured.requests[0]!)).toMatchObject({
      model: "real-model",
      input: "hello",
      stream: true,
    });
  });

  it("uses Azure Responses URL, api-version, api-key, and deployment mapping", async () => {
    const captured = capture();
    const sender = createResponsesNativeSender({
      model: model("azure-openai-responses", "azure-openai-responses", ""),
      auth: auth(
        { apiKey: "azure-key" },
        {
          AZURE_OPENAI_BASE_URL: "https://my-resource.openai.azure.com",
          AZURE_OPENAI_API_VERSION: "2026-01-01-preview",
          AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "real-model=my-deployment",
        },
      ),
      fetch: captured.fetch,
    });

    await sender!.send(
      "responses",
      JSON.stringify({ model: "alias", input: "hello" }),
      AbortSignal.timeout(5_000),
    );

    expect(captured.requests[0]?.url).toBe(
      "https://my-resource.openai.azure.com/openai/v1/responses?api-version=2026-01-01-preview",
    );
    expect(captured.requests[0]?.headers.get("api-key")).toBe("azure-key");
    expect(captured.requests[0]?.headers.has("authorization")).toBe(false);
    expect(await requestJson(captured.requests[0]!)).toMatchObject({
      model: "my-deployment",
      input: "hello",
    });
  });

  it.each([
    ["openai", "https://api.openai.com/v1", "https://api.openai.com/v1/responses/compact"],
    ["xai", "https://api.x.ai/v1", "https://api.x.ai/v1/responses/compact"],
    ["opencode", "https://opencode.ai/zen/v1", "https://opencode.ai/zen/v1/responses/compact"],
    ["opencode-go", "https://opencode.ai/zen/go/v1", "https://opencode.ai/zen/go/v1/responses/compact"],
  ])("builds native compact for %s OpenAI-style Responses", async (provider, baseUrl, expectedUrl) => {
    const captured = capture();
    const sender = createResponsesNativeSender({
      model: model(provider, "openai-responses", baseUrl),
      auth: auth({ apiKey: "key" }),
      fetch: captured.fetch,
    });

    expect(sender?.supportsNativeCompact).toBe(true);
    await sender!.send(
      "compact",
      JSON.stringify({ model: "alias", input: [], future_compact_field: true }),
      AbortSignal.timeout(5_000),
    );

    expect(captured.requests[0]?.url).toBe(expectedUrl);
    expect(await requestJson(captured.requests[0]!)).toMatchObject({
      model: "real-model",
      future_compact_field: true,
    });
  });

  it("builds native compact for Cloudflare AI Gateway and preserves header-owned auth", async () => {
    const captured = capture();
    const sender = createResponsesNativeSender({
      model: model(
        "cloudflare-ai-gateway",
        "openai-responses",
        "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/openai",
      ),
      auth: auth(
        {
          headers: {
            "cf-aig-authorization": "Bearer cf-secret",
            Authorization: null,
            "x-api-key": null,
          },
        },
        {
          CLOUDFLARE_ACCOUNT_ID: "account",
          CLOUDFLARE_GATEWAY_ID: "gateway",
        },
      ),
      fetch: captured.fetch,
    });

    expect(sender?.supportsNativeCompact).toBe(true);
    await sender!.send(
      "compact",
      JSON.stringify({ model: "alias", input: [] }),
      AbortSignal.timeout(5_000),
    );

    expect(captured.requests[0]?.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/account/gateway/openai/responses/compact",
    );
    expect(captured.requests[0]?.headers.get("cf-aig-authorization")).toBe(
      "Bearer cf-secret",
    );
    expect(captured.requests[0]?.headers.has("authorization")).toBe(false);
  });

  it("builds native compact for GitHub Copilot using the auth-derived base URL", async () => {
    const captured = capture();
    const sender = createResponsesNativeSender({
      model: model(
        "github-copilot",
        "openai-responses",
        "https://api.individual.githubcopilot.com",
        { "Editor-Version": "vscode/test" },
      ),
      auth: auth({
        apiKey: "copilot-key",
        baseUrl: "https://api.business.githubcopilot.com",
      }),
      fetch: captured.fetch,
    });

    expect(sender?.supportsNativeCompact).toBe(true);
    await sender!.send(
      "compact",
      JSON.stringify({ model: "alias", input: [{ role: "user", content: "hi" }] }),
      AbortSignal.timeout(5_000),
    );

    expect(captured.requests[0]?.url).toBe(
      "https://api.business.githubcopilot.com/responses/compact",
    );
    expect(captured.requests[0]?.headers.get("x-initiator")).toBe("user");
  });

  it("builds native Azure compact with deployment, api-version, and api-key auth", async () => {
    const captured = capture();
    const sender = createResponsesNativeSender({
      model: model("azure-openai-responses", "azure-openai-responses", ""),
      auth: auth(
        { apiKey: "azure-key" },
        {
          AZURE_OPENAI_BASE_URL: "https://my-resource.openai.azure.com",
          AZURE_OPENAI_API_VERSION: "2026-01-01-preview",
          AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "real-model=my-deployment",
        },
      ),
      fetch: captured.fetch,
    });

    expect(sender?.supportsNativeCompact).toBe(true);
    await sender!.send(
      "compact",
      JSON.stringify({ model: "alias", input: [] }),
      AbortSignal.timeout(5_000),
    );

    expect(captured.requests[0]?.url).toBe(
      "https://my-resource.openai.azure.com/openai/v1/responses/compact?api-version=2026-01-01-preview",
    );
    expect(captured.requests[0]?.headers.get("api-key")).toBe("azure-key");
    expect(await requestJson(captured.requests[0]!)).toMatchObject({
      model: "my-deployment",
    });
  });

  it("exposes native compact for every supported Responses provider/protocol pair", () => {
    const models = [
      model("openai", "openai-responses", "https://api.openai.com/v1"),
      model("xai", "openai-responses", "https://api.x.ai/v1"),
      model("opencode", "openai-responses", "https://opencode.ai/zen/v1"),
      model("opencode-go", "openai-responses", "https://opencode.ai/zen/go/v1"),
      model(
        "cloudflare-ai-gateway",
        "openai-responses",
        "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/openai",
      ),
      model("github-copilot", "openai-responses", "https://api.individual.githubcopilot.com"),
      model("openai-codex", "openai-codex-responses", "https://chatgpt.com/backend-api"),
      model("azure-openai-responses", "azure-openai-responses", ""),
    ];

    for (const candidate of models) {
      expect(supportsProviderNativeResponses(candidate)).toBe(true);
    }
  });
});
