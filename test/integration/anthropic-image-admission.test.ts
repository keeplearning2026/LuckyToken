import type { FetchFunction } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { createCommandCodeTestRuntime } from "../support/commandcode-serving.js";

function anthropicRequest(body: Record<string, unknown>): Request {
  return new Request("http://Token.test/v1/messages", {
    method: "POST",
    headers: {
      authorization: "Bearer client-key",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
}

function countingFetch(): { readonly fetch: FetchFunction; calls(): number } {
  let calls = 0;
  return {
    fetch: async () => {
      calls += 1;
      throw new Error("upstream fetch must not run");
    },
    calls: () => calls,
  };
}

describe("Anthropic image admission at the HTTP boundary", () => {
  it("rejects a base64 image before fetch when the model does not declare image input", async () => {
    const upstream = countingFetch();
    const runtime = createCommandCodeTestRuntime({
      clientApiKey: "client-key",
      commandCodeApiKey: "upstream-key",
      commandCodeBaseUrl: "https://fixture.commandcode.test",
      fetch: upstream.fetch,
      modelId: "model",
      modelInput: ["text"],
      createSessionId: () => "00000000-0000-4000-8000-000000000260",
    });

    const response = await runtime.handle(anthropicRequest({
      model: "model",
      max_tokens: 32,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "AA==" },
            },
          ],
        },
      ],
    }));

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.json()).resolves.toMatchObject({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: expect.stringMatching(/does not declare image input/u),
      },
    });
    expect(upstream.calls()).toBe(0);
  });

  it("rejects a URL image before fetch instead of dropping it", async () => {
    const upstream = countingFetch();
    const runtime = createCommandCodeTestRuntime({
      clientApiKey: "client-key",
      commandCodeApiKey: "upstream-key",
      commandCodeBaseUrl: "https://fixture.commandcode.test",
      fetch: upstream.fetch,
      modelId: "model",
      modelInput: ["text", "image"],
      createSessionId: () => "00000000-0000-4000-8000-000000000261",
    });

    const response = await runtime.handle(anthropicRequest({
      model: "model",
      max_tokens: 32,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "url", url: "https://example.test/a.png" },
            },
          ],
        },
      ],
    }));

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.json()).resolves.toMatchObject({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: expect.stringMatching(
          /URL image sources are not representable in Pi Context/u,
        ),
      },
    });
    expect(upstream.calls()).toBe(0);
  });
});
