import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Usage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  replayCommandCodeAssistantMessage,
  zeroUsage,
} from "../../src/providers/commandcode-private/semantic.js";

const usage: Usage = {
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 3,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function successMessage(): AssistantMessage {
  return {
    role: "assistant",
    api: "api",
    provider: "provider",
    model: "model",
    content: [
      { type: "text", text: "text" },
      { type: "thinking", thinking: "reason" },
      { type: "toolCall", id: "call", name: "tool", arguments: { value: 1 } },
    ],
    usage,
    stopReason: "toolUse",
    timestamp: 1,
  };
}

async function collect(
  message: AssistantMessage,
  signal?: AbortSignal,
): Promise<{ events: AssistantMessageEvent[]; result: AssistantMessage }> {
  const stream = createAssistantMessageEventStream();
  replayCommandCodeAssistantMessage(stream, message, signal);
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return { events, result: await stream.result() };
}

describe("CommandCode Pi replay", () => {
  it("emits complete ordered block lifecycles and one consistent done", async () => {
    const message = successMessage();
    const { events, result } = await collect(message);

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "toolcall_start",
      "toolcall_end",
      "done",
    ]);
    expect(
      events
        .filter((event) => "contentIndex" in event)
        .map((event) => event.contentIndex),
    ).toEqual([0, 0, 0, 1, 1, 1, 2, 2]);
    expect(events.some((event) => event.type === "toolcall_delta")).toBe(false);
    expect(events.at(-1)).toEqual({
      type: "done",
      reason: "toolUse",
      message,
    });
    expect(result).toBe(message);
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);
  });

  it("emits one error terminal and resolves the same failure", async () => {
    const failure: AssistantMessage = {
      ...successMessage(),
      content: [],
      usage: zeroUsage(),
      stopReason: "error",
      errorMessage: "failed",
    };
    const { events, result } = await collect(failure);
    expect(events).toEqual([{ type: "error", reason: "error", error: failure }]);
    expect(result).toBe(failure);
  });

  it("rechecks cancellation before start and emits only an aborted terminal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled before replay"));
    const { events, result } = await collect(successMessage(), controller.signal);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", reason: "aborted" });
    expect(result).toMatchObject({
      content: [],
      stopReason: "aborted",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
      },
    });
  });
});
