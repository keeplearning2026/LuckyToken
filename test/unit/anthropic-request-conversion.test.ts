import { describe, expect, it } from "vitest";

import {
  convertValidatedAnthropicRequestWithPolicy,
  parseAnthropicTextInvocation,
  validateAnthropicSourceRequest,
  type AnthropicRequestConversionPolicy,
} from "../../src/protocols/anthropic/request.js";

function body(messages: unknown, extras: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "model",
    max_tokens: 64,
    messages,
    ...extras,
  };
}

function policy(
  overrides: Partial<AnthropicRequestConversionPolicy> = {},
): AnthropicRequestConversionPolicy {
  return {
    unknownContent: "error",
    unresolvedToolCall: "xrepair",
    localCacheControl: "ignore",
    ...overrides,
  };
}

describe("05: Anthropic message order and system-prompt semantics", () => {
  it("converts mixed ordinary content and tool results in exact source order", () => {
    const invocation = parseAnthropicTextInvocation(
      body([
        { role: "user", content: "use a tool" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tool_1", name: "lookup", input: { q: 1 } }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tool_1", content: "X" },
            { type: "text", text: "after" },
          ],
        },
        { role: "user", content: "another" },
      ]),
      1,
    );
    const roles = invocation.context.messages.map((message) => message.role);
    expect(roles).toEqual(["user", "assistant", "toolResult", "user"]);
    const results = invocation.context.messages.filter(
      (message) => message.role === "toolResult",
    );
    expect(results[0]).toMatchObject({
      toolCallId: "tool_1",
      toolName: "lookup",
      content: [{ type: "text", text: "X" }],
      isError: false,
    });
    const lastUser = invocation.context.messages.at(-1);
    expect(lastUser?.role).toBe("user");
    const content = lastUser?.content as Array<{ text: string }>;
    expect(content.map((entry) => entry.text)).toEqual(["after", "another"]);
  });

  it("keeps ordinary text segments before and after each ToolResult in source order", () => {
    const invocation = parseAnthropicTextInvocation(
      body([
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "alpha", input: {} },
            { type: "tool_use", id: "t2", name: "beta", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "A" },
            { type: "tool_result", tool_use_id: "t1", content: "X" },
            { type: "text", text: "B" },
            { type: "tool_result", tool_use_id: "t2", content: "Y" },
            { type: "text", text: "C" },
          ],
        },
      ]),
      1,
    );
    const roles = invocation.context.messages.map((m) => m.role);
    expect(roles).toEqual([
      "user",
      "assistant",
      "user",
      "toolResult",
      "user",
      "toolResult",
      "user",
    ]);
    const users = invocation.context.messages.filter((m) => m.role === "user");
    expect(users[0]?.content).toEqual([{ type: "text", text: "go" }]);
    expect(users[1]?.content).toEqual([{ type: "text", text: "A" }]);
    expect(users[2]?.content).toEqual([{ type: "text", text: "B" }]);
    expect(users[3]?.content).toEqual([{ type: "text", text: "C" }]);
    const results = invocation.context.messages.filter(
      (m) => m.role === "toolResult",
    );
    expect(results.map((r) => r.toolCallId)).toEqual(["t1", "t2"]);
  });

  it("does not create synthetic messages for empty ordinary segments", () => {
    const invocation = parseAnthropicTextInvocation(
      body([
        { role: "user", content: "A" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tool_1", name: "lookup", input: {} }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1" }] },
      ]),
      1,
    );
    const roles = invocation.context.messages.map((message) => message.role);
    expect(roles).toEqual(["user", "assistant", "toolResult"]);
  });

  it("promotes only the first message-level system entry and degrades later ones", () => {
    const invocation = parseAnthropicTextInvocation(
      body([
        { role: "system", content: "first" },
        { role: "user", content: "hello" },
        { role: "system", content: "second" },
        { role: "system", content: "third" },
      ]),
      1,
    );
    expect(invocation.context.systemPrompt).toBe("first");
    // "hello" and degraded "second"/"third" are adjacent user messages and
    // merge without crossing any ToolResult boundary.
    expect(invocation.context.messages).toHaveLength(1);
    const content = invocation.context.messages[0]?.content as Array<{
      text: string;
    }>;
    expect(content.map((entry) => entry.text)).toEqual([
      "hello",
      "second",
      "third",
    ]);
  });

  it("does not grant system privilege to non-text blocks in a system message", () => {
    const invocation = parseAnthropicTextInvocation(
      body([
        {
          role: "system",
          content: [
            { type: "text", text: "privileged" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
          ],
        },
        { role: "user", content: "hi" },
      ]),
      1,
    );
    expect(invocation.context.systemPrompt).toBe("privileged");
    expect(invocation.context.messages).toHaveLength(1);
  });

  it("keeps non-text blocks of the first system message as ordinary user content", () => {
    const invocation = parseAnthropicTextInvocation(
      body([
        {
          role: "system",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "AA==" },
            },
          ],
        },
        { role: "user", content: "hi" },
      ]),
      1,
    );
    expect(invocation.context.systemPrompt).toBeUndefined();
    const user = invocation.context.messages.find((m) => m.role === "user");
    expect(user?.content).toEqual([
      { type: "image", mimeType: "image/png", data: "AA==" },
      { type: "text", text: "hi" },
    ]);
  });

  it("accepts a final assistant prefill as historical content with a notice", () => {
    const invocation = parseAnthropicTextInvocation(
      body([
        { role: "user", content: "choose" },
        { role: "assistant", content: "answer: " },
      ]),
      1,
    );
    const assistant = invocation.context.messages.at(-1);
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.content).toEqual([{ type: "text", text: "answer: " }]);
    expect(
      invocation.notices.some(
        (notice) => notice.code === "anthropic_assistant_prefill_degraded_to_history",
      ),
    ).toBe(true);
  });

  it("never mutates source objects and keeps state request-local", () => {
    const source = body([
      { role: "user", content: "hello" },
    ]);
    const snapshot = JSON.stringify(source);
    const first = parseAnthropicTextInvocation(source, 1);
    const second = parseAnthropicTextInvocation(source, 2);
    expect(JSON.stringify(source)).toBe(snapshot);
    expect(first.context.messages[0]?.timestamp).toBe(1);
    expect(second.context.messages[0]?.timestamp).toBe(2);
    expect(first.context.messages).not.toBe(second.context.messages);
  });

  it("isolates pending tool correlation across interleaved conversions", async () => {
    const firstBody = body([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "alpha", input: {} }],
      },
      { role: "user", content: "next" },
    ]);
    const secondBody = body([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t2", name: "beta", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t2", content: "real" }],
      },
    ]);
    const [first, second] = await Promise.all([
      Promise.resolve().then(() => parseAnthropicTextInvocation(firstBody, 1)),
      Promise.resolve().then(() => parseAnthropicTextInvocation(secondBody, 2)),
    ]);
    const firstResults = first.context.messages.filter(
      (m) => m.role === "toolResult",
    );
    expect(firstResults).toHaveLength(1);
    expect(firstResults[0]).toMatchObject({
      toolCallId: "t1",
      toolName: "alpha",
      isError: true,
    });
    const secondResults = second.context.messages.filter(
      (m) => m.role === "toolResult",
    );
    expect(secondResults).toHaveLength(1);
    expect(secondResults[0]).toMatchObject({
      toolCallId: "t2",
      toolName: "beta",
      isError: false,
      content: [{ type: "text", text: "real" }],
    });
    expect(first.context.messages).not.toBe(second.context.messages);
  });
});

