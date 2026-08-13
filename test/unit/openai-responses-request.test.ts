import { describe, expect, it } from "vitest";

import {
  convertResponsesRequest,
  convertResponsesRequestAsync,
  validateResponsesRequest,
  type ResponseRequestConversionPolicy,
} from "../../src/protocols/openai-responses/request.js";

function policy(
  overrides: Partial<ResponseRequestConversionPolicy> = {},
): ResponseRequestConversionPolicy {
  return {
    privilegedMessages: "first",
    unknownInputItem: "error",
    orphanToolOutput: "error",
    unresolvedToolCall: "xrepair",
    futureReasoningEffort: "max",
    ...overrides,
  };
}

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
    ).toThrow("max_output_tokens must be a positive safe integer");
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

  it("correlates outputs for multiple function_calls appended to one assistant turn", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          { type: "message", role: "user", content: "use two tools" },
          {
            type: "function_call",
            call_id: "call_1",
            name: "lookup",
            arguments: "{}",
          },
          {
            type: "function_call",
            call_id: "call_2",
            name: "search",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: "call_1",
            output: "first result",
          },
          {
            type: "function_call_output",
            call_id: "call_2",
            output: "second result",
          },
        ],
      },
      1,
    );

    const roles = invocation.context.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "toolResult", "toolResult"]);
    const results = invocation.context.messages.filter(
      (m) => m.role === "toolResult",
    );
    expect(results.map((m) => m.toolCallId)).toEqual(["call_1", "call_2"]);
    expect(results.map((m) => m.toolName)).toEqual(["lookup", "search"]);
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

  it("errors on an orphan function_call_output by default (frozen policy)", () => {
    // Frozen orphanToolOutput default is error: an output referencing an
    // unknown call_id is a lifecycle violation, not an ignorable drop.
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
            { type: "message", role: "user", content: "continue" },
          ],
        },
        1,
        policy(),
      ),
    ).toThrow(/references an unknown call_id/);
    // ignore emits a request-local notice and keeps the turn.
    const ignored = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "function_call_output",
            call_id: "call_missing",
            output: "x",
          },
          { type: "message", role: "user", content: "continue" },
        ],
      },
      1,
      policy({ orphanToolOutput: "ignore" }),
    );
    expect(ignored.context.messages).toHaveLength(1);
    expect(
      ignored.notices.some(
        (n) => n.code === "openai-responses_orphan_tool_output_ignored",
      ),
    ).toBe(true);
  });

  it("errors on foreign encrypted compaction instead of fabricating text", () => {
    // Frozen: compaction with foreign encrypted-only content is an error; the
    // adapter never fabricates byte-length text.
    expect(() =>
      convertResponsesRequest(
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
        policy(),
      ),
    ).toThrow(/compaction with foreign encrypted content/);
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

  it("maps a future reasoning.effort to max by default with a notice", () => {
    // Frozen futureReasoningEffort default is max: an unknown future effort
    // degrades to max with a request-local notice, not a hard error.
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", reasoning: { effort: "super" } },
      1,
      policy(),
    );
    expect(invocation.options.reasoning).toBe("max");
    expect(
      invocation.notices.some((n) => n.code === "openai-responses_future_effort"),
    ).toBe(true);
  });

  it("skips OpenAI-hosted tools and normalizes Codex tool shapes", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: "x",
        tools: [
          { type: "web_search", name: "web_search" },
          { type: "function", name: "shell_command", parameters: "not-an-object" },
          { type: "custom", name: "apply_patch" },
          {
            type: "namespace",
            name: "mcp",
            tools: [
              {
                type: "function",
                name: "inner_tool",
                description: "inner",
                parameters: { type: "object", properties: {} },
              },
            ],
          },
        ],
      },
      1,
    );
    expect(invocation.context.tools?.map((t) => t.name)).toEqual([
      "shell_command",
      "apply_patch",
      "mcp.inner_tool",
    ]);
    const shell = invocation.context.tools?.[0];
    expect(shell?.parameters).toMatchObject({ type: "object" });
    const applyPatch = invocation.context.tools?.[1];
    expect(applyPatch?.parameters).toMatchObject({
      type: "object",
      properties: { input: { type: "string" } },
    });
  });

  it("preserves strict on function tools", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: "x",
        tools: [
          {
            type: "function",
            name: "strict_tool",
            parameters: { type: "object", properties: {} },
            strict: true,
          },
        ],
      },
      1,
    );
    expect(invocation.context.tools?.[0]?.constrainedSampling).toEqual({
      type: "json_schema",
      strict: "require",
    });
  });
});

