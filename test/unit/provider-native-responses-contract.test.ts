import type { FetchFunction, Model, Models } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { handleHttpRequest, type HttpBoundaryDependencies } from "../../src/http.js";
import type {
  RequestJourneyObservationAuthority,
  RequestJourneyObservationInput,
} from "../../src/diagnostics/contract.js";
import { createOpenAIResponsesHandler } from "../../src/protocols/openai-responses/handler.js";
import type { PublicModelSource } from "../../src/public-model-seam.js";
import {
  createProviderNativeResponses,
  supportsProviderNativeResponses,
} from "../../src/provider-native-responses/index.js";
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

function request(
  body: string,
  headers: Record<string, string> = {},
  url = "http://Token.test/v1/responses",
): Request {
  return new Request(url, {
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
  diagnostics?: RequestJourneyObservationAuthority,
  publicModels?: PublicModelSource,
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
    ...(publicModels === undefined ? {} : { publicModels }),
  });
  return {
    clientProtocols: [handler],
    requestTimeoutMs: undefined,
    shutdownSignal: undefined,
    ...(diagnostics === undefined ? {} : { diagnostics }),
  };
}

function recordingJourney(): {
  readonly authority: RequestJourneyObservationAuthority;
  readonly observations: RequestJourneyObservationInput[];
} {
  const observations: RequestJourneyObservationInput[] = [];
  const authority: RequestJourneyObservationAuthority = {
    begin: (input) => ({
      requestId: input.requestId,
      observe: (observation) => observations.push(observation),
      close: () => undefined,
    }),
    observeRuntime: () => undefined,
  };
  return { authority, observations };
}

