import type { FetchFunction } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";

import { createCommandCodeTestRuntime as createTokenRuntime } from "../support/commandcode-serving.js";

it("preserves a complete client-tool next turn on the CommandCode wire", async () => {
  let upstreamRequest: Request | undefined;
  const fetch: FetchFunction = async (input, init) => {
    upstreamRequest = new Request(input, init);
    return new Response(
      [
        JSON.stringify({ type: "text-start", id: "0" }),
        JSON.stringify({ type: "text-delta", id: "0", text: "done" }),
        JSON.stringify({ type: "text-end", id: "0" }),
        JSON.stringify({
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        }),
      ].join("\n"),
    );
  };
  const runtime = createTokenRuntime({
    clientApiKey: "client-key",
    commandCodeApiKey: "upstream-key",
    commandCodeBaseUrl: "https://fixture.commandcode.test",
    fetch,
    modelId: "model",
    createSessionId: () => "00000000-0000-4000-8000-000000000050",
  });

  const response = await runtime.handle(
    new Request("http://Token.test/v1/messages", {
      method: "POST",
      headers: {
        authorization: "Bearer client-key",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "model",
        max_tokens: 32,
        messages: [
          { role: "user", content: "run" },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "call_1", name: "lookup", input: { q: "x" } },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call_1",
                content: [{ type: "text", text: "result" }],
              },
              { type: "text", text: "continue" },
            ],
          },
        ],
      }),
    }),
  );

  expect(response.status).toBe(200);
  const body: unknown = await upstreamRequest?.json();
  expect(body).toMatchObject({
    params: {
      messages: [
        { role: "user", content: [{ type: "text", text: "run" }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "lookup",
              input: { q: "x" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              toolName: "lookup",
              output: { type: "text", value: "result" },
            },
          ],
        },
        { role: "user", content: [{ type: "text", text: "continue" }] },
      ],
    },
  });
});