describe("13: Responses privileged prompts, options, and handles", () => {
  it("keeps top-level instructions as the leading Pi systemPrompt segment", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        instructions: "You are helpful",
        input: [
          { type: "message", role: "developer", content: "code rules" },
          { type: "message", role: "user", content: "hi" },
        ],
      },
      1,
      policy(),
    );
    expect(invocation.context.systemPrompt).toBe("You are helpful\ncode rules");
    expect(invocation.context.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("full mode promotes every system/developer message into systemPrompt in order", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        instructions: "top",
        input: [
          { type: "message", role: "system", content: "s1" },
          { type: "message", role: "developer", content: "d1" },
          { type: "message", role: "user", content: "u1" },
          { type: "message", role: "developer", content: "d2" },
          { type: "message", role: "user", content: "u2" },
        ],
      },
      1,
      policy({ privilegedMessages: "full" }),
    );
    expect(invocation.context.systemPrompt).toBe("top\ns1\nd1\nd2");
    expect(invocation.context.messages.map((m) => m.role)).toEqual(["user", "user"]);
    expect(
      invocation.context.messages.map(
        (m) => (m.content as Array<{ text: string }>)[0]?.text,
      ),
    ).toEqual(["u1", "u2"]);
  });

  it("first mode (default) promotes only privileged messages before the first user", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          { type: "message", role: "system", content: "s1" },
          { type: "message", role: "developer", content: "d1" },
          { type: "message", role: "user", content: "u1" },
          { type: "message", role: "developer", content: "later-rules" },
          { type: "message", role: "user", content: "u2" },
        ],
      },
      1,
      policy({ privilegedMessages: "first" }),
    );
    expect(invocation.context.systemPrompt).toBe("s1\nd1");
    const roles = invocation.context.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "user", "user"]);
    expect(
      invocation.context.messages.map(
        (m) => (m.content as Array<{ text: string }>)[0]?.text,
      ),
    ).toEqual(["u1", "later-rules", "u2"]);
  });

  it("user mode promotes no input system/developer messages", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        instructions: "top",
        input: [
          { type: "message", role: "system", content: "s1" },
          { type: "message", role: "developer", content: "d1" },
          { type: "message", role: "user", content: "u1" },
        ],
      },
      1,
      policy({ privilegedMessages: "user" }),
    );
    expect(invocation.context.systemPrompt).toBe("top");
    expect(invocation.context.messages.map((m) => m.role)).toEqual([
      "user",
      "user",
      "user",
    ]);
    expect(
      invocation.context.messages.map(
        (m) => (m.content as Array<{ text: string }>)[0]?.text,
      ),
    ).toEqual(["s1", "d1", "u1"]);
  });

  it("joins promoted prompt segments with exactly one newline and skips empty segments", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          { type: "message", role: "developer", content: "first" },
          { type: "message", role: "developer", content: "" },
          { type: "message", role: "system", content: "second" },
          { type: "message", role: "user", content: "u" },
        ],
      },
      1,
      policy({ privilegedMessages: "full" }),
    );
    expect(invocation.context.systemPrompt).toBe("first\nsecond");
  });

  it("later privileged messages degraded to user keep source order and are never lost", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          { type: "message", role: "user", content: "u1" },
          { type: "message", role: "system", content: "late-system" },
          { type: "message", role: "developer", content: "late-dev" },
          { type: "message", role: "user", content: "u2" },
        ],
      },
      1,
      policy({ privilegedMessages: "first" }),
    );
    expect(invocation.context.systemPrompt).toBeUndefined();
    const roles = invocation.context.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "user", "user", "user"]);
    expect(
      invocation.context.messages.map(
        (m) => (m.content as Array<{ text: string }>)[0]?.text,
      ),
    ).toEqual(["u1", "late-system", "late-dev", "u2"]);
  });

  it("maps max_output_tokens, temperature, and top_p into Pi options", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: "x",
        max_output_tokens: 512,
        temperature: 0.4,
        top_p: 0.9,
      },
      1,
      policy(),
    );
    expect(invocation.options.maxTokens).toBe(512);
    expect(invocation.options.temperature).toBe(0.4);
    expect(invocation.options.samplingParams).toEqual({ top_p: 0.9 });
  });

  it("maps prompt_cache_retention to Pi cacheRetention", () => {
    const shortInvocation = convertResponsesRequest(
      { model: "m", input: "x", prompt_cache_retention: "in-memory" },
      1,
      policy(),
    );
    expect(shortInvocation.options.cacheRetention).toBe("short");
    const longInvocation = convertResponsesRequest(
      { model: "m", input: "x", prompt_cache_retention: "24h" },
      1,
      policy(),
    );
    expect(longInvocation.options.cacheRetention).toBe("long");
    const none = convertResponsesRequest(
      { model: "m", input: "x", prompt_cache_retention: null },
      1,
      policy(),
    );
    expect(none.options.cacheRetention).toBeUndefined();
  });

  it("maps safety_identifier with a user fallback into Pi metadata", () => {
    const fromSafety = convertResponsesRequest(
      { model: "m", input: "x", safety_identifier: "sid-1" },
      1,
      policy(),
    );
    expect(fromSafety.options.metadata).toEqual({ user_id: "sid-1" });
    const fromUser = convertResponsesRequest(
      { model: "m", input: "x", user: "uid-2" },
      1,
      policy(),
    );
    expect(fromUser.options.metadata).toEqual({ user_id: "uid-2" });
    const safetyWins = convertResponsesRequest(
      { model: "m", input: "x", safety_identifier: "sid-3", user: "uid-4" },
      1,
      policy(),
    );
    expect(safetyWins.options.metadata).toEqual({ user_id: "sid-3" });
  });

  it("echoes stream into render state and drops unsupported auxiliary top-level fields", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: "x",
        stream: true,
        service_tier: "premium",
        prompt_cache_key: "cache-key",
        parallel_tool_calls: false,
        truncation: "auto",
        context_management: { type: "auto" },
        text: { format: { type: "text" }, verbosity: "low" },
        include: ["reasoning.summary"],
        unknown_top_level: "ignored",
      },
      1,
      policy(),
    );
    expect(invocation.renderState.stream).toBe(true);
    expect(invocation.options.samplingParams).toBeUndefined();
    expect(invocation.options.cacheRetention).toBeUndefined();
    expect(invocation.context.tools).toBeUndefined();
    // Unknown auxiliary fields must not appear in the options snapshot.
    expect(invocation.options).not.toHaveProperty("service_tier");
  });

  it("maps reasoning effort minimal through xhigh directly", () => {
    for (const effort of ["minimal", "low", "medium", "high", "xhigh"]) {
      const invocation = convertResponsesRequest(
        { model: "m", input: "x", reasoning: { effort } },
        1,
        policy(),
      );
      expect(invocation.options.reasoning).toBe(effort);
    }
  });

  it("maps none to omission (documented degradation) and absent/null without notices", () => {
    const none = convertResponsesRequest(
      { model: "m", input: "x", reasoning: { effort: "none" } },
      1,
      policy(),
    );
    expect(none.options.reasoning).toBeUndefined();
    // none is a documented explicit-off degradation: a notice is emitted.
    expect(
      none.notices.some(
        (n) => n.code === "openai-responses_effort_none_omitted",
      ),
    ).toBe(true);
    const absent = convertResponsesRequest(
      { model: "m", input: "x" },
      1,
      policy(),
    );
    expect(absent.options.reasoning).toBeUndefined();
    expect(absent.notices).toEqual([]);
  });

  it("maps ultra and max to Pi max", () => {
    const ultra = convertResponsesRequest(
      { model: "m", input: "x", reasoning: { effort: "ultra" } },
      1,
      policy(),
    );
    expect(ultra.options.reasoning).toBe("max");
    expect(
      ultra.notices.some((n) => n.code === "openai-responses_effort_ultra_alias"),
    ).toBe(true);
    const max = convertResponsesRequest(
      { model: "m", input: "x", reasoning: { effort: "max" } },
      1,
      policy(),
    );
    expect(max.options.reasoning).toBe("max");
    expect(max.notices).toEqual([]);
  });

  it("applies futureReasoningEffort=max to a future effort value with a notice", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", reasoning: { effort: "future-level" } },
      1,
      policy({ futureReasoningEffort: "max" }),
    );
    expect(invocation.options.reasoning).toBe("max");
    expect(
      invocation.notices.some((n) => n.code === "openai-responses_future_effort"),
    ).toBe(true);
  });

  it("applies futureReasoningEffort=omit with a notice", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", reasoning: { effort: "future-level" } },
      1,
      policy({ futureReasoningEffort: "omit" }),
    );
    expect(invocation.options.reasoning).toBeUndefined();
    expect(
      invocation.notices.some((n) => n.code === "openai-responses_future_effort"),
    ).toBe(true);
  });

  it("rejects a future effort value under futureReasoningEffort=error", () => {
    expect(() =>
      convertResponsesRequest(
        { model: "m", input: "x", reasoning: { effort: "future-level" } },
        1,
        policy({ futureReasoningEffort: "error" }),
      ),
    ).toThrow(/reasoning\.effort is not a known thinking level/);
  });

  it("filters the executable catalog for tool_choice none/auto/allowed", () => {
    const tools = [
      { type: "function", name: "a", parameters: { type: "object" } },
      { type: "function", name: "b", parameters: { type: "object" } },
    ];
    const none = convertResponsesRequest(
      { model: "m", input: "x", tools, tool_choice: "none" },
      1,
      policy(),
    );
    expect(none.context.tools).toBeUndefined();
    const auto = convertResponsesRequest(
      { model: "m", input: "x", tools, tool_choice: "auto" },
      1,
      policy(),
    );
    expect(auto.context.tools?.map((t) => t.name)).toEqual(["a", "b"]);
    const allowed = convertResponsesRequest(
      {
        model: "m",
        input: "x",
        tools,
        tool_choice: { type: "allowed", allowed_tools: ["b"] },
      },
      1,
      policy(),
    );
    expect(allowed.context.tools?.map((t) => t.name)).toEqual(["b"]);
  });

  it("drops unsupported forced tool_choice controls", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: "x",
        tools: [{ type: "function", name: "a", parameters: { type: "object" } }],
        tool_choice: { type: "function", name: "a" },
      },
      1,
      policy(),
    );
    expect(invocation.context.tools?.map((t) => t.name)).toEqual(["a"]);
    expect(invocation.renderState.toolChoice).toBeUndefined();
  });

  it("errors on a forced tool_choice requiring a tool absent from the catalog", () => {
    expect(() =>
      convertResponsesRequest(
        {
          model: "m",
          input: "x",
          tools: [{ type: "function", name: "a", parameters: { type: "object" } }],
          tool_choice: { type: "function", name: "missing-tool" },
        },
        1,
        policy(),
      ),
    ).toThrow(/tool_choice requires/);
  });

  it("rejects background=true as a Core conversion error", () => {
    expect(() =>
      convertResponsesRequest(
        { model: "m", input: "x", background: true },
        1,
        policy(),
      ),
    ).toThrow(/background/);
    const sync = convertResponsesRequest(
      { model: "m", input: "x", background: false },
      1,
      policy(),
    );
    expect(sync.renderState.stream).toBe(false);
  });

  it("rejects conversation, prompt, external item_reference, and foreign encrypted compaction", () => {
    expect(() =>
      convertResponsesRequest(
        { model: "m", input: "x", conversation: "conv_1" },
        1,
        policy(),
      ),
    ).toThrow(/conversation/);
    expect(() =>
      convertResponsesRequest({ model: "m", input: "x", prompt: "prompt_1" }, 1, policy()),
    ).toThrow(/prompt/);
    expect(() =>
      convertResponsesRequest(
        {
          model: "m",
          input: [{ type: "item_reference", id: "ext_1" }],
        },
        1,
        policy(),
      ),
    ).toThrow(/item_reference/);
    expect(() =>
      convertResponsesRequest(
        {
          model: "m",
          input: [{ type: "compaction", encrypted_content: "foreign-bytes" }],
        },
        1,
        policy(),
      ),
    ).toThrow(/compaction/);
  });

  it("resolves a Lucky-owned provable item_reference through the resolver capability", async () => {
    const invocation = await convertResponsesRequestAsync(
      {
        model: "m",
        input: [
          {
            type: "item_reference",
            id: "item_owned_1",
            envelope: { authority: "luckytoken", version: 1 },
          },
        ],
      },
      1,
      policy(),
      {
        resolveItemReference: async (reference, context) => {
          expect(reference.id).toBe("item_owned_1");
          expect(context.authority).toBe("luckytoken");
          return [{ type: "message", role: "user", content: "materialized" }];
        },
      },
    );
    expect(invocation.context.messages[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "materialized" }],
    });
  });

  it("reports an unresolvable Lucky-owned reference as a notice", async () => {
    const invocation = await convertResponsesRequestAsync(
      {
        model: "m",
        input: [
          {
            type: "item_reference",
            id: "item_owned_2",
            envelope: { authority: "luckytoken", version: 1 },
          },
        ],
      },
      1,
      policy(),
      {
        resolveItemReference: async () => {
          throw new Error("resolver failed");
        },
      },
    );
    expect(
      invocation.notices.some(
        (n) => n.code === "openai-responses_reference_unresolved",
      ),
    ).toBe(true);
  });

  it("forwards the caller abort signal to the resolver", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    await convertResponsesRequestAsync(
      {
        model: "m",
        input: [
          {
            type: "item_reference",
            id: "item_owned_3",
            envelope: { authority: "luckytoken", version: 1 },
          },
        ],
      },
      1,
      policy(),
      {
        resolveItemReference: async (_reference, context) => {
          receivedSignal = context.signal;
          return [];
        },
      },
      controller.signal,
    );
    expect(receivedSignal).toBe(controller.signal);
  });

  it("rejects an envelope with an empty authority without calling the resolver", async () => {
    // A Lucky-owned envelope must carry a non-empty authority; an empty
    // authority is not verified, never reaches the resolver, and the core
    // errors on the reference (no fail-open).
    let resolverCalls = 0;
    await expect(
      convertResponsesRequestAsync(
        {
          model: "m",
          input: [
            {
              type: "item_reference",
              id: "item_empty",
              envelope: { authority: "", version: 1 },
            },
          ],
        },
        1,
        policy(),
        {
          resolveItemReference: async () => {
            resolverCalls += 1;
            return [];
          },
        },
      ),
    ).rejects.toThrow(/item_reference/);
    expect(resolverCalls).toBe(0);
  });

  it("rejects a non-object envelope without calling the resolver", async () => {
    let resolverCalls = 0;
    await expect(
      convertResponsesRequestAsync(
        {
          model: "m",
          input: [
            {
              type: "compaction",
              id: "comp_1",
              encrypted_content: "bytes",
              envelope: "not-an-object",
            },
          ],
        },
        1,
        policy(),
        {
          resolveItemReference: async () => {
            resolverCalls += 1;
            return [];
          },
        },
      ),
    ).rejects.toThrow();
    expect(resolverCalls).toBe(0);
  });

  it("passes the envelope authority into the resolver context", async () => {
    let receivedAuthority: string | undefined;
    await convertResponsesRequestAsync(
      {
        model: "m",
        input: [
          {
            type: "item_reference",
            id: "item_owned_4",
            envelope: { authority: "responses-capability", version: 1 },
          },
        ],
      },
      1,
      policy(),
      {
        resolveItemReference: async (_reference, context) => {
          receivedAuthority = context.authority;
          return [];
        },
      },
    );
    expect(receivedAuthority).toBe("responses-capability");
  });

  it("errors on an external item_reference without a Lucky-owned envelope", async () => {
    expect(() =>
      convertResponsesRequest(
        { model: "m", input: [{ type: "item_reference", id: "ext_1" }] },
        1,
        policy(),
      ),
    ).toThrow(/item_reference cannot be resolved/);
  });

  it("retains source metadata only for request-local response echo", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: "x",
        metadata: { thread: "t-1", numeric: 42, nested: { a: 1 } },
      },
      1,
      policy(),
    );
    // Only safely-echoable string values are retained; nothing enters Pi
    // model context.
    expect(invocation.renderState.metadataEcho).toEqual({ thread: "t-1" });
    expect(invocation.options.metadata).toBeUndefined();
    expect(invocation.context).not.toHaveProperty("metadata");
  });

  it("applies unknownInputItem=error by default and ignore with a notice", () => {
    expect(() =>
      convertResponsesRequest(
        { model: "m", input: [{ type: "future_item", data: 1 }] },
        1,
        policy({ unknownInputItem: "error" }),
      ),
    ).toThrow(/Unsupported input item type/);
    const ignored = convertResponsesRequest(
      {
        model: "m",
        input: [
          { type: "future_item", data: 1 },
          { type: "message", role: "user", content: "keep" },
        ],
      },
      1,
      policy({ unknownInputItem: "ignore" }),
    );
    expect(ignored.context.messages).toHaveLength(1);
    expect(
      ignored.notices.some(
        (n) => n.code === "openai-responses_unknown_input_item_ignored",
      ),
    ).toBe(true);
  });
});

