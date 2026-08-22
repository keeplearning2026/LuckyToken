import type { FetchFunction, Model, Models } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { createAnthropicProviderNativeLane } from "../../src/provider-native-anthropic/index.js";
import {
  ambientProfileBindings,
  fixedManagedProfileBindings,
} from "../support/profile-binding-fixture.js";
import type {
  ManagedProviderAuthBindingCapture,
  ProviderAuthBindingCapture,
} from "../../src/credentials/profile-contract.js";

function model(api = "anthropic-messages", baseUrl = "https://provider.example.com/prefix"): Model<string> {
  return {
    id: "claude-test", name: "Claude Test", api, provider: "anthropic", baseUrl,
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
  bindings = ambientProfileBindings,
) {
  return createAnthropicProviderNativeLane({
    models: modelsWithAuth(auth),
    bindings,
    resolveRequestModel,
    fetch,
  });
}

describe("Anthropic Provider Native lane", () => {
  it("claims only an explicit anthropic-messages model capability", () => {
    const lane = createLane(async () => new Response());
    expect(lane.claims(model())).toBe(true);
    expect(lane.claims(model("openai-responses"))).toBe(false);
    expect(lane.claims({ ...model(), provider: "unrelated-vendor" })).toBe(false);
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

  it("projects a validated final-429 Retry-After fact into its own Profile transition", async () => {
    let transitionInput: unknown;
    const managed = fixedManagedProfileBindings("api_key");
    const lane = createLane(
      async () => new Response("limited", {
        status: 429,
        headers: { "retry-after": "2" },
      }),
      { auth: { apiKey: "provider-key" }, source: "fixture" },
      (value) => value,
      {
        capture: managed.capture,
        runBound: managed.runBound,
        advanceAfterFinal429: async (input) => {
          transitionInput = input;
          return { outcome: "exhausted" };
        },
      },
    );

    const result = await lane.execute({
      model: model(),
      rawBody: '{"model":"fixture/claude-test","messages":[]}',
      request: request(),
      requestId: "req_client",
      onExecutionStart: () => undefined,
    });

    expect(result.outcome).toBe("failed");
    expect(transitionInput).toMatchObject({
      attemptedCredentialIds: ["credential-a"],
      retryAfterMs: 2_000,
    });
  });

  it("stops after three outer Profile attempts even if a binding Adapter keeps switching", async () => {
    const captures: ManagedProviderAuthBindingCapture[] = [1, 2, 3, 4].map((index) => ({
      facts: {
        kind: "managed",
        providerId: "fixture",
        credentialId: `credential-${index}`,
        authType: "api_key",
        authMethodLabel: "Fixture credentials",
        displayName: `Profile ${index}`,
        credentialGeneration: `credential-generation-${index}`,
        selectionGeneration: `selection-generation-${index}`,
      },
    }));
    let transitions = 0;
    let calls = 0;
    const lane = createLane(
      async () => {
        calls += 1;
        return new Response("limited", { status: 429 });
      },
      { auth: { apiKey: "provider-key" }, source: "fixture" },
      (value) => value,
      {
        capture: async () => captures[0]!,
        runBound: async <T>(_binding: ProviderAuthBindingCapture, operation: () => Promise<T>) =>
          operation(),
        advanceAfterFinal429: async () => ({
          outcome: "switched",
          capture: captures[++transitions]!,
        }),
      },
    );

    const result = await lane.execute({
      model: model(),
      rawBody: '{"model":"fixture/claude-test","messages":[]}',
      request: request(),
      requestId: "req_client",
      onExecutionStart: () => undefined,
    });

    expect(result.outcome).toBe("failed");
    expect(calls).toBe(3);
    expect(transitions).toBe(2);
  });

  it("keeps auth-resolution failures diagnostic-only", async () => {
    const fetch = vi.fn(async () => new Response());
    const lane = createAnthropicProviderNativeLane({
      models: {
        getAuth: async () => {
          throw new Error("secret credential source failed");
        },
      } as unknown as Pick<Models, "getAuth">,
      bindings: ambientProfileBindings,
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
    expect(call?.[1]?.body).toBe(
      '{ "model": "claude-test", "max_tokens": 1, "messages": [] }',
    );
    const headers = new Headers(call?.[1]?.headers);
    expect(headers.get("x-api-key")).toBe("provider-key");
    expect(headers.get("authorization")).toBe("Bearer provider-token");
    expect(headers.get("x-operator")).toBe("operator");
    expect(headers.get("anthropic-beta")).not.toBe("tools-2025-04-14");
    expect(headers.get("x-stainless-timeout")).not.toBe("60000");
    expect(headers.get("authorization")).not.toBe("Bearer client-secret");
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("content-length")).toBeNull();
    expect(result.response.status).toBe(201);
    expect(result.response.headers.get("request-id")).toBe("req_upstream");
    expect(result.response.headers.get("x-ratelimit-remaining")).toBe("42");
    expect(result.response.headers.get("set-cookie")).toBeNull();
    expect(result.response.headers.get("x-api-key")).toBeNull();
  });

  it("selects the closed Anthropic OAuth body and envelope differential from the managed binding", async () => {
    let upstreamRequest: Request | undefined;
    const captures: unknown[] = [];
    const attempts: unknown[] = [];
    const lane = createLane(
      async (input, init) => {
        upstreamRequest = new Request(input, init);
        return new Response(
          '{"type":"message","model":"claude-test","content":[]}',
          { headers: { "content-type": "application/json" } },
        );
      },
      { auth: { apiKey: "not-an-oauth-shaped-token" }, source: "fixture" },
      (value) => value,
      fixedManagedProfileBindings("oauth"),
    );
    const rawBody = JSON.stringify({
      model: "anthropic/claude-test",
      system: "Client instruction",
      tools: [
        { name: "read", input_schema: { type: "object", properties: {} } },
      ],
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "bash", input: {} },
          ],
        },
      ],
    });

    const result = await lane.execute({
      model: { ...model(), provider: "anthropic" },
      rawBody,
      request: request(),
      requestId: "req_client",
      sessionId: "session-client",
      onExecutionStart: () => undefined,
      credentialActivity: {
        credentialCaptured: (capture) => captures.push(capture),
        credentialAttempt: (attempt) => attempts.push(attempt),
      },
    });

    expect(result.outcome).toBe("success");
    const sent = JSON.parse(await upstreamRequest!.text()) as Record<
      string,
      unknown
    >;
    expect(sent).toMatchObject({
      model: "claude-test",
      system: [
        {
          type: "text",
          text: "You are Claude Code, Anthropic's official CLI for Claude.",
        },
        { type: "text", text: "Client instruction" },
      ],
      tools: [{ name: "Read" }],
      messages: [
        { content: [{ type: "tool_use", name: "Bash" }] },
      ],
    });
    expect(upstreamRequest!.headers.get("authorization")).toBe(
      "Bearer not-an-oauth-shaped-token",
    );
    expect(upstreamRequest!.headers.get("x-api-key")).toBeNull();
    expect(upstreamRequest!.headers.get("user-agent")).toBe("claude-cli/2.1.75");
    expect(upstreamRequest!.headers.get("x-app")).toBe("cli");
    expect(upstreamRequest!.headers.get("anthropic-beta")).toContain(
      "claude-code-20250219",
    );
    expect(upstreamRequest!.headers.get("anthropic-beta")).toContain(
      "oauth-2025-04-20",
    );
    expect(upstreamRequest!.headers.get("x-session-affinity")).toBeNull();
    expect(captures).toEqual([
      expect.objectContaining({
        authType: "oauth",
        authMethodLabel: "Account",
        lane: "provider_native",
        selectionReason: "active",
      }),
    ]);
    expect(attempts).toEqual([
      expect.objectContaining({ attempt: 1, outcome: "success" }),
    ]);
  });

  it("does not select OAuth behavior from token text or an ambient binding", async () => {
    const bodies: string[] = [];
    const headers: Headers[] = [];
    const fetch: FetchFunction = async (input, init) => {
      const sent = new Request(input, init);
      bodies.push(await sent.text());
      headers.push(sent.headers);
      return new Response(
        '{"type":"message","model":"claude-test","content":[]}',
        { headers: { "content-type": "application/json" } },
      );
    };
    const auth = {
      auth: { apiKey: "sk-ant-oat-misleading-text" },
      source: "fixture",
    };
    const managedApiKey = createLane(
      fetch,
      auth,
      (value) => value,
      fixedManagedProfileBindings("api_key"),
    );
    const ambient = createLane(fetch, auth);
    const input = {
      model: { ...model(), provider: "anthropic" },
      rawBody: '{ "model": "anthropic/claude-test", "messages": [] }',
      request: request(),
      requestId: "req_client",
      sessionId: "session-client",
      onExecutionStart: () => undefined,
    } as const;

    await managedApiKey.execute(input);
    await ambient.execute(input);

    expect(bodies).toEqual([
      '{ "model": "claude-test", "messages": [] }',
      '{ "model": "claude-test", "messages": [] }',
    ]);
    expect(headers[0]!.get("x-api-key")).toBe("sk-ant-oat-misleading-text");
    expect(headers[0]!.get("authorization")).toBeNull();
    expect(headers[1]!.get("x-api-key")).toBe("sk-ant-oat-misleading-text");
    expect(headers[1]!.get("authorization")).toBeNull();
  });

  it("projects validated session affinity only for models that declare it", async () => {
    const sent: Request[] = [];
    const lane = createLane(
      async (input, init) => {
        sent.push(new Request(input, init));
        return new Response(
          '{"type":"message","model":"claude-test","content":[]}',
          { headers: { "content-type": "application/json" } },
        );
      },
      undefined,
      (value) => value,
      fixedManagedProfileBindings("api_key"),
    );
    const compatibleModel = {
      ...model(),
      provider: "anthropic",
      compat: { sendSessionAffinityHeaders: true },
    } as unknown as Model<string>;

    await lane.execute({
      model: compatibleModel,
      rawBody: '{"model":"anthropic/claude-test","messages":[]}',
      request: request(),
      requestId: "req_client",
      sessionId: "validated-session",
      onExecutionStart: () => undefined,
    });

    expect(sent[0]!.headers.get("x-session-affinity")).toBe(
      "validated-session",
    );
  });

  it("reconstructs the pinned GitHub Copilot bearer and request-intent headers", async () => {
    let sent: Request | undefined;
    const lane = createLane(
      async (input, init) => {
        sent = new Request(input, init);
        return new Response(
          '{"type":"message","model":"claude-test","content":[]}',
          { headers: { "content-type": "application/json" } },
        );
      },
      { auth: { apiKey: "copilot-token" }, source: "fixture" },
    );

    await lane.execute({
      model: { ...model(), provider: "github-copilot" },
      rawBody: JSON.stringify({
        model: "github-copilot/claude-test",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "AA==" },
              },
            ],
          },
          { role: "assistant", content: [{ type: "text", text: "working" }] },
        ],
      }),
      request: request(),
      requestId: "req_client",
      sessionId: "validated-session",
      onExecutionStart: () => undefined,
    });

    expect(sent!.headers.get("authorization")).toBe("Bearer copilot-token");
    expect(sent!.headers.get("x-api-key")).toBeNull();
    expect(sent!.headers.get("x-initiator")).toBe("agent");
    expect(sent!.headers.get("openai-intent")).toBe("conversation-edits");
    expect(sent!.headers.get("copilot-vision-request")).toBe("true");
    expect(sent!.headers.get("x-session-affinity")).toBeNull();
  });

  it("fails before fetch when the OAuth differential cannot be applied safely", async () => {
    const fetch = vi.fn(async () => new Response());
    const lane = createLane(
      fetch as unknown as FetchFunction,
      { auth: { apiKey: "oauth-token" }, source: "fixture" },
      (value) => value,
      fixedManagedProfileBindings("oauth"),
    );

    const result = await lane.execute({
      model: { ...model(), provider: "anthropic" },
      rawBody: '{"model":"anthropic/claude-test","system":42,"messages":[]}',
      request: request(),
      requestId: "req_client",
      onExecutionStart: () => undefined,
    });

    expect(result.outcome).toBe("failed");
    expect(result.response.status).toBe(502);
    expect(fetch).not.toHaveBeenCalled();
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
      model: model(), rawBody: '{"model":"fixture/claude-test"}', request: request(controller.signal),
      requestId: "req_client", onExecutionStart: () => undefined,
    })).rejects.toThrow("client closed");
  });
});
