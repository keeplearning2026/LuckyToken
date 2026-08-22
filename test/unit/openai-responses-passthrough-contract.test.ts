import type { FetchFunction, Model, Models } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { handleHttpRequest, type HttpBoundaryDependencies } from "../../src/http.js";
import {
  createOpenAIResponsesHandler,
  type OpenAIResponsesHandlerOptions,
} from "../../src/protocols/openai-responses/handler.js";
import {
  createProviderNativeResponses,
  supportsProviderNativeResponses,
} from "../../src/provider-native-responses/index.js";
import { createRecordingRequestLedger } from "../support/recording-request-ledger.js";
import { ambientProfileBindings } from "../support/profile-binding-fixture.js";

function responsesModel(
  api = "openai-responses",
  baseUrl = "https://responses.example.com",
): Model<string> {
  return {
    id: "gpt-5",
    name: "gpt-5",
    api,
    provider: "openai",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64_000,
  };
}

function request(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://luckytoken.test/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

function models(
  model: Model<string>,
  auth: unknown = { auth: { apiKey: "sk-responses" } },
): Models {
  return {
    getModels: () => [model],
    getAuth: async () => auth,
  } as unknown as Models;
}

function dependencies(
  source: Models,
  fetch: FetchFunction,
  extra: Partial<OpenAIResponsesHandlerOptions> = {},
): HttpBoundaryDependencies {
  const handler = createOpenAIResponsesHandler({
    models: source,
    providerNativeLane: createProviderNativeResponses({
      models: source,
      bindings: ambientProfileBindings,
      fetch,
    }),
    stateFile: "provider-native-contract-state.json",
    maxRequestBytes: 1_000_000,
    createResponseId: () => "resp_test",
    now: () => 1,
    ...extra,
  });
  return {
    clientProtocols: [handler],
    requestTimeoutMs: undefined,
    shutdownSignal: undefined,
  };
}

describe("Provider Native Responses contract", () => {
  it("claims only explicit provider/protocol native contracts", () => {
    expect(supportsProviderNativeResponses(responsesModel("openai-responses"))).toBe(true);
    expect(supportsProviderNativeResponses(responsesModel("anthropic-messages"))).toBe(false);

    const codex = responsesModel(
      "openai-codex-responses",
      "https://chatgpt.com/backend-api",
    );
    codex.provider = "openai-codex";
    expect(supportsProviderNativeResponses(codex)).toBe(true);

    const unrelated = responsesModel("openai-codex-responses");
    unrelated.provider = "another-provider";
    expect(supportsProviderNativeResponses(unrelated)).toBe(false);

    const custom = responsesModel("openai-responses");
    custom.provider = "custom-provider";
    expect(supportsProviderNativeResponses(custom)).toBe(false);
  });

  it("preserves opaque request fields while rewriting only the upstream model selector", async () => {
    const model = responsesModel();
    const upstream: Request[] = [];
    const fetch: FetchFunction = async (input, init) => {
      upstream.push(new Request(input, init));
      return new Response(
        JSON.stringify({ id: "resp_upstream", object: "response", status: "completed", model: "gpt-5", output: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const rawBody = '{\n  "model": "openai/gpt-5",\n  "input": [{"type":"additional_tools","role":"developer","tools":[{"type":"function","name":"lookup","namespace":"dynamic_tools"}]}],\n  "future_number": 9007199254740993,\n  "negative_zero": -0,\n  "future_field": {"opaque":true}\n}';

    const response = await handleHttpRequest(
      dependencies(models(model), fetch),
      request(rawBody),
    );

    expect(response.status).toBe(200);
    expect(upstream).toHaveLength(1);
    expect(upstream[0]?.url).toBe("https://responses.example.com/responses");
    expect(upstream[0]?.headers.get("authorization")).toBe("Bearer sk-responses");
    await expect(upstream[0]?.text()).resolves.toBe(
      rawBody.replace('"openai/gpt-5"', '"gpt-5"'),
    );
  });

  it("records native upstream usage through the Request Ledger", async () => {
    const model = responsesModel();
    const recorded = createRecordingRequestLedger();
    const fetch: FetchFunction = async () =>
      new Response(
        JSON.stringify({
          id: "resp_usage",
          object: "response",
          status: "completed",
          model: "gpt-5",
          output: [],
          usage: {
            input_tokens: 20,
            input_tokens_details: { cached_tokens: 5, cache_write_tokens: 3 },
            output_tokens: 7,
            output_tokens_details: { reasoning_tokens: 2 },
            total_tokens: 27,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const response = await handleHttpRequest(
      dependencies(models(model), fetch, { requestLedger: recorded.ledger }),
      request(JSON.stringify({ model: "openai/gpt-5", input: "hi" })),
    );

    expect(response.status).toBe(200);
    expect(recorded.terminalUsage).toHaveLength(1);
    expect(recorded.terminalUsage[0]).toMatchObject({
      api: "openai-responses",
      completeness: "complete",
      input: 12,
      cacheRead: 5,
      cacheWrite: 3,
      output: 7,
      reasoning: 2,
      normalizedTotal: 27,
    });
  });

  it("records streamed usage when a successful Provider Native upstream omits Content-Type", async () => {
    const model = responsesModel();
    const recorded = createRecordingRequestLedger();
    const terminal = JSON.stringify({
      type: "response.completed",
      response: {
        status: "completed",
        model: "gpt-5",
        usage: {
          input_tokens: 20,
          input_tokens_details: { cached_tokens: 5, cache_write_tokens: 3 },
          output_tokens: 7,
          output_tokens_details: { reasoning_tokens: 2 },
          total_tokens: 27,
        },
      },
    });
    const upstreamBody = `event: response.completed\ndata: ${terminal}\n\n`;
    const fetch: FetchFunction = async () =>
      new Response(new TextEncoder().encode(upstreamBody), { status: 200 });

    const response = await handleHttpRequest(
      dependencies(models(model), fetch, { requestLedger: recorded.ledger }),
      request(
        JSON.stringify({
          model: "openai/gpt-5",
          input: "hi",
          stream: true,
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBeNull();
    await expect(response.text()).resolves.toBe(upstreamBody);
    expect(recorded.terminalUsage).toEqual([
      expect.objectContaining({
        api: "openai-responses",
        completeness: "complete",
        input: 12,
        cacheRead: 5,
        cacheWrite: 3,
        output: 7,
        reasoning: 2,
        normalizedTotal: 27,
      }),
    ]);
  });

  it("returns upstream SSE bytes unchanged when no alias projection is required", async () => {
    const model = responsesModel();
    const sse =
      'data: {"type":"response.created","sequence_number":0,"response":{"status":"in_progress"}}\n\n' +
      'data: {"type":"response.output_item.done","sequence_number":1,"output_index":0,"item":{"type":"function_call","call_id":"call_1","name":"lookup","namespace":"dynamic_tools","arguments":"{}"}}\n\n' +
      'data: {"type":"response.completed","sequence_number":2,"response":{"status":"completed"}}\n\n' +
      "data: [DONE]\n\n";
    const fetch: FetchFunction = async () =>
      new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

    const response = await handleHttpRequest(
      dependencies(models(model), fetch),
      request(JSON.stringify({ model: "openai/gpt-5", input: "hi", stream: true })),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    await expect(response.text()).resolves.toBe(sse);
  });

  it("returns a fixed 502 when Provider credential resolution fails, without transport fallback", async () => {
    const model = responsesModel();
    let fetchCalls = 0;
    const fetch: FetchFunction = async () => {
      fetchCalls += 1;
      return new Response("unexpected");
    };

    const missingCredentialModels = {
      getModels: () => [model],
      getAuth: async () => undefined,
    } as unknown as Models;
    const response = await handleHttpRequest(
      dependencies(missingCredentialModels, fetch),
      request(JSON.stringify({ model: "openai/gpt-5", input: "hi" })),
    );

    expect(response.status).toBe(502);
    expect(fetchCalls).toBe(0);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "api_error", message: "Provider is not configured" },
    });
  });

  it("returns a fixed 502 when Provider Native transport rejects", async () => {
    const model = responsesModel();
    const fetch: FetchFunction = async () => {
      throw new TypeError("connection refused to secret.example");
    };

    const response = await handleHttpRequest(
      dependencies(models(model), fetch),
      request(JSON.stringify({ model: "openai/gpt-5", input: "hi" })),
    );

    expect(response.status).toBe(502);
    const body = (await response.json()) as { error?: { message?: string } };
    expect(body.error?.message).toBe("Upstream provider request failed");
    expect(JSON.stringify(body)).not.toContain("secret.example");
  });

  it("preserves a configured base-path prefix", async () => {
    const model = responsesModel("openai-responses", "https://responses.example.com/api");
    const urls: string[] = [];
    const fetch: FetchFunction = async (input) => {
      urls.push(String(input));
      return new Response(
        JSON.stringify({ id: "resp", object: "response", status: "completed", model: "gpt-5", output: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const response = await handleHttpRequest(
      dependencies(models(model), fetch),
      request(JSON.stringify({ model: "openai/gpt-5", input: "hi" })),
    );

    expect(response.status).toBe(200);
    expect(urls).toEqual(["https://responses.example.com/api/responses"]);
  });
});
