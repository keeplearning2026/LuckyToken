import type { Model, Models } from "@earendil-works/pi-ai";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Auth } from "../../src/auth.js";
import { handleHttpRequest, type HttpBoundaryDependencies } from "../../src/http.js";
import { HttpObserver } from "../../src/http-observer.js";
import { parseFailureLoggingConfiguration } from "../../src/invocation-diagnostics/configuration.js";
import { createInvocationDiagnosticsFactory } from "../../src/invocation-diagnostics/index.js";
import {
  isResponsesNativePassthroughModel,
  passthroughResponsesRequest,
  passthroughResponsesRequestHeaders,
} from "../../src/protocols/openai-responses/passthrough.js";
import {
  createOpenAIResponsesHandler,
  type OpenAIResponsesHandlerOptions,
} from "../../src/protocols/openai-responses/handler.js";

/**
 * Ticket 19: native Responses passthrough contract. The classifier, transport,
 * header policy, and certification are Responses-owned; nothing here may be
 * shared with (or imported from) the Anthropic passthrough profile.
 */

function responsesModel(
  api = "openai-responses",
  baseUrl = "https://responses.example.com",
): Model<string> {
  return {
    id: "gpt-5",
    name: "gpt-5",
    api,
    provider: "my-responses",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 64000,
  };
}

function request(
  body: string,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://luckytoken.test/v1/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer client",
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
}

function dependencies(
  models: Models,
  extra: Partial<OpenAIResponsesHandlerOptions> = {},
  observer?: HttpObserver,
): HttpBoundaryDependencies {
  const auth: Auth = {
    resolve: async () => ({ authorized: true, sessionId: "session" }),
  };
  const options: OpenAIResponsesHandlerOptions = {
    models,
    auth,
    createResponseId: () => "resp_test",
    maxRequestBytes: 1_000_000,
    routerDefaults: {},
    stateFile: join(tmpdir(), "luckytoken-responses-passthrough-state.json"),
    now: () => 1,
    ...extra,
    ...(observer === undefined ? {} : { httpObserver: observer }),
  };
  const responses = createOpenAIResponsesHandler(options);
  return {
    clientProtocols: [responses],
    requestTimeoutMs: undefined,
    shutdownSignal: undefined,
  };
}

function passthroughModels(
  model: Model<string>,
  authResult: unknown = { auth: { apiKey: "sk-responses" } },
): Models {
  return {
    getModels: () => [model],
    getAuth: async () => authResult,
  } as unknown as Models;
}

function captureGlobalFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): { restore: () => void; observer: HttpObserver } {
  const original = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = impl as typeof fetch;
  const observer = new HttpObserver();
  return {
    restore: () => {
      (globalThis as { fetch: typeof fetch }).fetch = original;
    },
    observer,
  };
}

