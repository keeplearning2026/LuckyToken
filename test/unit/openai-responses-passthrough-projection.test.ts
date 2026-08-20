import { describe, expect, it } from "vitest";

import { projectNativeResponsesBody as projectResponsesPassthroughBody } from "../../src/protocols/openai-responses/native-response.js";

const ALIAS = "my-alias";
const CANONICAL = "gpt-4o";

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function decode(body: Uint8Array): string {
  return new TextDecoder().decode(body);
}

function responseObject(model: string): string {
  return JSON.stringify({
    id: "resp_1",
    object: "response",
    created_at: 1,
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
    model,
    output: [],
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  });
}

describe("Ticket 15 Responses passthrough response projection", () => {
  it("rewrites the top-level model of a non-streaming response", () => {
    const result = projectResponsesPassthroughBody(
      encode(responseObject(CANONICAL)),
      "application/json",
      ALIAS,
    );
    expect("error" in result).toBe(false);
    const parsed = JSON.parse(decode((result as { body: Uint8Array }).body)) as {
      model: string;
    };
    expect(parsed.model).toBe(ALIAS);
  });

  it("changes only the model string in native JSON and preserves future numeric wire forms", () => {
    const source =
      '{\n  "id":"resp_lossless",  "model" : "gpt-4o",\n  "future_number":9007199254740993, "negative_zero":-0, "scientific":1e+30,\n  "future":{"opaque":true}\n}';
    const expected = source.replace('"gpt-4o"', '"my-alias"');

    const result = projectResponsesPassthroughBody(
      encode(source),
      "application/json",
      ALIAS,
    );

    expect("error" in result).toBe(false);
    expect(decode((result as { body: Uint8Array }).body)).toBe(expected);
  });

  it("changes only the model string inside a native SSE data line", () => {
    const source =
      'event: response.completed\r\ndata: {  "id":"resp_sse", "model" : "gpt-4o", "future_number":9007199254740993, "negative_zero":-0 }\r\n\r\n';
    const expected = source.replace('"gpt-4o"', '"my-alias"');

    const result = projectResponsesPassthroughBody(
      encode(source),
      "text/event-stream",
      ALIAS,
    );

    expect("error" in result).toBe(false);
    expect(decode((result as { body: Uint8Array }).body)).toBe(expected);
  });

  it("rewrites every model-bearing streaming event and preserves other events", () => {
    const stream = [
      "event: response.created",
      `data: ${responseObject(CANONICAL)}`,
      "",
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"hello"}',
      "",
      "event: response.completed",
      `data: ${responseObject(CANONICAL)}`,
      "",
      "",
    ].join("\n");
    const result = projectResponsesPassthroughBody(
      encode(stream),
      "text/event-stream",
      ALIAS,
    );
    expect("error" in result).toBe(false);
    const projected = decode((result as { body: Uint8Array }).body);
    // Both full-response events (created and completed) expose the alias.
    expect(projected.match(/"model":"my-alias"/gu)).toHaveLength(2);
    expect(projected).toContain(
      'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"hello"}',
    );
    expect(projected).not.toContain(CANONICAL);
  });

  it("fails closed when a non-streaming response carries a nested model that cannot be told apart from semantic content", () => {
    const body = JSON.parse(responseObject(CANONICAL)) as Record<string, unknown>;
    body.output = [
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [],
        model: CANONICAL,
      },
    ];
    const result = projectResponsesPassthroughBody(
      encode(JSON.stringify(body)),
      "application/json",
      ALIAS,
    );
    expect("error" in result).toBe(true);
  });

  it("fails closed when a streaming event carries a nested model", () => {
    const result = projectResponsesPassthroughBody(
      encode(
        `event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","status":"completed","content":[],"model":"${CANONICAL}"}}\n`,
      ),
      "text/event-stream",
      ALIAS,
    );
    expect("error" in result).toBe(true);
  });

  it("fails closed when a root-array streaming event carries a model key", () => {
    const direct = projectResponsesPassthroughBody(
      encode(`data: [{"model":"${CANONICAL}"}]\n`),
      "text/event-stream",
      ALIAS,
    );
    expect("error" in direct).toBe(true);
    const nested = projectResponsesPassthroughBody(
      encode(`data: [{"nested":{"model":"${CANONICAL}"}}]\n`),
      "text/event-stream",
      ALIAS,
    );
    expect("error" in nested).toBe(true);
  });

  it("passes a root-array streaming event without model keys through unchanged", () => {
    const result = projectResponsesPassthroughBody(
      encode('data: [1,2,{"x":1}]\n'),
      "text/event-stream",
      ALIAS,
    );
    expect("error" in result).toBe(false);
    expect(decode((result as { body: Uint8Array }).body)).toContain(
      'data: [1,2,{"x":1}]',
    );
  });

  it("fails safely on a non-JSON non-streaming body", () => {
    const result = projectResponsesPassthroughBody(
      encode("not-json{{{"),
      "application/json",
      ALIAS,
    );
    expect("error" in result).toBe(true);
  });

  it("fails safely when a non-streaming response carries no model identity", () => {
    const result = projectResponsesPassthroughBody(
      encode('{"object":"response","status":"completed"}'),
      "application/json",
      ALIAS,
    );
    expect("error" in result).toBe(true);
  });

  it("fails safely when a non-streaming response carries a non-string model", () => {
    const result = projectResponsesPassthroughBody(
      encode('{"object":"response","model":42,"status":"completed"}'),
      "application/json",
      ALIAS,
    );
    expect("error" in result).toBe(true);
  });

  it("fails safely when a streaming event carries a non-string model", () => {
    const result = projectResponsesPassthroughBody(
      encode('event: response.created\ndata: {"type":"response.created","model":7}\n'),
      "text/event-stream",
      ALIAS,
    );
    expect("error" in result).toBe(true);
  });

  it("fails safely on an unparseable streaming event", () => {
    const result = projectResponsesPassthroughBody(
      encode("event: response.created\ndata: {not-json\n"),
      "text/event-stream",
      ALIAS,
    );
    expect("error" in result).toBe(true);
  });

  it("passes model-free events through unchanged", () => {
    const result = projectResponsesPassthroughBody(
      encode('event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0}\n'),
      "text/event-stream",
      ALIAS,
    );
    expect("error" in result).toBe(false);
    expect(decode((result as { body: Uint8Array }).body)).toContain(
      'data: {"type":"response.output_item.added","output_index":0}',
    );
  });

  it("parses CR-only streams and rewrites the model identity", () => {
    const stream = [
      "event: response.created",
      `data: ${responseObject(CANONICAL)}`,
      "",
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"hello"}',
      "",
      "event: response.completed",
      `data: ${responseObject(CANONICAL)}`,
      "",
      "",
    ].join("\r");
    const result = projectResponsesPassthroughBody(
      encode(stream),
      "text/event-stream",
      ALIAS,
    );
    expect("error" in result).toBe(false);
    const projected = decode((result as { body: Uint8Array }).body);
    expect(projected.match(/"model":"my-alias"/gu)).toHaveLength(2);
    expect(projected).toContain('"delta":"hello"');
    expect(projected).not.toContain(CANONICAL);
  });

  it("parses CRLF streams and rewrites the model identity", () => {
    const stream = [
      "event: response.created",
      `data: ${responseObject(CANONICAL)}`,
      "",
      "event: response.completed",
      `data: ${responseObject(CANONICAL)}`,
      "",
      "",
    ].join("\r\n");
    const result = projectResponsesPassthroughBody(
      encode(stream),
      "text/event-stream",
      ALIAS,
    );
    expect("error" in result).toBe(false);
    const projected = decode((result as { body: Uint8Array }).body);
    expect(projected.match(/"model":"my-alias"/gu)).toHaveLength(2);
    expect(projected).not.toContain(CANONICAL);
  });

  it("parses a UTF-8 BOM-prefixed stream and rewrites the model identity", () => {
    const stream =
      "\uFEFF" +
      [
        "event: response.created",
        `data: ${responseObject(CANONICAL)}`,
        "",
        "event: response.completed",
        `data: ${responseObject(CANONICAL)}`,
        "",
        "",
      ].join("\r");
    const result = projectResponsesPassthroughBody(
      encode(stream),
      "text/event-stream",
      ALIAS,
    );
    expect("error" in result).toBe(false);
    const projected = decode((result as { body: Uint8Array }).body);
    expect(projected.match(/"model":"my-alias"/gu)).toHaveLength(2);
    expect(projected).not.toContain(CANONICAL);
  });
});
