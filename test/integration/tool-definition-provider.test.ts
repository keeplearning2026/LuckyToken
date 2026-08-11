import type { FetchFunction } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";

import { createCommandCodeTestRuntime as createLuckyTokenRuntime } from "../support/commandcode-serving.js";

it("carries an accepted Anthropic tool schema unchanged to CommandCode", async () => {
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
  const runtime = createLuckyTokenRuntime({
    clientApiKey: "client-key",
    commandCodeApiKey: "upstream-key",
    commandCodeBaseUrl: "https://fixture.commandcode.test",
    fetch,
    modelId: "model",
    createSessionId: () => "00000000-0000-4000-8000-000000000060",
  });
  const inputSchema = {
    type: "object",
    properties: { query: { type: "string", minLength: 1 } },
    required: ["query"],
    additionalProperties: false,
  };

  const response = await runtime.handle(
    new Request("http://luckytoken.test/v1/messages", {
      method: "POST",
      headers: {
        authorization: "Bearer client-key",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "model",
        max_tokens: 32,
        messages: [{ role: "user", content: "run" }],
        tools: [
          {
            name: "lookup",
            description: "Exact description",
            input_schema: inputSchema,
            strict: false,
          },
        ],
      }),
    }),
  );

  expect(response.status).toBe(200);
  const body: unknown = await upstreamRequest?.json();
  expect(body).toMatchObject({
    params: {
      tools: [
        {
          name: "lookup",
          description: "Exact description",
          input_schema: inputSchema,
        },
      ],
    },
  });
  expect(
    Object.keys(
      (
        body as {
          params: { tools: Array<Record<string, unknown>> };
        }
      ).params.tools[0] ?? {},
    ).sort(),
  ).toEqual(["description", "input_schema", "name"]);
});
