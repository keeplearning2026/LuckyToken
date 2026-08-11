import Anthropic from "@anthropic-ai/sdk";
import type { FetchFunction } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import {
  startLuckyTokenHttpServer,
  type RunningLuckyTokenHttpServer,
} from "../../src/server.js";
import { createCommandCodeTestRuntime } from "../support/commandcode-serving.js";

function responseWithReasoning(): Response {
  return new Response(
    [
      JSON.stringify({ type: "reasoning-start", id: "reasoning-1" }),
      JSON.stringify({
        type: "reasoning-delta",
        id: "reasoning-1",
        text: "provider reasoning",
      }),
      JSON.stringify({ type: "reasoning-end", id: "reasoning-1" }),
      JSON.stringify({ type: "text-start", id: "text-1" }),
      JSON.stringify({ type: "text-delta", id: "text-1", text: "answer" }),
      JSON.stringify({ type: "text-end", id: "text-1" }),
      JSON.stringify({
        type: "finish",
        finishReason: "stop",
        totalUsage: {
          inputTokens: 3,
          outputTokens: 4,
          outputTokenDetails: { reasoningTokens: 2 },
        },
      }),
    ].join("\n"),
  );
}

function textResponse(text: string): Response {
  return new Response(
    [
      JSON.stringify({ type: "text-start", id: "text-2" }),
      JSON.stringify({ type: "text-delta", id: "text-2", text }),
      JSON.stringify({ type: "text-end", id: "text-2" }),
      JSON.stringify({
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 5, outputTokens: 1 },
      }),
    ].join("\n"),
  );
}

describe("Anthropic and Pi thinking round trip", () => {
  let server: RunningLuckyTokenHttpServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("preserves Provider reasoning through a real SDK response and next request", async () => {
    const upstreamBodies: Array<Record<string, unknown>> = [];
    const upstream: FetchFunction = async (input, init) => {
      const request = new Request(input, init);
      upstreamBodies.push((await request.json()) as Record<string, unknown>);
      return upstreamBodies.length === 1
        ? responseWithReasoning()
        : textResponse("follow-up answer");
    };
    const runtime = createCommandCodeTestRuntime({
      clientApiKey: "client-key",
      commandCodeApiKey: "provider-key",
      commandCodeBaseUrl: "https://commandcode.fixture.test",
      fetch: upstream,
      modelId: "reasoning-model",
      modelReasoning: true,
      createMessageId: (() => {
        let id = 0;
        return () => `msg_thinking_${++id}`;
      })(),
      createSessionId: () => "00000000-0000-4000-8000-000000000261",
    });
    server = await startLuckyTokenHttpServer({ runtime, port: 0 });
    const client = new Anthropic({
      apiKey: "client-key",
      baseURL: server.origin,
      maxRetries: 0,
    });

    const first = await client.messages.create({
      model: "reasoning-model",
      max_tokens: 32,
      messages: [{ role: "user", content: "question" }],
    });
    expect(first.content).toEqual([
      {
        type: "thinking",
        thinking: "provider reasoning",
        signature: "",
      },
      { type: "text", text: "answer", citations: null },
    ]);

    const second = await client.messages.create({
      model: "reasoning-model",
      max_tokens: 32,
      messages: [
        { role: "user", content: "question" },
        { role: "assistant", content: first.content },
        { role: "user", content: "follow up" },
      ],
    });

    expect(second.content).toEqual([
      { type: "text", text: "follow-up answer", citations: null },
    ]);
    expect(upstreamBodies[1]).toMatchObject({
      params: {
        messages: [
          { role: "user", content: [{ type: "text", text: "question" }] },
          {
            role: "assistant",
            content: [
              { type: "reasoning", text: "provider reasoning" },
              { type: "text", text: "answer" },
            ],
          },
          { role: "user", content: [{ type: "text", text: "follow up" }] },
        ],
      },
    });
    const secondProviderWire = JSON.stringify(upstreamBodies[1]);
    expect(secondProviderWire).not.toContain('"type":"thinking"');
    expect(secondProviderWire).not.toContain('"signature"');
  });
});
