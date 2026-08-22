import type { FetchFunction, Model, Models } from "@earendil-works/pi-ai";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { handleHttpRequest, type HttpBoundaryDependencies } from "../../src/http.js";
import { parseFailureLoggingConfiguration } from "../../src/invocation-diagnostics/configuration.js";
import { createInvocationDiagnosticsFactory } from "../../src/invocation-diagnostics/index.js";
import { createAnthropicProviderNativeLane } from "../../src/provider-native-anthropic/index.js";
import { ambientProfileBindings } from "../support/profile-binding-fixture.js";
import {
  createAnthropicMessagesHandler,
  type AnthropicMessagesHandlerOptions,
} from "../../src/protocols/anthropic/handler.js";
import { defaultAnthropicModelValidityPolicy } from "../../src/protocols/anthropic/representability.js";
import { identityRequestModelResolver } from "../../src/protocols/anthropic/options.js";

/**
 * Ticket 11 certification supplement: behavior the earlier passthrough
 * contract tests did not cover — SSE fidelity, pre-commit body-read failure,
 * x-stainless-* approved headers, failure journal on final failure, and
 * cancellation at the HTTP boundary.
 */

function anthropicModel(): Model<string> {
  return {
    id: "claude-sonnet",
    name: "claude-sonnet",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://gateway.example.com",
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
  return new Request("http://luckytoken.test/v1/messages", {
    method: "POST",
    headers: {
      authorization: "Bearer client",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...headers,
    },
    body,
  });
}

function dependencies(
  models: Models,
  extra: Partial<AnthropicMessagesHandlerOptions> = {},
  passthroughFetch?: FetchFunction,
): HttpBoundaryDependencies {
  const options: AnthropicMessagesHandlerOptions = {
    models,
    modelValidityPolicy: defaultAnthropicModelValidityPolicy,
    createMessageId: () => "msg_client",
    maxRequestBytes: 1_000_000,
    routerDefaults: {},
    now: () => 1,
    ...extra,
    ...(passthroughFetch === undefined
      ? {}
      : {
          providerNativeLane: createAnthropicProviderNativeLane({
            models,
            bindings: ambientProfileBindings,
            resolveRequestModel: identityRequestModelResolver,
            fetch: passthroughFetch,
          }),
        }),
  };
  const anthropic = createAnthropicMessagesHandler(options);
  return {
    clientProtocols: [anthropic],
    requestTimeoutMs: undefined,
    shutdownSignal: undefined,
  };
}

function passthroughModels(
  model: Model<string>,
  authResult: unknown = { auth: { apiKey: "sk-gateway" } },
): Models {
  return {
    getModels: () => [model],
    getAuth: async () => authResult,
  } as unknown as Models;
}

function captureFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): { restore: () => void; passthroughFetch: FetchFunction } {
  return {
    restore: () => undefined,
    passthroughFetch: impl as FetchFunction,
  };
}

describe("11: native Anthropic passthrough certification", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("preserves native SSE frames byte-for-byte (status/body/SSE fidelity)", async () => {
    const model = anthropicModel();
    const sseBody =
      'event: message_start\ndata: {"type":"message_start","message":{"role":"assistant"}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const upstreamRequests: Request[] = [];
    const { restore, passthroughFetch } = captureFetch(async (input, init) => {
      upstreamRequests.push(new Request(input, init));
      return new Response(sseBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    try {
      const response = await handleHttpRequest(
        dependencies(passthroughModels(model), {}, passthroughFetch),
        request(
          JSON.stringify({
            model: "anthropic/claude-sonnet",
            max_tokens: 32,
            messages: [{ role: "user", content: "hi" }],
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

  it("returns a legal Anthropic error when the upstream body read fails (pre-commit)", async () => {
    const model = anthropicModel();
    const { restore, passthroughFetch } = captureFetch(async () => {
      // Response headers arrived but the body read fails: a pre-commit
      // body/read failure must produce a legal Anthropic error response, not
      // a hang or an unchecked exception.
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("connection reset while reading body"));
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    try {
      const response = await handleHttpRequest(
        dependencies(passthroughModels(model), {}, passthroughFetch),
        request(
          JSON.stringify({
            model: "anthropic/claude-sonnet",
            max_tokens: 32,
            messages: [{ role: "user", content: "hi" }],
          }),
        ),
      );
      expect(response.status).toBeGreaterThanOrEqual(500);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.type).toBe("error");
      const error = body.error as Record<string, unknown>;
      expect(["api_error", "overloaded_error"]).toContain(error.type);
    } finally {
      restore();
    }
  });

  it("reconstructs SDK headers and rejects client x-stainless overrides", async () => {
    const model = anthropicModel();
    const upstreamRequests: Request[] = [];
    const { restore, passthroughFetch } = captureFetch(async (input, init) => {
      upstreamRequests.push(new Request(input, init));
      return new Response('{"type":"message","content":[]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      const response = await handleHttpRequest(
        dependencies(passthroughModels(model), {}, passthroughFetch),
        request(
          JSON.stringify({
            model: "anthropic/claude-sonnet",
            max_tokens: 32,
            messages: [{ role: "user", content: "hi" }],
          }),
          { "x-stainless-retry-count": "1", "x-stainless-timeout": "60000" },
        ),
      );
      expect(response.status).toBe(200);
      expect(upstreamRequests[0]?.headers.get("x-stainless-retry-count")).toBe(
        "0",
      );
      expect(upstreamRequests[0]?.headers.get("x-stainless-timeout")).toBe(
        null,
      );
      expect(upstreamRequests[0]?.headers.get("x-stainless-lang")).toBe("js");
    } finally {
      restore();
    }
  });

  it("writes one bounded failure journal for a final upstream failure", async () => {
    const model = anthropicModel();
    const root = await mkdtemp(join(tmpdir(), "luckytoken-anthropic-pt-journal-"));
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
    const { restore, passthroughFetch } = captureFetch(async () =>
      new Response('{"error":{"type":"rate_limit","message":"slow"}}', {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      const response = await handleHttpRequest(
        dependencies(
          passthroughModels(model),
          { invocationDiagnostics: journal },
          passthroughFetch,
        ),
        request(
          JSON.stringify({
            model: "anthropic/claude-sonnet",
            max_tokens: 32,
            messages: [{ role: "user", content: "hi" }],
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
    const model = anthropicModel();
    const controller = new AbortController();
    let upstreamSignal: AbortSignal | null | undefined;
    const { restore, passthroughFetch } = captureFetch(async (input, init) => {
      void input;
      upstreamSignal = init?.signal;
      // Abort the caller while the upstream call is in flight. The handler
      // must race with the caller signal and terminate; the upstream fetch
      // observes the abort.
      controller.abort(new Error("client went away"));
      return new Response("{}", { status: 200 });
    });
    try {
      const responsePromise = handleHttpRequest(
        dependencies(passthroughModels(model), {}, passthroughFetch),
        new Request("http://luckytoken.test/v1/messages", {
          method: "POST",
          headers: {
            authorization: "Bearer client",
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "anthropic/claude-sonnet",
            max_tokens: 32,
            messages: [{ role: "user", content: "hi" }],
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
});
