import { createModels, type Context, type FetchFunction, type Model, type Provider } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { azureOpenAIResponsesProvider } from "@earendil-works/pi-ai/providers/azure-openai-responses";
import { zstdDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { convertResponsesRequest } from "../../src/protocols/openai-responses/request.js";
import { sendWithPiEnvelope } from "../support/pi-native-context-transport.js";
import { createProviderResponsesSender } from "../../src/provider-native-responses/index.js";
import { createOpenAIResponsesSender } from "../../src/provider-native-responses/openai.js";
import {
  buildCodexRoutedCompactionRequest, expandTokenCompactionEnvelopes,
  extractResponsesOutputText, isCodexRoutedCompactionRequest,
  renderRoutedCompactionClientResponse,
} from "../../src/responses-compaction.js";

const SESSION = "00000000-0000-4000-8000-000000000123";
const TOKEN = `header.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
})).toString("base64url")}.signature`;

function fixture(provider: string, api = "openai-responses", baseUrl = "https://gateway.example/v1") {
  const upstream: Provider = api === "openai-codex-responses" ? openaiCodexProvider()
    : api === "azure-openai-responses" ? azureOpenAIResponsesProvider() : openaiProvider();
  const model: Model<string> = {
    id: "real-model", name: "real-model", provider, api, baseUrl, reasoning: false,
    contextWindow: 100_000, maxTokens: 10_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    input: ["text", "image"], headers: { "x-provider-static": "static" },
  };
  const models = createModels();
  // Mock credentials only; still use the installed adapter's actual execution.
  models.setProvider({ ...upstream, id: provider, auth: openaiProvider().auth, getModels: () => [model] });
  return { models, model };
}

async function requestBody(request: Request) {
  const bytes = new Uint8Array(await request.clone().arrayBuffer());
  return JSON.parse(request.headers.get("content-encoding") === "zstd"
    ? zstdDecompressSync(bytes).toString("utf8") : new TextDecoder().decode(bytes));
}

describe("pure Responses envelope context mode", () => {
  it("keeps Semantic rejection while accepting opaque Native history without mutation", () => {
    const body = Object.freeze({
      model: "alias", input: [{ type: "compaction", encrypted_content: "foreign-envelope" }],
      tools: [{ type: "tool_search" }], reasoning: { effort: "none" },
    });
    const before = JSON.stringify(body);
    expect(() => convertResponsesRequest(body, 10)).toThrow();
    const query = convertResponsesRequest(body, 10, undefined, "max");
    expect(query.mode).toBe("max");
    expect(query.context.messages.at(-1)?.role).toBe("assistant");
    expect(query).not.toHaveProperty("invocation");
    expect(JSON.stringify(body)).toBe(before);
    expect(convertResponsesRequest(body, 10, undefined, "max")).toEqual(query);
  });

  it("does not read non-consumed top-level controls", () => {
    const body = { input: "hello",
      get metadata() { throw new Error("metadata read"); } };
    expect(() => convertResponsesRequest(body, 10, undefined, "max")).not.toThrow();
  });

  it("preserves the ordinary default semantic conversion", () => {
    const result = convertResponsesRequest({ model: "alias", input: "hello" }, 10);
    expect(result.invocation.pi.context.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 10 }]);
  });

  it("maps the full representable request rather than just producing an empty probe", () => {
    const body = {
      model: "alias", instructions: "system instruction",
      input: [{ role: "developer", content: "developer instruction" },
        { role: "user", content: [{ type: "input_text", text: "actual text" },
          { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" }] }],
      tools: [{ type: "function", name: "sum", description: "Add numbers",
        parameters: { type: "object", properties: { a: { type: "number" } } } }],
      reasoning: { effort: "medium" }, temperature: 0.3, max_output_tokens: 100,
      prompt_cache_retention: "24h", tool_choice: "auto",
    };
    const result = convertResponsesRequest(body, 10, undefined, "max");
    expect(result.context.systemPrompt).toBe("system instruction");
    expect(result.context.messages[0]).toMatchObject({ role: "system", content: [{ type: "text", text: "developer instruction" }] });
    expect(result.context.messages[1]).toMatchObject({ role: "user", content: [
      { type: "text", text: "actual text" }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ] });
    expect(result.context.tools?.[0]).toMatchObject({ name: "sum", description: "Add numbers",
      parameters: { properties: { a: { type: "number" } } } });
    expect(result.options).toEqual({ reasoning: "medium", temperature: 0.3, maxTokens: 100,
      cacheRetention: "long", toolChoice: "auto" });
    expect(result.notices).toEqual([]);
  });

  it("retains surrounding text when native opaque items cannot be represented", () => {
    const result = convertResponsesRequest({ model: "alias", input: [
      { role: "user", content: "before" }, { type: "compaction", encrypted_content: "foreign" },
      { type: "item_reference", id: "opaque" }, { type: "tool_search_call" },
      { role: "user", content: "after" },
    ] }, 10, undefined, "max");
    expect(result.context.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "before" }], timestamp: 10 },
      { role: "user", content: [{ type: "text", text: "after" }], timestamp: 10 },
    ]);
    expect(result.notices.map((notice) => notice.jsonPath)).toEqual(["$.input[1]", "$.input[2]", "$.input[3]"]);
  });

  it("allows deferred discovery declarations and retains schemas without strict execution claims", () => {
    const body = { model: "alias", input: "hello", tools: [
      { type: "function", name: "deferred", defer_loading: true, strict: true,
        parameters: { type: "object", properties: { optional: { type: "string" } } } },
    ] };
    expect(() => convertResponsesRequest(body, 10)).toThrow();
    const result = convertResponsesRequest(body, 10, undefined, "max");
    expect(result.context.tools).toHaveLength(1);
    expect(result.context.tools?.[0]?.parameters).toEqual(body.tools[0]?.parameters);
    expect(result.context.tools?.[0]?.constrainedSampling).toBeUndefined();
    expect(result.notices.length).toBeGreaterThan(0);
  });

  it("retains real calls/results in source order and creates no fake tool result", () => {
    const body = { model: "alias", tools: [{ type: "function", name: "sum", parameters: {} }],
      input: [{ type: "function_call", call_id: "c1", name: "sum", arguments: '{"a":2}' },
        { type: "function_call_output", call_id: "c1", output: "5" },
        { type: "function_call", call_id: "c2", name: "sum", arguments: '{"a":3}' }] };
    const result = convertResponsesRequest(body, 10, undefined, "max");
    expect(result.context.messages.map((message) => message.role)).toEqual(["assistant", "toolResult", "assistant"]);
    expect(result.context.messages[1]).toMatchObject({ toolCallId: "c1", toolName: "sum",
      content: [{ type: "text", text: "5" }], isError: false });
    expect(result.notices.some((notice) => notice.action === "xrepair")).toBe(false);
  });

  it("keeps namespace call identities and custom grammar through shared parsers", () => {
    const result = convertResponsesRequest({ model: "alias", tools: [
      { type: "namespace", name: "fs", tools: [{ type: "custom", name: "patch",
        format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } }] },
    ], input: [{ type: "custom_tool_call", namespace: "fs", name: "patch", call_id: "c", input: "patch text" },
      { type: "custom_tool_call_output", call_id: "c", output: "done" }] }, 10, undefined, "max");
    expect(result.context.tools?.[0]).toMatchObject({ name: "fs__patch",
      constrainedSampling: { type: "grammar", variants: { openai_lark: "start: /.+/" } } });
    expect(result.context.messages[0]).toMatchObject({ content: [{ type: "toolCall", name: "fs__patch", arguments: { input: "patch text" } }] });
    expect(result.context.messages[1]).toMatchObject({ toolName: "fs__patch" });
  });

  it("keeps declared tools with tool_choice=none without changing the default filter contract", () => {
    const body = { model: "alias", input: "hello", tools: [{ type: "function", name: "sum", parameters: {} }], tool_choice: "none" };
    const ordinary = convertResponsesRequest(body, 10);
    expect(convertResponsesRequest(body, 10, undefined, "semantic")).toEqual(ordinary);
    expect(ordinary.invocation.pi.context.tools).toHaveLength(1);
    expect(ordinary.invocation.pi.options.toolChoice).toBe("none");
    expect(convertResponsesRequest(body, 10, undefined, "max").context.tools).toHaveLength(1);
  });

  it.each([
    { model: "alias", input: "hello", reasoning: { effort: "medium" } },
    { model: "alias", input: [{ role: "developer", content: "system" }, { role: "user", content: "text" }] },
    { model: "alias", input: "hello", tools: [{ type: "custom", name: "patch" }] },
  ])("leaves the disabled/default max-mode result exactly equal to explicit Semantic", (body) => {
    expect(convertResponsesRequest(body, 10, undefined, "semantic")).toEqual(convertResponsesRequest(body, 10));
  });

  it("keeps default rejection identical when max mode is disabled", () => {
    const body = { model: "alias", input: [{ type: "item_reference", id: "opaque" }] };
    let expected: unknown;
    try { convertResponsesRequest(body, 10); } catch (error) { expected = error; }
    expect(() => convertResponsesRequest(body, 10, undefined, "semantic")).toThrow((expected as Error).message);
    expect(() => convertResponsesRequest(body, 10, undefined, "max")).not.toThrow();
  });

  it("bounds omission notices and never reads unclaimed body values", () => {
    const body = { model: "alias", input: Array.from({ length: 80 }, () => ({ type: "future_item" })),
      get metadata() { throw new Error("metadata must stay unread"); } };
    const result = convertResponsesRequest(body, 10, undefined, "max");
    expect(result.notices).toHaveLength(32);
    expect(result.notices.at(-1)?.code).toBe("openai-responses_max_notices_bounded");
  });

  it("retains valid namespace siblings and schemas when one child's constraint is unsupported", () => {
    const body = { model: "alias", input: "hello", tools: [{ type: "namespace", name: "fs", tools: [
      { type: "function", name: "good", parameters: {} },
      { type: "function", name: "strict", strict: true,
        parameters: { type: "object", properties: { optional: { type: "string" } } } },
      { type: "custom", name: "future_grammar", format: { type: "grammar", syntax: "future", definition: "grammar" } },
    ] }] };
    expect(() => convertResponsesRequest(body, 10)).toThrow();
    const result = convertResponsesRequest(body, 10, undefined, "max");
    expect(result.context.tools?.map((tool) => tool.name)).toEqual(["fs__good", "fs__strict", "fs__future_grammar"]);
    expect(result.context.tools?.[1]?.parameters).toMatchObject({ properties: { optional: { type: "string" } } });
  });

  it("retains enabled reasoning when only the summary selector is unsupported", () => {
    const result = convertResponsesRequest({ model: "alias", input: "hello",
      reasoning: { effort: "low", summary: "future-summary" } }, 10, undefined, "max");
    expect(result.options.reasoning).toBe("low");
    expect(result.notices.length).toBeGreaterThan(0);
  });
});