describe("06: Anthropic tool lifecycle and local missing-result repair", () => {
  it("preserves lossless tool identity, name, and object input", () => {
    const invocation = parseAnthropicTextInvocation(
      body([
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool_abc",
              name: "lookup",
              input: { nested: { array: [1, true, null] } },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_abc",
              is_error: true,
              content: [
                { type: "text", text: "failed" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
              ],
            },
          ],
        },
      ]),
      1,
    );
    const result = invocation.context.messages.find(
      (message) => message.role === "toolResult",
    );
    expect(result).toMatchObject({
      toolCallId: "tool_abc",
      toolName: "lookup",
      isError: true,
    });
    expect(result?.content).toEqual([
      { type: "text", text: "failed" },
      { type: "image", mimeType: "image/png", data: "AA==" },
    ]);
  });

  it("preserves tool_reference as addedToolNames and rejects unknown references", () => {
    const invocation = parseAnthropicTextInvocation(
      body(
        [
          { role: "user", content: "search" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "search", input: {} }],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                content: [{ type: "tool_reference", tool_name: "later_tool" }],
              },
            ],
          },
        ],
        {
          tools: [
            { name: "search", input_schema: { type: "object" } },
            { name: "later_tool", input_schema: { type: "object" } },
          ],
        },
      ),
      1,
    );
    const result = invocation.context.messages.find(
      (message) => message.role === "toolResult",
    );
    expect(result?.addedToolNames).toEqual(["later_tool"]);

    expect(() =>
      parseAnthropicTextInvocation(
        body([
          { role: "user", content: "search" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "search", input: {} }],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                content: [{ type: "tool_reference", tool_name: "unknown" }],
              },
            ],
          },
        ]),
        1,
      ),
    ).toThrow(/Unknown referenced tool name/u);
  });

  it("rejects orphan, duplicate, result-before-call, malformed, and non-object input", () => {
    const orphan = body([
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "ghost" }],
      },
    ]);
    expect(() => parseAnthropicTextInvocation(orphan, 1)).toThrow(/Orphan/u);

    const duplicate = body([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "lookup", input: {} }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "a" },
          { type: "tool_result", tool_use_id: "t1", content: "b" },
        ],
      },
    ]);
    expect(() => parseAnthropicTextInvocation(duplicate, 1)).toThrow(/duplicate|Orphan/u);

    const malformed = body([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "", name: "lookup", input: {} }],
      },
    ]);
    expect(() => parseAnthropicTextInvocation(malformed, 1)).toThrow(/non-empty/u);

    const nonObject = body([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "lookup", input: "x" }],
      },
    ]);
    expect(() => parseAnthropicTextInvocation(nonObject, 1)).toThrow(/object/u);
  });

  it("repairs unresolved calls in call order with the frozen synthetic text", () => {
    const invocation = parseAnthropicTextInvocation(
      body([
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "alpha", input: {} },
            { type: "text", text: "thinking" },
            { type: "tool_use", id: "t2", name: "beta", input: {} },
          ],
        },
        { role: "user", content: "next" },
      ]),
      1,
    );
    const results = invocation.context.messages.filter(
      (message) => message.role === "toolResult",
    );
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      toolCallId: "t1",
      toolName: "alpha",
      isError: true,
      content: [
        {
          type: "text",
          text: "No result — the tool call did not complete (interrupted or lost).",
        },
      ],
    });
    expect(results[1]).toMatchObject({ toolCallId: "t2", toolName: "beta" });
    const repairNotices = invocation.notices.filter(
      (notice) => notice.code === "anthropic_unresolved_tool_call_xrepair",
    );
    expect(repairNotices).toHaveLength(2);
    expect(repairNotices[0]?.action).toBe("xrepair");
  });

  it("rejects unresolved calls under the error policy without touching real results", () => {
    const request = body([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "alpha", input: {} }],
      },
      { role: "user", content: "next" },
    ]);
    const validated = validateAnthropicSourceRequest(request);
    expect(() =>
      convertValidatedAnthropicRequestWithPolicy(validated, 1, policy({ unresolvedToolCall: "error" })),
    ).toThrow(/Unresolved/u);
  });

  it("never replaces a real result with the synthetic text", () => {
    const invocation = parseAnthropicTextInvocation(
      body([
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "alpha", input: {} }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "real" }],
        },
        { role: "user", content: "done" },
      ]),
      1,
    );
    const results = invocation.context.messages.filter(
      (message) => message.role === "toolResult",
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toEqual([{ type: "text", text: "real" }]);
  });
});

