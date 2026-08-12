import { describe, expect, it } from "vitest";

import type { ResponsesResponseObject } from "../../src/protocols/openai-responses/response.js";
import { renderResponsesSse } from "../../src/protocols/openai-responses/sse.js";

function responseObject(): ResponsesResponseObject {
  return {
    id: "resp_1",
    object: "response" as const,
    created_at: 1_786_400_000,
    status: "completed" as const,
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
});
