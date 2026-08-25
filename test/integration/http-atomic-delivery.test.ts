import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
  Models,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import {
  handleHttpRequest,
  HttpRequestAbortedError,
  type HttpBoundaryDependencies,
} from "../../src/http.js";
import { createAnthropicProviderNativeLane } from "../../src/provider-native-anthropic/index.js";
import { ambientProfileBindings } from "../support/profile-binding-fixture.js";
import {
  createAnthropicMessagesHandler,
  type AnthropicMessagesHandlerOptions,
} from "../../src/protocols/anthropic/handler.js";
import { defaultAnthropicModelValidityPolicy } from "../../src/protocols/anthropic/representability.js";

const model: Model<string> = {
  id: "model",
  name: "model",
  api: "pi-messages",
  provider: "provider",
  baseUrl: "https://provider.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100,
  maxTokens: 10,
};

function message(
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    api: "pi-messages",
    provider: "provider",
    model: "model",
    content: [{ type: "text", text: "complete" }],
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
    ...overrides,
  };
}

function streamFrom(events: AssistantMessageEvent[]): AssistantMessageEventStream {
  let index = 0;
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        const value = events[index++];
        return value === undefined
          ? { done: true as const, value: undefined }
          : { done: false as const, value };
      },
    }),
  } as AssistantMessageEventStream;
}

function request(
  body: string = JSON.stringify({
    model: "model",
    max_tokens: 10,
    messages: [{ role: "user", content: "hello" }],
  }),
  signal?: AbortSignal,
): Request {
  const init: RequestInit = {
    method: "POST",
    headers: {
      authorization: "Bearer client",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body,
  };
  if (signal !== undefined) init.signal = signal;
  return new Request("http://Token.test/v1/messages", init);
}

function dependencies(
  streamFactory: () => AssistantMessageEventStream,
  overrides: Partial<AnthropicMessagesHandlerOptions> = {},
): HttpBoundaryDependencies {
  const models = {
    getModels: () => [model],
    streamSimple: vi.fn(
      (_model: Model<string>, _context: unknown, options?: ModelsSimpleStreamOptions) => {
        const stream = streamFactory();
        const iterator = stream[Symbol.asyncIterator]();
        let prepared = false;
        return {
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              if (!prepared) {
                prepared = true;
                await options?.onPayload?.({
                  model: model.id,
                  context: {},
                  options: { maxTokens: 10 },
                }, model);
              }
              return iterator.next();
            },
          }),
        } as AssistantMessageEventStream;
      },
    ),
  } as unknown as Models;
  const anthropic = createAnthropicMessagesHandler({
    models,
    modelValidityPolicy: defaultAnthropicModelValidityPolicy,
    createMessageId: () => "msg_client",
    maxRequestBytes: 1_000_000,
    routerDefaults: {},
    now: () => 1,
    ...overrides,
  });
  return {
    clientProtocols: [anthropic],
    requestTimeoutMs: undefined,
    shutdownSignal: undefined,
  };
}

async function expectError(
  response: Response,
  status: number,
  type: string,
): Promise<Record<string, unknown>> {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toBe("application/json");
  const body = (await response.json()) as Record<string, unknown>;
  expect(body).toMatchObject({ type: "error", error: { type } });
  expect(body).not.toHaveProperty("content");
  return body;
}

