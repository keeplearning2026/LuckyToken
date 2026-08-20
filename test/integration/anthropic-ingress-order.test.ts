import type { FetchFunction } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { createCommandCodeTestRuntime as createLuckyTokenRuntime } from "../support/commandcode-serving.js";

const fetchMustNotRun: FetchFunction = async () => {
  throw new Error("upstream fetch must not run");
};

function request(input: {
  authorization?: string;
  version: string;
  beta?: string;
  body: string;
}): Request {
  const headers: Record<string, string> = {
    authorization: input.authorization ?? "Bearer client-key",
    "content-type": "application/json",
    "anthropic-version": input.version,
  };
  if (input.beta !== undefined) headers["anthropic-beta"] = input.beta;
  return new Request("http://luckytoken.test/v1/messages", {
    method: "POST",
    headers,
    body: input.body,
  });
}

describe("Anthropic ingress failure order", () => {
  const runtime = createLuckyTokenRuntime({
    clientApiKey: "client-key",
    commandCodeApiKey: "upstream-key",
    commandCodeBaseUrl: "https://fixture.commandcode.test",
    fetch: fetchMustNotRun,
    modelId: "model",
  });

  it("does not gate protocol validity on a LuckyToken client credential", async () => {
    const response = await runtime.handle(
      request({
        authorization: "Bearer wrong-key",
        version: "future-version",
        body: "{malformed",
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "invalid_request_error" },
    });
  });

  it("detects malformed JSON before rejecting a valid unsupported profile", async () => {
    const malformed = await runtime.handle(
      request({ version: "2024-01-01", body: "{malformed" }),
    );
    await expect(malformed.json()).resolves.toMatchObject({
      error: { type: "invalid_request_error" },
    });

    const unsupported = await runtime.handle(
      request({
        version: "2024-01-01",
        body: JSON.stringify({
          model: "model",
          max_tokens: 32,
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    );
    await expect(unsupported.json()).resolves.toMatchObject({
      error: { type: "invalid_request_error" },
    });
  });
});
