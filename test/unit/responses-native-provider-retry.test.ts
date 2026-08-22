import type { FetchFunction, Model, Models } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { parseProviderNativeResponsesConfiguration } from "../../src/provider-native-responses/configuration.js";
import { createProviderNativeResponses as createProviderNativeResponsesRaw } from "../../src/provider-native-responses/index.js";
import { ambientProfileBindings } from "../support/profile-binding-fixture.js";
import type {
  ManagedProviderAuthBindingCapture,
  ProviderAuthBindingCapture,
} from "../../src/credentials/profile-contract.js";

const createProviderNativeResponses = (
  options: Omit<Parameters<typeof createProviderNativeResponsesRaw>[0], "bindings">,
) => createProviderNativeResponsesRaw({ ...options, bindings: ambientProfileBindings });

const SESSION_ID = "00000000-0000-4000-8000-000000000123";

function model(
  provider = "openai",
  api = "openai-responses",
  baseUrl = "https://api.openai.com/v1",
): Model<string> {
  return {
    id: "real-model",
    name: "real-model",
    provider,
    api,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 10_000,
  };
}

function models(): Pick<Models, "getAuth"> {
  return {
    getAuth: async () => ({ auth: { apiKey: "provider-key" } }),
  } as Pick<Models, "getAuth">;
}

