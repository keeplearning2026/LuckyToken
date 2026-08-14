import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  Models,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import type { Auth } from "../../src/auth.js";
import { createAnthropicMessagesHandler } from "../../src/protocols/anthropic/handler.js";
import {
  createUpstreamFailureDiagnostic,
  createUpstreamFailureFact,
} from "../../src/protocols/upstream-failure.js";
import { createOpenAIResponsesHandler } from "../../src/protocols/openai-responses/handler.js";
import type { ResponseSessionState } from "../../src/protocols/openai-responses/session-state.js";

const auth: Auth = {
  resolve: async () => ({ authorized: true, sessionId: "session" }),
};

function model(api: string): Model<string> {
  return {
    id: "model",
    name: "model",
    api,
    provider: "provider",
    baseUrl: "https://provider.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100,
    maxTokens: 10,
  };
}

function message(api: string): AssistantMessage {
  return {
    role: "assistant",
    api,
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
  };
}

function terminalStream(value: AssistantMessage): AssistantMessageEventStream {
  let emitted = false;
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        if (emitted) return { done: true as const, value: undefined };
        emitted = true;
        return {
          done: false as const,
          value: { type: "done" as const, reason: "stop" as const, message: value },
        };
      },
    }),
  } as AssistantMessageEventStream;
}

function errorStream(diagnostic: string): AssistantMessageEventStream {
  const failed = { ...message("fixture-api"), stopReason: "error" as const };
  failed.errorMessage = diagnostic;
  let emitted = false;
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        if (emitted) return { done: true as const, value: undefined };
        emitted = true;
        return {
          done: false as const,
          value: { type: "error" as const, reason: "error" as const, error: failed },
        };
      },
    }),
  } as AssistantMessageEventStream;
}

const sessionState: ResponseSessionState = {
  expand: async (body) => body,
  remember: async () => undefined,
  flush: async () => undefined,
  size: () => 0,
};

function responsesRequest(): Request {
  return new Request("https://luckytoken.test/v1/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer client",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "provider/model", input: "hello" }),
  });
}