describe("19: native Responses passthrough contract", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("selects on declared Responses wire compatibility, not provider identity", () => {
    expect(isResponsesNativePassthroughModel(responsesModel("openai-responses"))).toBe(
      true,
    );
    expect(isResponsesNativePassthroughModel(responsesModel("anthropic-messages"))).toBe(
      false,
    );
    expect(isResponsesNativePassthroughModel(responsesModel("openai-codex-responses"))).toBe(
      false,
    );
    const anyProvider = responsesModel("openai-responses");
    anyProvider.provider = "some-other-vendor";
    expect(isResponsesNativePassthroughModel(anyProvider)).toBe(true);
  });

  it("forwards the raw body verbatim to {baseUrl}/v1/responses with upstream auth", async () => {
    const model = responsesModel();
    const upstreamRequests: Request[] = [];
    const { restore, observer } = captureGlobalFetch(async (input, init) => {
      upstreamRequests.push(new Request(input, init));
      return new Response(
        JSON.stringify({
          id: "resp_upstream",
          object: "response",
          created_at: 1,
          status: "completed",
          error: null,
          incomplete_details: null,
          instructions: null,
          metadata: {},
          model: "gpt-5",
          output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [] }],
          parallel_tool_calls: true,
          temperature: null,
          tool_choice: "auto",
          tools: [],
          top_p: null,
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    try {
      const rawBody = JSON.stringify({
        model: "my-responses/gpt-5",
        input: "hi",
        stream: false,
        future_field: { opaque: true },
      });
      const response = await handleHttpRequest(
        dependencies(passthroughModels(model), {}, observer),
        request(rawBody),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.id).toBe("resp_upstream");
      expect(upstreamRequests).toHaveLength(1);
      expect(upstreamRequests[0]?.url).toBe(
        "https://responses.example.com/v1/responses",
      );
      expect(upstreamRequests[0]?.headers.get("authorization")).toBe(
        "Bearer sk-responses",
      );
      const upstreamBody = JSON.parse(
        (await upstreamRequests[0]?.text()) ?? "{}",
      ) as Record<string, unknown>;
      // The qualified Lucky selector is rewritten to the registered model id.
      expect(upstreamBody).toMatchObject({
        model: "gpt-5",
        input: "hi",
        future_field: { opaque: true },
      });
    } finally {
      restore();
    }
  });

  it("passes native handles, hosted tools, background/store and future fields without conversion loss", async () => {
    const model = responsesModel();
    const upstreamRequests: Request[] = [];
    const { restore, observer } = captureGlobalFetch(async (input, init) => {
      upstreamRequests.push(new Request(input, init));
      return new Response(
        JSON.stringify({
          id: "resp_upstream",
          object: "response",
          status: "completed",
          output: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    try {
      // Fields that Core conversion v1 would reject or degrade must survive
      // verbatim under native passthrough: conversation/prompt handles, file
      // IDs, compaction encrypted state, hosted tool declarations, background
      // jobs, store policy, and future wire fields.
      const rawBody = JSON.stringify({
        model: "my-responses/gpt-5",
        conversation: "conv_abc",
        prompt: "prompt_xyz",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_image", file_id: "file_123" },
              { type: "input_text", text: "hi" },
            ],
          },
          {
            type: "compaction",
            id: "comp_1",
            encrypted_content: "encrypted-bytes",
          },
          {
            type: "item_reference",
            id: "item_456",
            envelope: { authority: "external-service" },
          },
        ],
        tools: [
          { type: "web_search_preview" },
          { type: "file_search" },
          { type: "code_interpreter" },
        ],
        background: true,
        store: false,
        stream_options: { include_obfuscation: true },
        future_field: { nested: { value: 1 } },
      });
      const response = await handleHttpRequest(
        dependencies(passthroughModels(model), {}, observer),
        request(rawBody),
      );
      expect(response.status).toBe(200);
      expect(upstreamRequests).toHaveLength(1);
      const upstreamBody = JSON.parse(
        (await upstreamRequests[0]?.text()) ?? "{}",
      ) as Record<string, unknown>;
      // Everything except the qualified selector is preserved verbatim; the
      // selector itself is rewritten to the registered model id.
      const expected = JSON.parse(rawBody) as Record<string, unknown>;
      expected.model = "gpt-5";
      expect(upstreamBody).toEqual(expected);
    } finally {
      restore();
    }
  });

  it("filters request headers: approved end-to-end only; no hop-by-hop/cookie/auth", async () => {
    const headers = new Headers({
      authorization: "Bearer client-secret",
      cookie: "session=abc",
      "x-api-key": "client-key",
      "x-stainless-retry-count": "2",
      "openai-beta": "responses-v1",
      "content-length": "999",
      connection: "keep-alive",
      "transfer-encoding": "chunked",
    });
    const forwarded = passthroughResponsesRequestHeaders(
      new Request("http://lucky.test/v1/responses", { headers }),
    );
    expect(forwarded).toEqual({ "x-stainless-retry-count": "2" });
    expect(forwarded).not.toHaveProperty("authorization");
    expect(forwarded).not.toHaveProperty("cookie");
    expect(forwarded).not.toHaveProperty("x-api-key");
    expect(forwarded).not.toHaveProperty("openai-beta");
    expect(forwarded).not.toHaveProperty("content-length");
    expect(forwarded).not.toHaveProperty("connection");
    expect(forwarded).not.toHaveProperty("transfer-encoding");
  });

  it("preserves status, body, and safe response headers; strips unsafe ones", async () => {
    const model = responsesModel();
    const { restore, observer } = captureGlobalFetch(async () =>
      new Response('{"id":"resp_1","object":"response","status":"completed"}', {
        status: 200,
        headers: {
          "content-type": "application/json",
          "request-id": "req_resp_ok",
          "set-cookie": "sid=1",
          "transfer-encoding": "chunked",
          "x-ratelimit-remaining": "7",
        },
      }),
    );
    try {
      const result = await passthroughResponsesRequest({
        model,
        rawBody: "{}",
        apiKey: "upstream-key",
        signal: new AbortController().signal,
        fetch: observer.observedFetch,
      });
      expect(result.status).toBe(200);
      expect(new TextDecoder().decode(result.body)).toBe(
        '{"id":"resp_1","object":"response","status":"completed"}',
      );
      expect(result.headers).toEqual({
        "content-type": "application/json",
        "request-id": "req_resp_ok",
        "x-ratelimit-remaining": "7",
      });
      expect(result.headers).not.toHaveProperty("set-cookie");
      expect(result.headers).not.toHaveProperty("transfer-encoding");
    } finally {
      restore();
    }
  });

  it("preserves native SSE frames byte-for-byte", async () => {
    const model = responsesModel();
    const sseBody =
      'data: {"type":"response.created","sequence_number":0,"response":{"status":"in_progress"}}\n\n' +
      'data: {"type":"response.output_item.done","sequence_number":1,"output_index":0,"item":{"type":"message"}}\n\n' +
      'data: {"type":"response.completed","sequence_number":2,"response":{"status":"completed"}}\n\n' +
      "data: [DONE]\n\n";
    const { restore, observer } = captureGlobalFetch(async () =>
      new Response(sseBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    try {
      const response = await handleHttpRequest(
        dependencies(passthroughModels(model), {}, observer),
        request(
          JSON.stringify({
            model: "my-responses/gpt-5",
            input: "hi",
            stream: true,
          }),
        ),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      await expect(response.text()).resolves.toBe(sseBody);
    } finally {
      restore();
    }
  });

  it("preserves incomplete native SSE frames byte-for-byte", async () => {
    const model = responsesModel();
    // A native passthrough must forward the upstream's incomplete lifecycle
    // verbatim, never normalize it into a completed Response or a
    // conversion-semantic error.
    const sseBody =
      'data: {"type":"response.created","sequence_number":0,"response":{"status":"in_progress"}}\n\n' +
      'data: {"type":"response.incomplete","sequence_number":1,"response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}\n\n' +
      "data: [DONE]\n\n";
    const { restore, observer } = captureGlobalFetch(async () =>
      new Response(sseBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    try {
      const response = await handleHttpRequest(
        dependencies(passthroughModels(model), {}, observer),
        request(
          JSON.stringify({
            model: "my-responses/gpt-5",
            input: "hi",
            stream: true,
          }),
        ),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      await expect(response.text()).resolves.toBe(sseBody);
    } finally {
      restore();
    }
  });

  it("preserves failed native SSE frames byte-for-byte", async () => {
    const model = responsesModel();
    // A failed lifecycle must pass through verbatim: the client receives the
    // upstream's failed terminal event unchanged, never a conversion-rendered
    // error envelope.
    const sseBody =
      'data: {"type":"response.created","sequence_number":0,"response":{"status":"in_progress"}}\n\n' +
      'data: {"type":"response.failed","sequence_number":1,"response":{"status":"failed","error":{"code":"server_error","message":"upstream exploded"}}}\n\n' +
      "data: [DONE]\n\n";
    const { restore, observer } = captureGlobalFetch(async () =>
      new Response(sseBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    try {
      const response = await handleHttpRequest(
        dependencies(passthroughModels(model), {}, observer),
        request(
          JSON.stringify({
            model: "my-responses/gpt-5",
            input: "hi",
            stream: true,
          }),
        ),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      await expect(response.text()).resolves.toBe(sseBody);
    } finally {
      restore();
    }
  });

  it("returns a legal Responses error when the upstream body read fails (pre-commit)", async () => {
    const model = responsesModel();
    const { restore, observer } = captureGlobalFetch(async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new Error("connection reset while reading body"));
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    try {
      const response = await handleHttpRequest(
        dependencies(passthroughModels(model), {}, observer),
        request(
          JSON.stringify({
            model: "my-responses/gpt-5",
            input: "hi",
          }),
        ),
      );
      expect(response.status).toBeGreaterThanOrEqual(500);
      const body = (await response.json()) as Record<string, unknown>;
      const error = body.error as Record<string, unknown>;
      expect(error.type).toBeDefined();
    } finally {
      restore();
    }
  });

  it("writes one bounded failure journal for a final upstream failure", async () => {
    const model = responsesModel();
    const root = await mkdtemp(join(tmpdir(), "luckytoken-responses-pt-journal-"));
    roots.push(root);
    const journal = createInvocationDiagnosticsFactory({
      configuration: parseFailureLoggingConfiguration(
        {
          directory: root,
          detail: "safe",
          maxFileBytes: 64 * 1024,
          retentionDays: 1,
          maxFiles: 10,
          logCancellation: true,
        },
        root,
      ),
    });
    const { restore, observer } = captureGlobalFetch(async () =>
      new Response('{"error":{"message":"rate limited","type":"rate_limit"}}', {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      const response = await handleHttpRequest(
        dependencies(
          passthroughModels(model),
          { invocationDiagnostics: journal },
          observer,
        ),
        request(
          JSON.stringify({
            model: "my-responses/gpt-5",
            input: "hi",
          }),
        ),
      );
      expect(response.status).toBe(429);
      const days = await readdir(root);
      const files = await readdir(join(root, days[0] ?? ""));
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^[0-9a-f-]{36}\.json$/u);
    } finally {
      restore();
    }
  });

  it("aborts upstream work and never writes a closed response", async () => {
    const model = responsesModel();
    const controller = new AbortController();
    let upstreamSignal: AbortSignal | null | undefined;
    const { restore, observer } = captureGlobalFetch(async (input, init) => {
      void input;
      upstreamSignal = init?.signal;
      controller.abort(new Error("client went away"));
      return new Response("{}", { status: 200 });
    });
    try {
      const responsePromise = handleHttpRequest(
        dependencies(passthroughModels(model), {}, observer),
        new Request("http://luckytoken.test/v1/responses", {
          method: "POST",
          headers: {
            authorization: "Bearer client",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "my-responses/gpt-5",
            input: "hi",
          }),
          signal: controller.signal,
        }),
      );
      await expect(responsePromise).rejects.toThrow();
      expect(upstreamSignal?.aborted).toBe(true);
    } finally {
      restore();
    }
  });

  it("requires an upstream credential before any transport work", async () => {
    const model = responsesModel();
    const { restore, observer } = captureGlobalFetch(async () => {
      throw new Error("must not be called");
    });
    try {
      const response = await handleHttpRequest(
        dependencies(
          passthroughModels(model, undefined),
          {},
          observer,
        ),
        request(
          JSON.stringify({
            model: "my-responses/gpt-5",
            input: "hi",
          }),
        ),
      );
      expect(response.status).toBeGreaterThanOrEqual(500);
    } finally {
      restore();
    }
  });

  it("preserves a configured base-path prefix on the endpoint", async () => {
    const model = responsesModel("openai-responses", "https://responses.example.com/api");
    const upstreamRequests: Request[] = [];
    const { restore, observer } = captureGlobalFetch(async (input, init) => {
      upstreamRequests.push(new Request(input, init));
      return new Response(
        JSON.stringify({ id: "resp_1", object: "response", status: "completed" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    try {
      const response = await handleHttpRequest(
        dependencies(passthroughModels(model), {}, observer),
        request(
          JSON.stringify({
            model: "my-responses/gpt-5",
            input: "hi",
          }),
        ),
      );
      expect(response.status).toBe(200);
      expect(upstreamRequests[0]?.url).toBe(
        "https://responses.example.com/api/v1/responses",
      );
    } finally {
      restore();
    }
  });

  it("rewrites a qualified Lucky selector to the registered model id", async () => {
    const model = responsesModel();
    const upstreamRequests: Request[] = [];
    const { restore, observer } = captureGlobalFetch(async (input, init) => {
      upstreamRequests.push(new Request(input, init));
      return new Response(
        JSON.stringify({ id: "resp_1", object: "response", status: "completed" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    try {
      const rawBody = JSON.stringify({
        model: "my-responses/gpt-5",
        input: "hi",
        future_field: { opaque: true },
      });
      const response = await handleHttpRequest(
        dependencies(passthroughModels(model), {}, observer),
        request(rawBody),
      );
      expect(response.status).toBe(200);
      const upstreamBody = JSON.parse(
        (await upstreamRequests[0]?.text()) ?? "{}",
      ) as Record<string, unknown>;
      // The qualified Lucky selector is rewritten to the registered model id;
      // a Lucky selector must never leak to the upstream wire.
      expect(upstreamBody).toEqual({
        model: "gpt-5",
        input: "hi",
        future_field: { opaque: true },
      });
    } finally {
      restore();
    }
  });

  it("keeps the raw body byte-identical when the selector already equals the model id", async () => {
    const model = responsesModel();
    const upstreamRequests: Request[] = [];
    const { restore, observer } = captureGlobalFetch(async (input, init) => {
      upstreamRequests.push(new Request(input, init));
      return new Response(
        JSON.stringify({ id: "resp_1", object: "response", status: "completed" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    try {
      const rawBody = JSON.stringify({ model: "gpt-5", input: "hi" });
      const response = await handleHttpRequest(
        dependencies(passthroughModels(model), {}, observer),
        request(rawBody),
      );
      expect(response.status).toBe(200);
      expect(await upstreamRequests[0]?.text()).toBe(rawBody);
    } finally {
      restore();
    }
  });

  it("renders a legal Responses error when the upstream fetch rejects (pre-commit network failure)", async () => {
    const model = responsesModel();
    const { restore, observer } = captureGlobalFetch(async () => {
      throw new TypeError("fetch failed: connection refused");
    });
    try {
      const response = await handleHttpRequest(
        dependencies(passthroughModels(model), {}, observer),
        request(
          JSON.stringify({
            model: "my-responses/gpt-5",
            input: "hi",
          }),
        ),
      );
      expect(response.status).toBeGreaterThanOrEqual(500);
      const body = (await response.json()) as Record<string, unknown>;
      const error = body.error as Record<string, unknown>;
      expect(error.type).toBeDefined();
      // The message must reflect the upstream failure, never a generic
      // "Internal server error" that hides the transport failure.
      expect(String(error.message)).toContain("fetch failed");
    } finally {
      restore();
    }
  });
});