describe("13 recheck: resolved references keep privileged promotion", () => {
  it("promotes system/developer items returned by the resolver in full mode", async () => {
    const invocation = await convertResponsesRequestAsync(
      {
        model: "m",
        input: [
          {
            type: "item_reference",
            id: "ref_sys",
            envelope: { authority: "luckytoken", version: 1 },
          },
          { type: "message", role: "user", content: "hi" },
        ],
      },
      1,
      policy({ privilegedMessages: "full" }),
      {
        resolveItemReference: async () => [
          { type: "message", role: "system", content: "resolved rules" },
        ],
      },
    );
    expect(invocation.context.systemPrompt).toContain("resolved rules");
    expect(invocation.context.messages.map((m) => m.role)).toEqual(["user"]);
  });
});

describe("13 recheck: effort none is a documented degradation", () => {
  it("emits a notice for reasoning.effort=none (explicit off degradation)", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", reasoning: { effort: "none" } },
      1,
      policy(),
    );
    expect(invocation.options.reasoning).toBeUndefined();
    expect(
      invocation.notices.some(
        (n) => n.code === "openai-responses_effort_none_omitted",
      ),
    ).toBe(true);
  });

  it("emits no notice for absent or null reasoning", () => {
    const absent = convertResponsesRequest(
      { model: "m", input: "x" },
      1,
      policy(),
    );
    expect(absent.notices).toEqual([]);
    const nulled = convertResponsesRequest(
      { model: "m", input: "x", reasoning: null },
      1,
      policy(),
    );
    expect(nulled.notices).toEqual([]);
    const effortNull = convertResponsesRequest(
      { model: "m", input: "x", reasoning: { effort: null } },
      1,
      policy(),
    );
    expect(effortNull.notices).toEqual([]);
  });
});

