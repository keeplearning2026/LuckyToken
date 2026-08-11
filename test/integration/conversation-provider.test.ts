import type { FetchFunction } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";

import type { AnthropicModelValidityPolicy } from "../../src/protocols/anthropic/representability.js";
import { createCommandCodeTestRuntime as createLuckyTokenRuntime } from "../support/commandcode-serving.js";

it("preserves accepted conversation semantics on the CommandCode wire", async () => {
  let upstreamRequest: Request | undefined;
  const fetch: FetchFunction = async (input, init) => {
    upstreamRequest = new Request(input, init);
    return new Response(
      [
        JSON.stringify({ type: "text-start", id: "0" }),
        JSON.stringify({ type: "text-delta", id: "0", text: "ok" }),
        JSON.stringify({ type: "text-end", id: "0" }),
        JSON.stringify({
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        }),
      ].join("\n"),
    );
  };
  const modelValidityPolicy: AnthropicModelValidityPolicy = {
    revision: "fixture-image-v1",
    classifyFinalAssistantPrefill: () => "unknown",
    hasCertifiedImageFidelity: () => true,
  };
  const runtime = createLuckyTokenRuntime({
    clientApiKey: "client-key",
    commandCodeApiKey: "upstream-key",
    commandCodeBaseUrl: "https://fixture.commandcode.test",
    fetch,
    modelId: "model",
    modelInput: ["text", "image"],
    anthropicModelValidityPolicy: modelValidityPolicy,
    createSessionId: () => "00000000-0000-4000-8000-000000000040",
  });

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
        system: "system\n",
        messages: [
          { role: "user", content: "" },
          {
            role: "user",
            content: [
              { type: "text", text: " \t" },
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "AA==" },
              },
            ],
          },
          { role: "assistant", content: "first" },
          { role: "assistant", content: [{ type: "text", text: "second" }] },
          { role: "user", content: "tail" },
        ],
      }),
    }),
  );

  expect(response.status).toBe(200);
  const body: unknown = await upstreamRequest?.json();
  expect(body).toMatchObject({
    params: {
      system: "system\n",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "" },
            { type: "text", text: " \t" },
            {
              type: "image",
              image: "data:image/png;base64,AA==",
              mimeType: "image/png",
            },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
        },
        { role: "user", content: [{ type: "text", text: "tail" }] },
      ],
    },
  });
});
