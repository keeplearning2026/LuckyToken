import type { FetchFunction } from "@earendil-works/pi-ai";

import { afterEach, describe, expect, it } from "vitest";

import type { RequestJourneyObservationAuthority } from "../../src/diagnostics/index.js";
import {
  startLuckyTokenHttpServer,
  type RunningLuckyTokenHttpServer,
} from "../../src/server.js";
import { createCommandCodeTestRuntime } from "../support/commandcode-serving.js";

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
  const servers: RunningLuckyTokenHttpServer[] = [];

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
    const server = await startLuckyTokenHttpServer({
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

  it("keeps the real HTTP exchange identical when the authority or observer throws", async () => {
    const baseline = await runExchange();
    expect(baseline.response.status).toBe(200);
    expect(baseline.route).toEqual([
      { method: "POST", pathname: "/v1/messages" },
    ]);
    expect(baseline.response.headers).toContainEqual([
      "x-luckytoken-request-id",
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
    const throwingObserverAuthority: RequestJourneyObservationAuthority = {
      begin: (input) => ({
        requestId: input.requestId,
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
    expect(observerFaulted).toEqual(baseline);

    const comparedBytes = JSON.stringify({
      baseline,
      beginFaulted,
      observerFaulted,
    });
    expect(comparedBytes).not.toContain(DIAGNOSTICS_CANARY);
  });
});
