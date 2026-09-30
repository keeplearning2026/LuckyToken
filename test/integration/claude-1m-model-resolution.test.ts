import type { FetchFunction } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";

import type { PublicModelSource } from "../../src/public-model-seam.js";
import type { PublicModelSnapshot } from "../../src/public-models/authority.js";
import { markAnthropicModelId } from "../../src/protocols/anthropic/marked-model-id.js";
import { createCommandCodeTestRuntime } from "../support/commandcode-serving.js";

function publicModels(exactUnavailable = false): PublicModelSource {
  const snapshot: PublicModelSnapshot = Object.freeze({
    version: 1,
    endpoint: Object.freeze({ host: "127.0.0.1", port: 3000 }),
    providers: Object.freeze([]),
    resolve: (alias: string) => {
      if (exactUnavailable && alias === "fixture/claude-fixture[1m]") {
        return Object.freeze({
          providerId: "commandcode-private",
          modelId: "missing-model",
        });
      }
      return alias === "fixture/claude-fixture"
        ? Object.freeze({
            providerId: "commandcode-private",
            modelId: "claude-fixture",
          })
        : undefined;
    },
    publishedModels: () => Object.freeze([]),
    favoriteModels: () => Object.freeze([]),
  });
  return Object.freeze({
    requestSnapshot: async () => snapshot,
  });
}

it("accepts Claude Code [1m] as an Anthropic-only fallback alias suffix", async () => {
  const upstreamRequests: Request[] = [];
  const fetch: FetchFunction = async (input, init) => {
    upstreamRequests.push(new Request(input, init));
    return new Response(
      [
        JSON.stringify({ type: "text-start", id: "0" }),
        JSON.stringify({ type: "text-delta", id: "0", text: "ok" }),
        JSON.stringify({ type: "text-end", id: "0" }),
        JSON.stringify({
          type: "finish",
          finishReason: "stop",
          totalUsage: {
            inputTokens: 1,
            inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0 },
            outputTokens: 1,
            totalTokens: 2,
          },
        }),
        "",
      ].join("\n"),
      {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      },
    );
  };

  const runtime = createCommandCodeTestRuntime({
    clientApiKey: "client-key",
    commandCodeApiKey: "upstream-key",
    commandCodeBaseUrl: "https://fixture.commandcode.test",
    fetch,
    modelId: "claude-fixture",
    createMessageId: () => "msg_1m",
    publicModels: publicModels(),
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
        model: "fixture/claude-fixture[1m]",
        max_tokens: 32,
        messages: [{ role: "user", content: "hello" }],
      }),
    }),
  );

  expect(response.status).toBe(200);
  expect(upstreamRequests).toHaveLength(1);
  await expect(response.json()).resolves.toMatchObject({
    id: "msg_1m",
    model: "fixture/claude-fixture[1m]",
  });
});

it("does not strip [1m] when the exact alias exists but is unavailable", async () => {
  let dispatched = false;
  const runtime = createCommandCodeTestRuntime({
    clientApiKey: "client-key",
    commandCodeApiKey: "upstream-key",
    commandCodeBaseUrl: "https://fixture.commandcode.test",
    fetch: async () => {
      dispatched = true;
      throw new Error("must not dispatch");
    },
    modelId: "claude-fixture",
    publicModels: publicModels(true),
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
        model: "fixture/claude-fixture[1m]",
        max_tokens: 32,
        messages: [{ role: "user", content: "hello" }],
      }),
    }),
  );

  expect(response.status).toBe(502);
  expect(dispatched).toBe(false);
});

it("resolves a marked model through the public alias and echoes the marked ID", async () => {
  const upstreamRequests: Request[] = [];
  const runtime = createCommandCodeTestRuntime({
    clientApiKey: "client-key",
    commandCodeApiKey: "upstream-key",
    commandCodeBaseUrl: "https://fixture.commandcode.test",
    modelId: "claude-fixture",
    publicModels: publicModels(),
    fetch: async (input, init) => {
      upstreamRequests.push(new Request(input, init));
      return new Response([
        JSON.stringify({ type: "text-start", id: "0" }),
        JSON.stringify({ type: "text-delta", id: "0", text: "ok" }),
        JSON.stringify({ type: "text-end", id: "0" }),
        JSON.stringify({ type: "finish", finishReason: "stop", totalUsage: {
          inputTokens: 1, inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0 },
          outputTokens: 1, totalTokens: 2,
        } }),
        "",
      ].join("\n"), { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
    },
  });
  const model = markAnthropicModelId("fixture/claude-fixture");
  const request = (selector: string) => new Request("http://Token.test/v1/messages", {
    method: "POST",
    headers: {
      authorization: "Bearer client-key",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: selector, max_tokens: 32, messages: [{ role: "user", content: "hello" }] }),
  });
  const response = await runtime.handle(request(model));
  expect(response.status).toBe(200);
  expect(upstreamRequests).toHaveLength(1);
  await expect(response.json()).resolves.toMatchObject({ model });
  const unknown = await runtime.handle(request(markAnthropicModelId("missing/model")));
  expect(unknown.status).toBe(404);
  expect(upstreamRequests).toHaveLength(1);
});

it("resolves a marked model that carries the [1m] suffix and echoes it verbatim", async () => {
  const upstreamRequests: Request[] = [];
  const runtime = createCommandCodeTestRuntime({
    clientApiKey: "client-key",
    commandCodeApiKey: "upstream-key",
    commandCodeBaseUrl: "https://fixture.commandcode.test",
    modelId: "claude-fixture",
    publicModels: publicModels(),
    fetch: async (input, init) => {
      upstreamRequests.push(new Request(input, init));
      return new Response([
        JSON.stringify({ type: "text-start", id: "0" }),
        JSON.stringify({ type: "text-delta", id: "0", text: "ok" }),
        JSON.stringify({ type: "text-end", id: "0" }),
        JSON.stringify({ type: "finish", finishReason: "stop", totalUsage: {
          inputTokens: 1, inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0 },
          outputTokens: 1, totalTokens: 2,
        } }),
        "",
      ].join("\n"), { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
    },
  });
  const selector = `${markAnthropicModelId("fixture/claude-fixture")}[1m]`;
  const response = await runtime.handle(
    new Request("http://Token.test/v1/messages", {
      method: "POST",
      headers: {
        authorization: "Bearer client-key",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: selector, max_tokens: 32, messages: [{ role: "user", content: "hello" }] }),
    }),
  );
  expect(response.status).toBe(200);
  expect(upstreamRequests).toHaveLength(1);
  await expect(response.json()).resolves.toMatchObject({ model: selector });
  expect(selector).not.toBe("fixture/claude-fixture[1m]");
});
