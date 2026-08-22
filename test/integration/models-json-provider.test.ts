import type { FetchFunction } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadLuckyTokenCliConfig } from "../../src/cli-config.js";
import { createConfiguredLuckyTokenDataPlane } from "../support/configured-data-plane.js";

function anthropicSseResponse(text: string): Response {
  return new Response(
    [
      {
        type: "message_start",
        message: {
          id: "msg_upstream",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-sonnet",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 4, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 5 },
      },
      { type: "message_stop" },
    ]
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join(""),
    {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    },
  );
}

describe("models.json custom provider registration", () => {
  const directories: string[] = [];
  const compositions: Array<{ diagnosticsStore: { close(): void }; requestLedger: { close(): void }; deepCaptureStore: { close(): void } }> = [];

  afterEach(async () => {
    compositions.splice(0).forEach((composition) => {
      composition.diagnosticsStore.close();
      composition.requestLedger.close();
        composition.deepCaptureStore.close();
    });
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it.each([
    "bad/provider",
    "p".repeat(65),
  ])("rejects an unrepresentable custom Provider namespace: %s", async (providerId) => {
    const directory = await mkdtemp(
      join(tmpdir(), "luckytoken-models-json-provider-id-"),
    );
    directories.push(directory);
    const stateDirectory = join(directory, ".luckytoken");
    const piDirectory = join(stateDirectory, "pi");
    await mkdir(piDirectory, { recursive: true });
    await writeFile(
      join(piDirectory, "models.json"),
      JSON.stringify({
        providers: {
          [providerId]: {
            baseUrl: "https://gateway.example.com",
            api: "anthropic-messages",
            apiKey: "gateway-key",
            models: [{ id: "model-a", contextWindow: 200000, maxTokens: 64000 }],
          },
        },
      }),
      "utf8",
    );
    const configPath = join(stateDirectory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "luckytoken-config-v1",
        server: { port: 0 },
        clientProtocols: {
          "anthropic-messages": {},
        },
        pi: { directory: "pi", modelsJson: "pi/models.json" },
      }),
      "utf8",
    );

    let rejected: unknown;
    try {
      const composition = await createConfiguredLuckyTokenDataPlane({
        config: await loadLuckyTokenCliConfig(configPath),
        fetch: async () =>
          new Response(JSON.stringify({ object: "list", data: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      });
      compositions.push(composition);
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).message).toMatch(/Provider ID.*safe|safe Provider ID/u);
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
      return anthropicSseResponse("hello from custom gateway");
    };
    const directory = await mkdtemp(
      join(tmpdir(), "luckytoken-models-json-"),
    );
    directories.push(directory);
    const stateDirectory = join(directory, ".luckytoken");
    const piDirectory = join(stateDirectory, "pi");
    await mkdir(piDirectory, { recursive: true });
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
        schemaVersion: "luckytoken-config-v1",
        server: { port: 0 },
        clientProtocols: {
          "anthropic-messages": {},
        },
        pi: { directory: "pi", modelsJson: "pi/models.json" },
      }),
      "utf8",
    );

    const composition = await createConfiguredLuckyTokenDataPlane({
      config: await loadLuckyTokenCliConfig(configPath),
      fetch,
      createMessageId: () => "msg_models_json",
      createSessionId: () => "00000000-0000-4000-8000-000000000260",
      now: () => 1_786_400_000_000,
    });
    compositions.push(composition);

    expect(composition.userConfiguredProviderIds).toEqual(["my-anthropic"]);

    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof globalThis.fetch }).fetch = fetch as typeof globalThis.fetch;
    let response: Response;
    try {
      response = await composition.runtime.handle(
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
    } finally {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = originalFetch;
    }

    expect(response.status).toBe(200);
    // Uncertified custom Provider tuples execute through Semantic Conversion.
    await expect(response.json()).resolves.toMatchObject({
      id: "msg_upstream",
      model: "my-anthropic/claude-sonnet",
      content: [{ type: "text", text: "hello from custom gateway" }],
    });
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]?.url).toBe(
      "https://gateway.example.com/v1/messages",
    );
    expect(upstreamRequests[0]?.headers.get("x-api-key")).toBe("gateway-key");
  });
});
