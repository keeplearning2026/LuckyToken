import type { FetchFunction } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { createCommandCodeTestRuntime as createLuckyTokenRuntime } from "../support/commandcode-serving.js";

const encoder = new TextEncoder();

function line(event: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(event)}\n`);
}

function request(stream: boolean): Request {
  return new Request("http://luckytoken.test/v1/messages", {
    method: "POST",
    headers: {
      authorization: "Bearer client-key",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "model",
      max_tokens: 10,
      messages: [{ role: "user", content: "hello" }],
      stream,
    }),
  });
}

function parseEvents(body: string): Array<Record<string, unknown>> {
  return body
    .split("\n\n")
    .filter((frame) => frame.length > 0)
    .map((frame) => {
      const lines = frame.split("\n");
      expect(lines).toHaveLength(2);
      const event = lines[0]?.slice("event: ".length);
      const data = JSON.parse(
        lines[1]?.slice("data: ".length) ?? "null",
      ) as Record<string, unknown>;
      expect(data.type).toBe(event);
      return data;
    });
}

describe("Anthropic Atomic SSE HTTP representation", () => {
  it("waits for committed completion and returns one fully buffered SSE body", async () => {
    let upstream: ReadableStreamDefaultController<Uint8Array> | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const fetch: FetchFunction = async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          upstream = controller;
          controller.enqueue(line({ type: "text-start", id: "0" }));
          controller.enqueue(
            line({ type: "text-delta", id: "0", text: "complete only" }),
          );
          controller.enqueue(line({ type: "text-end", id: "0" }));
          markStarted?.();
        },
      });
      return new Response(body, { status: 200 });
    };
    const runtime = createLuckyTokenRuntime({
      clientApiKey: "client-key",
      commandCodeApiKey: "upstream-key",
      commandCodeBaseUrl: "https://commandcode.test",
      fetch,
      modelId: "model",
      createMessageId: () => "msg_atomic",
      createSessionId: () => "00000000-0000-4000-8000-000000000019",
      now: () => 1,
    });

    let resolved = false;
    const handling = runtime.handle(request(true));
    void handling.then(() => {
      resolved = true;
    });
    await started;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolved).toBe(false);

    upstream?.enqueue(
      line({
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      }),
    );
    upstream?.close();

    const response = await handling;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const body = await response.text();
    expect(body).not.toContain("[DONE]");
    const events = parseEvents(body);
    expect(events.map((event) => event.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(events[0]).toMatchObject({
      message: { id: "msg_atomic", content: [], stop_reason: null },
    });
    expect(events[2]).toEqual({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "complete only" },
    });
  });

  it("keeps pre-commit stream=true failures as ordinary JSON errors", async () => {
    const fetch: FetchFunction = async () => {
      throw new Error("must not dispatch");
    };
    const runtime = createLuckyTokenRuntime({
      clientApiKey: "client-key",
      commandCodeApiKey: "upstream-key",
      commandCodeBaseUrl: "https://commandcode.test",
      fetch,
      modelId: "model",
    });
    const invalid = new Request("http://luckytoken.test/v1/messages", {
      method: "POST",
      headers: {
        authorization: "Bearer client-key",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "model",
        max_tokens: 10,
        messages: [{ role: "user", content: "hello" }],
        stream: true,
        stop_sequences: ["unsupported"],
      }),
    });

    const response = await runtime.handle(invalid);
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.json()).resolves.toMatchObject({
      type: "error",
      error: { type: "invalid_request_error" },
    });
  });
});
