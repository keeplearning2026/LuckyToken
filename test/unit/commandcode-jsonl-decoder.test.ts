import { describe, expect, it } from "vitest";

import { consumeCommandCodeResponse } from "../../packages/provider-commandcode-private/src/attempts.js";

function chunkedResponse(bytes: Uint8Array, splitPoints: number[]): Response {
  const chunks: Uint8Array[] = [];
  let previous = 0;
  for (const point of splitPoints) {
    chunks.push(bytes.slice(previous, point));
    previous = point;
  }
  chunks.push(bytes.slice(previous));
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  );
}

describe("CommandCode bare JSONL decoder", () => {
  it("handles split UTF-8, split lines, CRLF, empty lines, and final unterminated line", async () => {
    const body = [
      JSON.stringify({ type: "text-start", id: "t" }),
      "",
      JSON.stringify({ type: "text-delta", id: "t", text: "A😀B" }),
      JSON.stringify({ type: "text-end", id: "t" }),
      JSON.stringify({
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 1, outputTokens: 2 },
      }),
    ].join("\r\n");
    const bytes = new TextEncoder().encode(body);
    const emojiStart = bytes.findIndex((byte) => byte === 0xf0);
    const response = chunkedResponse(bytes, [1, 7, emojiStart + 1, emojiStart + 3]);

    const result = await consumeCommandCodeResponse(
      response,
      new AbortController().signal,
    );

    expect(result.content).toEqual([
      { type: "text", id: "t", text: "A😀B" },
    ]);
    expect(result.rawUsage).toMatchObject({ inputTokens: 1, outputTokens: 2 });
  });

  it("handles several complete events in one network chunk", async () => {
    const response = new Response(
      [
        JSON.stringify({ type: "text-start", id: "t" }),
        JSON.stringify({ type: "text-delta", id: "t", text: "one chunk" }),
        JSON.stringify({ type: "text-end", id: "t" }),
        JSON.stringify({ type: "finish", finishReason: "stop" }),
        "",
      ].join("\n"),
    );

    const result = await consumeCommandCodeResponse(
      response,
      new AbortController().signal,
    );
    expect(result.content).toEqual([
      { type: "text", id: "t", text: "one chunk" },
    ]);
  });
});