describe("atomic HTTP failure delivery", () => {
  it("renders failures before render state without fake successful state", async () => {
    const never = vi.fn(() => streamFrom([]));
    const invalid = await handleHttpRequest(dependencies(never), request("{"));
    await expectError(invalid, 400, "invalid_request_error");

    const unsupported = await handleHttpRequest(
      dependencies(never),
      request(
        JSON.stringify({
          model: "model",
          max_tokens: 10,
          messages: [
            {
              role: "user",
              content: [{ type: "future_block", data: "x" }],
            },
          ],
        }),
      ),
    );
    await expectError(unsupported, 400, "invalid_request_error");
    expect(never).not.toHaveBeenCalled();
  });

  it("omits unsupported Anthropic stop_sequences without making the request unavailable", async () => {
    const execute = vi.fn(() =>
      streamFrom([{ type: "done", reason: "stop", message: message() }]),
    );
    const response = await handleHttpRequest(
      dependencies(execute),
      request(
        JSON.stringify({
          model: "model",
          max_tokens: 10,
          messages: [{ role: "user", content: "hello" }],
          stop_sequences: ["END"],
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      type: "message",
      content: [{ type: "text", text: "complete" }],
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("classifies an unrepresentable Anthropic server tool as a client semantic error", async () => {
    const execute = vi.fn(() =>
      streamFrom([{ type: "done", reason: "stop", message: message() }]),
    );
    const response = await handleHttpRequest(
      dependencies(execute),
      request(
        JSON.stringify({
          model: "model",
          max_tokens: 10,
          messages: [{ role: "user", content: "hello" }],
          tools: [{ type: "web_search_20250305", name: "web_search" }],
        }),
      ),
    );

    const body = await expectError(response, 400, "invalid_request_error");
    expect(body).toMatchObject({
      error: { message: expect.stringMatching(/server tool/iu) },
    });
  });

  it("keeps transport and model-resolution classifications", async () => {
    const never = vi.fn(() => streamFrom([]));
    const wrongRoute = await handleHttpRequest(
      dependencies(never),
      new Request("http://Token.test/no-route"),
    );
    expect(wrongRoute.status).toBe(404);

    const missing = await handleHttpRequest(
      dependencies(never),
      request(
        JSON.stringify({
          model: "missing",
          max_tokens: 10,
          messages: [{ role: "user", content: "hello" }],
        }),
      ),
    );
    await expectError(missing, 404, "not_found_error");
  });

  it("passes an observed upstream HTTP failure status to the Anthropic protocol", async () => {
    // anthropic-messages models take the passthrough path; mock the upstream
    // 429 and verify the status/body are forwarded to the Anthropic client.
    const observableModel: Model<string> = {
      ...model,
      api: "anthropic-messages",
      provider: "anthropic",
    };
    const upstreamBody = JSON.stringify({
      error: { message: "provider rate limited", type: "rate_limit" },
    });
    const globalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      if (String(input).includes("provider.test")) {
        return new Response(upstreamBody, {
          status: 429,
          statusText: "Too Many Requests",
          headers: { "content-type": "application/json" },
        });
      }
      return globalFetch(input, init);
    }) as typeof fetch;

    try {
      const models = {
        getModels: () => [observableModel],
        getAuth: async () => ({ auth: { apiKey: "sk-gateway" } }),
      } as unknown as Models;
      const anthropic = createAnthropicMessagesHandler({
        models,
        providerNativeLane: createAnthropicProviderNativeLane({
          models,
          bindings: ambientProfileBindings,
          resolveRequestModel: (value) => value,
          fetch: globalThis.fetch,
        }),
        modelValidityPolicy: defaultAnthropicModelValidityPolicy,
        createMessageId: () => "msg_client",
        maxRequestBytes: 1_000_000,
        routerDefaults: {},
        now: () => 1,
      });
      const runtimeDeps: HttpBoundaryDependencies = {
        clientProtocols: [anthropic],
        requestTimeoutMs: undefined,
        shutdownSignal: undefined,
      };
      const response = await handleHttpRequest(
        runtimeDeps,
        request(),
      );
      // Passthrough forwards the upstream error response verbatim.
      expect(response.status).toBe(429);
      expect(response.headers.get("content-type")).toBe("application/json");
      await expect(response.text()).resolves.toBe(upstreamBody);
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = globalFetch;
    }
  });

  it("forwards Pi provider failures as upstream errors without faking success", async () => {
    const providerDiagnostic = "provider rate limit exceeded";
    const failed = await handleHttpRequest(
      dependencies(() =>
        streamFrom([
          {
            type: "error",
            reason: "error",
            error: message({
              stopReason: "error",
              errorMessage: providerDiagnostic,
            }),
          },
        ]),
      ),
      request(),
    );
    const failedBody = await expectError(failed, 502, "api_error");
    expect(failedBody).toMatchObject({
      error: { message: "Upstream provider failed" },
    });
    expect(JSON.stringify(failedBody)).not.toContain(providerDiagnostic);

    const malformed = await handleHttpRequest(
      dependencies(() => streamFrom([])),
      request(),
    );
    await expectError(malformed, 500, "api_error");

    const unexpectedlyAborted = await handleHttpRequest(
      dependencies(() =>
        streamFrom([
          {
            type: "error",
            reason: "aborted",
            error: message({ stopReason: "aborted" }),
          },
        ]),
      ),
      request(),
    );
    await expectError(unexpectedlyAborted, 500, "api_error");

    const runtimeDiagnostic = "private runtime diagnostic";
    const runtimeFailure = await handleHttpRequest(
      dependencies(() => {
        throw new Error(runtimeDiagnostic);
      }),
      request(),
    );
    const runtimeBody = await expectError(runtimeFailure, 502, "api_error");
    expect(runtimeBody).toMatchObject({
      error: { message: "Upstream provider failed" },
    });
    expect(JSON.stringify(runtimeBody)).not.toContain(runtimeDiagnostic);
  });

  it("turns a post-commit late-block rendering failure into only a server error", async () => {
    const committed = message({
      content: [
        { type: "text", text: "must-not-be-written" },
        {
          type: "toolCall",
          id: "call",
          name: "tool",
          arguments: { invalid: BigInt(1) },
        },
      ],
      stopReason: "toolUse",
    });
    const createMessageId = vi.fn(() => "msg_client");
    const response = await handleHttpRequest(
      dependencies(
        () =>
          streamFrom([{ type: "done", reason: "toolUse", message: committed }]),
        { createMessageId },
      ),
      request(),
    );

    const body = await expectError(response, 500, "api_error");
    expect(createMessageId).toHaveBeenCalledOnce();
    expect(JSON.stringify(body)).not.toContain("must-not-be-written");
  });

  it("treats disconnect after commit as delivery-only and returns no response", async () => {
    const disconnect = new AbortController();
    const committed = message();
    const createMessageId = vi.fn(() => {
      disconnect.abort(new Error("closed after commit"));
      return "msg_client";
    });
    const handling = handleHttpRequest(
      dependencies(
        () => streamFrom([{ type: "done", reason: "stop", message: committed }]),
        { createMessageId },
      ),
      request(undefined, disconnect.signal),
    );

    await expect(handling).rejects.toBeInstanceOf(HttpRequestAbortedError);
    expect(createMessageId).toHaveBeenCalledOnce();
  });
});
