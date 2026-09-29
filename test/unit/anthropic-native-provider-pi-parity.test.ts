import {
  normalizeContext,
  type AssistantMessageEventStream,
  type FetchFunction,
  type Model,
} from "@earendil-works/pi-ai";
import { stream as streamAnthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { describe, expect, it } from "vitest";

import { passthroughAnthropicRequest } from "../../src/provider-native-anthropic/transport.js";
import { ANTHROPIC_NATIVE_CERTIFIED } from "../../src/provider-native-anthropic/certification.js";
import { anthropicBetaFeatures } from "../../src/provider-native-anthropic/envelope.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000123";
const CONTEXT = normalizeContext({ messages: [] });
const COPILOT_AUTH_TYPES = ANTHROPIC_NATIVE_CERTIFIED.find(
  (entry) => entry.provider === "github-copilot",
)?.authTypes ?? [];
const CLOUDFLARE_AUTH_TYPES = ANTHROPIC_NATIVE_CERTIFIED.find(
  (entry) => entry.provider === "cloudflare-ai-gateway",
)?.authTypes ?? [];

function model(
  provider: string,
  baseUrl: string,
): Model<"anthropic-messages"> {
  return {
    id: "claude-sonnet-4-5",
    name: "claude-sonnet-4-5",
    provider,
    api: "anthropic-messages",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_000,
    headers: { "x-provider-static": "provider-value" },
  } as Model<"anthropic-messages">;
}

function body(): string {
  return JSON.stringify({
    model: "anthropic/claude-sonnet",
    max_tokens: 32,
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  });
}

/** The model's static headers, as a non-optional record for strict callers. */
function staticHeaders(selected: Model<string>): Record<string, string> {
  return (selected.headers ?? {}) as Record<string, string>;
}

async function drain(stream: AssistantMessageEventStream): Promise<void> {
  for await (const event of stream) void event;
}

async function capturePiRequest(
  start: (fetch: FetchFunction) => AssistantMessageEventStream,
): Promise<Request> {
  let captured: Request | undefined;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured = new Request(input, init);
    return new Response("request captured", { status: 400 });
  }) as FetchFunction;
  await drain(start(fetch));
  if (captured === undefined) throw new Error("Pi did not dispatch a request");
  return captured;
}

async function captureNativeRequest(options: {
  readonly model: Model<string>;
  readonly apiKey?: string;
  readonly authMode: "api_key" | "oauth" | "github_copilot" | "ambient";
  readonly sessionId?: string;
  readonly composedHeaders?: Readonly<Record<string, string | null>>;
}): Promise<Request> {
  let captured: Request | undefined;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured = new Request(input, init);
    return new Response('{"type":"message"}', { status: 200 });
  }) as FetchFunction;
  await passthroughAnthropicRequest({
    model: options.model,
    rawBody: body(),
    apiKey: options.apiKey,
    signal: AbortSignal.timeout(5_000),
    fetch,
    bodyProjectionMode: "model_only",
    authMode: options.authMode,
    ...(options.sessionId === undefined
      ? {}
      : { sessionId: options.sessionId }),
    attempt: 1,
    composedHeaders:
      options.composedHeaders ?? staticHeaders(options.model),
  });
  if (captured === undefined) {
    throw new Error("Provider Native did not dispatch a request");
  }
  return captured;
}

/**
 * Provider Native must look like Pi on the whole envelope, not on a reviewed
 * subset: every header, the method, and the URL are compared.
 */
