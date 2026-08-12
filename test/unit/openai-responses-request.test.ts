import { describe, expect, it } from "vitest";

import {
  convertResponsesRequest,
  validateResponsesRequest,
} from "../../src/protocols/openai-responses/request.js";

describe("OpenAI Responses request → Pi IR conversion", () => {
  it("converts a string input and instructions into a Pi Context", () => {
    const invocation = convertResponsesRequest(
      {
        model: "commandcode-private/deepseek/deepseek-v4-flash",
        instructions: "You are a helpful assistant",
        input: "hello",
        max_output_tokens: 100,
        stream: true,
      },
      1_786_400_000_000,
    );

    expect(invocation.selector).toBe("commandcode-private/deepseek/deepseek-v4-flash");
    expect(invocation.context.systemPrompt).toBe("You are a helpful assistant");
    expect(invocation.context.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
        timestamp: 1_786_400_000_000,
      },
    ]);
    expect(invocation.options.maxTokens).toBe(100);
    expect(invocation.renderState).toEqual({
      clientModel: "commandcode-private/deepseek/deepseek-v4-flash",
      stream: true,
    });
  });

  it("validates the request shape strictly", () => {
    expect(() => validateResponsesRequest({ input: "x" })).toThrow(
      "model must be a non-empty string",
    );
    expect(() =>
      validateResponsesRequest({ model: "m", input: "x", max_output_tokens: -1 }),
    ).toThrow("max_output_tokens must be a non-negative safe integer");
  });

  it("attaches reasoning items to the next assistant message", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          { type: "reasoning", summary: [{ type: "summary_text", text: "thinking hard" }] },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "answer" }],
          },
        ],
      },
      1,
    );

    const assistant = invocation.context.messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toEqual([
      { type: "thinking", thinking: "thinking hard" },
      { type: "text", text: "answer" },
    ]);
  });

  it("maps function_call and function_call_output into correlated tool turns", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          { type: "message", role: "user", content: "use a tool" },
          {
            type: "function_call",
            call_id: "call_1",
            name: "lookup",
            arguments: '{"key":"value"}',
          },
          {
            type: "function_call_output",
            call_id: "call_1",
            output: "the result",
          },
        ],
      },
      1,
    );

    expect(invocation.context.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
    const assistant = invocation.context.messages[1];
    expect(assistant?.content).toEqual([
      { type: "toolCall", id: "call_1", name: "lookup", arguments: { key: "value" } },
    ]);
    expect(invocation.context.messages[2]).toMatchObject({
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "lookup",
      content: [{ type: "text", text: "the result" }],
    });
  });

  it("tolerates non-JSON tool arguments as empty objects", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "function_call",
            call_id: "call_1",
            name: "noop",
            arguments: "",
          },
        ],
      },
      1,
    );
    const assistant = invocation.context.messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toEqual([
      { type: "toolCall", id: "call_1", name: "noop", arguments: {} },
    ]);
  });

  it("rejects an orphan function_call_output", () => {
    expect(() =>
      convertResponsesRequest(
        {
          model: "m",
          input: [
            {
              type: "function_call_output",
              call_id: "call_missing",
              output: "x",
            },
          ],
        },
        1,
      ),
    ).toThrow("references an unknown tool call id");
  });

  it("degrades compaction items to user text", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "compaction",
            encrypted_content: "abc123",
          },
          { type: "message", role: "user", content: "continue" },
        ],
      },
      1,
    );
    expect(invocation.context.messages.map((m) => m.role)).toEqual(["user", "user"]);
    expect(invocation.context.messages[0]?.content).toEqual([
      { type: "text", text: "[compacted conversation: 6 bytes of encrypted content]" },
    ]);
  });

  it("drops web_search_call and compaction_trigger items", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          { type: "web_search_call", id: "ws_1" },
          { type: "compaction_trigger" },
          { type: "message", role: "user", content: "keep me" },
        ],
      },
      1,
    );
    expect(invocation.context.messages).toHaveLength(1);
  });

  it("converts agent_message to a user message", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "agent_message",
            author: "subagent",
            content: "report from subagent",
          },
        ],
      },
      1,
    );
    expect(invocation.context.messages[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "report from subagent" }],
    });
  });

  it("merges additional_tools into the tool list", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "additional_tools",
            role: "developer",
            tools: [
              {
                type: "function",
                name: "extra",
                description: "extra tool",
                parameters: { type: "object", properties: {} },
              },
            ],
          },
        ],
        tools: [
          {
            type: "function",
            name: "base",
            description: "base tool",
            parameters: { type: "object", properties: {} },
            strict: true,
          },
        ],
      },
      1,
    );
    expect(invocation.context.tools?.map((t) => t.name)).toEqual(["base", "extra"]);
    expect(invocation.context.tools?.[0]?.constrainedSampling).toEqual({
      type: "json_schema",
      strict: "require",
    });
  });

  it("maps reasoning.effort with ultra degraded to max", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", reasoning: { effort: "ultra" } },
      1,
    );
    expect(invocation.options.reasoning).toBe("max");
  });

  it("rejects malformed previous_response_id, store, and tool_choice shapes", () => {
    expect(() =>
      validateResponsesRequest({ model: "m", input: "x", previous_response_id: 42 }),
    ).toThrow("previous_response_id must be a non-empty string");
    expect(() =>
      validateResponsesRequest({ model: "m", input: "x", store: "yes" }),
    ).toThrow("store must be a boolean");
    expect(() =>
      validateResponsesRequest({ model: "m", input: "x", tool_choice: 42 }),
    ).toThrow("tool_choice must be a string or object");
  });

  it("rejects an unknown reasoning.effort instead of dropping it", () => {
    expect(() =>
      validateResponsesRequest({
        model: "m",
        input: "x",
        reasoning: { effort: "super" },
      }),
    ).toThrow("reasoning.effort is not a known thinking level");
  });
});