describe("Pi-owned envelope with Native body and Response", () => {
  it.each([
    { provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
    { provider: "openrouter", api: "openai-responses", baseUrl: "https://openrouter.ai/api/v1" },
    { provider: "github-copilot", api: "openai-responses", baseUrl: "https://api.githubcopilot.com" },
    { provider: "azure-openai-responses", api: "azure-openai-responses", baseUrl: "https://unit.openai.azure.com" },
    { provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" },
  ])("matches current Native envelope and preserves every body field for $provider", async ({ provider, api, baseUrl }) => {
    const { models, model } = fixture(provider, api, baseUrl);
    const body = {
      model: model.id, stream: true,
      input: [{ role: "user", content: [{ type: "input_image", image_url: "https://image.invalid/private.png" }] },
        { type: "compaction", encrypted_content: "opaque-native-state" }],
      tools: [{ type: "tool_search" }], reasoning: { effort: "low" },
      future_provider_field: { exact: [null, true, 17, "unchanged"] },
    };
    const apiKey = api === "openai-codex-responses" ? TOKEN : "sk-test";
    let experiment: Request | undefined;
    const realResponse = new Response("unknown: SSE\r\ndata: private\r\n\r\n", {
      status: 429, headers: { "content-type": "text/event-stream", "x-upstream": "preserve" },
    });
    const fetch: FetchFunction = async (input, init) => {
      experiment = new Request(input, init);
      return realResponse;
    };
    const result = await sendWithPiEnvelope(models, model, body, 10, {
      fetch, signal: AbortSignal.timeout(5_000),
      pi: { apiKey, sessionId: SESSION, headers: { "x-auth": "resolved" } },
    });
    expect(result).toBe(realResponse);
    expect(result.bodyUsed).toBe(false);
    expect(await requestBody(experiment!)).toEqual(body);
    let baseline: Request | undefined;
    const createSender = provider === "openrouter" ? createOpenAIResponsesSender : createProviderResponsesSender;
    const sender = createSender({
      model, auth: { auth: { apiKey, headers: { "x-auth": "resolved" } } },
      sessionId: SESSION,
      fetch: async (input, init) => { baseline = new Request(input, init); return new Response("opaque"); },
    });
    expect(sender).toBeDefined();
    await sender!.send("responses", JSON.stringify(body), AbortSignal.timeout(5_000));
    expect(experiment!.url).toBe(baseline!.url);
    expect(experiment!.method).toBe(baseline!.method);
    expect(Object.fromEntries(experiment!.headers)).toEqual(Object.fromEntries(baseline!.headers));
    expect(await result.text()).toBe("unknown: SSE\r\ndata: private\r\n\r\n");
  });

  it.each([
    { input: "hello", initiator: "user", image: false },
    { input: [], initiator: "user", image: false },
    { input: [{ role: "user", content: "hello" }], initiator: "user", image: false },
    { input: [{ role: "user", content: [{ type: "input_image", image_url: "https://invalid/image" }] }],
      initiator: "user", image: true },
    { input: [{ type: "function_call_output", call_id: "c", output: [{ type: "input_image", image_url: "https://invalid/image" }] }],
      initiator: "agent", image: true },
    { input: [{ role: "user", content: "hello" }, { role: "developer", content: "last" }],
      initiator: "agent", image: false },
  ])("lets Pi derive Copilot initiator=$initiator vision=$image", async ({ input, initiator, image }) => {
    const { models, model } = fixture("github-copilot");
    let captured: Request | undefined;
    await sendWithPiEnvelope(models, model, { model: model.id, input, stream: true }, 10, {
      fetch: async (input, init) => { captured = new Request(input, init); return new Response("native"); },
      signal: AbortSignal.timeout(5_000), pi: { apiKey: "test" },
    });
    expect(captured!.headers.get("x-initiator")).toBe(initiator);
    expect(captured!.headers.get("copilot-vision-request")).toBe(image ? "true" : null);
  });

  it("also agrees with Pi given a real, independently authored semantic image Context", async () => {
    const { models, model } = fixture("github-copilot");
    const context: Context = { messages: [{ role: "user", timestamp: 10,
      content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] }] };
    let oracle: Request | undefined;
    for await (const event of models.streamSimple(model, context, {
      apiKey: "test", maxRetries: 0,
      fetch: async (input, init) => { oracle = new Request(input, init); return new Response("stop", { status: 400 }); },
    })) void event;
    let experiment: Request | undefined;
    await sendWithPiEnvelope(models, model, {
      model: model.id, input: [{ role: "user", content: [{ type: "input_image", image_url: "https://invalid/image" }] }],
      stream: true,
    }, 10, { signal: AbortSignal.timeout(5_000), pi: { apiKey: "test" },
      fetch: async (input, init) => { experiment = new Request(input, init); return new Response("native"); } });
    expect(Object.fromEntries(experiment!.headers)).toEqual(Object.fromEntries(oracle!.headers));
  });

  it.each([200, 400, 429, 503])("preserves raw JSON status/body %s with stream=false and makes one physical request", async (status) => {
    const { models, model } = fixture("openai");
    const bytes = new Uint8Array([0, 255, 13, 10, 123, 125]);
    const response = new Response(bytes, { status, headers: { "x-private": "raw" } });
    let calls = 0;
    const result = await sendWithPiEnvelope(models, model, { model: model.id, input: "hello", stream: false }, 10, {
      fetch: async () => { calls++; return response; },
      signal: AbortSignal.timeout(5_000), pi: { apiKey: "test" },
    });
    expect(result).toBe(response);
    expect(result.bodyUsed).toBe(false);
    expect(calls).toBe(1);
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(bytes);
  });

  it.each(["known-field", "unknown-field", "deleted-field", "array-order", "number"] as const)(
    "fails before network if Pi/SDK changes the payload: %s", async (change) => {
    const { models, model } = fixture("openai");
    const altered: Pick<typeof models, "streamSimple"> = {
      streamSimple: (target, context, options) =>
        models.streamSimple(target, context, { ...options, onPayload: async (payload, currentModel) => {
          const replaced = await options?.onPayload?.(payload, currentModel) as Record<string, unknown>;
          if (change === "known-field") replaced.input = "changed";
          if (change === "unknown-field") replaced.future_provider_field = { exact: false };
          if (change === "deleted-field") delete replaced.future_provider_field;
          if (change === "array-order") replaced.future_array = [2, 1];
          if (change === "number") replaced.future_number = 43;
          return replaced;
        } }),
    };
    let calls = 0;
    const body = { model: model.id, input: "native", future_provider_field: { exact: true },
      future_array: [1, 2], future_number: 42 };
    await expect(sendWithPiEnvelope(altered, model, body, 10, {
      fetch: async () => { calls++; return new Response("must not dispatch"); },
      signal: AbortSignal.timeout(5_000), pi: { apiKey: "test" },
    })).rejects.toThrow("changed the native body");
    expect(calls).toBe(0);
    expect(body).toEqual({ model: model.id, input: "native", future_provider_field: { exact: true },
      future_array: [1, 2], future_number: 42 });
  });

  it("preserves transport errors before a Response exists", async () => {
    const { models, model } = fixture("openai");
    const failure = new Error("network unavailable");
    await expect(sendWithPiEnvelope(models, model, { model: model.id, input: "hello", stream: true }, 10, {
      fetch: async () => { throw failure; },
      signal: AbortSignal.timeout(5_000), pi: { apiKey: "test" },
    })).rejects.toBe(failure);
  });

  it("takes Azure deployment/api-version routing from Pi and changes only the native model field", async () => {
    const { models, model } = fixture("azure-openai-responses", "azure-openai-responses", "https://unit.openai.azure.com");
    const env = { AZURE_OPENAI_API_VERSION: "2025-04-01-preview",
      AZURE_OPENAI_DEPLOYMENT_NAME_MAP: `${model.id}=actual-deployment` };
    const body = { model: model.id, input: "hello", stream: true, future_field: { keep: true } };
    let experiment: Request | undefined;
    await sendWithPiEnvelope(models, model, body, 10, {
      signal: AbortSignal.timeout(5_000), pi: { apiKey: "test", env },
      fetch: async (input, init) => { experiment = new Request(input, init); return new Response("raw"); },
    });
    let baseline: Request | undefined;
    const sender = createProviderResponsesSender({ model, auth: { auth: { apiKey: "test" }, env },
      fetch: async (input, init) => { baseline = new Request(input, init); return new Response("raw"); } })!;
    await sender.send("responses", JSON.stringify(body), AbortSignal.timeout(5_000));
    expect(experiment!.url).toBe(baseline!.url);
    expect(Object.fromEntries(experiment!.headers)).toEqual(Object.fromEntries(baseline!.headers));
    expect(await requestBody(experiment!)).toEqual({ ...body, model: "actual-deployment" });
    expect(await requestBody(baseline!)).toEqual({ ...body, model: "actual-deployment" });
    expect(body.model).toBe(model.id);
    expect(new URL(experiment!.url).searchParams.get("api-version")).toBe("2025-04-01-preview");
  });

  it("lets Pi resolve header-owned authentication without inventing a credential in Context", async () => {
    const provider = openaiProvider();
    const model = { ...provider.getModels()[0]!, baseUrl: "https://gateway.example/v1" };
    const models = createModels();
    models.setProvider({ ...provider, auth: { apiKey: {
      ...provider.auth.apiKey!,
      resolve: async () => ({ auth: { headers: { Authorization: "Bearer header-owned", "x-auth": "resolved" } } }),
    } } });
    let captured: Request | undefined;
    const response = await sendWithPiEnvelope(models, model, { model: model.id, input: "hello", stream: true }, 10, {
      signal: AbortSignal.timeout(5_000),
      fetch: async (input, init) => { captured = new Request(input, init); return new Response("raw"); },
    });
    expect(response.bodyUsed).toBe(false);
    expect(captured!.headers.get("authorization")).toBe("Bearer header-owned");
    expect(captured!.headers.get("x-auth")).toBe("resolved");
  });
});

describe("Responses compaction through max envelope", () => {
  it.each([
    { provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
    { provider: "azure-openai-responses", api: "azure-openai-responses", baseUrl: "https://unit.openai.azure.com" },
    { provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" },
  ])("preserves a certified native compaction turn and opaque compaction response for $provider", async ({ provider, api, baseUrl }) => {
    const { models, model } = fixture(provider, api, baseUrl);
    const body = {
      model: model.id, stream: true, instructions: "client instructions",
      input: [{ role: "user", content: "retain this history" },
        { type: "compaction", encrypted_content: "upstream-opaque-history" },
        { type: "compaction_trigger" }],
      tools: [{ type: "function", name: "sum", parameters: {} }],
      parallel_tool_calls: true, reasoning: { effort: "low" },
      future_compaction_control: { exact: true },
    };
    expect(isCodexRoutedCompactionRequest(body)).toBe(true);
    expect(() => convertResponsesRequest(body, 10)).toThrow();
    expect(() => convertResponsesRequest(body, 10, undefined, "max")).not.toThrow();
    const item = { type: "compaction", id: "cmp_upstream", encrypted_content: "upstream-opaque-new" };
    const wire = [
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { status: "completed", output: [item] } },
    ].map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n";
    const response = new Response(wire, { headers: { "content-type": "text/event-stream" } });
    let captured: Request | undefined;
    const result = await sendWithPiEnvelope(models, model, body, 10, {
      signal: AbortSignal.timeout(5_000), pi: { apiKey: api === "openai-codex-responses" ? TOKEN : "sk-test" },
      fetch: async (input, init) => { captured = new Request(input, init); return response; },
    });
    expect(new URL(captured!.url).pathname).toMatch(/\/responses$/);
    await expect(requestBody(captured!)).resolves.toEqual(body);
    expect(result).toBe(response);
    expect(result.bodyUsed).toBe(false);
    await expect(result.text()).resolves.toBe(wire);
    expect(body.input.at(-1)).toEqual({ type: "compaction_trigger" });
  });

  it.each([true, false])("composes unchanged Token1/routed compaction pure helpers with max, stream=%s", async (stream) => {
    const { models, model } = fixture("github-copilot");
    const envelope = "Token1:" + Buffer.from("previous summary", "utf8").toString("base64");
    const source = {
      model: model.id, stream, instructions: "client instructions",
      input: [{ type: "compaction", encrypted_content: envelope },
        { type: "function_call", namespace: "fs", name: "sum", call_id: "c", arguments: '{"a":2}' },
        { type: "function_call_output", call_id: "c", output: "5" },
        { type: "compaction_trigger" }],
      tools: [{ type: "namespace", name: "fs", tools: [{ type: "function", name: "sum", parameters: {} }] }],
      tool_choice: "auto", parallel_tool_calls: true, reasoning: { effort: "low" },
    };
    const before = JSON.stringify(source);
    // Exactly the existing preparation order; max does not detect/expand/rewrite
    // or reimplement any Token1/routed-compaction operation.
    const expanded = expandTokenCompactionEnvelopes(source);
    const prepared = buildCodexRoutedCompactionRequest(expanded) as Record<string, unknown>;
    expect(isCodexRoutedCompactionRequest(prepared)).toBe(false);
    expect(prepared.tools).toBeUndefined();
    const input = prepared.input as Array<Record<string, unknown>>;
    expect(input.find((item) => item.type === "function_call")).toMatchObject({ name: "fs__sum", call_id: "c" });
    expect(input.find((item) => item.type === "function_call")).not.toHaveProperty("namespace");
    expect(input.at(-1)?.role).toBe("user");
    const query = convertResponsesRequest(prepared, 10, undefined, "max");
    expect(query.context.tools).toBeUndefined();
    expect(JSON.stringify(query.context)).toContain("previous summary");
    const summary = "Goal: retain context.\nNext steps: continue safely.";
    const completed = { status: "completed", output: [{ type: "message", role: "assistant",
      content: [{ type: "output_text", text: summary }] }] };
    const upstreamWire = stream
      ? `data: ${JSON.stringify({ type: "response.completed", response: completed })}\n\ndata: [DONE]\n\n`
      : JSON.stringify(completed);
    const upstream = new Response(upstreamWire, {
      headers: { "content-type": stream ? "text/event-stream" : "application/json" },
    });
    let request: Request | undefined;
    const result = await sendWithPiEnvelope(models, model, prepared, 10, {
      signal: AbortSignal.timeout(5_000), pi: { apiKey: "test" },
      fetch: async (input, init) => { request = new Request(input, init); return upstream; },
    });
    await expect(requestBody(request!)).resolves.toEqual(prepared);
    expect(request!.headers.get("x-initiator")).toBe("user");
    expect(result).toBe(upstream);
    expect(result.bodyUsed).toBe(false);
    const text = extractResponsesOutputText(await result.text());
    expect(text).toBe(summary);
    const client = renderRoutedCompactionClientResponse(text!, {
      responseId: "resp_compaction", createdAt: 10, model: model.id, stream: false,
    });
    const clientBody = await client.json() as { output: Array<Record<string, unknown>> };
    expect(clientBody.output).toHaveLength(1);
    expect(clientBody.output[0]).toMatchObject({ type: "compaction", encrypted_content: expect.stringMatching(/^Token1:/) });
    const next = expandTokenCompactionEnvelopes({ model: model.id, input: clientBody.output });
    expect(JSON.stringify(convertResponsesRequest(next, 10, undefined, "max").context)).toContain(summary.replace(/\n/g, "\\n"));
    expect(JSON.stringify(source)).toBe(before);
  });

  it("also accepts a compact HTTP body shape without stream or a trigger", () => {
    const body = { model: "alias", instructions: "compact", input: [
      { role: "user", content: "history" }, { type: "compaction", encrypted_content: "opaque" },
    ] };
    const before = JSON.stringify(body);
    expect(() => convertResponsesRequest(body, 10, undefined, "max")).not.toThrow();
    expect(JSON.stringify(body)).toBe(before);
  });
});
