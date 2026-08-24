import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import {
  CLIENT_USAGE_UNAVAILABLE_NOTICE_CODE,
  convertAssistantMessageToAnthropicWithPolicy,
  type AnthropicResponseMessage,
} from "../../src/protocols/anthropic/response.js";
import {
  createAnthropicAtomicSseEvents,
  renderAnthropicAtomicSse,
  type AnthropicAtomicSseEvent,
} from "../../src/protocols/anthropic/sse.js";

function target(): AnthropicResponseMessage {
  return {
    id: "msg_same",
    container: null,
    content: [
      { citations: null, text: "", type: "text" },
      { signature: "opaque-signature", thinking: "private reasoning", type: "thinking" },
      {
        id: "call_exact",
        caller: { type: "direct" },
        input: { nested: [1, true, null, { text: "x\ny" }] },
        name: "tool_exact",
        type: "tool_use",
      },
      { citations: null, text: " after ", type: "text" },
    ],
    model: "client-selector",
    role: "assistant",
    stop_details: null,
    stop_reason: "tool_use",
    stop_sequence: null,
    type: "message",
    usage: {
      cache_creation: {
        ephemeral_1h_input_tokens: 2,
        ephemeral_5m_input_tokens: 3,
      },
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 3,
      inference_geo: null,
      input_tokens: 11,
      output_tokens: 7,
      output_tokens_details: { thinking_tokens: 4 },
      server_tool_use: null,
      service_tier: null,
    },
  };
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

  it("renders a schema-valid stream with the atomic zero usage for malformed usage", () => {
    // Ticket 20 additive: malformed usage must not discard the response on
    // the streaming seam either. The target carries the all-zero fallback
    // and the stream stays schema-valid while the content is preserved.
    const converted = convertAssistantMessageToAnthropicWithPolicy(
      {
        role: "assistant",
        api: "anthropic-messages",
        provider: "anthropic",
        model: "internal-model",
        content: [{ type: "text", text: "complete" }],
        usage: {
          input: -1,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 1,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1,
      },
      { selector: "client-selector" },
      { unknownPiContent: "error" },
    );
    expect(converted.notices.map((notice) => notice.code)).toContain(
      CLIENT_USAGE_UNAVAILABLE_NOTICE_CODE,
    );
    const rendered = renderAnthropicAtomicSse(converted.message);
    expect(rendered.status).toBe(200);
    expect(rendered.contentType).toBe("text/event-stream");
    const events = parseSse(rendered.body);
    const start = events.find((entry) => entry.event === "message_start")!
      .data as Extract<AnthropicAtomicSseEvent, { type: "message_start" }>;
    expect(start.message.usage).toEqual({
      cache_creation: null,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      inference_geo: null,
      input_tokens: 0,
      output_tokens: 0,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    });
    const delta = events.find((entry) => entry.event === "message_delta")!
      .data as Extract<AnthropicAtomicSseEvent, { type: "message_delta" }>;
    expect(delta.usage).toEqual({
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      server_tool_use: null,
    });
    const textDelta = events.find(
      (entry) =>
        entry.event === "content_block_delta" &&
        (entry.data as { delta: { type: string } }).delta.type === "text_delta",
    );
    expect(textDelta).toBeDefined();
    expect((textDelta!.data as { delta: { text: string } }).delta.text).toBe(
      "complete",
    );
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
    expect(start.message.usage).toEqual({
      ...message.usage,
      output_tokens: 0,
      output_tokens_details: null,
    });
    expect(delta.usage).toEqual({
      cache_creation_input_tokens: message.usage.cache_creation_input_tokens,
      cache_read_input_tokens: message.usage.cache_read_input_tokens,
      input_tokens: message.usage.input_tokens,
      output_tokens: message.usage.output_tokens,
      server_tool_use: message.usage.server_tool_use,
    });
  });

  it("frames and accumulates every represented field back to the JSON target", () => {
    const message = target();
    const rendered = renderAnthropicAtomicSse(message);
    expect(rendered).toMatchObject({ status: 200, contentType: "text/event-stream" });
    const frames = parseSse(rendered.body);
    for (const frame of frames) expect(frame.event).toBe(frame.data.type);
    const accumulated = accumulate(frames.map((frame) => frame.data));
    expect(accumulated).toEqual({
      ...message,
      usage: { ...message.usage, output_tokens_details: null },
    });
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
    expect(sdkWireMessage).toEqual({
      ...message,
      usage: { ...message.usage, output_tokens_details: null },
    });
  });
});
