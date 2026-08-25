import type { FetchFunction } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";

import { createCommandCodeTestRuntime as createTokenRuntime } from "../support/commandcode-serving.js";

it("keeps model-resolution failure outside conversion classification", async () => {
  const fetch: FetchFunction = async () => {
    throw new Error("must not dispatch");
  };
  const runtime = createTokenRuntime({
    clientApiKey: "client-key",
    commandCodeApiKey: "upstream-key",
    commandCodeBaseUrl: "https://fixture.commandcode.test",
    fetch,
    modelId: "known-model",
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
        model: "unknown-model",
        max_tokens: 32,
        messages: [{ role: "user", content: "hello" }],
      }),
    }),
  );

  expect(response.status).toBe(404);
  await expect(response.json()).resolves.toMatchObject({
    error: { type: "not_found_error" },
  });
});
