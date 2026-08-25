import type { FetchFunction } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { createEmptyServerConfig } from "../../packages/provider-commandcode-private/src/project.js";
import { createCommandCodeTestRuntime as createTokenRuntime } from "../support/commandcode-serving.js";

function successResponse(): Response {
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
}

function request(): Request {
  return new Request("http://Token.test/v1/messages", {
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
  });
}

describe("CommandCode fixed server config integration", () => {
  it("sends no project authority and always uses the empty config", async () => {
    let upstreamRequest: Request | undefined;
    const fetch: FetchFunction = async (input, init) => {
      upstreamRequest = new Request(input, init);
      return successResponse();
    };
    const runtime = createTokenRuntime({
      clientApiKey: "unused-client-key",
      commandCodeApiKey: "upstream-key",
      commandCodeBaseUrl: "https://fixture.commandcode.test",
      fetch,
      modelId: "model",
      createMessageId: () => "msg",
      createSessionId: () => "00000000-0000-4000-8000-000000000030",
    });

    expect((await runtime.handle(request())).status).toBe(200);
    expect(upstreamRequest?.headers.get("x-project-slug")).toBeNull();
    await expect(upstreamRequest?.json()).resolves.toMatchObject({
      config: createEmptyServerConfig(),
    });
  });
});