describe("13 recheck: resolver receives explicit limits", () => {
  it("passes size/MIME/redirect limits into the resolver context", async () => {
    let receivedLimits: unknown;
    await convertResponsesRequestAsync(
      {
        model: "m",
        input: [
          {
            type: "item_reference",
            id: "item_owned_5",
            envelope: { authority: "luckytoken", version: 1 },
          },
        ],
      },
      1,
      policy(),
      {
        resolveItemReference: async (_reference, context) => {
          receivedLimits = context.limits;
          return [];
        },
      },
    );
    expect(receivedLimits).toMatchObject({
      maxBytes: expect.any(Number),
    });
  });
});

describe("13 recheck: forced tool_choice drop is documented", () => {
  it("emits a notice when an unsupported forced tool_choice is dropped", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: "x",
        tools: [{ type: "function", name: "a", parameters: { type: "object" } }],
        tool_choice: { type: "function", name: "a" },
      },
      1,
      policy(),
    );
    expect(invocation.context.tools?.map((t) => t.name)).toEqual(["a"]);
    expect(
      invocation.notices.some(
        (n) => n.code === "openai-responses_forced_tool_choice_dropped",
      ),
    ).toBe(true);
  });

  it("emits no notice for tool_choice none/auto/allowed", () => {
    const none = convertResponsesRequest(
      {
        model: "m",
        input: "x",
        tools: [{ type: "function", name: "a", parameters: { type: "object" } }],
        tool_choice: "none",
      },
      1,
      policy(),
    );
    expect(none.notices).toEqual([]);
    const auto = convertResponsesRequest(
      {
        model: "m",
        input: "x",
        tools: [{ type: "function", name: "a", parameters: { type: "object" } }],
        tool_choice: "auto",
      },
      1,
      policy(),
    );
    expect(auto.notices).toEqual([]);
    const allowed = convertResponsesRequest(
      {
        model: "m",
        input: "x",
        tools: [{ type: "function", name: "a", parameters: { type: "object" } }],
        tool_choice: { type: "allowed", allowed_tools: ["a"] },
      },
      1,
      policy(),
    );
    expect(allowed.notices).toEqual([]);
  });
});