function anthropicRequest(): Request {
  return new Request("https://luckytoken.test/v1/messages", {
    method: "POST",
    headers: {
      authorization: "Bearer client",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "provider/model",
      max_tokens: 10,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
}

describe("Provider execution boundary", () => {
  it.each(["anthropic", "responses"] as const)(
    "renders an unstructured %s Provider failure as a fixed generic 502",
    async (client) => {
      const diagnostic = "status=401 secret provider diagnostic";
      const selected = model("fixture-api");
      const models = {
        getModels: () => [selected],
        streamSimple: () => errorStream(diagnostic),
      } as unknown as Models;
      const handler = client === "anthropic"
        ? createAnthropicMessagesHandler({
            models,
            auth,
            maxRequestBytes: 1024,
            createMessageId: () => "msg_test",
            now: () => 1,
          })
        : createOpenAIResponsesHandler({
            models,
            auth,
            stateFile: "unused.json",
            sessionState,
            maxRequestBytes: 1024,
            createResponseId: () => "resp_test",
            now: () => 1,
          });

      const response = await handler.handle(
        client === "anthropic" ? anthropicRequest() : responsesRequest(),
      );
      expect(response.status).toBe(502);
      const body = JSON.stringify(await response.json());
      expect(body).toContain("Upstream provider failed");
      expect(body).not.toContain(diagnostic);
      expect(body).not.toContain("401");
    },
  );

  it.each(["anthropic-messages", "google-generative-ai", "google-vertex"])(
    "executes %s through the Responses conversion route without custom fetch",
    async (api) => {
      const selected = model(api);
      const streamSimple = vi.fn(
        (
          _model: Model<string>,
          _context: unknown,
          options: ModelsSimpleStreamOptions,
        ) => {
          expect(options).not.toHaveProperty("fetch");
          return terminalStream(message(api));
        },
      );
      const models = {
        getModels: () => [selected],
        streamSimple,
      } as unknown as Models;
      const handler = createOpenAIResponsesHandler({
        models,
        auth,
        stateFile: "unused.json",
        sessionState,
        maxRequestBytes: 1024,
        createResponseId: () => "resp_test",
        now: () => 1,
      });

      const response = await handler.handle(responsesRequest());

      expect(response.status).toBe(200);
      expect(streamSimple).toHaveBeenCalledOnce();
    },
  );

  it("executes the Anthropic conversion route without custom fetch", async () => {
    const selected = model("fixture-api");
    const streamSimple = vi.fn(
      (
        _model: Model<string>,
        _context: unknown,
        options: ModelsSimpleStreamOptions,
      ) => {
        expect(options).not.toHaveProperty("fetch");
        return terminalStream(message("fixture-api"));
      },
    );
    const models = {
      getModels: () => [selected],
      streamSimple,
    } as unknown as Models;
    const handler = createAnthropicMessagesHandler({
      models,
      auth,
      maxRequestBytes: 1024,
      createMessageId: () => "msg_test",
      now: () => 1,
    });

    const response = await handler.handle(anthropicRequest());

    expect(response.status).toBe(200);
    expect(streamSimple).toHaveBeenCalledOnce();
  });

  it("keeps concurrent and later neutral failures request-local", async () => {
    const selected = model("fixture-api");
    const facts = [
      createUpstreamFailureFact({
        kind: "http",
        status: 429,
        message: "first request throttled",
        headers: { "x-request-id": "req-first" },
      }),
      createUpstreamFailureFact({
        kind: "http",
        status: 503,
        message: "second request unavailable",
        headers: { "x-request-id": "req-second" },
      }),
    ] as const;
    let call = 0;
    let started = 0;
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const streamSimple = vi.fn(() => {
      const fact = facts[call++];
      if (fact === undefined) return errorStream("later unstructured failure");
      const failed = { ...message("fixture-api"), stopReason: "error" as const };
      failed.errorMessage = "fallback must not replace neutral fact";
      failed.diagnostics = [createUpstreamFailureDiagnostic(fact, call)];
      let emitted = false;
      return {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            if (emitted) return { done: true as const, value: undefined };
            emitted = true;
            started += 1;
            if (started === 2) release();
            await bothStarted;
            return {
              done: false as const,
              value: {
                type: "error" as const,
                reason: "error" as const,
                error: failed,
              },
            };
          },
        }),
      } as AssistantMessageEventStream;
    });
    const models = {
      getModels: () => [selected],
      streamSimple,
    } as unknown as Models;
    const anthropic = createAnthropicMessagesHandler({
      models,
      auth,
      maxRequestBytes: 1024,
      now: () => 1,
    });
    const responses = createOpenAIResponsesHandler({
      models,
      auth,
      stateFile: "unused.json",
      sessionState,
      maxRequestBytes: 1024,
      now: () => 1,
    });

    const [first, second] = await Promise.all([
      anthropic.handle(anthropicRequest()),
      responses.handle(responsesRequest()),
    ]);

    expect(first.status).toBe(429);
    expect(first.headers.get("x-request-id")).toBe("req-first");
    expect(await first.text()).toContain("first request throttled");
    expect(second.status).toBe(503);
    expect(second.headers.get("x-request-id")).toBe("req-second");
    expect(await second.text()).toContain("second request unavailable");

    const prefetchFailure = await anthropic.handle(
      new Request("https://luckytoken.test/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer client",
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "provider/model",
          max_tokens: 10,
          messages: [
            {
              role: "user",
              content: [{ type: "future_block", data: "invalid" }],
            },
          ],
        }),
      }),
    );
    expect(prefetchFailure.status).toBe(400);
    const prefetchBody = await prefetchFailure.text();
    expect(prefetchBody).not.toContain("req-first");
    expect(prefetchBody).not.toContain("req-second");
    expect(prefetchBody).not.toContain("first request throttled");
    expect(prefetchBody).not.toContain("second request unavailable");

    const later = await responses.handle(responsesRequest());
    expect(later.status).toBe(502);
    const laterBody = await later.text();
    expect(laterBody).toContain("Upstream provider failed");
    expect(laterBody).not.toContain("req-first");
    expect(laterBody).not.toContain("req-second");
  });
});