function fullHeaders(request: Request): Record<string, string> {
  return Object.fromEntries(
    [...request.headers.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

describe("Anthropic Provider Native Pi HTTP parity", () => {
  it("matches Pi's api-key envelope", async () => {
    const selected = model("anthropic", "https://api.anthropic.com");
    const pi = await capturePiRequest((fetch) =>
      streamAnthropicMessages(selected, CONTEXT, {
        apiKey: "sk-ant-api-key",
        fetch,
        maxRetries: 0,
        headers: staticHeaders(selected),
      }),
    );
    const native = await captureNativeRequest({
      model: selected,
      apiKey: "sk-ant-api-key",
      authMode: "api_key",
    });

    expect(native.method).toBe(pi.method);
    expect(native.url).toBe(pi.url);
    expect(fullHeaders(native)).toEqual(fullHeaders(pi));
  });

  it("matches Pi's ambient API-key envelope without inferring a managed auth type", async () => {
    const selected = model("anthropic", "https://api.anthropic.com");
    const pi = await capturePiRequest((fetch) =>
      streamAnthropicMessages(selected, CONTEXT, {
        apiKey: "ambient-provider-key",
        fetch,
        maxRetries: 0,
        headers: staticHeaders(selected),
      }),
    );
    const native = await captureNativeRequest({
      model: selected,
      apiKey: "ambient-provider-key",
      authMode: "ambient",
    });

    expect(native.method).toBe(pi.method);
    expect(native.url).toBe(pi.url);
    expect(fullHeaders(native)).toEqual(fullHeaders(pi));
  });

  it("preserves projected JSON semantics without injecting body fields", async () => {
    const selected = model("anthropic", "https://api.anthropic.com");
    const native = await captureNativeRequest({
      model: selected,
      apiKey: "sk-ant-api-key",
      authMode: "api_key",
    });

    await expect(native.json()).resolves.toEqual({
      model: selected.id,
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
  });

  it("matches Pi's OAuth (Claude Code identity) envelope", async () => {
    const selected = model("anthropic", "https://api.anthropic.com");
    const oauthKey = "sk-ant-oat01-parity";
    const pi = await capturePiRequest((fetch) =>
      streamAnthropicMessages(selected, CONTEXT, {
        apiKey: oauthKey,
        fetch,
        maxRetries: 0,
        headers: staticHeaders(selected),
      }),
    );
    const native = await captureNativeRequest({
      model: selected,
      apiKey: oauthKey,
      authMode: "oauth",
    });

    expect(native.method).toBe(pi.method);
    expect(native.url).toBe(pi.url);
    expect(fullHeaders(native)).toEqual(fullHeaders(pi));
  });

  it.each(COPILOT_AUTH_TYPES)("matches Pi's GitHub Copilot envelope with %s auth", async (authMode) => {
    const selected = model("github-copilot", "https://api.githubcopilot.com");
    const pi = await capturePiRequest((fetch) =>
      streamAnthropicMessages(selected, CONTEXT, {
        apiKey: "copilot-token",
        fetch,
        maxRetries: 0,
        headers: staticHeaders(selected),
      }),
    );
    const native = await captureNativeRequest({
      model: selected,
      apiKey: "copilot-token",
      authMode,
    });

    expect(native.method).toBe(pi.method);
    expect(native.url).toBe(pi.url);
    expect(fullHeaders(native)).toEqual(fullHeaders(pi));
  });

  it.each(CLOUDFLARE_AUTH_TYPES)("matches Pi's Cloudflare AI Gateway envelope with composed headers and %s auth", async (authMode) => {
    const selected = model(
      "cloudflare-ai-gateway",
      "https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic",
    );
    const pi = await capturePiRequest((fetch) =>
      streamAnthropicMessages(selected, CONTEXT, {
        apiKey: "cf-aig-key",
        fetch,
        maxRetries: 0,
        headers: staticHeaders(selected),
      }),
    );
    const native = await captureNativeRequest({
      model: selected,
      apiKey: "cf-aig-key",
      authMode,
    });

    expect(native.method).toBe(pi.method);
    expect(native.url).toBe(pi.url);
    expect(fullHeaders(native)).toEqual(fullHeaders(pi));
  });

  it("locks the bounded Cloudflare header-only auth exception until pinned Pi dispatches it", async () => {
    const selected = model(
      "cloudflare-ai-gateway",
      "https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic",
    );
    const composedHeaders = {
      ...staticHeaders(selected),
      "cf-aig-authorization": "Bearer cf-header-only",
    } as const;

    let piRequest: Request | undefined;
    const piFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      piRequest = new Request(input, init);
      return new Response("request captured", { status: 400 });
    }) as FetchFunction;
    await drain(
      streamAnthropicMessages(selected, CONTEXT, {
        fetch: piFetch,
        maxRetries: 0,
        headers: composedHeaders,
      }),
    );

    // The real Cloudflare binding supplies only cf-aig-authorization. Pi
    // accepts it in assertRequestAuth, but its SDK client rejects before fetch
    // unless x-api-key/authorization is explicitly omitted with a null header.
    // When Pi dispatches this exact binding, this assertion turns red so the
    // lane's bounded escape hatch can be removed.
    expect(piRequest).toBeUndefined();

    const native = await captureNativeRequest({
      model: selected,
      authMode: "ambient",
      composedHeaders,
    });
    expect(native.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic/v1/messages?beta=true",
    );
    expect(native.headers.get("cf-aig-authorization")).toBe(
      "Bearer cf-header-only",
    );
    expect(native.headers.get("authorization")).toBeNull();
    expect(native.headers.get("x-api-key")).toBeNull();
  });

  it("matches Pi when Cloudflare header-only auth explicitly omits SDK auth headers", async () => {
    const selected = model(
      "cloudflare-ai-gateway",
      "https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic",
    );
    const composedHeaders = {
      ...staticHeaders(selected),
      "cf-aig-authorization": "Bearer cf-header-only",
      authorization: null,
      "x-api-key": null,
    } as const;
    const pi = await capturePiRequest((fetch) =>
      streamAnthropicMessages(selected, CONTEXT, {
        fetch,
        maxRetries: 0,
        headers: composedHeaders,
      }),
    );
    const native = await captureNativeRequest({
      model: selected,
      authMode: "ambient",
      composedHeaders,
    });
    expect(native.method).toBe(pi.method);
    expect(native.url).toBe(pi.url);
    expect(fullHeaders(native)).toEqual(fullHeaders(pi));
  });

  it("matches Pi's OpenRouter-hosted session affinity default", async () => {
    const selected = model("anthropic", "https://openrouter.ai/api/v1");
    const pi = await capturePiRequest((fetch) =>
      streamAnthropicMessages(selected, CONTEXT, {
        apiKey: "sk-ant-api-key",
        fetch,
        sessionId: SESSION_ID,
        maxRetries: 0,
        headers: staticHeaders(selected),
      }),
    );
    const native = await captureNativeRequest({
      model: selected,
      apiKey: "sk-ant-api-key",
      authMode: "api_key",
      sessionId: SESSION_ID,
    });

    expect(native.method).toBe(pi.method);
    expect(native.url).toBe(pi.url);
    expect(fullHeaders(native)).toEqual(fullHeaders(pi));
  });

  it("records Pi's Context-only mid-conversation tool-change beta as a Native omission", async () => {
    const selected = {
      ...model("anthropic", "https://api.anthropic.com"),
      compat: {
        supportsMidConvoSystemMessages: true,
        supportsMidConvoToolChanges: true,
      },
    } as unknown as Model<"anthropic-messages">;
    const tool = {
      name: "lookup",
      description: "Lookup",
      parameters: { type: "object" as const },
    };
    const context = normalizeContext({
      messages: [
        { role: "system", content: "base", toolsAdded: [tool], timestamp: 0 },
        { role: "user", content: "before", timestamp: 1 },
        { role: "system", content: "more", timestamp: 2 },
      ],
    });
    const pi = await capturePiRequest((fetch) =>
      streamAnthropicMessages(selected, context, {
        apiKey: "sk-ant-api-key",
        fetch,
        maxRetries: 0,
      }),
    );
    expect(pi.headers.get("anthropic-beta")).toContain(
      "mid-conversation-tool-changes-2026-07-01",
    );
    expect(
      anthropicBetaFeatures(selected, JSON.parse(body()) as Record<string, unknown>, "api_key", undefined),
    ).not.toContain("mid-conversation-tool-changes-2026-07-01");
  });
});