describe("13 recheck: malformed effort is rejected, not degraded", () => {
  it("rejects an empty-string reasoning.effort as invalid", () => {
    expect(() =>
      convertResponsesRequest(
        { model: "m", input: "x", reasoning: { effort: "" } },
        1,
        policy(),
      ),
    ).toThrow(/reasoning\.effort/);
  });

  it("rejects a whitespace-only reasoning.effort as invalid", () => {
    expect(() =>
      convertResponsesRequest(
        { model: "m", input: "x", reasoning: { effort: "   " } },
        1,
        policy(),
      ),
    ).toThrow(/reasoning\.effort/);
  });
});

describe("13 recheck: malformed allowed_tools is rejected", () => {
  it("rejects a non-array allowed_tools instead of silently clearing the catalog", () => {
    expect(() =>
      convertResponsesRequest(
        {
          model: "m",
          input: "x",
          tools: [{ type: "function", name: "a", parameters: { type: "object" } }],
          tool_choice: { type: "allowed", allowed_tools: "not-an-array" },
        },
        1,
        policy(),
      ),
    ).toThrow(/allowed_tools/);
  });

  it("rejects an allowed_tools array with a non-string entry", () => {
    expect(() =>
      convertResponsesRequest(
        {
          model: "m",
          input: "x",
          tools: [{ type: "function", name: "a", parameters: { type: "object" } }],
          tool_choice: { type: "allowed", allowed_tools: ["a", 42] },
        },
        1,
        policy(),
      ),
    ).toThrow(/allowed_tools/);
  });
});

