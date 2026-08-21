import type { FetchFunction, Model, Models } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { createAnthropicProviderNativeLane } from "../../src/provider-native-anthropic/index.js";

function model(api = "anthropic-messages", baseUrl = "https://provider.example.com/prefix"): Model<string> {
  return {
    id: "claude-test", name: "Claude Test", api, provider: "fixture", baseUrl,
    reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000, maxTokens: 100,
  };
}

function modelsWithAuth(auth: unknown): Pick<Models, "getAuth"> {
  return { getAuth: async () => auth } as unknown as Pick<Models, "getAuth">;
}

function request(signal?: AbortSignal): Request {
  return new Request("http://luckytoken.test/v1/messages", {
    method: "POST",
    headers: {
      authorization: "Bearer client-secret",
      cookie: "client-cookie",
      "anthropic-beta": "tools-2025-04-14",
      "x-stainless-timeout": "60000",
    },
    body: "{}",
    ...(signal === undefined ? {} : { signal }),
  });
}

function createLane(
  fetch: FetchFunction,
  auth: unknown = { auth: { apiKey: "provider-key" }, source: "fixture" },
  resolveRequestModel: (value: Model<string>) => Model<string> = (value) => value,
) {
  return createAnthropicProviderNativeLane({
    models: modelsWithAuth(auth), resolveRequestModel, fetch,
  });
}

