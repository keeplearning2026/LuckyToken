import Anthropic from "@anthropic-ai/sdk";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  convertAssistantMessageToAnthropic,
  type AnthropicResponseMessage,
} from "../../src/protocols/anthropic/response.js";
import {
  createAnthropicAtomicSseEvents,
  renderAnthropicAtomicSse,
  type AnthropicAtomicSseEvent,
} from "../../src/protocols/anthropic/sse.js";

function target(): AnthropicResponseMessage {
  const source: AssistantMessage = {
    role: "assistant",
    api: "api",
    provider: "provider",
    model: "internal-model",
    content: [
      { type: "text", text: "" },
      {
        type: "thinking",
        thinking: "private reasoning",
        thinkingSignature: "opaque-signature",
      },
      {
        type: "toolCall",
        id: "call_exact",
        name: "tool_exact",
        arguments: { nested: [1, true, null, { text: "x\ny" }] },
      },
      { type: "text", text: " after " },
    ],
    usage: {
      input: 11,
      output: 7,
      cacheRead: 3,
      cacheWrite: 5,
      cacheWrite1h: 2,
      reasoning: 4,
      totalTokens: 26,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 1,
  };
  return convertAssistantMessageToAnthropic(
    source,
    "client-selector",
    "msg_same",
  );
}

function parseSse(body: Uint8Array): Array<{
  event: string;
  data: AnthropicAtomicSseEvent;
}> {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  expect(text).not.toContain("[DONE]");
  return text
    .split("\n\n")
    .filter((frame) => frame.length > 0)
    .map((frame) => {
      const [eventLine, dataLine, ...extra] = frame.split("\n");
      expect(extra).toEqual([]);
      expect(eventLine).toMatch(/^event: /u);
      expect(dataLine).toMatch(/^data: /u);
      return {
        event: eventLine?.slice("event: ".length) ?? "",
        data: JSON.parse(dataLine?.slice("data: ".length) ?? "null") as AnthropicAtomicSseEvent,
      };
    });
}

function accumulate(events: AnthropicAtomicSseEvent[]): AnthropicResponseMessage {
  let result: AnthropicResponseMessage | undefined;
  const toolJson = new Map<number, string>();
  for (const event of events) {
    if (event.type === "message_start") {
      result = structuredClone(event.message) as unknown as AnthropicResponseMessage;
      continue;
    }
    if (result === undefined) throw new Error("event before message_start");
    if (event.type === "content_block_start") {
      result.content[event.index] = structuredClone(event.content_block);
      if (event.content_block.type === "tool_use") toolJson.set(event.index, "");
      continue;
    }
    if (event.type === "content_block_delta") {
      const block = result.content[event.index];
      if (event.delta.type === "text_delta" && block?.type === "text") {
        block.text += event.delta.text;
      } else if (
        event.delta.type === "thinking_delta" &&
        block?.type === "thinking"
      ) {
        block.thinking += event.delta.thinking;
      } else if (
        event.delta.type === "signature_delta" &&
        block?.type === "thinking"
      ) {
        block.signature += event.delta.signature;
      } else if (
        event.delta.type === "input_json_delta" &&
        block?.type === "tool_use"
      ) {
        const json = (toolJson.get(event.index) ?? "") + event.delta.partial_json;
        toolJson.set(event.index, json);
        block.input = JSON.parse(json) as typeof block.input;
      } else {
        throw new Error("delta does not match its block");
      }
      continue;
    }
    if (event.type === "message_delta") {
      result.container = event.delta.container;
      result.stop_details = event.delta.stop_details;
      result.stop_reason = event.delta.stop_reason;
      result.stop_sequence = event.delta.stop_sequence;
      result.usage = {
        ...result.usage,
        ...event.usage,
      };
    }
  }
  if (result === undefined) throw new Error("missing message_start");
  return result;
}

describe("verifiable Anthropic Atomic SSE", () => {
  it("emits the exact ordered lifecycle and full atomic deltas", () => {
    const message = target();
    const events = createAnthropicAtomicSseEvents(message);

    expect(events.map((event) => event.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(events[2]).toEqual({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "" },
    });
    expect(events[5]).toEqual({
      type: "content_block_delta",
      index: 1,
      delta: { type: "thinking_delta", thinking: "private reasoning" },
    });
    expect(events[6]).toEqual({
      type: "content_block_delta",
      index: 1,
      delta: { type: "signature_delta", signature: "opaque-signature" },
    });
    const tool = message.content[2];
    if (tool?.type !== "tool_use") throw new Error("invalid tool fixture");
    expect(events[9]).toEqual({
      type: "content_block_delta",
      index: 2,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(tool.input),
      },
    });
    expect(events.at(-1)).toEqual({ type: "message_stop" });
  });

  it("uses a schema-valid constant cumulative usage trajectory", () => {
    const message = target();
    const events = createAnthropicAtomicSseEvents(message);
    const start = events[0];
    const delta = events.at(-2);
    expect(start?.type).toBe("message_start");
    expect(delta?.type).toBe("message_delta");
    if (start?.type !== "message_start" || delta?.type !== "message_delta") {
      throw new Error("invalid fixture lifecycle");
    }
    expect(start.message.usage).toEqual(message.usage);
    expect(delta.usage).toEqual({
      cache_creation_input_tokens: message.usage.cache_creation_input_tokens,
      cache_read_input_tokens: message.usage.cache_read_input_tokens,
      input_tokens: message.usage.input_tokens,
      output_tokens: message.usage.output_tokens,
      output_tokens_details: message.usage.output_tokens_details,
      server_tool_use: message.usage.server_tool_use,
    });
  });

  it("frames and accumulates every represented field back to the JSON target", () => {
    const message = target();
    const rendered = renderAnthropicAtomicSse(message);
    expect(rendered).toMatchObject({ status: 200, contentType: "text/event-stream" });
    const frames = parseSse(rendered.body);
    for (const frame of frames) expect(frame.event).toBe(frame.data.type);
    expect(accumulate(frames.map((frame) => frame.data))).toEqual(message);
  });

  it("is accepted and reconstructed by the installed official Anthropic SDK", async () => {
    const message = target();
    const rendered = renderAnthropicAtomicSse(message);
    const client = new Anthropic({
      apiKey: "fixture-key",
      baseURL: "http://anthropic-sdk-consumer.test",
      fetch: async () =>
        new Response(rendered.body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    });
    const sdk = client.messages.stream({
      model: "client-selector",
      max_tokens: 10,
      messages: [{ role: "user", content: "fixture" }],
    });

    const sdkMessage = await sdk.finalMessage();
    expect(sdkMessage.parsed_output).toBeNull();
    const sdkWireMessage = { ...sdkMessage };
    delete (sdkWireMessage as { parsed_output?: unknown }).parsed_output;
    expect(sdkWireMessage).toEqual(message);
  });
});
