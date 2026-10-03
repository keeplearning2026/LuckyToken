import { describe, expect, it } from "vitest";
import { createModels, type Context, type Model } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { parseAnthropicTextInvocation } from "../../src/protocols/anthropic/request.js";
import { sendAnthropicWithPiEnvelope, createAnthropicPiNativeRequestSender } from "../support/pi-native-anthropic-context-transport.js";
import { createAnthropicProviderNativeLane } from "../../src/provider-native-anthropic/index.js";
import { fixedManagedProfileBindings } from "../support/profile-binding-fixture.js";
import { createServer } from "node:http";
import type { ProviderAuthBindingCapture } from "../../src/credentials/profile-contract.js";
import { isProfileProviderAuthBindingCapture } from "../../src/credentials/profile-contract.js";

function fixture(provider = "anthropic") {
  const model: Model<"anthropic-messages"> = {
    id: "claude-test", name: "Claude Test", api: "anthropic-messages", provider,
    baseUrl: "https://provider.invalid/prefix", reasoning: true, input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4_096,
  };
  const models = createModels();
  models.setProvider({ ...anthropicProvider(), id: provider, getModels: () => [model] });
  return { models, model };
}

describe("pure Anthropic max Context experiment", () => {
  it.each(["user", "tool-result"] as const)("retains string document content in max: %s", (location) => {
    const document = { type: "document", source: { type: "content", content: "valid document text" } };
    const body = { model: "alias", max_tokens: 128, messages: location === "user" ? [{ role: "user", content: [document] }]
      : [{ role: "assistant", content: [{ type: "tool_use", id: "c", name: "lookup", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: [document] }] }] };
    const before = JSON.stringify(body);
    expect(() => parseAnthropicTextInvocation(body, 10)).toThrow();
    const query = parseAnthropicTextInvocation(body, 10, "max");
    const parts = query.context.messages.flatMap((message) => (message.role === "user" || message.role === "toolResult")
      && Array.isArray(message.content) ? message.content : []);
    expect(parts).toContainEqual({ type: "text", text: "valid document text" });
    expect(JSON.stringify(body)).toBe(before);
  });

  it("reports omitted tool extensions and serial tool-choice preferences", () => {
    const query = parseAnthropicTextInvocation({ model: "alias", max_tokens: 128, messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "plain", input_schema: { type: "object" } }, { name: "extended", input_schema: { type: "object" },
        defer_loading: true, cache_control: { type: "ephemeral" } }],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    }, 10, "max");
    const paths = query.notices.map((notice) => notice.jsonPath);
    expect(paths).toContain("$.tools[1].defer_loading");
    expect(paths).toContain("$.tools[1].cache_control");
    expect(paths).toContain("$.tool_choice.disable_parallel_tool_use");
    expect(query.options.toolChoice).toBe("auto");
  });

  it("pairs large tool history in source order without mutating the Native body", () => {
    const count = 10_000;
    const body = { model: "alias", max_tokens: 128, messages: [
      { role: "assistant", content: Array.from({ length: count }, (_, index) => ({ type: "tool_use", id: `c${index}`, name: `tool${index}`, input: { index } })) },
      { role: "user", content: Array.from({ length: count }, (_, index) => ({ type: "tool_result", tool_use_id: `c${count - index - 1}`, content: `result${index}` })) },
    ] };
    const before = JSON.stringify(body);
    const query = parseAnthropicTextInvocation(body, 10, "max");
    const results = query.context.messages.filter((message) => message.role === "toolResult");
    expect(results).toHaveLength(count);
    for (const [index, message] of results.entries()) expect(message).toMatchObject({
      toolCallId: `c${count - index - 1}`, toolName: `tool${count - index - 1}`, content: [{ type: "text", text: `result${index}` }],
    });
    expect(JSON.stringify(body)).toBe(before);
  });

  it("never reads unclaimed metadata and bounds partial-conversion notices", () => {
    const value = { model: "alias", max_tokens: 128, messages: [{ role: "user", content: "hello" }],
      get metadata() { throw new Error("Unclaimed metadata was read"); },
      ...Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`future_${index}`, null])),
    };
    const query = parseAnthropicTextInvocation(value, 10, "max");
    expect(query.notices).toHaveLength(32);
    expect(query.notices.at(-1)?.code).toBe("anthropic_max_notices_bounded");
  });
  it("retains result text when siblings need Native preservation", () => {
    const query = parseAnthropicTextInvocation({ model: "alias", max_tokens: 128, messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "c", name: "lookup", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: [
        { type: "text", text: "result text" },
        { type: "image", source: { type: "url", url: "https://image.invalid/native.png" } },
        { type: "tool_reference", tool_name: "future_tool" },
      ] }] },
    ] }, 10, "max");
    expect(query.context.messages.find((message) => message.role === "toolResult")).toMatchObject({
      toolCallId: "c", content: [{ type: "text", text: "result text" }],
    });
    expect(query.notices.length).toBeGreaterThan(0);
  });

  it("keeps default Semantic results and shared tool-call/result conversion", () => {
    const body = { model: "alias", max_tokens: 256, system: "system text", tools: [{ name: "sum", input_schema: { type: "object", properties: {} } }], messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "sum", input: { a: 2 } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "5" }] },
    ] };
    const before = JSON.stringify(body);
    const normal = parseAnthropicTextInvocation(body, 10);
    expect(parseAnthropicTextInvocation(body, 10, "semantic")).toEqual(normal);
    const query = parseAnthropicTextInvocation(body, 10, "max");
    expect(query.context.messages.filter((message) => message.role !== "user" || message.content !== "")).toEqual(normal.invocation.pi.context.messages);
    expect(query.context.tools).toEqual(normal.invocation.pi.context.tools);
    expect(query.context.systemPrompt).toBe("system text");
    expect(JSON.stringify(body)).toBe(before);
  });
  it("retains representable content while accepting Native URL images and opaque blocks without mutation", () => {
    const body = { model: "alias", max_tokens: 256, messages: [{ role: "user", content: [
      { type: "text", text: "actual text" },
      { type: "image", source: { type: "url", url: "https://image.invalid/native.png" } },
      { type: "future_native_block", encrypted: "opaque" },
    ] }] };
    const before = JSON.stringify(body);
    expect(() => parseAnthropicTextInvocation(body, 10)).toThrow();
    const query = parseAnthropicTextInvocation(body, 10, "max");
    expect(query.mode).toBe("max");
    expect(query).not.toHaveProperty("invocation");
    expect(query.context.messages.some((message) => message.role === "user" && Array.isArray(message.content)
      && message.content.some((part) => part.type === "text" && part.text === "actual text"))).toBe(true);
    expect(query.context.messages.some((message) => message.role === "user" && Array.isArray(message.content)
      && message.content.some((part) => part.type === "image"))).toBe(true);
    expect(query.notices.length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).toBe(before);
    expect(parseAnthropicTextInvocation(body, 10, "max")).toEqual(query);
  });
});

