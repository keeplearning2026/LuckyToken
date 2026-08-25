import type { FetchFunction } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { createCommandCodeTestRuntime } from "../support/commandcode-serving.js";

function commandCodeText(text: string): Response {
  return new Response(
    [
      JSON.stringify({ type: "text-start", id: "0" }),
      JSON.stringify({ type: "text-delta", id: "0", text }),
      JSON.stringify({ type: "text-end", id: "0" }),
      JSON.stringify({
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }),
    ].join("\n"),
  );
}

describe("local HTTP client access contract", () => {
  it("serves Anthropic requests without a Token client credential", async () => {
    const fetch: FetchFunction = async () => commandCodeText("anonymous");
    const runtime = createCommandCodeTestRuntime({
      clientApiKey: "unused",
      commandCodeApiKey: "provider-secret",
      commandCodeBaseUrl: "https://fixture.commandcode.test",
      fetch,
      modelId: "model",
    });

    const response = await runtime.handle(
      new Request("http://Token.test/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "model",
          max_tokens: 32,
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      content: [{ type: "text", text: "anonymous" }],
    });
  });
});
