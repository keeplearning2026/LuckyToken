import { describe, expect, it } from "vitest";

import { projectAnthropicPassthroughBody } from "../../src/protocols/anthropic/passthrough.js";

const ALIAS = "my-alias";
const CANONICAL = "claude-sonnet";

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function decode(body: Uint8Array): string {
  return new TextDecoder().decode(body);
}

function messageStartData(model: string): string {
  return `{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"${model}","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":4,"output_tokens":0}}}`;
}

describe("Ticket 15 Anthropic passthrough response projection", () => {
  it("rewrites the top-level model of a non-streaming response", () => {
    const result = projectAnthropicPassthroughBody(
      encode(
        '{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet","content":[],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}',
      ),
      "application/json",
      ALIAS,
    );
    expect("error" in result).toBe(false);
    const parsed = JSON.parse(decode((result as { body: Uint8Array }).body)) as {
      model: string;
    };
    expect(parsed.model).toBe(ALIAS);
  });

  it("rewrites message_start.message.model in a streaming response and preserves every other event", () => {
    const stream = [
      "event: message_start",
      `data: ${messageStartData(CANONICAL)}`,
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
      "",
      "",
    ].join("\n");
    const result = projectAnthropicPassthroughBody(
      encode(stream),
      "text/event-stream",
      ALIAS,
    );
    expect("error" in result).toBe(false);
    const projected = decode((result as { body: Uint8Array }).body);
    expect(projected).toContain(`"model":"${ALIAS}"`);
    expect(projected).toContain(
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
    );
    expect(projected).toContain('data: {"type":"message_stop"}');
    expect(projected).toContain("event: message_start");
    expect(projected).toContain("event: content_block_delta");
    expect(projected).toContain("event: message_stop");
    expect(projected).not.toContain(CANONICAL);
  });

  it("fails closed when message_start also carries a top-level model", () => {
    const result = projectAnthropicPassthroughBody(
      encode(
        `event: message_start\ndata: {"type":"message_start","model":"${CANONICAL}","message":{"id":"msg_1","type":"message","role":"assistant","model":"${CANONICAL}","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n`,
      ),
      "text/event-stream",
      ALIAS,
    );
    expect("error" in result).toBe(true);
  });

  it("fails closed when a non-message_start event carries any model", () => {
    const topLevel = projectAnthropicPassthroughBody(
      encode(
        `event: custom\ndata: {"type":"custom","model":"${CANONICAL}"}\n`,
      ),
      "text/event-stream",
      ALIAS,
    );
    expect("error" in topLevel).toBe(true);
    const nested = projectAnthropicPassthroughBody(
      encode(
        `event: custom\ndata: {"type":"custom","nested":{"model":"${CANONICAL}"}}\n`,
      ),
      "text/event-stream",
      ALIAS,
    );
    expect("error" in nested).toBe(true);
  });

  it("fails closed on a type-less nested message.model", () => {
    const result = projectAnthropicPassthroughBody(
      encode(
        `event: custom\ndata: {"message":{"model":"${CANONICAL}"}}\n`,
      ),
      "text/event-stream",
      ALIAS,
    );
    expect("error" in result).toBe(true);
  });

  it("fails closed when a root-array streaming event carries a model key", () => {
    const direct = projectAnthropicPassthroughBody(
      encode(`data: [{"model":"${CANONICAL}"}]\n`),
      "text/event-stream",
      ALIAS,
    );
    expect("error" in direct).toBe(true);
    const nested = projectAnthropicPassthroughBody(
      encode(`data: [{"nested":{"model":"${CANONICAL}"}}]\n`),
      "text/event-stream",
      ALIAS,
    );
    expect("error" in nested).toBe(true);
  });

  it("passes a root-array streaming event without model keys through unchanged", () => {
    const result = projectAnthropicPassthroughBody(
      encode('data: [{"type":"ping"},1,true]\n'),
      "text/event-stream",
      ALIAS,
    );
    expect("error" in result).toBe(false);
    expect(decode((result as { body: Uint8Array }).body)).toContain(
      'data: [{"type":"ping"},1,true]',
    );
  });

  it("fails closed when a non-streaming response carries a nested model that cannot be told apart from semantic content", () => {
    const result = projectAnthropicPassthroughBody(
      encode(
        `{"id":"msg_1","type":"message","role":"assistant","model":"${CANONICAL}","content":[{"type":"tool_use","id":"t_1","caller":{"type":"direct"},"name":"create_config","input":{"model":"${CANONICAL}"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}`,
      ),
      "application/json",
      ALIAS,
    );
    expect("error" in result).toBe(true);
  });

  it("fails safely on a non-JSON non-streaming body", () => {
    const result = projectAnthropicPassthroughBody(
      encode("not-json{{{"),
      "application/json",
      ALIAS,
    );
    expect("error" in result).toBe(true);
  });

  it("fails safely when a non-streaming response carries no model identity", () => {
    const result = projectAnthropicPassthroughBody(
      encode('{"type":"message","content":[]}'),
      "application/json",
      ALIAS,
    );
    expect("error" in result).toBe(true);
  });

  it("fails safely when a non-streaming response carries a non-string model", () => {
    const result = projectAnthropicPassthroughBody(
      encode('{"type":"message","model":42,"content":[]}'),
      "application/json",
      ALIAS,
    );
    expect("error" in result).toBe(true);
  });

  it("fails safely when message_start carries no message envelope or model", () => {
    const missingEnvelope = projectAnthropicPassthroughBody(
      encode('event: message_start\ndata: {"type":"message_start"}\n'),
      "text/event-stream",
      ALIAS,
    );
    expect("error" in missingEnvelope).toBe(true);
    const missingModel = projectAnthropicPassthroughBody(
      encode(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","content":[]}}\n',
      ),
      "text/event-stream",
      ALIAS,
    );
    expect("error" in missingModel).toBe(true);
  });

  it("fails safely on an unparseable streaming event", () => {
    const result = projectAnthropicPassthroughBody(
      encode("event: message_start\ndata: {not-json\n"),
      "text/event-stream",
      ALIAS,
    );
    expect("error" in result).toBe(true);
  });

  it("fails safely when a streaming event carries a non-string model", () => {
    const result = projectAnthropicPassthroughBody(
      encode('event: message_start\ndata: {"type":"message_start","message":{"id":"m","model":7,"content":[]}}\n'),
      "text/event-stream",
      ALIAS,
    );
    expect("error" in result).toBe(true);
  });

  it("parses CR-only streams and rewrites the model identity", () => {
    const stream = [
      "event: message_start",
      `data: ${messageStartData(CANONICAL)}`,
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
      "",
      "",
    ].join("\r");
    const result = projectAnthropicPassthroughBody(
      encode(stream),
      "text/event-stream",
      ALIAS,
    );
    expect("error" in result).toBe(false);
    const projected = decode((result as { body: Uint8Array }).body);
    expect(projected).toContain(`"model":"${ALIAS}"`);
    expect(projected).toContain("event: message_start");
    expect(projected).toContain('data: {"type":"message_stop"}');
    expect(projected).not.toContain(CANONICAL);
  });

  it("parses CRLF streams and rewrites the model identity", () => {
    const stream = [
      "event: message_start",
      `data: ${messageStartData(CANONICAL)}`,
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
      "",
      "",
    ].join("\r\n");
    const result = projectAnthropicPassthroughBody(
      encode(stream),
      "text/event-stream",
      ALIAS,
    );
    expect("error" in result).toBe(false);
    const projected = decode((result as { body: Uint8Array }).body);
    expect(projected).toContain(`"model":"${ALIAS}"`);
    expect(projected).not.toContain(CANONICAL);
  });

  it("parses a UTF-8 BOM-prefixed stream and rewrites the model identity", () => {
    const stream =
      "\uFEFF" +
      [
        "event: message_start",
        `data: ${messageStartData(CANONICAL)}`,
        "",
        "event: message_stop",
        'data: {"type":"message_stop"}',
        "",
        "",
      ].join("\r\n");
    const result = projectAnthropicPassthroughBody(
      encode(stream),
      "text/event-stream",
      ALIAS,
    );
    expect("error" in result).toBe(false);
    const projected = decode((result as { body: Uint8Array }).body);
    expect(projected).toContain(`"model":"${ALIAS}"`);
    expect(projected).not.toContain(CANONICAL);
  });

  it("preserves comments, non-data fields and data-less frames in order", () => {
    const stream = [
      ": keep-alive comment",
      "event: message_start",
      `data: ${messageStartData(CANONICAL)}`,
      "",
      ": second comment",
      "id: evt-7",
      "retry: 3000",
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
      "",
      "",
    ].join("\n");
    const result = projectAnthropicPassthroughBody(
      encode(stream),
      "text/event-stream",
      ALIAS,
    );
    expect("error" in result).toBe(false);
    const projected = decode((result as { body: Uint8Array }).body);
    expect(projected).toContain(": keep-alive comment");
    expect(projected).toContain(": second comment");
    expect(projected).toContain("id: evt-7");
    expect(projected).toContain("retry: 3000");
    expect(projected.indexOf(": keep-alive comment")).toBeLessThan(
      projected.indexOf("event: message_start"),
    );
    expect(projected.indexOf(": second comment")).toBeGreaterThan(
      projected.indexOf("event: message_start"),
    );
    expect(projected).not.toContain(CANONICAL);
  });

  it("passes a data-less event frame through unchanged", () => {
    const result = projectAnthropicPassthroughBody(
      encode("event: ping\n"),
      "text/event-stream",
      ALIAS,
    );
    expect("error" in result).toBe(false);
    const projected = decode((result as { body: Uint8Array }).body);
    expect(projected).toContain("event: ping");
  });
});
