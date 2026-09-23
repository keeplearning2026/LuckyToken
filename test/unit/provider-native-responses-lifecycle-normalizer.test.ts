import { describe, expect, it } from "vitest";

import {
  normalizeNativeResponsesSse,
  type NativeResponsesNormalizationResult,
} from "../../src/protocols/openai-responses/native-sse-lifecycle-normalizer.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function sse(events: readonly Record<string, unknown>[]): Uint8Array<ArrayBuffer> {
  return encoder.encode(
    events
      .map(
        (event, sequenceNumber) =>
          `event: ${String(event.type)}\ndata: ${JSON.stringify({
            ...event,
            sequence_number: sequenceNumber,
          })}\n\n`,
      )
      .join(""),
  );
}

function text(body: Uint8Array<ArrayBuffer>): string {
  return decoder.decode(body);
}

function message(id: string, textValue = "", status = "in_progress") {
  return {
    type: "message",
    id,
    role: "assistant",
    status,
    content:
      textValue.length === 0
        ? []
        : [{ type: "output_text", text: textValue, annotations: [] }],
  };
}

function reasoning(id: string, status = "in_progress") {
  return {
    type: "reasoning",
    id,
    status,
    summary: [],
  };
}

function expectSkipped(
  result: NativeResponsesNormalizationResult,
  body: Uint8Array<ArrayBuffer>,
  reason: Extract<NativeResponsesNormalizationResult, { kind: "skipped" }>["reason"],
): void {
  expect(result).toEqual({ kind: "skipped", body, reason });
  expect(result.body).toBe(body);
}

