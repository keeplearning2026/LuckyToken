import type { FetchFunction, Model, Models } from "@earendil-works/pi-ai";

import { afterEach, describe, expect, it } from "vitest";

import type { RequestJourneyObservationAuthority } from "../../src/diagnostics/index.js";
import { createProviderNativeResponses } from "../../src/provider-native-responses/index.js";
import { createOpenAIResponsesHandler } from "../../src/protocols/openai-responses/handler.js";
import { createTokenRuntime } from "../../src/runtime.js";
import {
  startTokenHttpServer,
  type RunningTokenHttpServer,
} from "../../src/server.js";
import { createCommandCodeTestRuntime } from "../support/commandcode-serving.js";
import { ambientProfileBindings } from "../support/profile-binding-fixture.js";

const REQUEST_ID = "30000000-0000-4000-8000-000000000001";
const SESSION_ID = "30000000-0000-4000-8000-000000000002";
const DIAGNOSTICS_CANARY = "diagnostics-must-not-escape-9c57b284";

interface OutboundSnapshot {
  readonly url: string;
  readonly method: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly bodyBase64: string;
}

interface ExchangeSnapshot {
  readonly route: ReadonlyArray<{
    readonly method: string;
    readonly pathname: string;
  }>;
  readonly outbound: readonly OutboundSnapshot[];
  readonly response: {
    readonly status: number;
    readonly headers: ReadonlyArray<readonly [string, string]>;
    readonly bodyBase64: string;
  };
}

function sortedHeaders(
  headers: Headers,
  omitted: ReadonlySet<string> = new Set(),
): ReadonlyArray<readonly [string, string]> {
  return Array.from(headers.entries())
    .filter(([name]) => !omitted.has(name.toLowerCase()))
    .sort(([left], [right]) => left.localeCompare(right));
}

function commandCodeSuccess(): Response {
  return new Response(
    [
      JSON.stringify({ type: "text-start", id: "0" }),
      JSON.stringify({
        type: "text-delta",
        id: "0",
        text: "diagnostics did not interfere",
      }),
      JSON.stringify({ type: "text-end", id: "0" }),
      JSON.stringify({
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      }),
      "",
    ].join("\n"),
    { status: 200 },
  );
}