describe("13 recheck: temperature range is validated", () => {
  it("accepts temperature within the valid range", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", temperature: 1.5 },
      1,
      policy(),
    );
    expect(invocation.options.temperature).toBe(1.5);
  });

  it("rejects temperature below 0", () => {
    expect(() =>
      convertResponsesRequest(
        { model: "m", input: "x", temperature: -0.5 },
        1,
        policy(),
      ),
    ).toThrow(/temperature/);
  });

  it("rejects temperature above 2", () => {
    expect(() =>
      convertResponsesRequest(
        { model: "m", input: "x", temperature: 2.5 },
        1,
        policy(),
      ),
    ).toThrow(/temperature/);
  });

  it("validates top_p within 0..1", () => {
    expect(() =>
      convertResponsesRequest(
        { model: "m", input: "x", top_p: 1.5 },
        1,
        policy(),
      ),
    ).toThrow(/top_p/);
    const valid = convertResponsesRequest(
      { model: "m", input: "x", top_p: 0.5 },
      1,
      policy(),
    );
    expect(valid.options.samplingParams).toEqual({ top_p: 0.5 });
  });
});

describe("13 recheck: prototype pollution resistance", () => {
  it("does not let metadata __proto__/constructor keys pollute the echo object", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: "x",
        metadata: {
          __proto__: { polluted: true },
          constructor: "ctor-value",
          normal: "safe",
        },
      },
      1,
      policy(),
    );
    const echo = invocation.renderState.metadataEcho ?? {};
    expect(Object.keys(echo).sort()).toEqual(["constructor", "normal"]);
    // The echo object is null-prototype: hostile keys cannot pollute it.
    expect(Object.getPrototypeOf(echo)).toBeNull();
    expect((echo as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("13 recheck: prototype pollution via JSON.parse input", () => {
  it("does not pollute when metadata arrives from JSON.parse with __proto__ as own key", () => {
    const raw = '{"model":"m","input":"x","metadata":{"__proto__":{"polluted":true},"constructor":"ctor-value","normal":"safe"}}';
    const value = JSON.parse(raw) as Record<string, unknown>;
    const invocation = convertResponsesRequest(value, 1, policy());
    const echo = invocation.renderState.metadataEcho ?? {};
    const keys = Object.keys(echo).sort();
    // __proto__ as an own key must not be echoed as an own property, and the
    // echo object is null-prototype so hostile keys cannot pollute it.
    expect(keys).toEqual(["constructor", "normal"]);
    expect(Object.getPrototypeOf(echo)).toBeNull();
    expect((echo as Record<string, unknown>).polluted).toBeUndefined();
    // The source object must not have been mutated either.
    expect((value as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("13 recheck: resolver failure branches", () => {
  it("resolves a failing reference to a notice while keeping later items", async () => {
    const invocation = await convertResponsesRequestAsync(
      {
        model: "m",
        input: [
          {
            type: "item_reference",
            id: "ref_fail",
            envelope: { authority: "luckytoken", version: 1 },
          },
          { type: "message", role: "user", content: "keep me" },
        ],
      },
      1,
      policy(),
      {
        resolveItemReference: async () => {
          throw new Error("boom");
        },
      },
    );
    expect(
      invocation.notices.some(
        (n) => n.code === "openai-responses_reference_unresolved",
      ),
    ).toBe(true);
    expect(invocation.context.messages).toHaveLength(1);
    expect(invocation.context.messages[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "keep me" }],
    });
  });

  it("passes custom limits through to the resolver context", async () => {
    let receivedLimits: unknown;
    await convertResponsesRequestAsync(
      {
        model: "m",
        input: [
          {
            type: "item_reference",
            id: "ref_limits",
            envelope: { authority: "luckytoken", version: 1 },
          },
        ],
      },
      1,
      policy(),
      {
        resolveItemReference: async (_ref, context) => {
          receivedLimits = context.limits;
          return [];
        },
      },
      undefined,
      { maxBytes: 1234, maxRedirects: 2 },
    );
    expect(receivedLimits).toMatchObject({ maxBytes: 1234, maxRedirects: 2 });
  });

  it("forwards the abort signal even when custom limits are given", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    await convertResponsesRequestAsync(
      {
        model: "m",
        input: [
          {
            type: "item_reference",
            id: "ref_sig",
            envelope: { authority: "luckytoken", version: 1 },
          },
        ],
      },
      1,
      policy(),
      {
        resolveItemReference: async (_ref, context) => {
          receivedSignal = context.signal;
          return [];
        },
      },
      controller.signal,
      { maxBytes: 99 },
    );
    expect(receivedSignal).toBe(controller.signal);
  });
});

describe("13 recheck: privileged mode extreme combinations", () => {
  it("promotes all system/developer when there is no user message (first mode)", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          { type: "message", role: "system", content: "s1" },
          { type: "message", role: "developer", content: "d1" },
          { type: "message", role: "system", content: "s2" },
        ],
      },
      1,
      policy({ privilegedMessages: "first" }),
    );
    expect(invocation.context.systemPrompt).toBe("s1\nd1\ns2");
    expect(invocation.context.messages).toHaveLength(0);
  });

  it("joins consecutive system messages with single newlines (no blank lines)", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          { type: "message", role: "system", content: "a" },
          { type: "message", role: "system", content: "b" },
          { type: "message", role: "system", content: "c" },
          { type: "message", role: "user", content: "u" },
        ],
      },
      1,
      policy({ privilegedMessages: "full" }),
    );
    expect(invocation.context.systemPrompt).toBe("a\nb\nc");
    expect(invocation.context.systemPrompt).not.toContain("\n\n");
  });

  it("preserves exact segment text including internal newlines", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          { type: "message", role: "developer", content: "line1\nline2\n\nline4" },
          { type: "message", role: "user", content: "u" },
        ],
      },
      1,
      policy({ privilegedMessages: "first" }),
    );
    // Exact segment text is not rewritten; segments join with one newline.
    expect(invocation.context.systemPrompt).toBe("line1\nline2\n\nline4");
  });

  it("degrades every system/developer to user in user mode even without user messages", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          { type: "message", role: "system", content: "s1" },
          { type: "message", role: "developer", content: "d1" },
        ],
      },
      1,
      policy({ privilegedMessages: "user" }),
    );
    expect(invocation.context.systemPrompt).toBeUndefined();
    expect(invocation.context.messages.map((m) => m.role)).toEqual(["user", "user"]);
    expect(
      invocation.context.messages.map(
        (m) => (m.content as Array<{ text: string }>)[0]?.text,
      ),
    ).toEqual(["s1", "d1"]);
  });
});

