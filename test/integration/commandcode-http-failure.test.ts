import type { FetchFunction } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { createCommandCodeTestRuntime } from "../support/commandcode-serving.js";

describe("CommandCode HTTP failure passthrough", () => {
  it("passes an upstream 429 status and body to the Anthropic protocol", async () => {
    const upstreamBody = JSON.stringify({
      error: { code: "RATE_LIMITED", message: "slow down" },
    });
    const fixtureFetch: FetchFunction = async () =>
      new Response(upstreamBody, {
        status: 429,
        statusText: "Too Many Requests",
        headers: { "content-type": "application/json" },
      });

    const runtime = createCommandCodeTestRuntime({
      clientApiKey: "fixture-client-key",
      commandCodeApiKey: "fixture-commandcode-key",
      commandCodeBaseUrl: "https://fixture.commandcode.test/nested/base",
      fetch: fixtureFetch,
      modelId: "claude-fixture",
      createMessageId: () => "msg_fixture",
      createSessionId: () => "00000000-0000-4000-8000-000000000002",
      now: () => 1_786_400_000_000,
    });

    const response = await runtime.handle(
      new Request("http://luckytoken.test/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer fixture-client-key",
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-fixture",
          max_tokens: 64,
          messages: [{ role: "user", content: "Hello" }],
        }),
      }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("content-type")).toBe("application/json");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      type: "error",
      error: { type: "rate_limit_error" },
    });
    expect(JSON.stringify(body)).toContain("slow down");
  });
});