describe("installed Pi Anthropic Native transport experiment", () => {
  it.each(["user", "tool-result"] as const)("retains document content and matches independent Pi vision facts: %s", async (location) => {
    const { models, model } = fixture("github-copilot");
    const document = { type: "document", source: { type: "content", content: [
      { type: "text", text: "caption" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "YQ==" } },
    ] } };
    const body = { model: model.id, max_tokens: 128, messages: location === "user"
      ? [{ role: "user", content: [document] }]
      : [{ role: "assistant", content: [{ type: "tool_use", id: "c", name: "lookup", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: [document] }] }] };
    const before = JSON.stringify(body);
    const query = parseAnthropicTextInvocation(body, 10, "max");
    const parts = query.context.messages.flatMap((message) => (message.role === "user" || message.role === "toolResult")
      && Array.isArray(message.content) ? message.content : []);
    expect(parts).toContainEqual({ type: "text", text: "caption" });
    expect(parts).toContainEqual({ type: "image", data: "YQ==", mimeType: "image/png" });
    const content = [{ type: "text" as const, text: "caption" }, { type: "image" as const, data: "YQ==", mimeType: "image/png" }];
    const context: Context = { messages: location === "user" ? [{ role: "user", content, timestamp: 10 }]
      : [{ role: "toolResult", toolCallId: "c", toolName: "lookup", content, isError: false, timestamp: 10 }] };
    let oracle: Request | undefined;
    for await (const event of models.stream(model, context, { apiKey: "mock", thinkingEnabled: false, maxRetries: 0,
      fetch: async (input, init) => { oracle = new Request(input, init); return new Response("stop", { status: 400 }); },
    })) void event;
    let sent: Request | undefined;
    await sendAnthropicWithPiEnvelope(models, model, body, 10, { signal: AbortSignal.timeout(2_000), pi: { apiKey: "mock" },
      fetch: async (input, init) => { sent = new Request(input, init); return new Response("raw"); },
    });
    expect(sent!.headers.get("copilot-vision-request")).toBe("true");
    expect(Object.fromEntries(sent!.headers)).toEqual(Object.fromEntries(oracle!.headers));
    expect(await sent!.text()).toBe(before);
    expect(JSON.stringify(body)).toBe(before);
  });

  it("preserves the original network failure without retrying", async () => {
    const { models, model } = fixture();
    const original = new Error("Physical network failed");
    let calls = 0;
    await expect(sendAnthropicWithPiEnvelope(models, model, { model: model.id, messages: [] }, 10, {
      signal: AbortSignal.timeout(2_000), pi: { apiKey: "mock" },
      fetch: async () => { calls++; throw original; },
    })).rejects.toBe(original);
    expect(calls).toBe(1);
  });

  it("does not hide caller cancellation during private Pi response handling", async () => {
    const { models, model } = fixture();
    const caller = new AbortController();
    const original = new Error("Caller canceled during private parsing");
    const reasons: unknown[] = [];
    const response = new Response(new ReadableStream({ cancel(reason) { reasons.push(reason); } }));
    const canceled: Pick<typeof models, "stream"> = {
      stream: (target, context, options) => models.stream(target, context, Object.assign({}, options, {
        onProviderStreamEvent: () => caller.abort(original),
      })),
    };
    await expect(sendAnthropicWithPiEnvelope(canceled, model, { model: model.id, messages: [] }, 10, {
      signal: caller.signal, pi: { apiKey: "mock" }, fetch: async () => response,
    })).rejects.toBe(original);
    expect(reasons).toEqual([original]);
  });

  it("rejects a second dispatch even when a future adapter swallows it, releasing capture", async () => {
    const { models, model } = fixture();
    const reasons: unknown[] = [];
    const response = new Response(new ReadableStream({ cancel(reason) { reasons.push(reason); } }));
    const repeated: Pick<typeof models, "stream"> = {
      stream: (target, context, options) => models.stream(target, context, Object.assign({}, options, {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const synthetic = await options!.fetch!(input, init);
          try { await options!.fetch!(input, init); } catch { /* Future adapter swallowing a guard failure. */ }
          return synthetic;
        },
      })),
    };
    let calls = 0;
    await expect(sendAnthropicWithPiEnvelope(repeated, model, { model: model.id, messages: [] }, 10, {
      signal: AbortSignal.timeout(2_000), pi: { apiKey: "mock" }, fetch: async () => { calls++; return response; },
    })).rejects.toThrow("unexpected dispatch");
    expect(calls).toBe(1);
    expect(reasons).toHaveLength(1);
  });

  it.each(["default", "none", "explicit-beta", "null-beta"] as const)("matches Pi header precedence/session/beta handling: %s", async (variant) => {
    const { models, model } = fixture();
    const requestModel = { ...model, compat: { sendSessionAffinityHeaders: true },
      headers: { "x-provider-fact": "model", "anthropic-beta": "model-beta" } };
    const pi = { apiKey: "mock", sessionId: "session", cacheRetention: variant === "none" ? "none" as const : "long" as const,
      headers: { "X-Provider-Fact": "options", ...(variant === "explicit-beta" ? { "anthropic-beta": "explicit-beta" }
        : variant === "null-beta" ? { "anthropic-beta": null } : {}) } };
    let oracle: Request | undefined;
    for await (const event of models.stream(requestModel, { messages: [{ role: "user", content: "hello", timestamp: 10 }] }, {
      ...pi, thinkingEnabled: false, maxRetries: 0,
      fetch: async (input, init) => { oracle = new Request(input, init); return new Response("stop", { status: 400 }); },
    })) void event;
    let sent: Request | undefined;
    await sendAnthropicWithPiEnvelope(models, requestModel, { model: model.id, messages: [{ role: "user", content: "hello" }] }, 10, {
      signal: AbortSignal.timeout(2_000), pi, fetch: async (input, init) => { sent = new Request(input, init); return new Response("raw"); },
    });
    expect(sent!.url).toBe(oracle!.url);
    expect(Object.fromEntries(sent!.headers)).toEqual(Object.fromEntries(oracle!.headers));
    expect(sent!.headers.get("x-session-affinity")).toBe(variant === "none" ? null : "session");
  });

  it("keeps deep unknown JSON and large history out of Pi's temporary builder", async () => {
    const { models, model } = fixture();
    const deep = '{"nested":'.repeat(2_000) + '"leaf"' + '}'.repeat(2_000);
    const body = { model: model.id, max_tokens: 128, future: JSON.parse(deep), messages: [
      { role: "assistant", content: Array.from({ length: 140_000 }, () => ({ type: "text", text: "x" })) },
      { role: "user", content: "next turn" },
    ] };
    const before = JSON.stringify(body);
    let sent: Request | undefined;
    await sendAnthropicWithPiEnvelope(models, model, body, 10, {
      signal: AbortSignal.timeout(10_000), pi: { apiKey: "mock" },
      fetch: async (input, init) => { sent = new Request(input, init); return new Response("raw"); },
    });
    expect(await sent!.text()).toBe(before);
    expect(JSON.stringify(body)).toBe(before);
  });

  it("ignores metadata images and includes images in declared tool output paths only", async () => {
    const { models, model } = fixture("github-copilot");
    let sent: Request | undefined;
    await sendAnthropicWithPiEnvelope(models, model, { model: model.id, max_tokens: 128,
      messages: [{ role: "user", content: [{ type: "text", text: "hello", metadata: { type: "image" } }] }] }, 10, {
      signal: AbortSignal.timeout(2_000), pi: { apiKey: "mock" },
      fetch: async (input, init) => { sent = new Request(input, init); return new Response("raw"); },
    });
    expect(sent!.headers.has("copilot-vision-request")).toBe(false);
    expect(sent!.headers.get("x-initiator")).toBe("user");
  });

  it("rejects a repeated payload hook after capture and releases the abandoned body", async () => {
    const { models, model } = fixture();
    const reasons: unknown[] = [];
    const response = new Response(new ReadableStream({ cancel(reason) { reasons.push(reason); } }));
    const repeated: Pick<typeof models, "stream"> = {
      stream: (target, context, options) => models.stream(target, context, Object.assign({}, options, {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const synthetic = await options!.fetch!(input, init);
          try { await options!.onPayload!({}, target); } catch { /* Simulate a future adapter swallowing the hook failure. */ }
          return synthetic;
        },
      })),
    };
    await expect(sendAnthropicWithPiEnvelope(repeated, model, { model: model.id, max_tokens: 128, messages: [{ role: "user", content: "hello" }] }, 10, {
      signal: AbortSignal.timeout(2_000), pi: { apiKey: "mock" }, fetch: async () => response,
    })).rejects.toThrow("more than once");
    expect(reasons).toHaveLength(1);
  });

  it("returns caller cancellation even while abandoned-body cleanup is pending", async () => {
    const { models, model } = fixture();
    const caller = new AbortController();
    const original = new Error("Caller stopped");
    const reasons: unknown[] = [];
    let finish!: () => void;
    const cleanup = new Promise<void>((resolve) => { finish = resolve; });
    const response = new Response(new ReadableStream({ cancel(reason) { reasons.push(reason); return cleanup; } }));
    const pending = sendAnthropicWithPiEnvelope(models, model, { model: model.id, messages: [] }, 10, {
      signal: caller.signal, pi: { apiKey: "mock" }, fetch: async () => { caller.abort(original); return response; },
    }).catch((error: unknown) => error);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([pending, new Promise<string>((resolve) => { timer = setTimeout(() => resolve("cleanup blocked"), 200); })]);
      expect(result).toBe(original);
      expect(reasons).toEqual([original]);
    } finally { clearTimeout(timer); finish(); await pending; }
  });

  it("enforces real header timeout and stops its timer before later body reads", async () => {
    const { models, model } = fixture();
    let slowHeaders = true;
    const server = createServer((_request, response) => {
      if (slowHeaders) return;
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
      const timer = setTimeout(() => response.end('{"late":"body"}'), 80);
      response.once("close", () => clearTimeout(timer));
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing HTTP address");
      const localModel = { ...model, baseUrl: `http://127.0.0.1:${address.port}` };
      const options = { signal: AbortSignal.timeout(2_000), pi: { apiKey: "mock", timeoutMs: 20 }, fetch: globalThis.fetch };
      await expect(sendAnthropicWithPiEnvelope(models, localModel, { model: model.id, messages: [] }, 10, options)).rejects.toThrow("headers timed out");
      slowHeaders = false;
      const response = await sendAnthropicWithPiEnvelope(models, localModel, { model: model.id, messages: [] }, 10, options);
      await expect(response.json()).resolves.toEqual({ late: "body" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
  it("dispatches explicitly resolved Cloudflare header-owned auth without a wire placeholder credential", async () => {
    const { models, model } = fixture("cloudflare-ai-gateway");
    let sent: Request | undefined;
    await sendAnthropicWithPiEnvelope(models, model, { model: model.id, max_tokens: 128, messages: [{ role: "user", content: "hello" }] }, 10, {
      signal: AbortSignal.timeout(2_000), pi: { apiKey: "", headers: { "cf-aig-authorization": "Bearer gateway-owned" } },
      fetch: async (input, init) => { sent = new Request(input, init); return new Response("raw"); },
    });
    expect(sent!.headers.get("cf-aig-authorization")).toBe("Bearer gateway-owned");
    expect(sent!.headers.has("x-api-key")).toBe(false);
    expect(sent!.headers.has("authorization")).toBe(false);
    expect([...sent!.headers.values()].join(" ")).not.toContain("Token-envelope-query-credential");
  });

  it.each([
    { name: "api-key", provider: "anthropic", apiKey: "mock", image: false, agent: false, toolResult: false },
    { name: "oauth", provider: "anthropic", apiKey: "sk-ant-oat-mock", image: false, agent: false, toolResult: false },
    { name: "copilot-image", provider: "github-copilot", apiKey: "mock", image: true, agent: false, toolResult: false },
    { name: "copilot-prefill", provider: "github-copilot", apiKey: "mock", image: false, agent: true, toolResult: false },
    { name: "copilot-tool-image", provider: "github-copilot", apiKey: "mock", image: true, agent: true, toolResult: true },
  ])("matches an independently authored Pi Context's full URL/method/headers: $name", async ({ provider, apiKey, image, agent, toolResult }) => {
    const { models, model } = fixture(provider);
    const tool = { name: "lookup", description: "Lookup", parameters: { type: "object" as const, properties: {} } };
    const context: Context = { tools: [tool], messages: toolResult
      ? [{ role: "toolResult", toolCallId: "c", toolName: "lookup", content: [{ type: "image", data: "", mimeType: "image/png" }], isError: false, timestamp: 10 }]
      : agent ? [{ role: "assistant", api: "fixture", provider: "fixture", model: "fixture", content: [],
        stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 10 }]
        : [{ role: "user", content: image ? [{ type: "image", data: "", mimeType: "image/png" }] : "hello", timestamp: 10 }] };
    const pi = { apiKey, sessionId: "fixed-session", timeoutMs: 2_000, headers: { "x-provider-fact": "final" } };
    let oracle: Request | undefined;
    for await (const event of models.stream(model, context, { ...pi, thinkingEnabled: true, maxRetries: 0,
      fetch: async (input, init) => { oracle = new Request(input, init); return new Response("stop", { status: 400 }); },
    })) void event;
    const imageBlock = { type: "image", source: { type: "url", url: "https://image.invalid/native.png" } };
    const messages = toolResult ? [{ role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: [imageBlock] }] }]
      : [{ role: agent ? "assistant" : "user", content: image ? [imageBlock] : "hello" }];
    let sent: Request | undefined;
    await sendAnthropicWithPiEnvelope(models, model, { model: model.id, max_tokens: 128, messages,
      tools: [{ name: "lookup", input_schema: { type: "object", properties: {} } }], thinking: { type: "enabled", budget_tokens: 1024 } }, 10, {
      signal: AbortSignal.timeout(2_000), pi,
      fetch: async (input, init) => { sent = new Request(input, init); return new Response("raw"); },
    });
    expect(sent!.url).toBe(oracle!.url);
    expect(sent!.method).toBe(oracle!.method);
    expect(Object.fromEntries(sent!.headers)).toEqual(Object.fromEntries(oracle!.headers));
  });

  it.each([
    { kind: "api_key" as const, key: "sk-ant-oat-is-actually-an-api-key", header: "x-api-key", expected: "sk-ant-oat-is-actually-an-api-key" },
    { kind: "oauth" as const, key: "opaque-managed-oauth", header: "authorization", expected: "Bearer opaque-managed-oauth" },
  ])("keeps captured $kind authority even when Pi's token heuristic disagrees", async ({ kind, key, header, expected }) => {
    const { models, model } = fixture();
    let sent: Request | undefined;
    await sendAnthropicWithPiEnvelope(models, model, { model: model.id, max_tokens: 128, messages: [{ role: "user", content: "hello" }] }, 10, {
      credentialKind: kind, signal: AbortSignal.timeout(2_000), pi: { apiKey: key },
      fetch: async (input, init) => { sent = new Request(input, init); return new Response("raw"); },
    });
    expect(sent!.headers.get(header)).toBe(expected);
    expect(sent!.headers.has(kind === "oauth" ? "x-api-key" : "authorization")).toBe(false);
    expect(sent!.headers.get("x-app")).toBe(kind === "oauth" ? "cli" : null);
    expect(sent!.headers.get("anthropic-beta")?.includes("oauth-2025-04-20") ?? false).toBe(kind === "oauth");
    expect([...sent!.headers.values()].join(" ")).not.toContain("Token-envelope-query-credential");
  });

  it.each([true, false, undefined])("preserves the approved Native body and raw Response, stream=%s", async (stream) => {
    const { models, model } = fixture();
    const body = { model: model.id, max_tokens: 128, ...(stream === undefined ? {} : { stream }),
      messages: [{ role: "user", content: "native" }],
      output_format: { type: "json_schema", schema: { type: "object" } },
      future: { exact: [null, true, 17, "unchanged"] },
    };
    const before = JSON.stringify(body);
    const response = new Response(new Uint8Array([0, 255, 13, 10]), { status: 429, headers: { "x-unknown": "raw" } });
    let sent: Request | undefined;
    let calls = 0;
    const result = await sendAnthropicWithPiEnvelope(models, model, body, 10, {
      signal: AbortSignal.timeout(2_000), pi: { apiKey: "mock" },
      fetch: async (input, init) => { calls++; sent = new Request(input, init); return response; },
    });
    expect(calls).toBe(1);
    expect(sent!.url).toBe("https://provider.invalid/prefix/v1/messages?beta=true");
    expect(JSON.stringify(await sent!.json())).toBe(before);
    expect(JSON.stringify(body)).toBe(before);
    expect(result).toBe(response);
    expect(result.bodyUsed).toBe(false);
    expect(result.status).toBe(429);
    expect(result.headers.get("x-unknown")).toBe("raw");
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(new Uint8Array([0, 255, 13, 10]));
  });
});

describe("Pi sender composed with the existing Anthropic Native lane", () => {
  it("rebuilds auth, OAuth identity and body projection after a final-429 Profile switch", async () => {
    const { models, model } = fixture();
    const first = await fixedManagedProfileBindings("api_key", "key-profile").capture(model.provider);
    const second = await fixedManagedProfileBindings("oauth", "oauth-profile").capture(model.provider);
    if (!isProfileProviderAuthBindingCapture(second)) throw new Error("Expected a managed test Profile");
    let current = first;
    let switches = 0;
    const sent: Request[] = [];
    const lane = createAnthropicProviderNativeLane({
      models: { getAuth: async () => ({ auth: { apiKey: current === first ? "sk-ant-oat-actually-api" : "opaque-oauth" } }) },
      bindings: {
        capture: async () => first,
        runBound: async <T>(capture: ProviderAuthBindingCapture, run: () => Promise<T>) => { current = capture; return run(); },
        advanceAfterFinal429: async () => { switches++; return { outcome: "switched", capture: second }; },
      },
      resolveRequestModel: (value) => value, requestSender: createAnthropicPiNativeRequestSender(models),
      fetch: async (input, init) => {
        sent.push(new Request(input, init));
        return sent.length === 1 ? new Response("limited", { status: 429 })
          : new Response(JSON.stringify({ id: "msg", type: "message", role: "assistant", model: model.id, content: [{ type: "text", text: "done" }], stop_reason: "end_turn" }), { headers: { "content-type": "application/json" } });
      },
    });
    const result = await lane.execute({ model, rawBody: JSON.stringify({ model: "alias", max_tokens: 128, stream: false, messages: [{ role: "user", content: "hello" }] }),
      request: new Request("https://token.invalid/v1/messages"), alias: "alias", requestId: "request", onExecutionStart: () => {},
    });
    expect(switches).toBe(1);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.headers.get("x-api-key")).toBe("sk-ant-oat-actually-api");
    expect(sent[0]!.headers.has("x-app")).toBe(false);
    expect(sent[1]!.headers.get("authorization")).toBe("Bearer opaque-oauth");
    expect(sent[1]!.headers.get("x-app")).toBe("cli");
    expect((await sent[0]!.json()).system).toBeUndefined();
    expect((await sent[1]!.json()).system[0].text).toContain("You are Claude Code");
    expect(result.outcome).toBe("success");
    await expect(result.response.json()).resolves.toMatchObject({ model: "alias", content: [{ type: "text", text: "done" }] });
  });

  it.each(["api_key", "oauth"] as const)("projects the approved %s body, filters headers and returns client JSON with alias", async (kind) => {
    const { models, model } = fixture();
    const key = kind === "oauth" ? "opaque-managed-token" : "mock";
    let sent: Request | undefined;
    const lane = createAnthropicProviderNativeLane({
      models: { getAuth: async () => ({ auth: { apiKey: key } }) },
      bindings: fixedManagedProfileBindings(kind), resolveRequestModel: (value) => value,
      requestSender: createAnthropicPiNativeRequestSender(models),
      fetch: async (input, init) => {
        sent = new Request(input, init);
        return new Response(JSON.stringify({ id: "msg_real", type: "message", role: "assistant", model: model.id,
          content: [{ type: "text", text: "native response", future: 42 }], stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 2 } }), {
          headers: { "content-type": "application/json", "set-cookie": "private", authorization: "private", "request-id": "upstream-id" },
        });
      },
    });
    const result = await lane.execute({ model, rawBody: JSON.stringify({ model: "alias", max_tokens: 128, stream: false,
      tools: [{ name: "read", input_schema: { type: "object", properties: {} } }], messages: [{ role: "user", content: "hello" }], future: "retained" }),
      request: new Request("https://token.invalid/v1/messages", { headers: { authorization: "Bearer client-owned" } }),
      requestId: "request", alias: "alias", onExecutionStart: () => {},
    });
    const body = await sent!.json();
    expect(body).toMatchObject({ model: model.id, stream: false, future: "retained" });
    expect(body.tools[0].name).toBe(kind === "oauth" ? "Read" : "read");
    if (kind === "oauth") expect(body.system[0].text).toContain("You are Claude Code");
    expect(sent!.headers.get("authorization")).not.toBe("Bearer client-owned");
    expect(result.outcome).toBe("success");
    expect(result.response.headers.has("authorization")).toBe(false);
    expect(result.response.headers.has("set-cookie")).toBe(false);
    expect(result.response.headers.get("request-id")).toBe("upstream-id");
    await expect(result.response.json()).resolves.toMatchObject({ model: "alias", content: [{ type: "text", text: "native response", future: 42 }] });
  });

  it("returns a pre-commit error when the real body read fails", async () => {
    const { models, model } = fixture();
    const lane = createAnthropicProviderNativeLane({
      models: { getAuth: async () => ({ auth: { apiKey: "mock" } }) }, bindings: fixedManagedProfileBindings("api_key"),
      resolveRequestModel: (value) => value, requestSender: createAnthropicPiNativeRequestSender(models),
      fetch: async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("broken body")); } })),
    });
    const result = await lane.execute({ model, rawBody: JSON.stringify({ model: "alias", messages: [] }),
      request: new Request("https://token.invalid/v1/messages"), requestId: "request", onExecutionStart: () => {},
    });
    expect(result.outcome).toBe("failed");
    expect(result.response.status).toBe(502);
    expect(await result.response.text()).toContain("Upstream provider response could not be read");
  });
});