describe("13 recheck: effort full matrix", () => {
  it("maps every known effort value exactly", () => {
    const cases: Array<[string, string | undefined]> = [
      ["none", undefined],
      ["minimal", "minimal"],
      ["low", "low"],
      ["medium", "medium"],
      ["high", "high"],
      ["xhigh", "xhigh"],
      ["max", "max"],
      ["ultra", "max"],
    ];
    for (const [effort, expected] of cases) {
      const invocation = convertResponsesRequest(
        { model: "m", input: "x", reasoning: { effort } },
        1,
        policy(),
      );
      expect(invocation.options.reasoning).toBe(expected);
    }
  });

  it("maps future effort per every futureReasoningEffort policy", () => {
    const max = convertResponsesRequest(
      { model: "m", input: "x", reasoning: { effort: "future-level" } },
      1,
      policy({ futureReasoningEffort: "max" }),
    );
    expect(max.options.reasoning).toBe("max");
    expect(
      max.notices.some((n) => n.code === "openai-responses_future_effort"),
    ).toBe(true);

    const omit = convertResponsesRequest(
      { model: "m", input: "x", reasoning: { effort: "future-level" } },
      1,
      policy({ futureReasoningEffort: "omit" }),
    );
    expect(omit.options.reasoning).toBeUndefined();
    expect(
      omit.notices.some((n) => n.code === "openai-responses_future_effort"),
    ).toBe(true);

    expect(() =>
      convertResponsesRequest(
        { model: "m", input: "x", reasoning: { effort: "future-level" } },
        1,
        policy({ futureReasoningEffort: "error" }),
      ),
    ).toThrow(/reasoning\.effort/);
  });
});