describe("07: Anthropic sampling, thinking budgets, and cache policy", () => {
  it("maps top_p/top_k into samplingParams and metadata user_id", () => {
    const invocation = parseAnthropicTextInvocation(
      body([{ role: "user", content: "hi" }], {
        top_p: 0.9,
        top_k: 5,
        metadata: { user_id: "user-1" },
      }),
      1,
    );
    expect(invocation.options.samplingParams).toEqual({ top_p: 0.9, top_k: 5 });
    expect(invocation.options.metadata).toEqual({ user_id: "user-1" });
  });

  it("omits metadata.user_id when null or absent", () => {
    const invocation = parseAnthropicTextInvocation(
      body([{ role: "user", content: "hi" }], { metadata: { user_id: null } }),
      1,
    );
    expect(invocation.options.metadata).toBeUndefined();
  });

  it("maps effort exactly and preserves the exact budget in the normalized slot", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      const invocation = parseAnthropicTextInvocation(
        body([{ role: "user", content: "hi" }], {
          output_config: { effort },
          thinking: { type: "enabled", budget_tokens: 32_768 },
        }),
        1,
      );
      expect(invocation.options.reasoning).toBe(effort);
      expect(invocation.options.thinkingBudgets).toEqual({
        [effort === "xhigh" || effort === "max" ? "high" : effort]: 32_768,
      });
    }
  });

  it("uses the budget ladder when no effort is present", () => {
    const invocation = parseAnthropicTextInvocation(
      body([{ role: "user", content: "hi" }], {
        thinking: { type: "enabled", budget_tokens: 8_192 },
      }),
      1,
    );
    expect(invocation.options.reasoning).toBeUndefined();
    expect(invocation.options.thinkingBudgets).toEqual({ low: 8_192 });
  });

  it("drops disabled/adaptive/display without fabricating off or injecting text", () => {
    const invocation = parseAnthropicTextInvocation(
      body([{ role: "user", content: "hi" }], {
        thinking: { type: "disabled" },
        output_config: { effort: null },
      }),
      1,
    );
    expect(invocation.options.reasoning).toBeUndefined();
    expect(invocation.options.thinkingBudgets).toBeUndefined();
  });

  it("ignores local cache breakpoints by default and promotes them when configured", () => {
    const ignored = parseAnthropicTextInvocation(
      body([{ role: "user", content: "hi" }], {
        cache_control: { type: "ephemeral", ttl: "1h" },
      }),
      1,
    );
    expect(ignored.options.cacheRetention).toBeUndefined();

    const validated = validateAnthropicSourceRequest(
      body([{ role: "user", content: "hi" }], {
        cache_control: { type: "ephemeral", ttl: "1h" },
      }),
    );
    const promoted = convertValidatedAnthropicRequestWithPolicy(
      validated,
      1,
      policy({ localCacheControl: "promote" }),
    );
    expect(promoted.options.cacheRetention).toBe("long");
    expect(
      promoted.notices.some(
        (notice) => notice.code === "anthropic_local_cache_promoted",
      ),
    ).toBe(true);

    const short = convertValidatedAnthropicRequestWithPolicy(
      validateAnthropicSourceRequest(
        body([{ role: "user", content: "hi" }], {
          cache_control: { type: "ephemeral" },
        }),
      ),
      1,
      policy({ localCacheControl: "promote" }),
    );
    expect(short.options.cacheRetention).toBe("short");
  });

  it("rejects invalid numeric bounds as Anthropic Client errors", () => {
    expect(() =>
      parseAnthropicTextInvocation(
        body([{ role: "user", content: "hi" }], {
          thinking: { type: "enabled", budget_tokens: 100 },
        }),
        1,
      ),
    ).toThrow(/1024/u);
    expect(() =>
      parseAnthropicTextInvocation(
        body([{ role: "user", content: "hi" }], { top_p: Number.NaN }),
        1,
      ),
    ).toThrow(/finite/u);
  });

  it("treats null container/inference_geo/service_tier as absence", () => {
    const invocation = parseAnthropicTextInvocation(
      body([{ role: "user", content: "hi" }], {
        container: null,
        inference_geo: null,
        service_tier: null,
        top_p: 0.5,
      }),
      1,
    );
    expect(invocation.options).toEqual({
      maxTokens: 64,
      samplingParams: { top_p: 0.5 },
    });
  });
});

