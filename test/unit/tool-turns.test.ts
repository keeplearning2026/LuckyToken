import { describe, expect, it } from "vitest";

import { InvalidRequest } from "../../src/protocols/anthropic/failures.js";
import {
  convertValidatedAnthropicRequest,
  validateAnthropicSourceRequest,
} from "../../src/protocols/anthropic/request.js";

function request(messages: unknown[]): Record<string, unknown> {
  return { model: "client-model", max_tokens: 32, messages };
}

const parallelCalls = {
  role: "assistant",
  content: [
    { type: "tool_use", id: "call_a", name: "alpha", input: { value: 1 } },
    { type: "tool_use", id: "call_b", name: "beta", input: { value: 2 } },
  ],
};

describe("Anthropic tool turns", () => {
  it("accepts the direct caller projection on replay and discards no tool semantic", () => {
    const conversion = convertValidatedAnthropicRequest(
      validateAnthropicSourceRequest(
        request([
          { role: "user", content: "run" },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "call",
                name: "lookup",
                input: { q: "x" },
                caller: { type: "direct" },
              },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "call" }],
          },
        ]),
      ),
      1,
    );

    expect(conversion.context.messages[1]).toMatchObject({
      role: "assistant",
      content: [
        { type: "toolCall", id: "call", name: "lookup", arguments: { q: "x" } },
      ],
    });
  });

  it("ignores optional caller forms per doc §4.3", () => {
    const withCaller = (caller: unknown) =>
      request([
        { role: "user", content: "run" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call", name: "lookup", input: {}, caller },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call" }],
        },
      ]);

    for (const caller of [
      undefined,
      {},
      { type: "direct" },
      { type: "server_tool", tool_name: "lookup" },
    ]) {
      const conversion = convertValidatedAnthropicRequest(
        validateAnthropicSourceRequest(withCaller(caller)),
        1,
      );
      expect(conversion.context.messages[1]).toMatchObject({
        role: "assistant",
        content: [
          { type: "toolCall", id: "call", name: "lookup", arguments: {} },
        ],
      });
    }
  });

  it("correlates parallel results by ID and expands results before ordinary user content", () => {
    const receivedAt = 1234;
    const conversion = convertValidatedAnthropicRequest(
      validateAnthropicSourceRequest(
        request([
          { role: "user", content: "run" },
          parallelCalls,
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call_b",
                content: [{ type: "text", text: "B" }],
                is_error: true,
              },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "call_a" },
              { type: "text", text: "continue" },
            ],
          },
        ]),
      ),
      receivedAt,
    );

    expect(conversion.context.messages).toMatchObject([
      { role: "user" },
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "toolCall", id: "call_a", name: "alpha", arguments: { value: 1 } },
          { type: "toolCall", id: "call_b", name: "beta", arguments: { value: 2 } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_b",
        toolName: "beta",
        content: [{ type: "text", text: "B" }],
        isError: true,
        timestamp: receivedAt,
      },
      {
        role: "toolResult",
        toolCallId: "call_a",
        toolName: "alpha",
        content: [],
        isError: false,
        timestamp: receivedAt,
      },
      {
        role: "user",
        content: [{ type: "text", text: "continue" }],
        timestamp: receivedAt,
      },
    ]);
  });

  it("converts string and explicit-empty-array ToolResult content per the conversion method", () => {
    for (const content of ["", " ", "text"]) {
      const conversion = convertValidatedAnthropicRequest(
        validateAnthropicSourceRequest(
          request([
            { role: "user", content: "run" },
            parallelCalls,
            {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "call_a", content },
                { type: "tool_result", tool_use_id: "call_b" },
              ],
            },
          ]),
        ),
        1,
      );
      const resultA = conversion.context.messages.find(
        (m) => m.role === "toolResult" && m.toolCallId === "call_a",
      );
      expect(resultA?.content).toEqual([{ type: "text", text: content }]);
    }

    const emptyArray = convertValidatedAnthropicRequest(
      validateAnthropicSourceRequest(
        request([
          { role: "user", content: "run" },
          parallelCalls,
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "call_a", content: [] },
              { type: "tool_result", tool_use_id: "call_b" },
            ],
          },
        ]),
      ),
      1,
    );
    const resultA = emptyArray.context.messages.find(
      (m) => m.role === "toolResult" && m.toolCallId === "call_a",
    );
    expect(resultA?.content).toEqual([]);
  });

  it("accepts grouped parallel results and maps explicit false deterministically", () => {
    const conversion = convertValidatedAnthropicRequest(
      validateAnthropicSourceRequest(
        request([
          { role: "user", content: "run" },
          parallelCalls,
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call_a",
                content: [{ type: "text", text: "A" }],
                is_error: false,
              },
              { type: "tool_result", tool_use_id: "call_b" },
            ],
          },
        ]),
      ),
      1,
    );

    expect(conversion.context.messages.slice(-2)).toMatchObject([
      { role: "toolResult", toolCallId: "call_a", isError: false },
      { role: "toolResult", toolCallId: "call_b", isError: false },
    ]);
  });

  it.each([
    {
      name: "duplicate calls",
      messages: [
        { role: "user", content: "run" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "same", name: "a", input: {} },
            { type: "tool_use", id: "same", name: "b", input: {} },
          ],
        },
      ],
    },
    {
      name: "orphan result",
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "missing" }],
        },
      ],
    },
    {
      name: "duplicate result",
      messages: [
        { role: "user", content: "run" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call", name: "a", input: {} }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call" },
            { type: "tool_result", tool_use_id: "call" },
          ],
        },
      ],
    },
    {
      name: "unresolved call",
      messages: [
        { role: "user", content: "run" },
        parallelCalls,
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_a" }],
        },
      ],
    },
    {
      name: "ordinary content before required results",
      messages: [
        { role: "user", content: "run" },
        parallelCalls,
        {
          role: "user",
          content: [
            { type: "text", text: "too early" },
            { type: "tool_result", tool_use_id: "call_a" },
            { type: "tool_result", tool_use_id: "call_b" },
          ],
        },
      ],
    },
  ])("rejects $name as source-invalid", ({ messages }) => {
    expect(() => validateAnthropicSourceRequest(request(messages))).toThrow(
      InvalidRequest,
    );
  });
});
