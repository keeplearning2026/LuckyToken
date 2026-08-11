import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
  Models,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import type { Auth } from "../../src/auth.js";
import {
  handleHttpRequest,
  HttpRequestAbortedError,
  type HttpBoundaryDependencies,
} from "../../src/http.js";
import {
  createAnthropicMessagesHandler,
  type AnthropicMessagesHandlerOptions,
} from "../../src/protocols/anthropic/handler.js";
import { defaultAnthropicModelValidityPolicy } from "../../src/protocols/anthropic/representability.js";

const model: Model<string> = {
  id: "model",
  name: "model",
  api: "api",
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
    api: "api",
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
  return new Request("http://luckytoken.test/v1/messages", init);
}

function dependencies(
  streamFactory: () => AssistantMessageEventStream,
  overrides: Partial<AnthropicMessagesHandlerOptions> = {},
): HttpBoundaryDependencies {
  const auth: Auth = {
    resolve: async () => ({ authorized: true, sessionId: "session" }),
  };
  const models = {
    getModels: () => [model],
    streamSimple: vi.fn(streamFactory),
  } as unknown as Models;
  const anthropic = createAnthropicMessagesHandler({
    models,
    auth,
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
          messages: [{ role: "user", content: "hello" }],
          stop_sequences: ["stop"],
        }),
      ),
    );
    await expectError(unsupported, 400, "invalid_request_error");
    expect(never).not.toHaveBeenCalled();
  });

  it("keeps transport, authorization, and model-resolution classifications", async () => {
    const never = vi.fn(() => streamFrom([]));
    const wrongRoute = await handleHttpRequest(
      dependencies(never),
      new Request("http://luckytoken.test/no-route"),
    );
    expect(wrongRoute.status).toBe(404);

    const denied = await handleHttpRequest(
      dependencies(never, {
        auth: { resolve: async () => ({ authorized: false }) },
      }),
      request(),
    );
    await expectError(denied, 401, "authentication_error");

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

  it("never converts Pi errors, Provider failures, or malformed execution to success", async () => {
    const providerDiagnostic = "private provider diagnostic";
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
    const failedBody = await expectError(failed, 500, "api_error");
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
    const runtimeBody = await expectError(runtimeFailure, 500, "api_error");
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