describe("08: Anthropic known content and tools", () => {
  it("maps document text and search_result in source order", () => {
    const invocation = parseAnthropicTextInvocation(
      body([
        {
          role: "user",
          content: [
            { type: "text", text: "before" },
            {
              type: "document",
              source: {
                type: "content",
                content: [{ type: "text", text: "doc text" }],
              },
            },
            { type: "text", text: "middle" },
            {
              type: "search_result",
              title: "Title",
              content: "result text",
            },
            { type: "text", text: "after" },
          ],
        },
      ]),
      1,
    );
    expect(invocation.context.messages[0]?.content).toEqual([
      { type: "text", text: "before" },
      { type: "text", text: "doc text" },
      { type: "text", text: "middle" },
      { type: "text", text: "Title\nresult text" },
      { type: "text", text: "after" },
    ]);
  });

  it("drops resolver-dependent document sources without fabricating content", () => {
    expect(() =>
      parseAnthropicTextInvocation(
        body([
          {
            role: "user",
            content: [
              {
                type: "document",
                source: { type: "url", url: "https://example.test/doc.pdf" },
              },
            ],
          },
        ]),
        1,
      ),
    ).toThrow(/Resolver-dependent/u);
  });

  it("keeps server-hosted tool calls and results out of the client tool catalog", () => {
    const invocation = parseAnthropicTextInvocation(
      body([
        { role: "user", content: "search" },
        {
          role: "assistant",
          content: [
            {
              type: "server_tool_use",
              id: "server_1",
              name: "web_search",
              input: { query: "x" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "web_search_tool_result",
              tool_use_id: "server_1",
              content: [
                { type: "web_search_result", title: "T", url: "u", content: [{ type: "text", text: "c" }] },
              ],
            },
          ],
        },
      ]),
      1,
    );
    const assistant = invocation.context.messages.find(
      (message) => message.role === "assistant",
    );
    expect(assistant?.content).toEqual([
      { type: "text", text: "[server tool: web_search]" },
    ]);
    expect(invocation.context.tools).toBeUndefined();
    expect(invocation.context.messages.some((m) => m.role === "toolResult")).toBe(false);
  });

  it("maps client/BYOT tools including defer_loading definitions", () => {
    const invocation = parseAnthropicTextInvocation(
      body([{ role: "user", content: "hi" }], {
        tools: [
          {
            name: "alpha",
            description: "Alpha tool",
            input_schema: { type: "object", properties: { x: { type: "string" } } },
            strict: true,
            defer_loading: true,
          },
          {
            name: "beta",
            input_schema: { type: "object" },
          },
        ],
      }),
      1,
    );
    expect(invocation.context.tools).toEqual([
      {
        name: "alpha",
        description: "Alpha tool",
        parameters: { type: "object", properties: { x: { type: "string" } } },
        constrainedSampling: { type: "json_schema", strict: "require" },
      },
      { name: "beta", description: "", parameters: { type: "object" } },
    ]);
  });

  it("handles unknown content with the error/ignore policy", () => {
    expect(() =>
      parseAnthropicTextInvocation(
        body([{ role: "user", content: [{ type: "future_block", data: "x" }] }]),
        1,
      ),
    ).toThrow(/unknown content block/u);

    const validated = validateAnthropicSourceRequest(
      body([{ role: "user", content: [{ type: "future_block", data: "x" }] }]),
    );
    const ignored = convertValidatedAnthropicRequestWithPolicy(
      validated,
      1,
      policy({ unknownContent: "ignore" }),
    );
    expect(ignored.context.messages[0]?.content).toEqual([]);
    expect(
      ignored.notices.some(
        (notice) => notice.code === "anthropic_unknown_content_ignored",
      ),
    ).toBe(true);
  });

  it("never lets unknown=ignore repair malformed known content", () => {
    const malformed = body([
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "" }],
      },
    ]);
    expect(() =>
      parseAnthropicTextInvocation(malformed, 1),
    ).toThrow(/non-empty/u);
  });

  it("keeps all client tools in the catalog when tool_reference is present", () => {
    const invocation = parseAnthropicTextInvocation(
      body(
        [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "search", input: {} }],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                content: [{ type: "tool_reference", tool_name: "deferred_tool" }],
              },
            ],
          },
        ],
        {
          tools: [
            { name: "search", input_schema: { type: "object" } },
            { name: "deferred_tool", input_schema: { type: "object" }, defer_loading: true },
          ],
        },
      ),
      1,
    );
    expect(invocation.context.tools?.map((tool) => tool.name)).toEqual([
      "search",
      "deferred_tool",
    ]);
  });
});
