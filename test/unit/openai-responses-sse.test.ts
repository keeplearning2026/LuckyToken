import { describe, expect, it } from "vitest";

import type { ResponsesResponseObject } from "../../src/protocols/openai-responses/response.js";
import { renderResponsesSse } from "../../src/protocols/openai-responses/sse.js";

function responseObject(): ResponsesResponseObject {
  return {
    id: "resp_1",
    object: "response" as const,
    created_at: 1_786_400_000,
    status: "completed" as const,
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
    model: "commandcode-private/deepseek/deepseek-v4-flash",
    output: [
      {
        type: "message" as const,
        id: "msg_resp_1_0",
        role: "assistant" as const,
        status: "completed" as const,
        content: [
          { type: "output_text" as const, text: "hello", annotations: [] },
        ],
      },
    ],
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    usage: {
      input_tokens: 12,
      output_tokens: 5,
      total_tokens: 17,
      input_tokens_details: { cached_tokens: 2 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

describe("OpenAI Responses SSE rendering", () => {
  it("renders the canonical created → output_item.done → completed → [DONE] sequence", () => {
    const body = renderResponsesSse(responseObject());
    const text = new TextDecoder().decode(body.body);
    const frames = text.split("\n\n").filter((frame) => frame.length > 0);

    expect(frames[0]).toMatch(/^data: /);
    expect(frames).toHaveLength(4);
    const first = JSON.parse(frames[0]!.replace(/^data: /, ""));
    expect(first.type).toBe("response.created");
    expect(first.response.status).toBe("in_progress");
    expect(first.response.output).toEqual([]);

    const second = JSON.parse(frames[1]!.replace(/^data: /, ""));
    expect(second.type).toBe("response.output_item.done");
    expect(second.output_index).toBe(0);
    expect(second.item.type).toBe("message");

    const third = JSON.parse(frames[2]!.replace(/^data: /, ""));
    expect(third.type).toBe("response.completed");
    expect(third.response.status).toBe("completed");
    expect(third.response.output).toHaveLength(1);

    expect(frames[3]).toBe("data: [DONE]");
  });

  it("uses text/event-stream content type", () => {
    const body = renderResponsesSse(responseObject());
    expect(body.contentType).toBe("text/event-stream");
  });

  it("gives every schema event a monotonically increasing sequence_number", () => {
    const body = renderResponsesSse(responseObject());
    const frames = new TextDecoder()
      .decode(body.body)
      .split("\n\n")
      .filter((frame) => frame.length > 0);
    const sequences = frames
      .filter((frame) => frame.startsWith("data: ") && frame !== "data: [DONE]")
      .map((frame) => {
        const parsed = JSON.parse(frame.replace(/^data: /, "")) as {
          sequence_number: number;
        };
        return parsed.sequence_number;
      });
    expect(sequences.length).toBe(3); // created + output_item.done + terminal
    for (let index = 1; index < sequences.length; index += 1) {
      expect(sequences[index]!).toBeGreaterThan(sequences[index - 1]!);
    }
    expect(sequences[0]).toBe(0);
  });

  it("emits one ordered output_item.done per output item with matching output_index", () => {
    const body = renderResponsesSse({
      ...responseObject(),
      output: [
        responseObject().output[0]!,
        {
          type: "function_call" as const,
          id: "fc_1",
          call_id: "call_1",
          name: "lookup",
          arguments: "{}",
          status: "completed" as const,
        },
      ],
    });
    const frames = new TextDecoder()
      .decode(body.body)
      .split("\n\n")
      .filter((frame) => frame.length > 0);
    const done = frames
      .filter((frame) =>
        frame.startsWith('data: {"type":"response.output_item.done"'),
      )
      .map((frame) => JSON.parse(frame.replace(/^data: /, "")));
    expect(done).toHaveLength(2);
    expect(done[0]).toMatchObject({ output_index: 0, item: { type: "message" } });
    expect(done[1]).toMatchObject({
      output_index: 1,
      item: { type: "function_call" },
    });
  });

  it("emits the status-matching terminal: incomplete has details/error null", () => {
    const body = renderResponsesSse({
      ...responseObject(),
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    });
    const text = new TextDecoder().decode(body.body);
    const frames = text.split("\n\n").filter((frame) => frame.length > 0);
    expect(frames).toHaveLength(4);
    const terminal = JSON.parse(frames[2]!.replace(/^data: /, ""));
    expect(terminal.type).toBe("response.incomplete");
    expect(terminal.response.status).toBe("incomplete");
    expect(terminal.response.incomplete_details).toEqual({
      reason: "max_output_tokens",
    });
    expect(terminal.response.error).toBeNull();
    expect(text).not.toContain("response.completed");
  });

  it("emits the status-matching terminal: failed has a non-null error", () => {
    const body = renderResponsesSse({
      ...responseObject(),
      status: "failed",
      error: {
        message: "upstream broke",
        // The SDK Response error is exactly {code, message}; a failed
        // terminal carries the required enum code, never a null code.
        code: "server_error",
      },
    });
    const frames = new TextDecoder()
      .decode(body.body)
      .split("\n\n")
      .filter((frame) => frame.length > 0);
    expect(frames).toHaveLength(4);
    const terminal = JSON.parse(frames[2]!.replace(/^data: /, ""));
    expect(terminal.type).toBe("response.failed");
    expect(terminal.response.status).toBe("failed");
    expect(terminal.response.error).toEqual({
      message: "upstream broke",
      code: "server_error",
    });
    // The SDK ResponseError has exactly {code, message}; a failed terminal
    // never carries a type/param field or a null code.
    expect(Object.keys(terminal.response.error)).toEqual(["message", "code"]);
    expect(terminal.response.incomplete_details).toBeNull();
  });

  it("failed terminal error is passed through without shape corruption", () => {
    // The SSE renderer is a pass-through for the already-formed Response
    // error; the SDK-required {code,message} shape and enum code are
    // guaranteed by the Response converter (covered in the converter tests).
    // This test locks the pass-through: a failed terminal built by the
    // converter carries the enum code and exactly two keys on the wire.
    const body = renderResponsesSse({
      ...responseObject(),
      status: "failed",
      error: { code: "rate_limit_exceeded", message: "throttled" },
    });
    const frames = new TextDecoder()
      .decode(body.body)
      .split("\n\n")
      .filter((frame) => frame.length > 0);
    const terminal = JSON.parse(frames[2]!.replace(/^data: /, ""));
    expect(terminal.response.error).toEqual({
      code: "rate_limit_exceeded",
      message: "throttled",
    });
  });

  it("emits completed with error/incomplete_details null", () => {
    const frames = new TextDecoder()
      .decode(renderResponsesSse(responseObject()).body)
      .split("\n\n")
      .filter((frame) => frame.length > 0);
    const terminal = JSON.parse(frames[2]!.replace(/^data: /, ""));
    expect(terminal.response.error).toBeNull();
    expect(terminal.response.incomplete_details).toBeNull();
  });

  it("keeps [DONE] as the compatibility terminator after the semantic terminal", () => {
    const frames = new TextDecoder()
      .decode(renderResponsesSse(responseObject()).body)
      .split("\n\n")
      .filter((frame) => frame.length > 0);
    expect(frames.at(-1)).toBe("data: [DONE]");
  });

  it("terminates according to the status, never by re-deriving it from text", () => {
    // The terminal type is derived from the Response object's status field,
    // never by reparsing a string.
    const text = new TextDecoder().decode(renderResponsesSse(responseObject()).body);
    expect(text).toContain("response.completed");
    expect(text).not.toContain("response.incomplete");
    expect(text).not.toContain("response.failed");
  });
});