describe("Provider Native Responses SSE lifecycle normalizer", () => {
  it("preserves the complete wire when a bare CR precedes a sequence token in an interleaved stream", () => {
    const body = encoder.encode(
      ': bare-cr comment\r' +
        text(sse([
          { type: "response.output_item.added", output_index: 0, item: message("a") },
          { type: "response.output_item.added", output_index: 1, item: message("b") },
          { type: "response.output_item.done", output_index: 1, item: message("b") },
          { type: "response.output_item.done", output_index: 0, item: message("a") },
        ])),
    );

    expectSkipped(normalizeNativeResponsesSse(body), body, "invalid_sse_structure");
  });

  it.each([
    ': comment\revent: response.completed\ndata: {"type":"response.completed"}\n\n',
    'event: response.completed\ndata: {"type":\rdata: "response.completed"}\n\n',
    'id: cursor\revent: response.completed\ndata: {"type":"response.completed"}\n\n',
    'event: response.completed\rdata: {"type":"response.completed"}\r\r',
  ])("skips unsupported bare CR records without rebuilding even a serial stream (%#)", (wire) => {
    const body = encoder.encode(wire);
    expectSkipped(normalizeNativeResponsesSse(body), body, "invalid_sse_structure");
  });

  it("serializes complete item chains at their original done positions rather than by output_index", () => {
    const aAdded = {
      type: "response.output_item.added",
      output_index: 0,
      item: message("msg_a"),
    };
    const aDelta = {
      type: "response.output_text.delta",
      output_index: 0,
      item_id: "msg_a",
      content_index: 0,
      delta: "ANSWER_A",
    };
    const aDone = {
      type: "response.output_item.done",
      output_index: 0,
      item: message("msg_a", "ANSWER_A", "completed"),
    };
    const bAdded = {
      type: "response.output_item.added",
      output_index: 1,
      item: message("msg_b"),
    };
    const bDelta = {
      type: "response.output_text.delta",
      output_index: 1,
      item_id: "msg_b",
      content_index: 0,
      delta: "ANSWER_B",
    };
    const bDone = {
      type: "response.output_item.done",
      output_index: 1,
      item: message("msg_b", "ANSWER_B", "completed"),
    };

    const input = sse([aAdded, bAdded, bDelta, bDone, aDelta, aDone]);
    const expected = sse([bAdded, bDelta, bDone, aAdded, aDelta, aDone]);

    const result = normalizeNativeResponsesSse(input);

    expect(result.kind).toBe("normalized");
    if (result.kind !== "normalized") throw new Error("expected normalized result");
    expect(result.body).toEqual(expected);
    expect(result.commitOrderDiffersFromOutputIndex).toBe(true);
  });

  it("returns an already serialized CRLF stream byte-for-byte unchanged", () => {
    const raw =
      ": keepalive\r\n" +
      "event: response.output_item.added\r\n" +
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"in_progress","content":[]},"sequence_number":7}\r\n' +
      "\r\n" +
      "event: response.output_text.delta\r\n" +
      'data: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_a","content_index":0,"delta":"A","sequence_number":8}\r\n' +
      "\r\n" +
      "event: response.output_item.done\r\n" +
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"completed","content":[{"type":"output_text","text":"A","annotations":[]}]},"sequence_number":9}\r\n' +
      "\r\n";
    const input = encoder.encode(raw);

    const result = normalizeNativeResponsesSse(input);

    expect(result).toEqual({ kind: "unchanged", body: input });
    expect(result.body).toBe(input);
  });

  it("keeps the global-plus-done skeleton in original order while expanding each item at its done", () => {
    const global1 = { type: "response.metadata", marker: "G1" };
    const global2 = { type: "response.future_global", marker: "G2" };
    const aAdded = { type: "response.output_item.added", output_index: 0, item: message("msg_a") };
    const aDelta = { type: "response.output_text.delta", output_index: 0, item_id: "msg_a", content_index: 0, delta: "A" };
    const aDone = { type: "response.output_item.done", output_index: 0, item: message("msg_a", "A", "completed") };
    const bAdded = { type: "response.output_item.added", output_index: 1, item: message("msg_b") };
    const bDelta = { type: "response.output_text.delta", output_index: 1, item_id: "msg_b", content_index: 0, delta: "B" };
    const bDone = { type: "response.output_item.done", output_index: 1, item: message("msg_b", "B", "completed") };

    const input = sse([aAdded, global1, bAdded, bDelta, global2, bDone, aDelta, aDone]);
    const expected = sse([global1, global2, bAdded, bDelta, bDone, aAdded, aDelta, aDone]);

    const result = normalizeNativeResponsesSse(input);

    expect(result.kind).toBe("normalized");
    if (result.kind !== "normalized") throw new Error("expected normalized result");
    expect(result.body).toEqual(expected);
  });

  it("serializes true content interleaving while preserving each item chain's internal order", () => {
    const aAdded = { type: "response.output_item.added", output_index: 4, item: message("msg_a", "seed-a") };
    const a1 = { type: "response.output_text.delta", output_index: 4, item_id: "msg_a", content_index: 0, delta: "A1" };
    const a2 = { type: "response.output_text.delta", output_index: 4, item_id: "msg_a", content_index: 0, delta: "A2" };
    const aDone = { type: "response.output_item.done", output_index: 4, item: message("msg_a", "seed-aA1A2", "completed") };
    const bAdded = { type: "response.output_item.added", output_index: 9, item: message("msg_b", "seed-b") };
    const b1 = { type: "response.output_text.delta", output_index: 9, item_id: "msg_b", content_index: 0, delta: "B1" };
    const b2 = { type: "response.output_text.delta", output_index: 9, item_id: "msg_b", content_index: 0, delta: "B2" };
    const bDone = { type: "response.output_item.done", output_index: 9, item: message("msg_b", "seed-bB1B2", "completed") };

    const input = sse([aAdded, a1, bAdded, b1, a2, b2, aDone, bDone]);
    const expected = sse([aAdded, a1, a2, aDone, bAdded, b1, b2, bDone]);

    const result = normalizeNativeResponsesSse(input);

    expect(result.kind).toBe("normalized");
    if (result.kind !== "normalized") throw new Error("expected normalized result");
    expect(result.body).toEqual(expected);
    expect(result.commitOrderDiffersFromOutputIndex).toBe(false);
  });

  it("handles three interleaved chains and preserves original done order", () => {
    const add = (id: string, output_index: number) => ({
      type: "response.output_item.added",
      output_index,
      item: message(id),
    });
    const delta = (id: string, output_index: number, value: string) => ({
      type: "response.output_text.delta",
      output_index,
      item_id: id,
      content_index: 0,
      delta: value,
    });
    const done = (id: string, output_index: number, value: string) => ({
      type: "response.output_item.done",
      output_index,
      item: message(id, value, "completed"),
    });
    const input = sse([
      add("a", 0),
      add("b", 1),
      add("c", 2),
      delta("a", 0, "A"),
      delta("c", 2, "C"),
      done("c", 2, "C"),
      delta("b", 1, "B"),
      done("b", 1, "B"),
      done("a", 0, "A"),
    ]);
    const expected = sse([
      add("c", 2),
      delta("c", 2, "C"),
      done("c", 2, "C"),
      add("b", 1),
      delta("b", 1, "B"),
      done("b", 1, "B"),
      add("a", 0),
      delta("a", 0, "A"),
      done("a", 0, "A"),
    ]);

    const result = normalizeNativeResponsesSse(input);

    expect(result.kind).toBe("normalized");
    if (result.kind !== "normalized") throw new Error("expected normalized result");
    expect(result.body).toEqual(expected);
    expect(result.commitOrderDiffersFromOutputIndex).toBe(true);
  });

  it("preserves done-order serialization across a fixed set of interleaving permutations", () => {
    const added = (id: string, output_index: number) => ({
      type: "response.output_item.added",
      output_index,
      item: message(id),
    });
    const delta = (id: string, output_index: number) => ({
      type: "response.output_text.delta",
      output_index,
      item_id: id,
      content_index: 0,
      delta: id.toUpperCase(),
    });
    const done = (id: string, output_index: number) => ({
      type: "response.output_item.done",
      output_index,
      item: message(id, id.toUpperCase(), "completed"),
    });
    const chains = {
      a: [added("a", 0), delta("a", 0), done("a", 0)] as const,
      b: [added("b", 1), delta("b", 1), done("b", 1)] as const,
      c: [added("c", 2), delta("c", 2), done("c", 2)] as const,
    };

    const cases = [
      {
        input: [
          chains.a[0],
          chains.b[0],
          chains.c[0],
          chains.a[1],
          chains.c[1],
          chains.c[2],
          chains.b[1],
          chains.b[2],
          chains.a[2],
        ],
        expected: [...chains.c, ...chains.b, ...chains.a],
      },
      {
        input: [
          chains.c[0],
          chains.a[0],
          chains.c[1],
          chains.b[0],
          chains.a[1],
          chains.a[2],
          chains.b[1],
          chains.b[2],
          chains.c[2],
        ],
        expected: [...chains.a, ...chains.b, ...chains.c],
      },
      {
        input: [
          chains.b[0],
          chains.c[0],
          chains.a[0],
          chains.b[1],
          chains.b[2],
          chains.a[1],
          chains.c[1],
          chains.a[2],
          chains.c[2],
        ],
        expected: [...chains.b, ...chains.a, ...chains.c],
      },
    ] as const;

    for (const fixture of cases) {
      const result = normalizeNativeResponsesSse(sse(fixture.input));
      expect(result.kind).toBe("normalized");
      if (result.kind !== "normalized") {
        throw new Error("expected normalized result");
      }
      expect(result.body).toEqual(sse(fixture.expected));
    }
  });

  it("serializes interleaved function and custom-tool chains without changing arguments", () => {
    const functionAdded = {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "lookup",
        arguments: "",
        status: "in_progress",
      },
    };
    const functionDelta = {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: "fc_1",
      delta: '{"query":"alpha"}',
    };
    const functionDone = {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "lookup",
        arguments: '{"query":"alpha"}',
        status: "completed",
      },
    };
    const customAdded = {
      type: "response.output_item.added",
      output_index: 1,
      item: {
        type: "custom_tool_call",
        id: "ctc_1",
        call_id: "call_2",
        name: "patch",
        input: "",
        status: "in_progress",
      },
    };
    const customDelta = {
      type: "response.custom_tool_call_input.delta",
      output_index: 1,
      item_id: "ctc_1",
      call_id: "call_2",
      delta: "*** Begin Patch",
    };
    const customDone = {
      type: "response.output_item.done",
      output_index: 1,
      item: {
        type: "custom_tool_call",
        id: "ctc_1",
        call_id: "call_2",
        name: "patch",
        input: "*** Begin Patch",
        status: "completed",
      },
    };

    const input = sse([
      functionAdded,
      customAdded,
      functionDelta,
      customDelta,
      customDone,
      functionDone,
    ]);
    const expected = sse([
      customAdded,
      customDelta,
      customDone,
      functionAdded,
      functionDelta,
      functionDone,
    ]);

    const result = normalizeNativeResponsesSse(input);

    expect(result.kind).toBe("normalized");
    if (result.kind !== "normalized") throw new Error("expected normalized result");
    expect(result.body).toEqual(expected);
    expect(text(result.body)).toContain('*** Begin Patch');
    expect(text(result.body)).toContain('\\\"query\\\":\\\"alpha\\\"');
  });

  it("keeps both reasoning.delta and reasoning_text.delta in their item chain without interpreting either", () => {
    const rAdded = { type: "response.output_item.added", output_index: 0, item: reasoning("rs_1") };
    const rLegacy = { type: "response.reasoning.delta", output_index: 0, item_id: "rs_1", delta: "legacy" };
    const rCodex = { type: "response.reasoning_text.delta", output_index: 0, item_id: "rs_1", content_index: 0, delta: "codex" };
    const rDone = { type: "response.output_item.done", output_index: 0, item: reasoning("rs_1", "completed") };
    const mAdded = { type: "response.output_item.added", output_index: 1, item: message("msg_1") };
    const mDone = { type: "response.output_item.done", output_index: 1, item: message("msg_1", "", "completed") };
    const input = sse([rAdded, mAdded, rLegacy, rCodex, mDone, rDone]);
    const expected = sse([mAdded, mDone, rAdded, rLegacy, rCodex, rDone]);

    const result = normalizeNativeResponsesSse(input);

    expect(result.kind).toBe("normalized");
    if (result.kind !== "normalized") throw new Error("expected normalized result");
    expect(result.body).toEqual(expected);
  });

  it("treats an unknown event with a resolvable item identity as item-local", () => {
    const input = sse([
      { type: "response.output_item.added", output_index: 0, item: message("msg_a") },
      { type: "response.output_item.added", output_index: 1, item: message("msg_b") },
      { type: "response.future_item_delta", output_index: 0, item_id: "msg_a", opaque: { keep: true } },
      { type: "response.output_item.done", output_index: 1, item: message("msg_b", "", "completed") },
      { type: "response.output_item.done", output_index: 0, item: message("msg_a", "", "completed") },
    ]);
    const expected = sse([
      { type: "response.output_item.added", output_index: 1, item: message("msg_b") },
      { type: "response.output_item.done", output_index: 1, item: message("msg_b", "", "completed") },
      { type: "response.output_item.added", output_index: 0, item: message("msg_a") },
      { type: "response.future_item_delta", output_index: 0, item_id: "msg_a", opaque: { keep: true } },
      { type: "response.output_item.done", output_index: 0, item: message("msg_a", "", "completed") },
    ]);

    const result = normalizeNativeResponsesSse(input);

    expect(result.kind).toBe("normalized");
    if (result.kind !== "normalized") throw new Error("expected normalized result");
    expect(result.body).toEqual(expected);
  });

  it("supports CRLF, comments, non-data fields, and multi-line data without rebuilding payloads", () => {
    const aAdded =
      ": keep-with-a\r\n" +
      "retry: 1234\r\n" +
      "event: response.output_item.added\r\n" +
      'data: {"type":"response.output_item.added","sequence_number":40,\r\n' +
      'data: "output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"in_progress","content":[]}}\r\n\r\n';
    const bAdded =
      "event: response.output_item.added\r\n" +
      'data: {"type":"response.output_item.added","sequence_number":41,"output_index":1,"item":{"type":"message","id":"msg_b","role":"assistant","status":"in_progress","content":[]}}\r\n\r\n';
    const bDone =
      "event: response.output_item.done\r\n" +
      'data: {"type":"response.output_item.done","sequence_number":42,"output_index":1,"item":{"type":"message","id":"msg_b","role":"assistant","status":"completed","content":[]}}\r\n\r\n';
    const aDone =
      "event: response.output_item.done\r\n" +
      'data: {"type":"response.output_item.done","sequence_number":43,"output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"completed","content":[]}}\r\n\r\n';
    const input = encoder.encode(aAdded + bAdded + bDone + aDone);

    const result = normalizeNativeResponsesSse(input);

    expect(result.kind).toBe("normalized");
    if (result.kind !== "normalized") throw new Error("expected normalized result");
    const rendered = text(result.body);
    expect(rendered.indexOf("msg_b")).toBeLessThan(rendered.indexOf("msg_a"));
    expect(rendered).toContain(": keep-with-a\r\nretry: 1234\r\n");
    expect(rendered).toContain(
      'data: {"type":"response.output_item.added","sequence_number":2,\r\n' +
        'data: "output_index":0',
    );
  });

  it("skips identity contradictions and returns the exact original body", () => {
    const body = sse([
      { type: "response.output_item.added", output_index: 0, item: message("msg_a") },
      { type: "response.output_text.delta", output_index: 1, item_id: "msg_a", content_index: 0, delta: "A" },
      { type: "response.output_item.done", output_index: 0, item: message("msg_a", "A", "completed") },
    ]);

    expectSkipped(normalizeNativeResponsesSse(body), body, "item_identity_conflict");
  });

  it("skips an item-local SSE record with no data/identity instead of treating it as global", () => {
    const body = encoder.encode(
      "event: response.output_text.delta\n\n",
    );

    expectSkipped(
      normalizeNativeResponsesSse(body),
      body,
      "unsupported_event_attribution",
    );
  });

  it("skips an explicitly item-local frame whose identity cannot be resolved", () => {
    const body = sse([
      { type: "response.output_item.added", output_index: 0, item: message("msg_a") },
      { type: "response.output_text.delta", content_index: 0, delta: "orphan" },
      { type: "response.output_item.done", output_index: 0, item: message("msg_a", "", "completed") },
    ]);

    expectSkipped(
      normalizeNativeResponsesSse(body),
      body,
      "unsupported_event_attribution",
    );
  });

  it("skips duplicate lifecycle events and item content after done", () => {
    const duplicateAdded = sse([
      { type: "response.output_item.added", output_index: 0, item: message("msg_a") },
      { type: "response.output_item.added", output_index: 0, item: message("msg_a") },
      { type: "response.output_item.done", output_index: 0, item: message("msg_a", "", "completed") },
    ]);
    expectSkipped(
      normalizeNativeResponsesSse(duplicateAdded),
      duplicateAdded,
      "invalid_item_lifecycle",
    );

    const afterDone = sse([
      { type: "response.output_item.added", output_index: 0, item: message("msg_a") },
      { type: "response.output_item.done", output_index: 0, item: message("msg_a", "", "completed") },
      { type: "response.output_text.delta", output_index: 0, item_id: "msg_a", content_index: 0, delta: "late" },
    ]);
    expectSkipped(
      normalizeNativeResponsesSse(afterDone),
      afterDone,
      "invalid_item_lifecycle",
    );
  });

  it("skips failed/incomplete termination while an item chain is still open", () => {
    for (const terminal of ["response.failed", "response.incomplete"] as const) {
      const body = sse([
        { type: "response.output_item.added", output_index: 0, item: message("msg_a") },
        { type: terminal, response: { id: "resp_x", status: terminal.slice("response.".length) } },
      ]);
      expectSkipped(
        normalizeNativeResponsesSse(body),
        body,
        "incomplete_item_chain",
      );
    }
  });

  it("treats [DONE] as a terminal record and never emits an open chain after it", () => {
    const body = encoder.encode(
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":0,"output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"in_progress","content":[]}}\n\n' +
        "data: [DONE]\n\n" +
        'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":1,"output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"completed","content":[]}}\n\n',
    );

    expectSkipped(
      normalizeNativeResponsesSse(body),
      body,
      "incomplete_item_chain",
    );
  });

  it("reports cursor/background semantics as skipped even when the stream is already serialized", () => {
    const body = sse([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: message("msg_a"),
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: message("msg_a", "", "completed"),
      },
    ]);

    expectSkipped(
      normalizeNativeResponsesSse(body, { upstreamCursorSemantics: true }),
      body,
      "upstream_cursor_semantics",
    );
  });

  it("skips reconnect/background cursor semantics instead of renumbering", () => {
    const withSseId = encoder.encode(
      'event: response.output_item.added\nid: cursor-7\ndata: {"type":"response.output_item.added","sequence_number":0,"output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"in_progress","content":[]}}\n\n' +
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":1,"output_index":1,"item":{"type":"message","id":"msg_b","role":"assistant","status":"in_progress","content":[]}}\n\n' +
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":2,"output_index":1,"item":{"type":"message","id":"msg_b","role":"assistant","status":"completed","content":[]}}\n\n' +
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":3,"output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"completed","content":[]}}\n\n',
    );
    expectSkipped(
      normalizeNativeResponsesSse(withSseId),
      withSseId,
      "upstream_cursor_semantics",
    );

    const withBackground = sse([
      { type: "response.created", response: { id: "resp_bg", background: true, status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item: message("msg_a") },
      { type: "response.output_item.added", output_index: 1, item: message("msg_b") },
      { type: "response.output_item.done", output_index: 1, item: message("msg_b", "", "completed") },
      { type: "response.output_item.done", output_index: 0, item: message("msg_a", "", "completed") },
    ]);
    expectSkipped(
      normalizeNativeResponsesSse(withBackground),
      withBackground,
      "upstream_cursor_semantics",
    );
  });

  it("preserves a UTF-8 BOM as a stream-level prefix when frames are reordered", () => {
    const payload =
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":0,"output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"in_progress","content":[]}}\n\n' +
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":1,"output_index":1,"item":{"type":"message","id":"msg_b","role":"assistant","status":"in_progress","content":[]}}\n\n' +
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":2,"output_index":1,"item":{"type":"message","id":"msg_b","role":"assistant","status":"completed","content":[]}}\n\n' +
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":3,"output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"completed","content":[]}}\n\n';
    const bytes = encoder.encode(payload);
    const body = new Uint8Array(bytes.byteLength + 3);
    body.set([0xef, 0xbb, 0xbf], 0);
    body.set(bytes, 3);

    const result = normalizeNativeResponsesSse(body);

    expect(result.kind).toBe("normalized");
    if (result.kind !== "normalized") throw new Error("expected normalized result");
    expect(Array.from(result.body.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(text(result.body.slice(3)).indexOf('"id":"msg_b"')).toBeLessThan(
      text(result.body.slice(3)).indexOf('"id":"msg_a"'),
    );
  });

  it("renumbers only the sequence_number numeric token and preserves surrounding whitespace", () => {
    const raw =
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number": 40   ,"output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"in_progress","content":[]}}\n\n' +
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number": 41   ,"output_index":1,"item":{"type":"message","id":"msg_b","role":"assistant","status":"in_progress","content":[]}}\n\n' +
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number": 42   ,"output_index":1,"item":{"type":"message","id":"msg_b","role":"assistant","status":"completed","content":[]}}\n\n' +
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number": 43   ,"output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"completed","content":[]}}\n\n';
    const body = encoder.encode(raw);

    const result = normalizeNativeResponsesSse(body);

    expect(result.kind).toBe("normalized");
    if (result.kind !== "normalized") throw new Error("expected normalized result");
    const rendered = text(result.body);
    expect(rendered).toContain('"sequence_number": 0   ,"output_index":1');
    expect(rendered).toContain('"sequence_number": 1   ,"output_index":1');
    expect(rendered).toContain('"sequence_number": 2   ,"output_index":0');
    expect(rendered).toContain('"sequence_number": 3   ,"output_index":0');
  });

  it("skips an item with an ambiguous duplicate nested id", () => {
    const body = encoder.encode(
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":0,"output_index":0,"item":{"type":"message","id":"msg_a","id":"msg_b","role":"assistant","status":"in_progress","content":[]}}\n\n',
    );

    expectSkipped(
      normalizeNativeResponsesSse(body),
      body,
      "invalid_sse_structure",
    );
  });

  it("skips malformed SSE without rebuilding or partially normalizing it", () => {
    const typeMismatch = encoder.encode(
      'event: response.output_item.added\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"completed","content":[]},"sequence_number":0}\n\n',
    );
    expectSkipped(
      normalizeNativeResponsesSse(typeMismatch),
      typeMismatch,
      "invalid_sse_structure",
    );

    const invalidUtf8 = new Uint8Array([0xff, 0xfe, 0xfd]).slice();
    expectSkipped(
      normalizeNativeResponsesSse(invalidUtf8),
      invalidUtf8,
      "invalid_sse_structure",
    );

    const incompleteFrame = encoder.encode(
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"in_progress","content":[]},"sequence_number":0}\n',
    );
    expectSkipped(
      normalizeNativeResponsesSse(incompleteFrame),
      incompleteFrame,
      "invalid_sse_structure",
    );
  });

  it("skips a reordered stream with ambiguous or invalid top-level sequence_number", () => {
    const duplicate =
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":0,"sequence_number":1,"output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"in_progress","content":[]}}\n\n' +
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":2,"output_index":1,"item":{"type":"message","id":"msg_b","role":"assistant","status":"in_progress","content":[]}}\n\n' +
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":3,"output_index":1,"item":{"type":"message","id":"msg_b","role":"assistant","status":"completed","content":[]}}\n\n' +
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":4,"output_index":0,"item":{"type":"message","id":"msg_a","role":"assistant","status":"completed","content":[]}}\n\n';
    const duplicateBody = encoder.encode(duplicate);
    expectSkipped(
      normalizeNativeResponsesSse(duplicateBody),
      duplicateBody,
      "invalid_sequence_number",
    );

    const invalid = duplicate.replace(
      '"sequence_number":0,"sequence_number":1',
      '"sequence_number":-1',
    );
    const invalidBody = encoder.encode(invalid);
    expectSkipped(
      normalizeNativeResponsesSse(invalidBody),
      invalidBody,
      "invalid_sequence_number",
    );
  });
});