function codexToken(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

describe("Provider Native Responses HTTP retry", () => {
  it("retries an OpenAI 429 with Pi Retry-After semantics and an identical request", async () => {
    const requests: Request[] = [];
    let attempt = 0;
    const fetch: FetchFunction = async (input, init) => {
      requests.push(new Request(input, init));
      attempt += 1;
      return attempt === 1
        ? new Response("rate limited", {
            status: 429,
            headers: { "retry-after-ms": "0" },
          })
        : new Response('{"status":"completed"}', {
            status: 200,
            headers: { "content-type": "application/json" },
          });
    };
    const lane = createProviderNativeResponses({
      models: models(),
      fetch,
      configuration: parseProviderNativeResponsesConfiguration({
        transport: { maxRetries: 1, maxRetryDelayMs: 60_000 },
      }),
    });
    const rawBody = '{"model":"public-alias","input":"hello"}';

    const response = await lane.execute({
      model: model(),
      rawBody,
      operation: "responses",
      signal: AbortSignal.timeout(5_000),
      sessionId: SESSION_ID,
    });

    expect(response.status).toBe(200);
    expect(requests).toHaveLength(2);
    await expect(Promise.all(requests.map((request) => request.text()))).resolves.toEqual([
      '{"model":"real-model","input":"hello"}',
      '{"model":"real-model","input":"hello"}',
    ]);
    expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
      "Bearer provider-key",
      "Bearer provider-key",
    ]);
  });

  it("honors Pi x-should-retry=false before status classification", async () => {
    let calls = 0;
    const lane = createProviderNativeResponses({
      models: models(),
      fetch: async () => {
        calls += 1;
        return new Response("do not retry", {
          status: 429,
          headers: { "x-should-retry": "false" },
        });
      },
      configuration: parseProviderNativeResponsesConfiguration({
        transport: { maxRetries: 2 },
      }),
    });

    const response = await lane.execute({
      model: model(),
      rawBody: '{"model":"alias","input":"hello"}',
      operation: "responses",
      signal: AbortSignal.timeout(5_000),
      sessionId: SESSION_ID,
    });

    expect(response.status).toBe(429);
    expect(calls).toBe(1);
  });

  it("never retries a successful OpenAI response carrying x-should-retry=true", async () => {
    let calls = 0;
    const lane = createProviderNativeResponses({
      models: models(),
      fetch: async () => {
        calls += 1;
        return new Response("successful", {
          status: 200,
          headers: { "x-should-retry": "true" },
        });
      },
      configuration: parseProviderNativeResponsesConfiguration({
        transport: { maxRetries: 1 },
      }),
      retryDependencies: { sleep: async () => undefined },
    });

    const response = await lane.execute({
      model: model(),
      rawBody: '{"model":"alias","input":"hello"}',
      operation: "responses",
      signal: AbortSignal.timeout(5_000),
      sessionId: SESSION_ID,
    });

    expect(response.status).toBe(200);
    expect(calls).toBe(1);
  });

  it("retries an OpenAI network failure and keeps the request abortable", async () => {
    let calls = 0;
    const lane = createProviderNativeResponses({
      models: models(),
      fetch: async () => {
        calls += 1;
        if (calls === 1) throw new TypeError("connection reset");
        return new Response("ok", { status: 200 });
      },
      configuration: parseProviderNativeResponsesConfiguration({
        transport: { maxRetries: 1 },
      }),
    });

    const response = await lane.execute({
      model: model(),
      rawBody: '{"model":"alias","input":"hello"}',
      operation: "responses",
      signal: AbortSignal.timeout(5_000),
      sessionId: SESSION_ID,
    });

    expect(response.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("aborts the production backoff without replaying the request", async () => {
    const controller = new AbortController();
    let calls = 0;
    let resolveFirstFetch: (() => void) | undefined;
    const firstFetch = new Promise<void>((resolve) => {
      resolveFirstFetch = resolve;
    });
    const lane = createProviderNativeResponses({
      models: models(),
      fetch: async () => {
        calls += 1;
        resolveFirstFetch!();
        return new Response("retry later", {
          status: 429,
          headers: { "retry-after-ms": "60000" },
        });
      },
      configuration: parseProviderNativeResponsesConfiguration({
        transport: { maxRetries: 1 },
      }),
    });
    const execution = lane.execute({
      model: model(),
      rawBody: '{"model":"alias","input":"hello"}',
      operation: "responses",
      signal: controller.signal,
      sessionId: SESSION_ID,
    });

    await firstFetch;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    controller.abort();

    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });

  it("does not classify request construction failures as retryable network errors", async () => {
    let fetchCalls = 0;
    let sleepCalls = 0;
    const lane = createProviderNativeResponses({
      models: models(),
      fetch: async () => {
        fetchCalls += 1;
        return new Response("unused", { status: 200 });
      },
      configuration: parseProviderNativeResponsesConfiguration({
        transport: { maxRetries: 2 },
      }),
      retryDependencies: {
        sleep: async () => {
          sleepCalls += 1;
        },
      },
    });

    const response = await lane.execute({
      model: model("openai", "openai-responses", "not-a-valid-url"),
      rawBody: '{"model":"alias","input":"hello"}',
      operation: "responses",
      signal: AbortSignal.timeout(5_000),
      sessionId: SESSION_ID,
    });

    expect(response.status).toBe(502);
    expect(fetchCalls).toBe(0);
    expect(sleepCalls).toBe(0);
  });

  it("fails before retry when the server delay exceeds Pi maxRetryDelayMs", async () => {
    let calls = 0;
    const lane = createProviderNativeResponses({
      models: models(),
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? new Response("slow down", {
              status: 429,
              headers: { "retry-after-ms": "11" },
            })
          : new Response("must not execute", { status: 200 });
      },
      configuration: parseProviderNativeResponsesConfiguration({
        transport: { maxRetries: 1, maxRetryDelayMs: 10 },
      }),
    });

    const response = await lane.execute({
      model: model(),
      rawBody: '{"model":"alias","input":"hello"}',
      operation: "responses",
      signal: AbortSignal.timeout(5_000),
      sessionId: SESSION_ID,
    });

    expect(response.status).toBe(502);
    expect(calls).toBe(1);
  });

  it("retries a Codex SSE 503 using the Pi Codex HTTP policy", async () => {
    let calls = 0;
    const lane = createProviderNativeResponses({
      models: {
        getAuth: async () => ({ auth: { apiKey: codexToken("acct-retry") } }),
      } as Pick<Models, "getAuth">,
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? new Response("service unavailable", {
              status: 503,
              headers: { "retry-after-ms": "0" },
            })
          : new Response("ok", { status: 200 });
      },
      configuration: parseProviderNativeResponsesConfiguration({
        transport: { maxRetries: 1 },
      }),
    });

    const response = await lane.execute({
      model: model(
        "openai-codex",
        "openai-codex-responses",
        "https://chatgpt.com/backend-api",
      ),
      rawBody: '{"model":"alias","input":"hello","stream":true}',
      operation: "responses",
      signal: AbortSignal.timeout(5_000),
      sessionId: SESSION_ID,
    });

    expect(response.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("never inspects or retries a successful Codex response body", async () => {
    let calls = 0;
    const lane = createProviderNativeResponses({
      models: {
        getAuth: async () => ({ auth: { apiKey: codexToken("acct-success") } }),
      } as Pick<Models, "getAuth">,
      fetch: async () => {
        calls += 1;
        return new Response("service unavailable is ordinary successful text", {
          status: 200,
        });
      },
      configuration: parseProviderNativeResponsesConfiguration({
        transport: { maxRetries: 1 },
      }),
      retryDependencies: { sleep: async () => undefined },
    });

    const response = await lane.execute({
      model: model(
        "openai-codex",
        "openai-codex-responses",
        "https://chatgpt.com/backend-api",
      ),
      rawBody: '{"model":"alias","input":"hello","stream":true}',
      operation: "responses",
      signal: AbortSignal.timeout(5_000),
      sessionId: SESSION_ID,
    });

    expect(response.status).toBe(200);
    expect(calls).toBe(1);
    await expect(response.text()).resolves.toContain("ordinary successful text");
  });

  it("uses the Pi Codex one-second base delay after a network failure", async () => {
    let calls = 0;
    const delays: number[] = [];
    const lane = createProviderNativeResponses({
      models: {
        getAuth: async () => ({ auth: { apiKey: codexToken("acct-network") } }),
      } as Pick<Models, "getAuth">,
      fetch: async () => {
        calls += 1;
        if (calls === 1) throw new TypeError("connection reset");
        return new Response("ok", { status: 200 });
      },
      configuration: parseProviderNativeResponsesConfiguration({
        transport: { maxRetries: 1 },
      }),
      retryDependencies: {
        random: () => 0,
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
      },
    });

    const response = await lane.execute({
      model: model(
        "openai-codex",
        "openai-codex-responses",
        "https://chatgpt.com/backend-api",
      ),
      rawBody: '{"model":"alias","input":"hello","stream":true}',
      operation: "responses",
      signal: AbortSignal.timeout(5_000),
      sessionId: SESSION_ID,
    });

    expect(response.status).toBe(200);
    expect(delays).toEqual([1_000]);
  });

  it("retries a Codex error-body read failure like a Pi network failure", async () => {
    let calls = 0;
    const delays: number[] = [];
    const lane = createProviderNativeResponses({
      models: {
        getAuth: async () => ({ auth: { apiKey: codexToken("acct-body") } }),
      } as Pick<Models, "getAuth">,
      fetch: async () => {
        calls += 1;
        if (calls > 1) return new Response("ok", { status: 200 });
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("response body failed"));
            },
          }),
          { status: 429 },
        );
      },
      configuration: parseProviderNativeResponsesConfiguration({
        transport: { maxRetries: 1 },
      }),
      retryDependencies: {
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
      },
    });

    const response = await lane.execute({
      model: model(
        "openai-codex",
        "openai-codex-responses",
        "https://chatgpt.com/backend-api",
      ),
      rawBody: '{"model":"alias","input":"hello","stream":true}',
      operation: "responses",
      signal: AbortSignal.timeout(5_000),
      sessionId: SESSION_ID,
    });

    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(delays).toEqual([1_000]);
  });

  it("uses Pi Codex strict Retry-After parsing before exponential fallback", async () => {
    let calls = 0;
    const delays: number[] = [];
    const lane = createProviderNativeResponses({
      models: {
        getAuth: async () => ({ auth: { apiKey: codexToken("acct-delay") } }),
      } as Pick<Models, "getAuth">,
      fetch: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response("temporary", {
            status: 503,
            headers: { "retry-after-ms": "0" },
          });
        }
        if (calls === 2) {
          return new Response("temporary", {
            status: 503,
            headers: { "retry-after": "1foo" },
          });
        }
        return new Response("ok", { status: 200 });
      },
      configuration: parseProviderNativeResponsesConfiguration({
        transport: { maxRetries: 2 },
      }),
      retryDependencies: {
        now: () => 0,
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
      },
    });

    const response = await lane.execute({
      model: model(
        "openai-codex",
        "openai-codex-responses",
        "https://chatgpt.com/backend-api",
      ),
      rawBody: '{"model":"alias","input":"hello","stream":true}',
      operation: "responses",
      signal: AbortSignal.timeout(5_000),
      sessionId: SESSION_ID,
    });

    expect(response.status).toBe(200);
    expect(delays).toEqual([0, 2_000]);
  });

  it("uses the Pi OpenAI exponential jitter through deterministic retry dependencies", async () => {
    let calls = 0;
    const delays: number[] = [];
    const lane = createProviderNativeResponses({
      models: models(),
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? new Response("temporary", { status: 500 })
          : new Response("ok", { status: 200 });
      },
      configuration: parseProviderNativeResponsesConfiguration({
        transport: { maxRetries: 1 },
      }),
      retryDependencies: {
        random: () => 0,
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
      },
    });

    const response = await lane.execute({
      model: model(),
      rawBody: '{"model":"alias","input":"hello"}',
      operation: "responses",
      signal: AbortSignal.timeout(5_000),
      sessionId: SESSION_ID,
    });

    expect(response.status).toBe(200);
    expect(delays).toEqual([500]);
  });

  it("treats a present malformed OpenAI Retry-After as an immediate Pi delay", async () => {
    let calls = 0;
    const delays: number[] = [];
    const lane = createProviderNativeResponses({
      models: models(),
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? new Response("temporary", {
              status: 429,
              headers: { "retry-after": "not-a-delay" },
            })
          : new Response("ok", { status: 200 });
      },
      configuration: parseProviderNativeResponsesConfiguration({
        transport: { maxRetries: 1 },
      }),
      retryDependencies: {
        random: () => 0,
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
      },
    });

    const response = await lane.execute({
      model: model(),
      rawBody: '{"model":"alias","input":"hello"}',
      operation: "responses",
      signal: AbortSignal.timeout(5_000),
      sessionId: SESSION_ID,
    });

    expect(response.status).toBe(200);
    expect(delays).toEqual([0]);
  });

  it("releases an intermediate error body before replaying the request", async () => {
    let calls = 0;
    let cancelled = false;
    const lane = createProviderNativeResponses({
      models: models(),
      fetch: async () => {
        calls += 1;
        if (calls > 1) return new Response("final response", { status: 200 });
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 500 },
        );
      },
      configuration: parseProviderNativeResponsesConfiguration({
        transport: { maxRetries: 1 },
      }),
      retryDependencies: { sleep: async () => undefined },
    });

    const response = await lane.execute({
      model: model(),
      rawBody: '{"model":"alias","input":"hello"}',
      operation: "responses",
      signal: AbortSignal.timeout(5_000),
      sessionId: SESSION_ID,
    });

    expect(response.status).toBe(200);
    expect(cancelled).toBe(true);
    await expect(response.text()).resolves.toBe("final response");
  });

  it.each([408, 409, 500, 502, 503, 504])(
    "retries Pi OpenAI status %i",
    async (status) => {
      let calls = 0;
      const lane = createProviderNativeResponses({
        models: models(),
        fetch: async () => {
          calls += 1;
          return calls === 1
            ? new Response("temporary", { status })
            : new Response("ok", { status: 200 });
        },
        configuration: parseProviderNativeResponsesConfiguration({
          transport: { maxRetries: 1 },
        }),
        retryDependencies: { sleep: async () => undefined },
      });

      const response = await lane.execute({
        model: model(),
        rawBody: '{"model":"alias","input":"hello"}',
        operation: "responses",
        signal: AbortSignal.timeout(5_000),
        sessionId: SESSION_ID,
      });

      expect(response.status).toBe(200);
      expect(calls).toBe(2);
    },
  );

  it("does not retry a terminal Codex quota response and preserves its raw body", async () => {
    let calls = 0;
    const lane = createProviderNativeResponses({
      models: {
        getAuth: async () => ({ auth: { apiKey: codexToken("acct-quota") } }),
      } as Pick<Models, "getAuth">,
      fetch: async () => {
        calls += 1;
        return new Response("Monthly usage limit reached", {
          status: 429,
          headers: { "content-type": "text/plain" },
        });
      },
      configuration: parseProviderNativeResponsesConfiguration({
        transport: { maxRetries: 2 },
      }),
      retryDependencies: { sleep: async () => undefined },
    });

    const response = await lane.execute({
      model: model(
        "openai-codex",
        "openai-codex-responses",
        "https://chatgpt.com/backend-api",
      ),
      rawBody: '{"model":"alias","input":"hello","stream":true}',
      operation: "responses",
      signal: AbortSignal.timeout(5_000),
      sessionId: SESSION_ID,
    });

    expect(response.status).toBe(429);
    await expect(response.text()).resolves.toBe("Monthly usage limit reached");
    expect(calls).toBe(1);
  });

  it("does not inspect the final Codex error body when no retry budget remains", async () => {
    let cloned = false;
    const upstream = new Response("opaque final error", { status: 429 });
    Object.defineProperty(upstream, "clone", {
      value() {
        cloned = true;
        return Response.prototype.clone.call(upstream);
      },
    });
    const lane = createProviderNativeResponses({
      models: {
        getAuth: async () => ({ auth: { apiKey: codexToken("acct-final") } }),
      } as Pick<Models, "getAuth">,
      fetch: async () => upstream,
    });

    const response = await lane.execute({
      model: model(
        "openai-codex",
        "openai-codex-responses",
        "https://chatgpt.com/backend-api",
      ),
      rawBody: '{"model":"alias","input":"hello","stream":true}',
      operation: "responses",
      signal: AbortSignal.timeout(5_000),
      sessionId: SESSION_ID,
    });

    expect(response).toBe(upstream);
    expect(cloned).toBe(false);
    await expect(response.text()).resolves.toBe("opaque final error");
  });

  it("stops after three outer Profile attempts independently of inner transport retry", async () => {
    const captures: ManagedProviderAuthBindingCapture[] = [1, 2, 3, 4].map((index) => ({
      facts: {
        kind: "managed",
        providerId: "openai",
        credentialId: `credential-${index}`,
        authType: "api_key",
        authMethodLabel: "OpenAI credentials",
        displayName: `Profile ${index}`,
        credentialGeneration: `credential-generation-${index}`,
        selectionGeneration: `selection-generation-${index}`,
      },
    }));
    let transitions = 0;
    let calls = 0;
    const lane = createProviderNativeResponsesRaw({
      models: models(),
      bindings: {
        capture: async () => captures[0]!,
        runBound: async <T>(_binding: ProviderAuthBindingCapture, operation: () => Promise<T>) =>
          operation(),
        advanceAfterFinal429: async () => ({
          outcome: "switched",
          capture: captures[++transitions]!,
        }),
      },
      fetch: async () => {
        calls += 1;
        return new Response("limited", { status: 429 });
      },
      configuration: parseProviderNativeResponsesConfiguration({
        transport: { maxRetries: 0 },
      }),
    });

    const response = await lane.execute({
      model: model(),
      rawBody: '{"model":"alias","input":"hello"}',
      operation: "responses",
      signal: AbortSignal.timeout(5_000),
      sessionId: SESSION_ID,
    });

    expect(response.status).toBe(429);
    expect(calls).toBe(3);
    expect(transitions).toBe(2);
  });

  it("never applies Responses retry policy to Compact", async () => {
    let calls = 0;
    const lane = createProviderNativeResponses({
      models: models(),
      fetch: async () => {
        calls += 1;
        return new Response("compact rate limit", { status: 429 });
      },
      configuration: parseProviderNativeResponsesConfiguration({
        transport: { maxRetries: 2 },
      }),
      retryDependencies: { sleep: async () => undefined },
    });

    const response = await lane.execute({
      model: model(),
      rawBody: '{"model":"alias","input":[]}',
      operation: "compact",
      signal: AbortSignal.timeout(5_000),
    });

    expect(response.status).toBe(429);
    expect(calls).toBe(1);
  });
});
