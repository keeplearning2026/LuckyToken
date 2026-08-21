import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  Models,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createInvocationAttemptDiagnostic } from "@luckytoken/provider-contract/diagnostics";
import { parseFailureLoggingConfiguration } from "../../src/invocation-diagnostics/configuration.js";
import { createInvocationDiagnosticsFactory } from "../../src/invocation-diagnostics/index.js";
import { createAnthropicMessagesHandler } from "../../src/protocols/anthropic/handler.js";
import {
  createUpstreamFailureDiagnostic,
  createUpstreamFailureFact,
} from "@luckytoken/provider-contract/diagnostics";
import { createOpenAIResponsesHandler } from "../../src/protocols/openai-responses/handler.js";
import type { ResponseSessionState } from "../../src/protocols/openai-responses/session-state.js";

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

function responsesRequest(content = "hello"): Request {
  return new Request("https://luckytoken.test/v1/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer client",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "provider/model", input: content }),
  });
}

function anthropicRequest(content = "hello"): Request {
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
      messages: [{ role: "user", content }],
    }),
  });
}

describe("Provider execution boundary", () => {
  it("executes a complete Responses request without expanding continuation state", async () => {
    const selected = model("fixture-api");
    const streamSimple = vi.fn(() => terminalStream(message("fixture-api")));
    const models = {
      getModels: () => [selected],
      streamSimple,
    } as unknown as Models;
    const handler = createOpenAIResponsesHandler({
      models,
      stateFile: "unused.json",
      sessionState: {
        ...sessionState,
        expand: async () => {
          throw new Error("complete requests must not expand continuation state");
        },
      },
      maxRequestBytes: 1024,
      createResponseId: () => "resp_test",
      now: () => 1,
    });

    const response = await handler.handle(responsesRequest());

    expect(response.status).toBe(200);
    expect(streamSimple).toHaveBeenCalledOnce();
  });

  it("uses a LuckyToken-owned response ID on the converted path", async () => {
    const selected = model("fixture-api");
    const providerMessage = {
      ...message("fixture-api"),
      responseId: "resp_provider_owned",
    };
    const models = {
      getModels: () => [selected],
      streamSimple: () => terminalStream(providerMessage),
    } as unknown as Models;
    const createResponseId = vi.fn(() => "resp_luckytoken_owned");
    const handler = createOpenAIResponsesHandler({
      models,
      stateFile: "unused.json",
      sessionState,
      maxRequestBytes: 1024,
      createResponseId,
      now: () => 1,
    });

    const response = await handler.handle(responsesRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "resp_luckytoken_owned" });
    expect(createResponseId).toHaveBeenCalledOnce();
  });

  it("checkpoints only the raw current request after continuation expansion", async () => {
    const selected = model("fixture-api");
    const models = {
      getModels: () => [selected],
      streamSimple: () => terminalStream(message("fixture-api")),
    } as unknown as Models;
    const remember = vi.fn(async () => undefined);
    const handler = createOpenAIResponsesHandler({
      models,
      stateFile: "unused.json",
      sessionState: {
        ...sessionState,
        expand: async (body) => ({
          ...(body as Record<string, unknown>),
          input: "expanded history",
        }),
        remember,
      },
      maxRequestBytes: 1024,
      createResponseId: () => "resp_child",
      now: () => 1,
    });
    const rawRequest = {
      model: "provider/model",
      input: "current increment",
      previous_response_id: "resp_parent",
    };

    const response = await handler.handle(
      new Request("https://luckytoken.test/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer client",
          "content-type": "application/json",
        },
        body: JSON.stringify(rawRequest),
      }),
    );

    expect(response.status).toBe(200);
    expect(remember).toHaveBeenCalledWith(
      rawRequest,
      expect.objectContaining({ id: "resp_child" }),
      expect.any(Function),
    );
  });

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
            maxRequestBytes: 1024,
            createMessageId: () => "msg_test",
            now: () => 1,
          })
        : createOpenAIResponsesHandler({
            models,
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
      const body = (await response.json()) as {
        error?: { type?: string; message?: string };
        request_id?: string;
      };
      expect(body.error).toMatchObject({
        type: "api_error",
        message: "Upstream provider failed",
      });
      expect(JSON.stringify(body)).not.toContain(diagnostic);
      // The upstream status must not leak through the error payload. The
      // unrelated request_id is an opaque UUID and may legitimately contain
      // the digit sequence "401" by chance.
      expect(JSON.stringify(body.error)).not.toContain("401");
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
    let started = 0;
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const streamWithFact = (
      fact: (typeof facts)[number],
      attempt: number,
    ): AssistantMessageEventStream => {
      const failed = { ...message("fixture-api"), stopReason: "error" as const };
      failed.errorMessage = "fallback must not replace neutral fact";
      failed.diagnostics = [createUpstreamFailureDiagnostic(fact, attempt)];
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
    };
    const anthropicModels = {
      getModels: () => [selected],
      streamSimple: vi.fn(() => streamWithFact(facts[0], 1)),
    } as unknown as Models;
    let responsesCalls = 0;
    const responsesModels = {
      getModels: () => [selected],
      streamSimple: vi.fn(() => {
        responsesCalls += 1;
        return responsesCalls === 1
          ? streamWithFact(facts[1], 2)
          : errorStream("later unstructured failure");
      }),
    } as unknown as Models;
    const anthropic = createAnthropicMessagesHandler({
      models: anthropicModels,
      maxRequestBytes: 1024,
      now: () => 1,
    });
    const responses = createOpenAIResponsesHandler({
      models: responsesModels,
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

  it("writes one isolated journal per failed Anthropic/Responses route and none for success", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-cross-route-journal-"));
    try {
      const configuration = parseFailureLoggingConfiguration(
        { directory: "journals", maxFiles: 10 },
        root,
      );
      const requestIds = [
        "44444444-4444-4444-8444-444444444441",
        "44444444-4444-4444-8444-444444444442",
        "44444444-4444-4444-8444-444444444443",
      ];
      const invocationDiagnostics = createInvocationDiagnosticsFactory({
        configuration,
        createRequestId: () => requestIds.shift()!,
        now: () => Date.UTC(2026, 7, 14),
      });
      const selected = model("fixture-api");
      let started = 0;
      let release!: () => void;
      const bothStarted = new Promise<void>((resolve) => {
        release = resolve;
      });
      const streamSimple = vi.fn((_model: unknown, context: unknown) => {
        const serialized = JSON.stringify(context);
        if (serialized.includes("successful-later-request")) {
          return terminalStream(message("fixture-api"));
        }
        const anthropicFailure = serialized.includes("anthropic-journal-marker");
        const fact = createUpstreamFailureFact({
          kind: "http",
          status: anthropicFailure ? 429 : 503,
          message: anthropicFailure ? "anthropic throttled" : "responses unavailable",
          headers: {
            "x-request-id": anthropicFailure
              ? "upstream-anthropic"
              : "upstream-responses",
          },
          attemptCount: 1,
        });
        const attempt = Object.freeze({
          attempt: 1,
          classification: "http",
          stage: "response_headers",
          status: anthropicFailure ? 429 : 503,
          retryable: false,
          safeIds: Object.freeze({
            "x-request-id": anthropicFailure
              ? "upstream-anthropic"
              : "upstream-responses",
          }),
        });
        const failed = { ...message("fixture-api"), stopReason: "error" as const };
        failed.errorMessage = "generic fallback";
        failed.diagnostics = [
          createInvocationAttemptDiagnostic(attempt, 1),
          createUpstreamFailureDiagnostic(fact, 1),
        ];
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
        invocationDiagnostics,
        maxRequestBytes: 1024,
        now: () => 1,
      });
      const responses = createOpenAIResponsesHandler({
        models,
        invocationDiagnostics,
        stateFile: join(root, "responses-state.json"),
        sessionState,
        maxRequestBytes: 1024,
        now: () => 1,
      });

      const [anthropicResponse, responsesResponse] = await Promise.all([
        anthropic.handle(anthropicRequest("anthropic-journal-marker")),
        responses.handle(responsesRequest("responses-journal-marker")),
      ]);
      expect(anthropicResponse.status).toBe(429);
      expect(responsesResponse.status).toBe(503);
      expect(
        (await responses.handle(responsesRequest("successful-later-request"))).status,
      ).toBe(200);

      const journalFiles = (await readdir(configuration.directory, {
        recursive: true,
      }))
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => join(configuration.directory, entry));
      expect(journalFiles).toHaveLength(2);
      const journals = await Promise.all(
        journalFiles.map(async (path) =>
          JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>,
        ),
      );
      const byProtocol = Object.fromEntries(
        journals.map((journal) => [journal.clientProtocol, journal]),
      );
      expect(byProtocol["anthropic-messages"]).toMatchObject({
        classification: "client-failure",
        clientStatus: 429,
        attempts: [
          {
            attempt: 1,
            classification: "http",
            status: 429,
            safeIds: { "x-request-id": "upstream-anthropic" },
          },
        ],
      });
      expect(byProtocol["openai-responses"]).toMatchObject({
        classification: "runtime-failure",
        clientStatus: 503,
        attempts: [
          {
            attempt: 1,
            classification: "http",
            status: 503,
            safeIds: { "x-request-id": "upstream-responses" },
          },
        ],
      });
      expect(JSON.stringify(byProtocol["anthropic-messages"])).not.toContain(
        "upstream-responses",
      );
      expect(JSON.stringify(byProtocol["openai-responses"])).not.toContain(
        "upstream-anthropic",
      );
      expect(
        journalFiles.some((path) => path.endsWith("44444444-4444-4444-8444-444444444443.json")),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