describe("Anthropic Provider Native lane", () => {
  it("claims only an explicit anthropic-messages model capability", () => {
    const lane = createLane(async () => new Response());
    expect(lane.claims(model())).toBe(true);
    expect(lane.claims(model("openai-responses"))).toBe(false);
    expect(lane.claims({ ...model(), provider: "unrelated-vendor" })).toBe(true);
  });

  it("requires Provider-owned auth before dispatch", async () => {
    const fetch = vi.fn(async () => new Response());
    const onExecutionStart = vi.fn();
    const lane = createLane(fetch as unknown as FetchFunction, null);
    const result = await lane.execute({
      model: model(), rawBody: '{"model":"fixture/claude-test"}',
      request: request(), requestId: "req_client", onExecutionStart,
    });
    expect(result.outcome).toBe("failed");
    expect(result.response.status).toBe(502);
    expect(await result.response.text()).not.toContain("client-secret");
    expect(fetch).not.toHaveBeenCalled();
    expect(onExecutionStart).not.toHaveBeenCalled();
  });

  it("keeps auth-resolution failures diagnostic-only", async () => {
    const fetch = vi.fn(async () => new Response());
    const lane = createAnthropicProviderNativeLane({
      models: {
        getAuth: async () => {
          throw new Error("secret credential source failed");
        },
      } as unknown as Pick<Models, "getAuth">,
      resolveRequestModel: (value) => value,
      fetch: fetch as unknown as FetchFunction,
    });
    const result = await lane.execute({
      model: model(), rawBody: "{}", request: request(),
      requestId: "req_client", onExecutionStart: () => undefined,
    });

    expect(result.outcome).toBe("failed");
    if (result.outcome !== "failed") throw new Error("expected failure");
    expect(result.response.status).toBe(500);
    expect(await result.response.text()).not.toContain("secret credential source");
    expect(result.diagnostic?.error).toBeInstanceOf(Error);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("owns effective model, endpoint, credentials, header precedence and raw-wire dispatch", async () => {
    const rawBody = '{ "model": "fixture/claude-test", "max_tokens": 1, "messages": [] }';
    const calls: Array<readonly [RequestInfo | URL, RequestInit | undefined]> = [];
    const fetch: FetchFunction = async (input, init) => {
      calls.push([input, init]);
      return new Response('{"type":"message","model":"claude-test","content":[]}',
      { status: 201, headers: {
        "content-type": "application/json", "request-id": "req_upstream",
        "set-cookie": "upstream-cookie", "x-api-key": "echoed-secret",
        "x-ratelimit-remaining": "42",
      } });
    };
    const onExecutionStart = vi.fn();
    const lane = createLane(
      fetch,
      { auth: { apiKey: "provider-key", headers: {
        Authorization: "Bearer provider-token", "X-Api-Key": "must-not-win", "X-Operator": "operator",
      } }, source: "fixture" },
      (value) => ({ ...value, baseUrl: "https://effective.example.com/gateway" }),
    );
    const result = await lane.execute({
      model: model(), rawBody, request: request(), requestId: "req_client", onExecutionStart,
    });
    expect(result.outcome).toBe("success");
    expect(onExecutionStart).toHaveBeenCalledTimes(1);
    const call = calls[0];
    expect(String(call?.[0])).toBe("https://effective.example.com/gateway/v1/messages");
    expect(call?.[1]?.body).toBe('{"model":"claude-test","max_tokens":1,"messages":[]}');
    const headers = new Headers(call?.[1]?.headers);
    expect(headers.get("x-api-key")).toBe("provider-key");
    expect(headers.get("authorization")).toBe("Bearer provider-token");
    expect(headers.get("x-operator")).toBe("operator");
    expect(headers.get("anthropic-beta")).toBe("tools-2025-04-14");
    expect(headers.get("x-stainless-timeout")).toBe("60000");
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("content-length")).toBeNull();
    expect(result.response.status).toBe(201);
    expect(result.response.headers.get("request-id")).toBe("req_upstream");
    expect(result.response.headers.get("x-ratelimit-remaining")).toBe("42");
    expect(result.response.headers.get("set-cookie")).toBeNull();
    expect(result.response.headers.get("x-api-key")).toBeNull();
  });

  it("accepts header-only auth without fabricating an API key", async () => {
    let sentHeaders: Headers | undefined;
    const fetch: FetchFunction = async (_input, init) => {
      sentHeaders = new Headers(init?.headers);
      return new Response('{"type":"message","model":"claude-test"}',
        { headers: { "content-type": "application/json" } });
    };
    const lane = createLane(fetch, {
      auth: { headers: { Authorization: "Bearer header-token" } }, source: "fixture",
    });
    const result = await lane.execute({
      model: model(), rawBody: '{"model":"claude-test"}', request: request(),
      requestId: "req_client", onExecutionStart: () => undefined,
    });
    expect(result.outcome).toBe("success");
    expect(sentHeaders?.get("authorization")).toBe("Bearer header-token");
    expect(sentHeaders?.get("x-api-key")).toBeNull();
  });

  it("projects JSON and SSE model identity to the requested alias", async () => {
    const responses = [
      new Response('{"type":"message","model":"claude-test","content":[]}', { headers: { "content-type": "application/json" } }),
      new Response(
        'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-test"}}\n\n' +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      ),
    ];
    const lane = createLane(async () => responses.shift()!);
    const input = {
      model: model(), rawBody: '{"model":"fixture/claude-test"}', request: request(),
      alias: "public-claude", requestId: "req_client", onExecutionStart: () => undefined,
    } as const;
    const json = await lane.execute(input);
    const sse = await lane.execute(input);
    expect(await json.response.text()).toContain('"model":"public-claude"');
    const sseText = await sse.response.text();
    expect(sseText).toContain('"model":"public-claude"');
    expect(sseText).not.toContain("claude-test");
  });

  it("fails closed when alias projection cannot identify one safe model position", async () => {
    const lane = createLane(async () => new Response(
      '{"type":"message","model":"claude-test","tool":{"model":"semantic-value"}}',
      { headers: { "content-type": "application/json" } },
    ));
    const result = await lane.execute({
      model: model(), rawBody: '{"model":"fixture/claude-test"}', request: request(),
      alias: "public-claude", requestId: "req_client", onExecutionStart: () => undefined,
    });
    expect(result.outcome).toBe("failed");
    if (result.outcome !== "failed") throw new Error("expected failure");
    expect(result.response.status).toBe(502);
    expect(await result.response.text()).not.toContain("claude-test");
    expect(result.diagnostic?.error).toBeInstanceOf(Error);
  });

  it("preserves a safe upstream failure only when no alias could leak", async () => {
    const upstreamBody = '{"error":{"type":"rate_limit","message":"slow"}}';
    const lane = createLane(async () => new Response(upstreamBody, {
      status: 429, headers: { "content-type": "application/json", "request-id": "req_safe", "set-cookie": "secret" },
    }));
    const base = {
      model: model(), rawBody: '{"model":"claude-test"}', request: request(),
      requestId: "req_client", onExecutionStart: () => undefined,
    } as const;
    const unaliased = await lane.execute(base);
    const aliased = await lane.execute({ ...base, alias: "public-claude" });
    expect(unaliased.response.status).toBe(429);
    if (unaliased.outcome !== "failed") throw new Error("expected failure");
    expect(await unaliased.response.text()).toBe(upstreamBody);
    expect(unaliased.response.headers.get("set-cookie")).toBeNull();
    expect(unaliased.diagnostic).toMatchObject({ upstreamStatus: 429, safeRequestId: "req_safe" });
    expect(aliased.response.status).toBe(502);
    expect(await aliased.response.text()).not.toContain("slow");
  });

  it("renders transport failure safely and propagates caller cancellation", async () => {
    const failedLane = createLane(async () => { throw new Error("secret upstream host failed"); });
    const failed = await failedLane.execute({
      model: model(), rawBody: "{}", request: request(), requestId: "req_client", onExecutionStart: () => undefined,
    });
    expect(failed.outcome).toBe("failed");
    if (failed.outcome !== "failed") throw new Error("expected failure");
    expect(failed.response.status).toBe(502);
    expect(await failed.response.text()).not.toContain("secret upstream host");
    expect(failed.diagnostic?.error).toBeDefined();

    const controller = new AbortController();
    const cancelledLane = createLane(async (_input, init) => {
      controller.abort(new Error("client closed"));
      expect(init?.signal?.aborted).toBe(true);
      return await new Promise<Response>(() => undefined);
    });
    await expect(cancelledLane.execute({
      model: model(), rawBody: "{}", request: request(controller.signal),
      requestId: "req_client", onExecutionStart: () => undefined,
    })).rejects.toThrow("client closed");
  });
});