describe("Provider Native Responses contract", () => {
  it("claims only explicit provider/protocol native contracts", () => {
    expect(
      supportsProviderNativeResponses(
        responsesModel("openai-responses"),
        "responses",
      ),
    ).toBe(true);
    expect(
      supportsProviderNativeResponses(
        responsesModel("anthropic-messages"),
        "responses",
      ),
    ).toBe(false);

    const codex = responsesModel(
      "openai-codex-responses",
      "https://chatgpt.com/backend-api",
    );
    codex.provider = "openai-codex";
    expect(supportsProviderNativeResponses(codex, "responses")).toBe(true);

    const unrelated = responsesModel("openai-codex-responses");
    unrelated.provider = "another-provider";
    expect(
      supportsProviderNativeResponses(unrelated, "responses"),
    ).toBe(false);

    const custom = responsesModel("openai-responses");
    custom.provider = "custom-provider";
    expect(supportsProviderNativeResponses(custom, "responses")).toBe(false);
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

  it("observes native upstream usage through the Request Journey", async () => {
    const model = responsesModel();
    const recorded = recordingJourney();
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
      dependencies(models(model), fetch, recorded.authority),
      request(JSON.stringify({ model: "openai/gpt-5", input: "hi" })),
    );

    expect(response.status).toBe(200);
    expect(recorded.observations).toContainEqual(expect.objectContaining({
      kind: "terminal_usage_observed",
      usage: expect.objectContaining({
        input: 12,
        cacheRead: 5,
        output: 7,
        terminalClass: "done",
      }),
    }));
  });

  it("records streamed usage when a successful Provider Native upstream omits Content-Type", async () => {
    const model = responsesModel();
    const recorded = recordingJourney();
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
      dependencies(models(model), fetch, recorded.authority),
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
    expect(recorded.observations).toContainEqual(expect.objectContaining({
      kind: "terminal_usage_observed",
      usage: expect.objectContaining({
        input: 12,
        cacheRead: 5,
        output: 7,
        terminalClass: "done",
      }),
    }));
  });

  it("projects wrapped SSE response identity without treating tool-schema model properties as aliases", async () => {
    const model = responsesModel();
    const alias = "public/gpt-native";
    const publicModels: PublicModelSource = {
      requestSnapshot: async () =>
        ({
          resolve: (selector: string) =>
            selector === alias
              ? { providerId: model.provider, modelId: model.id }
              : undefined,
        }) as never,
    };
    const responseObject = {
      id: "resp_tools",
      object: "response",
      status: "completed",
      model: model.id,
      tools: [{
        type: "function",
        name: "choose",
        parameters: {
          type: "object",
          properties: {
            model: {
              type: "string",
              description: "Requested model",
            },
          },
        },
      }],
    };
    const sse = ["created", "in_progress", "completed"]
      .map(
        (status) =>
          `event: response.${status}\ndata: ${JSON.stringify({
            type: `response.${status}`,
            response: responseObject,
          })}\n\n`,
      )
      .join("");
    const fetch: FetchFunction = async () =>
      new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

    const response = await handleHttpRequest(
      dependencies(models(model), fetch, undefined, publicModels),
      request(JSON.stringify({ model: alias, input: "hi", stream: true })),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const projected = await response.text();
    const frames = projected.trim().split("\n\n");
    expect(frames).toHaveLength(3);
    for (const frame of frames) {
      const payload = JSON.parse(frame.split("\n")[1]!.slice(6)) as {
        response: typeof responseObject;
      };
      expect(payload.response.model).toBe(alias);
      expect(
        payload.response.tools[0]!.parameters.properties.model.description,
      ).toBe("Requested model");
    }
  });

  it("applies alias projection after lifecycle normalization", async () => {
    const model = responsesModel();
    const alias = "public/gpt-native";
    const publicModels: PublicModelSource = {
      requestSnapshot: async () =>
        ({
          resolve: (selector: string) =>
            selector === alias
              ? { providerId: model.provider, modelId: model.id }
              : undefined,
        }) as never,
    };
    const responseObject = {
      id: "resp_alias_normalized",
      object: "response",
      status: "in_progress",
      model: model.id,
      output: [],
    };
    const item = (id: string, status: string) => ({
      type: "message",
      id,
      role: "assistant",
      status,
      content: [],
    });
    const events = [
      { type: "response.created", response: responseObject },
      { type: "response.output_item.added", output_index: 0, item: item("msg_a", "in_progress") },
      { type: "response.output_item.added", output_index: 1, item: item("msg_b", "in_progress") },
      { type: "response.output_item.done", output_index: 1, item: item("msg_b", "completed") },
      { type: "response.output_item.done", output_index: 0, item: item("msg_a", "completed") },
      { type: "response.completed", response: { ...responseObject, status: "completed" } },
    ];
    const upstreamSse = events
      .map(
        (event, sequence_number) =>
          `event: ${event.type}\ndata: ${JSON.stringify({
            ...event,
            sequence_number,
          })}\n\n`,
      )
      .join("");
    const fetch: FetchFunction = async () =>
      new Response(upstreamSse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

    const response = await handleHttpRequest(
      dependencies(models(model), fetch, undefined, publicModels),
      request(JSON.stringify({ model: alias, input: "hi", stream: true })),
    );

    expect(response.status).toBe(200);
    const result = await response.text();
    expect(result).toContain(`"model":"${alias}"`);
    expect(result).not.toContain(`"model":"${model.id}"`);
    expect(result.indexOf('"id":"msg_b"')).toBeLessThan(
      result.indexOf('"id":"msg_a"'),
    );
  });

  it("still applies alias projection when lifecycle normalization is skipped", async () => {
    const model = responsesModel();
    const alias = "public/gpt-native";
    const publicModels: PublicModelSource = {
      requestSnapshot: async () =>
        ({
          resolve: (selector: string) =>
            selector === alias
              ? { providerId: model.provider, modelId: model.id }
              : undefined,
        }) as never,
    };
    const upstreamSse =
      `event: response.created\ndata: ${JSON.stringify({
        type: "response.created",
        sequence_number: 0,
        response: {
          id: "resp_alias_skipped",
          object: "response",
          status: "in_progress",
          model: model.id,
          output: [],
        },
      })}\n\n` +
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"in_progress","content":[]}}\n\n' +
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":2,"output_index":1,"item_id":"msg_a","content_index":0,"delta":"A"}\n\n' +
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":3,"output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"completed","content":[]}}\n\n' +
      `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        sequence_number: 4,
        response: {
          id: "resp_alias_skipped",
          object: "response",
          status: "completed",
          model: model.id,
          output: [],
        },
      })}\n\n`;
    const fetch: FetchFunction = async () =>
      new Response(upstreamSse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

    const response = await handleHttpRequest(
      dependencies(models(model), fetch, undefined, publicModels),
      request(JSON.stringify({ model: alias, input: "hi", stream: true })),
    );

    expect(response.status).toBe(200);
    const result = await response.text();
    expect(result).toContain(`"model":"${alias}"`);
    expect(result).not.toContain(`"model":"${model.id}"`);
    expect(result).toContain('"output_index":1,"item_id":"msg_a"');
  });

  it("records an exact Provider Native alias-projection failure instead of a generic request failure", async () => {
    const model = responsesModel();
    const alias = "public/gpt-native";
    const publicModels: PublicModelSource = {
      requestSnapshot: async () =>
        ({
          resolve: (selector: string) =>
            selector === alias
              ? { providerId: model.provider, modelId: model.id }
              : undefined,
        }) as never,
    };
    const recorded = recordingJourney();
    const responseObject = {
      id: "resp_ambiguous",
      object: "response",
      status: "completed",
      model: model.id,
      output: [{
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [],
        model: model.id,
      }],
    };
    const sse =
      `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: responseObject,
      })}\n\n`;
    const fetch: FetchFunction = async () =>
      new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

    const response = await handleHttpRequest(
      dependencies(models(model), fetch, recorded.authority, publicModels),
      request(JSON.stringify({ model: alias, input: "hi", stream: true })),
    );

    expect(response.status).toBe(502);
    expect(recorded.observations).toContainEqual(
      expect.objectContaining({
        kind: "failure_detected",
        classification: "provider_native_alias_projection_failed",
        origin: "Token",
        originPrecision: "exact",
        location: expect.objectContaining({
          phase: "lane_response_processing",
          lane: "provider_native",
          step: "preserve_provider_response",
        }),
      }),
    );
  });

  it("records a safe upstream HTTP failure for alias errors without leaking bytes", async () => {
    const model = responsesModel();
    const alias = "public/gpt-native";
    const publicModels: PublicModelSource = {
      requestSnapshot: async () =>
        ({
          resolve: (selector: string) =>
            selector === alias
              ? { providerId: model.provider, modelId: model.id }
              : undefined,
        }) as never,
    };
    const recorded = recordingJourney();
    const upstreamBody = JSON.stringify({
      error: {
        message: JSON.stringify({
          error: {
            message: "Request Entity Too Large",
            type: "AI_APICallError",
          },
          providerMetadata: {
            gateway: {
              routing: {
                originalModelId: "deepseek/deepseek-v4.1-flash",
                resolvedProvider: "deepseek",
                canonicalSlug: "deepseek/deepseek-v4.1-flash",
              },
            },
          },
        }),
        type: "server_error",
      },
    });
    const fetch: FetchFunction = async () =>
      new Response(upstreamBody, {
        status: 413,
        headers: { "content-type": "application/json" },
      });

    const response = await handleHttpRequest(
      dependencies(models(model), fetch, recorded.authority, publicModels),
      request(JSON.stringify({ model: alias, input: "hi" })),
    );
    const body = await response.text();

    expect(response.status).toBe(502);
    expect(body).toContain("Upstream provider failed");
    expect(body).not.toContain("Request Entity Too Large");
    expect(body).not.toContain("deepseek");
    expect(recorded.observations).toContainEqual(
      expect.objectContaining({
        kind: "failure_detected",
        role: "primary",
        classification: "provider_http_413",
        origin: "provider",
        originPrecision: "external_boundary",
        safeMessage:
          "Upstream provider returned HTTP 413: Request Entity Too Large.",
        location: expect.objectContaining({
          phase: "lane_response_processing",
          lane: "provider_native",
          step: "preserve_provider_response",
          attempt: 1,
        }),
      }),
    );
  });

  it("records a safe upstream HTTP failure for non-alias errors", async () => {
    const model = responsesModel();
    const recorded = recordingJourney();
    const upstreamBody = JSON.stringify({
      error: {
        message: "Invalid input",
        type: "invalid_request_error",
        param: "input",
      },
    });
    const fetch: FetchFunction = async () =>
      new Response(upstreamBody, {
        status: 400,
        headers: { "content-type": "application/json" },
      });

    const response = await handleHttpRequest(
      dependencies(models(model), fetch, recorded.authority),
      request(JSON.stringify({ model: "openai/gpt-5", input: "hi" })),
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe(upstreamBody);
    expect(recorded.observations).toContainEqual(
      expect.objectContaining({
        kind: "failure_detected",
        role: "primary",
        classification: "provider_http_400",
        origin: "provider",
        originPrecision: "external_boundary",
        safeMessage: "Upstream provider returned HTTP 400: Invalid input.",
        location: expect.objectContaining({
          phase: "lane_response_processing",
          lane: "provider_native",
          step: "preserve_provider_response",
          attempt: 1,
        }),
      }),
    );
  });

  it("normalizes interleaved Provider Native SSE and records bounded lifecycle observations", async () => {
    const model = responsesModel();
    const recorded = recordingJourney();
    const upstreamSse =
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":0,"output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"in_progress","content":[]}}\n\n' +
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":1,"output_index":1,"item":{"type":"message","id":"msg_b","role":"assistant","status":"in_progress","content":[]}}\n\n' +
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":2,"output_index":1,"item_id":"msg_b","content_index":0,"delta":"B"}\n\n' +
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":3,"output_index":1,"item":{"type":"message","id":"msg_b","role":"assistant","status":"completed","content":[{"type":"output_text","text":"B","annotations":[]}]}}\n\n' +
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":4,"output_index":0,"item_id":"msg_a","content_index":0,"delta":"A"}\n\n' +
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":5,"output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"completed","content":[{"type":"output_text","text":"A","annotations":[]}]}}\n\n';
    const expectedSse =
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":0,"output_index":1,"item":{"type":"message","id":"msg_b","role":"assistant","status":"in_progress","content":[]}}\n\n' +
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":1,"output_index":1,"item_id":"msg_b","content_index":0,"delta":"B"}\n\n' +
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":2,"output_index":1,"item":{"type":"message","id":"msg_b","role":"assistant","status":"completed","content":[{"type":"output_text","text":"B","annotations":[]}]}}\n\n' +
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":3,"output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"in_progress","content":[]}}\n\n' +
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":4,"output_index":0,"item_id":"msg_a","content_index":0,"delta":"A"}\n\n' +
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":5,"output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"completed","content":[{"type":"output_text","text":"A","annotations":[]}]}}\n\n';
    const fetch: FetchFunction = async () =>
      new Response(upstreamSse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

    const response = await handleHttpRequest(
      dependencies(models(model), fetch, recorded.authority),
      request(JSON.stringify({ model: "openai/gpt-5", input: "hi", stream: true })),
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(expectedSse);
    expect(recorded.observations).toContainEqual(
      expect.objectContaining({
        kind: "conversion_notice_observed",
        code: "provider_native_lifecycle_normalized",
        severity: "info",
        location: {
          phase: "lane_response_processing",
          lane: "provider_native",
          step: "normalize_provider_native_lifecycle",
        },
      }),
    );
    expect(recorded.observations).toContainEqual(
      expect.objectContaining({
        kind: "conversion_notice_observed",
        code: "item_commit_order_differs_from_output_index",
        severity: "warning",
      }),
    );
    expect(recorded.observations).toContainEqual(
      expect.objectContaining({
        kind: "artifact_observed",
        artifactId: "provider_native_lifecycle_normalized_wire",
        artifactKind: "provider_native_lifecycle_normalized_wire",
        state: "captured",
      }),
    );
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

  it("normalizes interleaved Provider Native SSE before returning it", async () => {
    const model = responsesModel();
    const item = (id: string, status: string) => ({
      type: "message",
      id,
      role: "assistant",
      status,
      content: [],
    });
    const events = [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: item("msg_a", "in_progress"),
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: item("msg_b", "in_progress"),
      },
      {
        type: "response.output_text.delta",
        output_index: 1,
        item_id: "msg_b",
        content_index: 0,
        delta: "B",
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: item("msg_b", "completed"),
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        item_id: "msg_a",
        content_index: 0,
        delta: "A",
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: item("msg_a", "completed"),
      },
    ] as const;
    const upstreamSse = events
      .map(
        (event, sequence_number) =>
          `event: ${event.type}\ndata: ${JSON.stringify({
            ...event,
            sequence_number,
          })}\n\n`,
      )
      .join("");
    const expectedEvents = [
      events[1]!,
      events[2]!,
      events[3]!,
      events[0]!,
      events[4]!,
      events[5]!,
    ];
    const expectedSse = expectedEvents
      .map(
        (event, sequence_number) =>
          `event: ${event.type}\ndata: ${JSON.stringify({
            ...event,
            sequence_number,
          })}\n\n`,
      )
      .join("");
    const fetch: FetchFunction = async () =>
      new Response(upstreamSse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

    const response = await handleHttpRequest(
      dependencies(models(model), fetch),
      request(JSON.stringify({ model: "openai/gpt-5", input: "hi", stream: true })),
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(expectedSse);
  });

  it("keeps the original Provider Native SSE when lifecycle normalization is skipped", async () => {
    const model = responsesModel();
    const upstreamSse =
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":0,"output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"in_progress","content":[]}}\n\n' +
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":1,"output_index":1,"item_id":"msg_a","content_index":0,"delta":"A"}\n\n' +
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":2,"output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"completed","content":[]}}\n\n';
    const fetch: FetchFunction = async () =>
      new Response(upstreamSse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

    const response = await handleHttpRequest(
      dependencies(models(model), fetch),
      request(JSON.stringify({ model: "openai/gpt-5", input: "hi", stream: true })),
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(upstreamSse);
  });

  it.each([
    {
      name: "background request",
      body: { model: "openai/gpt-5", input: "hi", stream: true, background: true },
      headers: {},
      url: "http://Token.test/v1/responses",
    },
    {
      name: "Last-Event-ID",
      body: { model: "openai/gpt-5", input: "hi", stream: true },
      headers: { "last-event-id": "cursor-1" },
      url: "http://Token.test/v1/responses",
    },
    {
      name: "starting_after query",
      body: { model: "openai/gpt-5", input: "hi", stream: true },
      headers: {},
      url: "http://Token.test/v1/responses?starting_after=7",
    },
  ])("does not normalize Provider Native SSE with upstream cursor semantics: $name", async ({ body, headers, url }) => {
    const model = responsesModel();
    const upstreamSse =
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":0,"output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"in_progress","content":[]}}\n\n' +
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":1,"output_index":1,"item":{"type":"message","id":"msg_b","role":"assistant","status":"in_progress","content":[]}}\n\n' +
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":2,"output_index":1,"item":{"type":"message","id":"msg_b","role":"assistant","status":"completed","content":[]}}\n\n' +
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":3,"output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"completed","content":[]}}\n\n';
    const fetch: FetchFunction = async () =>
      new Response(upstreamSse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

    const response = await handleHttpRequest(
      dependencies(models(model), fetch),
      request(JSON.stringify(body), headers, url),
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(upstreamSse);
  });

  it("does not confuse previous_response_id with upstream SSE cursor semantics", async () => {
    const model = responsesModel();
    const upstreamSse =
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":0,"output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"in_progress","content":[]}}\n\n' +
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":1,"output_index":1,"item":{"type":"message","id":"msg_b","role":"assistant","status":"in_progress","content":[]}}\n\n' +
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":2,"output_index":1,"item":{"type":"message","id":"msg_b","role":"assistant","status":"completed","content":[]}}\n\n' +
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":3,"output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"completed","content":[]}}\n\n';
    const expectedSse =
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":0,"output_index":1,"item":{"type":"message","id":"msg_b","role":"assistant","status":"in_progress","content":[]}}\n\n' +
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":1,"output_index":1,"item":{"type":"message","id":"msg_b","role":"assistant","status":"completed","content":[]}}\n\n' +
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"in_progress","content":[]}}\n\n' +
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":3,"output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"completed","content":[]}}\n\n';
    const fetch: FetchFunction = async () =>
      new Response(upstreamSse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

    const response = await handleHttpRequest(
      dependencies(models(model), fetch),
      request(JSON.stringify({
        model: "openai/gpt-5",
        input: "hi",
        stream: true,
        previous_response_id: "resp_previous",
      })),
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(expectedSse);
  });

  it("observes lifecycle normalization without changing Provider Native success semantics", async () => {
    const model = responsesModel();
    const recorded = recordingJourney();
    const upstreamSse =
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":0,"output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"in_progress","content":[]}}\n\n' +
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":1,"output_index":1,"item":{"type":"message","id":"msg_b","role":"assistant","status":"in_progress","content":[]}}\n\n' +
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":2,"output_index":1,"item":{"type":"message","id":"msg_b","role":"assistant","status":"completed","content":[]}}\n\n' +
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":3,"output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"completed","content":[]}}\n\n';
    const fetch: FetchFunction = async () =>
      new Response(upstreamSse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

    const response = await handleHttpRequest(
      dependencies(models(model), fetch, recorded.authority),
      request(JSON.stringify({ model: "openai/gpt-5", input: "hi", stream: true })),
    );

    expect(response.status).toBe(200);
    expect(recorded.observations).toContainEqual(expect.objectContaining({
      kind: "step_completed",
      stepInstanceId: "p5.normalize_provider_native_lifecycle",
      completion: "success",
      location: {
        phase: "lane_response_processing",
        lane: "provider_native",
        step: "normalize_provider_native_lifecycle",
      },
    }));
    expect(recorded.observations).toContainEqual(expect.objectContaining({
      kind: "conversion_notice_observed",
      code: "provider_native_lifecycle_normalized",
      severity: "info",
    }));
    expect(recorded.observations).toContainEqual(expect.objectContaining({
      kind: "conversion_notice_observed",
      code: "item_commit_order_differs_from_output_index",
      severity: "warning",
    }));
    expect(recorded.observations).toContainEqual(expect.objectContaining({
      kind: "artifact_observed",
      artifactId: "provider_native_lifecycle_normalized_wire",
      artifactKind: "provider_native_lifecycle_normalized_wire",
      state: "captured",
    }));
    expect(
      recorded.observations.filter(
        (observation) => observation.kind === "failure_detected",
      ),
    ).toEqual([]);
  });

  it("records a bounded skipped notice without turning normalization into a request failure", async () => {
    const model = responsesModel();
    const recorded = recordingJourney();
    const upstreamSse =
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":0,"output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"in_progress","content":[]}}\n\n' +
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":1,"output_index":1,"item_id":"msg_a","content_index":0,"delta":"A"}\n\n' +
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":2,"output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"completed","content":[]}}\n\n';
    const fetch: FetchFunction = async () =>
      new Response(upstreamSse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

    const response = await handleHttpRequest(
      dependencies(models(model), fetch, recorded.authority),
      request(JSON.stringify({ model: "openai/gpt-5", input: "hi", stream: true })),
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(upstreamSse);
    expect(recorded.observations).toContainEqual(expect.objectContaining({
      kind: "conversion_notice_observed",
      code: "provider_native_lifecycle_normalization_skipped",
      severity: "info",
      message: "item_identity_conflict",
    }));
    expect(
      recorded.observations.some(
        (observation) =>
          observation.kind === "artifact_observed" &&
          observation.artifactKind === "provider_native_lifecycle_normalized_wire",
      ),
    ).toBe(false);
    expect(
      recorded.observations.filter(
        (observation) => observation.kind === "failure_detected",
      ),
    ).toEqual([]);
  });

  it("keeps normalized Provider Native responses identical when diagnostics observation throws", async () => {
    const model = responsesModel();
    const upstreamSse =
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":0,"output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"in_progress","content":[]}}\n\n' +
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":1,"output_index":1,"item":{"type":"message","id":"msg_b","role":"assistant","status":"in_progress","content":[]}}\n\n' +
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":2,"output_index":1,"item":{"type":"message","id":"msg_b","role":"assistant","status":"completed","content":[]}}\n\n' +
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":3,"output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"completed","content":[]}}\n\n';
    const fetch: FetchFunction = async () =>
      new Response(upstreamSse, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "x-provider-response": "kept",
        },
      });
    const requestBody = JSON.stringify({
      model: "openai/gpt-5",
      input: "hi",
      stream: true,
    });
    const run = async (
      diagnostics?: RequestJourneyObservationAuthority,
    ): Promise<{
      readonly status: number;
      readonly headers: readonly (readonly [string, string])[];
      readonly body: string;
    }> => {
      const response = await handleHttpRequest(
        dependencies(models(model), fetch, diagnostics),
        request(requestBody),
      );
      return {
        status: response.status,
        headers: Array.from(response.headers.entries())
          .filter(([name]) => name.toLowerCase() !== "x-token-request-id")
          .sort(([a], [b]) => a.localeCompare(b)),
        body: await response.text(),
      };
    };

    const baseline = await run();
    let observeReached = false;
    const throwing: RequestJourneyObservationAuthority = {
      begin: (input) => ({
        requestId: input.requestId,
        observe: () => {
          observeReached = true;
          throw new Error("diagnostics-observe-must-not-interfere");
        },
        close: () => {
          throw new Error("diagnostics-close-must-not-interfere");
        },
      }),
      observeRuntime: () => undefined,
    };
    const faulted = await run(throwing);

    expect(observeReached).toBe(true);
    expect(faulted).toEqual(baseline);
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