describe("Request Journey diagnostics non-interference", () => {
  const servers: RunningTokenHttpServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function runExchange(
    diagnostics?: RequestJourneyObservationAuthority,
  ): Promise<ExchangeSnapshot> {
    const route: Array<{ method: string; pathname: string }> = [];
    const outbound: OutboundSnapshot[] = [];
    const providerFetch: FetchFunction = async (input, init) => {
      const request = new Request(input, init);
      outbound.push({
        url: request.url,
        method: request.method,
        headers: sortedHeaders(request.headers),
        bodyBase64: Buffer.from(await request.arrayBuffer()).toString("base64"),
      });
      return commandCodeSuccess();
    };
    const servingRuntime = createCommandCodeTestRuntime({
      clientApiKey: "fixture-client-key",
      commandCodeApiKey: "fixture-provider-key",
      commandCodeBaseUrl: "https://fixture.commandcode.test",
      fetch: providerFetch,
      modelId: "claude-fixture",
      createMessageId: () => "msg_non_interference",
      createSessionId: () => SESSION_ID,
      now: () => 1_787_472_000_000,
    });
    const runtime = {
      routes: servingRuntime.routes,
      handle: (...args: Parameters<typeof servingRuntime.handle>) => {
        const [request] = args;
        route.push({
          method: request.method,
          pathname: new URL(request.url).pathname,
        });
        return servingRuntime.handle(...args);
      },
    };
    const server = await startTokenHttpServer({
      runtime,
      ...(diagnostics === undefined ? {} : { diagnostics }),
      createRequestId: () => REQUEST_ID,
      port: 0,
    });
    servers.push(server);

    const response = await fetch(`${server.origin}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer fixture-client-key",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-fixture",
        max_tokens: 32,
        messages: [{ role: "user", content: "observe without interference" }],
      }),
    });
    const responseBody = Buffer.from(await response.arrayBuffer());

    return {
      route,
      outbound,
      response: {
        status: response.status,
        // Node owns this volatile transport header; every application-owned
        // header, including the stable request ID, is compared byte-for-byte.
        headers: sortedHeaders(response.headers, new Set(["date"])),
        bodyBase64: responseBody.toString("base64"),
      },
    };
  }

  async function runProviderNativeResponsesExchange(
    diagnostics?: RequestJourneyObservationAuthority,
  ): Promise<ExchangeSnapshot> {
    const route: Array<{ method: string; pathname: string }> = [];
    const outbound: OutboundSnapshot[] = [];
    const model: Model<string> = {
      id: "gpt-native",
      name: "GPT Native",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://provider.example.com/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
    };
    const models = {
      getModels: () => [model],
      getAuth: async () => ({ auth: { apiKey: "provider-key" } }),
    } as unknown as Models;
    const upstreamSse =
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":0,"output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"in_progress","content":[]}}\n\n' +
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":1,"output_index":1,"item":{"type":"message","id":"msg_b","role":"assistant","status":"in_progress","content":[]}}\n\n' +
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":2,"output_index":1,"item":{"type":"message","id":"msg_b","role":"assistant","status":"completed","content":[]}}\n\n' +
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":3,"output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"completed","content":[]}}\n\n';
    const providerFetch: FetchFunction = async (input, init) => {
      const request = new Request(input, init);
      outbound.push({
        url: request.url,
        method: request.method,
        headers: sortedHeaders(request.headers),
        bodyBase64: Buffer.from(await request.arrayBuffer()).toString("base64"),
      });
      return new Response(upstreamSse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    const handler = createOpenAIResponsesHandler({
      models,
      providerNativeLane: createProviderNativeResponses({
        models,
        bindings: ambientProfileBindings,
        fetch: providerFetch,
      }),
      stateFile: "provider-native-non-interference-state.json",
      maxRequestBytes: 1_000_000,
      createSessionId: () => SESSION_ID,
      createResponseId: () => "resp_unused",
      now: () => 1_787_472_000_000,
    });
    const servingRuntime = createTokenRuntime({
      clientProtocols: [handler],
    });
    const runtime = {
      routes: servingRuntime.routes,
      handle: (...args: Parameters<typeof servingRuntime.handle>) => {
        const [request] = args;
        route.push({
          method: request.method,
          pathname: new URL(request.url).pathname,
        });
        return servingRuntime.handle(...args);
      },
    };
    const server = await startTokenHttpServer({
      runtime,
      ...(diagnostics === undefined ? {} : { diagnostics }),
      createRequestId: () => REQUEST_ID,
      port: 0,
    });
    servers.push(server);

    const response = await fetch(`${server.origin}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-native",
        input: "normalize without interference",
        stream: true,
      }),
    });
    const responseBody = Buffer.from(await response.arrayBuffer());

    return {
      route,
      outbound,
      response: {
        status: response.status,
        headers: sortedHeaders(response.headers, new Set(["date"])),
        bodyBase64: responseBody.toString("base64"),
      },
    };
  }

  it("keeps the Provider Native normalized HTTP exchange identical when observation throws", async () => {
    const baseline = await runProviderNativeResponsesExchange();
    expect(baseline.response.status).toBe(200);
    expect(baseline.route).toEqual([
      { method: "POST", pathname: "/v1/responses" },
    ]);

    let observeReached = false;
    const throwingObserverAuthority: RequestJourneyObservationAuthority = {
      begin: (input) => ({
        requestId: input.requestId,
        observe: () => {
          observeReached = true;
          throw new Error(`${DIAGNOSTICS_CANARY}-responses-observe`);
        },
        close: () => {
          throw new Error(`${DIAGNOSTICS_CANARY}-responses-close`);
        },
      }),
      observeRuntime: () => undefined,
    };

    const faulted = await runProviderNativeResponsesExchange(
      throwingObserverAuthority,
    );
    expect(observeReached).toBe(true);
    expect(faulted).toEqual(baseline);
    expect(JSON.stringify(faulted)).not.toContain(DIAGNOSTICS_CANARY);
  });

  it("keeps the real HTTP exchange identical when the authority or observer throws", async () => {
    const baseline = await runExchange();
    expect(baseline.response.status).toBe(200);
    expect(baseline.route).toEqual([
      { method: "POST", pathname: "/v1/messages" },
    ]);
    expect(baseline.response.headers).toContainEqual([
      "x-token-request-id",
      REQUEST_ID,
    ]);
    expect(baseline.outbound).toHaveLength(1);

    let throwingBeginReached = false;
    const throwingAuthority: RequestJourneyObservationAuthority = {
      begin: () => {
        throwingBeginReached = true;
        throw new Error(`${DIAGNOSTICS_CANARY}-begin`);
      },
      observeRuntime: () => {
        throw new Error(`${DIAGNOSTICS_CANARY}-runtime`);
      },
    };
    const beginFaulted = await runExchange(throwingAuthority);
    expect(throwingBeginReached).toBe(true);
    expect(beginFaulted).toEqual(baseline);

    let observerObserveReached = false;
    let observerCloseReached = false;
    let recorderAppendReached = false;
    let recorderFinishReached = false;
    const throwingObserverAuthority: RequestJourneyObservationAuthority = {
      begin: (input) => ({
        requestId: input.requestId,
        openArtifact: () => ({
          captureJson: () => {
            throw new Error(`${DIAGNOSTICS_CANARY}-capture-json`);
          },
          append: () => {
            recorderAppendReached = true;
            throw new Error(`${DIAGNOSTICS_CANARY}-append`);
          },
          finish: () => {
            recorderFinishReached = true;
            throw new Error(`${DIAGNOSTICS_CANARY}-finish`);
          },
          abandon: () => {
            throw new Error(`${DIAGNOSTICS_CANARY}-abandon`);
          },
        }),
        observe: () => {
          observerObserveReached = true;
          throw new Error(`${DIAGNOSTICS_CANARY}-observe`);
        },
        close: () => {
          observerCloseReached = true;
          throw new Error(`${DIAGNOSTICS_CANARY}-close`);
        },
      }),
      observeRuntime: () => undefined,
    };
    const observerFaulted = await runExchange(throwingObserverAuthority);
    expect(observerObserveReached).toBe(true);
    expect(observerCloseReached).toBe(true);
    expect(recorderAppendReached).toBe(true);
    expect(recorderFinishReached).toBe(true);
    expect(observerFaulted).toEqual(baseline);

    const comparedBytes = JSON.stringify({
      baseline,
      beginFaulted,
      observerFaulted,
    });
    expect(comparedBytes).not.toContain(DIAGNOSTICS_CANARY);
  });
});
