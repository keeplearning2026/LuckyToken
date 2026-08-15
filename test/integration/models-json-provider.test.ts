import type { FetchFunction } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadLuckyTokenCliConfig } from "../../src/cli-config.js";
import { createFileClientTokenStore } from "../../src/client-auth/file-token-store.js";
import { createConfiguredLuckyTokenComposition } from "../../src/composition.js";

function anthropicJsonResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      id: "msg_upstream",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      model: "claude-sonnet",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 4, output_tokens: 5 },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

describe("models.json custom provider registration", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("registers a custom anthropic provider and serves it through the route", async () => {
    const upstreamRequests: Request[] = [];
    const fetch: FetchFunction = async (input, init) => {
      const request = new Request(input, init);
      if (String(input).includes("/provider/v1/models")) {
        return new Response(
          JSON.stringify({ object: "list", data: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      upstreamRequests.push(request);
      return anthropicJsonResponse("hello from custom gateway");
    };
    const directory = await mkdtemp(
      join(tmpdir(), "luckytoken-models-json-"),
    );
    directories.push(directory);
    const stateDirectory = join(directory, ".luckytoken");
    const piDirectory = join(stateDirectory, "pi");
    await mkdir(piDirectory, { recursive: true });
    const clientAuthPath = join(
      stateDirectory,
      "client-auth",
      "anthropic-messages.json",
    );
    await createFileClientTokenStore({ path: clientAuthPath }).create(
      { type: "global" },
      "client-token",
    );
    const modelsJsonPath = join(piDirectory, "models.json");
    await writeFile(
      modelsJsonPath,
      JSON.stringify({
        providers: {
          "my-anthropic": {
            baseUrl: "https://gateway.example.com",
            api: "anthropic-messages",
            apiKey: "gateway-key",
            models: [
              { id: "claude-sonnet", contextWindow: 200000, maxTokens: 64000 },
            ],
          },
        },
      }),
      "utf8",
    );
    const configPath = join(stateDirectory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        server: { port: 0 },
        clientProtocols: {
          "anthropic-messages": {
            authFile: "client-auth/anthropic-messages.json",
          },
        },
        pi: { directory: "pi", modelsJson: "pi/models.json" },
      }),
      "utf8",
    );

    const composition = await createConfiguredLuckyTokenComposition({
      config: await loadLuckyTokenCliConfig(configPath),
      fetch,
      createMessageId: () => "msg_models_json",
      createSessionId: () => "00000000-0000-4000-8000-000000000260",
      now: () => 1_786_400_000_000,
    });

    expect(composition.userConfiguredProviderIds).toEqual(["my-anthropic"]);

    const response = await composition.runtime.handle(
      new Request("http://luckytoken.test/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer client-token",
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "my-anthropic/claude-sonnet",
          max_tokens: 32,
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    );

    expect(response.status).toBe(200);
    // Passthrough: the upstream Anthropic response is forwarded verbatim.
    await expect(response.json()).resolves.toMatchObject({
      id: "msg_upstream",
      model: "claude-sonnet",
      content: [{ type: "text", text: "hello from custom gateway" }],
    });
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]?.url).toBe(
      "https://gateway.example.com/v1/messages",
    );
    expect(upstreamRequests[0]?.headers.get("x-api-key")).toBe("gateway-key");
  });
});
