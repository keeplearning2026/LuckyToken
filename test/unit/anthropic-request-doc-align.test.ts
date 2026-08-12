import { describe, expect, it } from "vitest";

import { parseAnthropicTextInvocation } from "../../src/protocols/anthropic/request.js";

function minimalBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    model: "model",
    max_tokens: 32,
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

describe("Anthropic request system conversion (doc §3)", () => {
  it("joins a TextBlock[] system with \\n in source order", () => {
    const invocation = parseAnthropicTextInvocation(
      minimalBody({
        system: [
          { type: "text", text: "part one" },
          { type: "text", text: "part two" },
        ],
      }),
      1,
    );
    expect(invocation.context.systemPrompt).toBe("part one\npart two");
  });

  it("converts an empty system array to an empty string", () => {
    const invocation = parseAnthropicTextInvocation(
      minimalBody({ system: [] }),
      1,
    );
    expect(invocation.context.systemPrompt).toBe("");
  });

  it("preserves a plain string system exactly", () => {
    const invocation = parseAnthropicTextInvocation(
      minimalBody({ system: "  keep me  " }),
      1,
    );
    expect(invocation.context.systemPrompt).toBe("  keep me  ");
  });

  it("keeps systemPrompt absent when request.system is absent", () => {
    const invocation = parseAnthropicTextInvocation(minimalBody(), 1);
    expect(invocation.context.systemPrompt).toBeUndefined();
  });
});

describe("Anthropic request output_config.effort conversion (doc §6.3)", () => {
  it.each(["low", "medium", "high", "xhigh", "max"] as const)(
    "maps effort %s to options.reasoning",
    (effort) => {
      const invocation = parseAnthropicTextInvocation(
        minimalBody({ output_config: { effort } }),
        1,
      );
      expect(invocation.options.reasoning).toBe(effort);
    },
  );

  it("omits reasoning when output_config or effort is absent", () => {
    const invocation = parseAnthropicTextInvocation(minimalBody(), 1);
    expect(invocation.options.reasoning).toBeUndefined();
    const withConfig = parseAnthropicTextInvocation(
      minimalBody({ output_config: {} }),
      1,
    );
    expect(withConfig.options.reasoning).toBeUndefined();
  });

  it("falls back to Pi reasoning default for an unknown effort", () => {
    const invocation = parseAnthropicTextInvocation(
      minimalBody({ output_config: { effort: "super" } }),
      1,
    );
    expect(invocation.options.reasoning).toBeUndefined();
  });
});

describe("Anthropic request max_tokens conversion (doc §6.1)", () => {
  it("preserves max_tokens=0 as maxTokens=0", () => {
    const invocation = parseAnthropicTextInvocation(
      minimalBody({ max_tokens: 0 }),
      1,
    );
    expect(invocation.options.maxTokens).toBe(0);
  });
});

describe("Anthropic request tool_result content conversion (doc §4.2)", () => {
  const toolTurn = (content: unknown): Record<string, unknown> =>
    minimalBody({
      messages: [
        { role: "user", content: "use a tool" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tool_1", name: "lookup", input: {} },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1", ...(content === undefined ? {} : { content }) }] },
      ],
    });

  it("converts absent tool_result content to an empty content array", () => {
    const invocation = parseAnthropicTextInvocation(toolTurn(undefined), 1);
    const result = invocation.context.messages.find((m) => m.role === "toolResult");
    expect(result).toBeDefined();
    expect(result?.content).toEqual([]);
    expect(result).toMatchObject({
      toolCallId: "tool_1",
      toolName: "lookup",
      isError: false,
    });
  });

  it("converts a string tool_result content to a single TextContent", () => {
    const invocation = parseAnthropicTextInvocation(toolTurn("the result"), 1);
    const result = invocation.context.messages.find((m) => m.role === "toolResult");
    expect(result?.content).toEqual([{ type: "text", text: "the result" }]);
  });

  it("converts a text/image block array tool_result content in source order", () => {
    const invocation = parseAnthropicTextInvocation(
      toolTurn([
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ]),
      1,
    );
    const result = invocation.context.messages.find((m) => m.role === "toolResult");
    expect(result?.content).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
  });

  it("preserves is_error as error state", () => {
    const invocation = parseAnthropicTextInvocation(
      minimalBody({
        messages: [
          { role: "user", content: "use a tool" },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "tool_1", name: "lookup", input: {} },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool_1",
                content: "failed",
                is_error: true,
              },
            ],
          },
        ],
      }),
      1,
    );
    const result = invocation.context.messages.find((m) => m.role === "toolResult");
    expect(result).toBeDefined();
    expect(result?.isError).toBe(true);
  });

  it("splits one source user message into toolResult and user Pi messages in source order", () => {
    const invocation = parseAnthropicTextInvocation(
      minimalBody({
        messages: [
          { role: "user", content: "use a tool" },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "tool_1", name: "lookup", input: {} },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "tool_1", content: "ok" },
              { type: "text", text: "after" },
            ],
          },
        ],
      }),
      1,
    );
    const roles = invocation.context.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "toolResult", "user"]);
    const users = invocation.context.messages.filter((m) => m.role === "user");
    expect(users.at(-1)?.content).toEqual([{ type: "text", text: "after" }]);
  });
});
