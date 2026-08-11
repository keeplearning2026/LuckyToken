import type { FetchFunction } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { createCommandCodeTestRuntime as createLuckyTokenRuntime } from "../support/commandcode-serving.js";

describe("minimal Anthropic text route", () => {
  it("crosses the full route while ignoring non-version client headers", async () => {
    const upstreamRequests: Request[] = [];
    const fixtureFetch: FetchFunction = async (input, init) => {
      upstreamRequests.push(new Request(input, init));

      return new Response(
        [
          JSON.stringify({ type: "text-start", id: "0" }),
          JSON.stringify({ type: "text-delta", id: "0", text: "Hello from CommandCode." }),
          JSON.stringify({ type: "text-end", id: "0" }),
          JSON.stringify({
            type: "finish",
            finishReason: "stop",
            totalUsage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
          }),
          "",
        ].join("\n"),
        {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        },
      );
    };

    const runtime = createLuckyTokenRuntime({
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
          "anthropic-beta": "anything",
          "anthropic-dangerous-direct-browser-access": "true",
          "x-arbitrary-agent-header": "anything",
        },
        body: JSON.stringify({
          model: "claude-fixture",
          max_tokens: 64,
          messages: [{ role: "user", content: "Hello" }],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.json()).resolves.toEqual({
      id: "msg_fixture",
      container: null,
      content: [
        {
          citations: null,
          text: "Hello from CommandCode.",
          type: "text",
        },
      ],
      model: "claude-fixture",
      role: "assistant",
      stop_details: null,
      stop_reason: "end_turn",
      stop_sequence: null,
      type: "message",
      usage: {
        cache_creation: null,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        inference_geo: null,
        input_tokens: 3,
        output_tokens: 4,
        output_tokens_details: null,
        server_tool_use: null,
        service_tier: null,
      },
    });

    expect(upstreamRequests).toHaveLength(1);
    const upstreamRequest = upstreamRequests[0];
    expect(upstreamRequest?.url).toBe("https://fixture.commandcode.test/alpha/generate");
    expect(upstreamRequest?.method).toBe("POST");
    expect(upstreamRequest?.headers.get("authorization")).toBe(
      "Bearer fixture-commandcode-key",
    );
    expect(upstreamRequest?.headers.has("anthropic-beta")).toBe(false);
    expect(
      upstreamRequest?.headers.has("anthropic-dangerous-direct-browser-access"),
    ).toBe(false);
    expect(upstreamRequest?.headers.has("x-arbitrary-agent-header")).toBe(false);
    expect(upstreamRequest?.headers.get("x-session-id")).toBe(
      "00000000-0000-4000-8000-000000000002",
    );
    await expect(upstreamRequest?.json()).resolves.toEqual({
      config: {
        workingDir: "",
        date: "",
        environment: "",
        structure: [],
        isGitRepo: false,
        currentBranch: "",
        mainBranch: "",
        gitStatus: "",
        recentCommits: [],
      },
      memory: null,
      taste: null,
      skills: null,
      permissionMode: "standard",
      threadId: "00000000-0000-4000-8000-000000000002",
      params: {
        model: "claude-fixture",
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
        tools: [],
        max_tokens: 64,
        stream: true,
      },
    });
  });
});