describe("13 recheck: tool_choice full combination matrix", () => {
  const tools = [
    { type: "function", name: "a", parameters: { type: "object" } },
    { type: "function", name: "b", parameters: { type: "object" } },
    { type: "custom", name: "apply_patch" },
  ];

  it("none clears the catalog regardless of tools", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", tools, tool_choice: "none" },
      1,
      policy(),
    );
    expect(invocation.context.tools).toBeUndefined();
    expect(invocation.renderState.toolChoice).toBe("none");
    expect(invocation.notices).toEqual([]);
  });

  it("auto keeps the full catalog", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", tools, tool_choice: "auto" },
      1,
      policy(),
    );
    expect(invocation.context.tools?.map((t) => t.name)).toEqual([
      "a",
      "b",
      "apply_patch",
    ]);
    expect(invocation.renderState.toolChoice).toBeUndefined();
  });

  it("absence/null keeps the full catalog with no effective choice", () => {
    const absent = convertResponsesRequest(
      { model: "m", input: "x", tools },
      1,
      policy(),
    );
    expect(absent.context.tools?.map((t) => t.name)).toEqual([
      "a",
      "b",
      "apply_patch",
    ]);
    expect(absent.renderState.toolChoice).toBeUndefined();
    const nulled = convertResponsesRequest(
      { model: "m", input: "x", tools, tool_choice: null },
      1,
      policy(),
    );
    expect(nulled.context.tools?.map((t) => t.name)).toEqual([
      "a",
      "b",
      "apply_patch",
    ]);
  });

  it("allowed filters deterministically and records the effective choice", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", tools, tool_choice: { type: "allowed", allowed_tools: ["a", "b"] } },
      1,
      policy(),
    );
    expect(invocation.context.tools?.map((t) => t.name)).toEqual(["a", "b"]);
    expect(invocation.renderState.toolChoice).toBe("allowed");
  });

  it("allowed with an unknown name filters it out", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", tools, tool_choice: { type: "allowed", allowed_tools: ["a", "zzz"] } },
      1,
      policy(),
    );
    expect(invocation.context.tools?.map((t) => t.name)).toEqual(["a"]);
  });

  it("allowed with an empty list clears the catalog but records allowed", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", tools, tool_choice: { type: "allowed", allowed_tools: [] } },
      1,
      policy(),
    );
    expect(invocation.context.tools).toBeUndefined();
    expect(invocation.renderState.toolChoice).toBe("allowed");
  });

  it("forced with an available tool drops the control with a notice", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", tools, tool_choice: { type: "function", name: "a" } },
      1,
      policy(),
    );
    expect(invocation.context.tools?.map((t) => t.name)).toEqual([
      "a",
      "b",
      "apply_patch",
    ]);
    expect(invocation.renderState.toolChoice).toBeUndefined();
    expect(
      invocation.notices.some(
        (n) => n.code === "openai-responses_forced_tool_choice_dropped",
      ),
    ).toBe(true);
  });

  it("forced with an unavailable tool errors", () => {
    expect(() =>
      convertResponsesRequest(
        { model: "m", input: "x", tools, tool_choice: { type: "function", name: "zzz" } },
        1,
        policy(),
      ),
    ).toThrow(/tool_choice requires an unavailable tool/);
  });

  it("required string behaves like a dropped forced control", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", tools, tool_choice: "required" },
      1,
      policy(),
    );
    expect(invocation.context.tools?.map((t) => t.name)).toEqual([
      "a",
      "b",
      "apply_patch",
    ]);
    expect(invocation.renderState.toolChoice).toBeUndefined();
    expect(invocation.notices).toEqual([]);
  });
});

describe("13 recheck: resolver returns malformed items", () => {
  it("skips non-object resolver results without crashing", async () => {
    const invocation = await convertResponsesRequestAsync(
      {
        model: "m",
        input: [
          {
            type: "item_reference",
            id: "ref_malformed",
            envelope: { authority: "luckytoken", version: 1 },
          },
          { type: "message", role: "user", content: "after" },
        ],
      },
      1,
      policy(),
      {
        resolveItemReference: async () => [
          "not-an-object",
          42,
          { type: "message", role: "user", content: "valid-resolved" },
        ],
      },
    );
    const texts = invocation.context.messages
      .filter((m) => m.role === "user")
      .map((m) => (m.content as Array<{ text: string }>)[0]?.text);
    expect(texts).toEqual(["valid-resolved", "after"]);
  });

  it("applies unknownInputItem policy to unknown resolver result types", async () => {
    const invocation = await convertResponsesRequestAsync(
      {
        model: "m",
        input: [
          {
            type: "item_reference",
            id: "ref_unknown",
            envelope: { authority: "luckytoken", version: 1 },
          },
        ],
      },
      1,
      policy({ unknownInputItem: "ignore" }),
      {
        resolveItemReference: async () => [{ type: "future_family", data: 1 }],
      },
    );
    expect(invocation.context.messages).toHaveLength(0);
    expect(
      invocation.notices.some(
        (n) => n.code === "openai-responses_unknown_input_item_ignored",
      ),
    ).toBe(true);
  });
});
