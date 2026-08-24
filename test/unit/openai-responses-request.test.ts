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
    expect(invocation.invocation.pi.context.systemPrompt).toBe("You are a helpful assistant");
    expect(invocation.invocation.pi.context.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
        timestamp: 1_786_400_000_000,
      },
    ]);
    expect(invocation.invocation.pi.options.maxTokens).toBe(100);
    expect(invocation.client.renderState).toEqual({
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

    const assistant = invocation.invocation.pi.context.messages.find((m) => m.role === "assistant");
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

    expect(invocation.invocation.pi.context.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
    const assistant = invocation.invocation.pi.context.messages[1];
    expect(assistant?.content).toEqual([
      { type: "toolCall", id: "call_1", name: "lookup", arguments: { key: "value" } },
    ]);
    expect(invocation.invocation.pi.context.messages[2]).toMatchObject({
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

    const roles = invocation.invocation.pi.context.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "toolResult", "toolResult"]);
    const results = invocation.invocation.pi.context.messages.filter(
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
    const assistant = invocation.invocation.pi.context.messages.find((m) => m.role === "assistant");
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
    expect(ignored.invocation.pi.context.messages).toHaveLength(1);
    expect(
      ignored.client.notices.some(
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
    expect(invocation.invocation.pi.context.messages).toHaveLength(1);
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
    expect(invocation.invocation.pi.context.messages[0]).toMatchObject({
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
    expect(invocation.invocation.pi.context.tools?.map((t) => t.name)).toEqual(["base", "extra"]);
    expect(invocation.invocation.pi.context.tools?.[0]?.constrainedSampling).toEqual({
      type: "json_schema",
      strict: "require",
    });
  });

  it("maps reasoning.effort with ultra degraded to max", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", reasoning: { effort: "ultra" } },
      1,
    );
    expect(invocation.invocation.pi.options.reasoning).toBe("max");
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
    ).toThrow("tool_choice must be auto, none, required, or an object");
  });

  it("maps a future reasoning.effort to max by default with a notice", () => {
    // Frozen futureReasoningEffort default is max: an unknown future effort
    // degrades to max with a request-local notice, not a hard error.
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", reasoning: { effort: "super" } },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.options.reasoning).toBe("max");
    expect(
      invocation.client.notices.some((n) => n.code === "openai-responses_future_effort"),
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
    expect(invocation.invocation.pi.context.tools?.map((t) => t.name)).toEqual([
      "shell_command",
      "apply_patch",
      "mcp__inner_tool",
    ]);
    const shell = invocation.invocation.pi.context.tools?.[0];
    expect(shell?.parameters).toMatchObject({ type: "object" });
    const applyPatch = invocation.invocation.pi.context.tools?.[1];
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
    expect(invocation.invocation.pi.context.tools?.[0]?.constrainedSampling).toEqual({
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
    expect(invocation.invocation.pi.context.systemPrompt).toBe("You are helpful\ncode rules");
    expect(invocation.invocation.pi.context.messages.map((m) => m.role)).toEqual(["user"]);
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
    expect(invocation.invocation.pi.context.systemPrompt).toBe("top\ns1\nd1\nd2");
    expect(invocation.invocation.pi.context.messages.map((m) => m.role)).toEqual(["user", "user"]);
    expect(
      invocation.invocation.pi.context.messages.map(
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
    expect(invocation.invocation.pi.context.systemPrompt).toBe("s1\nd1");
    const roles = invocation.invocation.pi.context.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "user", "user"]);
    expect(
      invocation.invocation.pi.context.messages.map(
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
    expect(invocation.invocation.pi.context.systemPrompt).toBe("top");
    expect(invocation.invocation.pi.context.messages.map((m) => m.role)).toEqual([
      "user",
      "user",
      "user",
    ]);
    expect(
      invocation.invocation.pi.context.messages.map(
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
    expect(invocation.invocation.pi.context.systemPrompt).toBe("first\nsecond");
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
    expect(invocation.invocation.pi.context.systemPrompt).toBeUndefined();
    const roles = invocation.invocation.pi.context.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "user", "user", "user"]);
    expect(
      invocation.invocation.pi.context.messages.map(
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
    expect(invocation.invocation.pi.options.maxTokens).toBe(512);
    expect(invocation.invocation.pi.options.temperature).toBe(0.4);
    expect(invocation.invocation.pi.options.samplingParams).toEqual({ top_p: 0.9 });
  });

  it("maps prompt_cache_retention to Pi cacheRetention", () => {
    const shortInvocation = convertResponsesRequest(
      { model: "m", input: "x", prompt_cache_retention: "in_memory" },
      1,
      policy(),
    );
    expect(shortInvocation.invocation.pi.options.cacheRetention).toBe("short");
    const longInvocation = convertResponsesRequest(
      { model: "m", input: "x", prompt_cache_retention: "24h" },
      1,
      policy(),
    );
    expect(longInvocation.invocation.pi.options.cacheRetention).toBe("long");
    const none = convertResponsesRequest(
      { model: "m", input: "x", prompt_cache_retention: null },
      1,
      policy(),
    );
    expect(none.invocation.pi.options.cacheRetention).toBeUndefined();
  });

  it("maps safety_identifier with a user fallback into Pi metadata", () => {
    const fromSafety = convertResponsesRequest(
      { model: "m", input: "x", safety_identifier: "sid-1" },
      1,
      policy(),
    );
    expect(fromSafety.invocation.pi.options.metadata).toEqual({ user_id: "sid-1" });
    const fromUser = convertResponsesRequest(
      { model: "m", input: "x", user: "uid-2" },
      1,
      policy(),
    );
    expect(fromUser.invocation.pi.options.metadata).toEqual({ user_id: "uid-2" });
    const safetyWins = convertResponsesRequest(
      { model: "m", input: "x", safety_identifier: "sid-3", user: "uid-4" },
      1,
      policy(),
    );
    expect(safetyWins.invocation.pi.options.metadata).toEqual({ user_id: "sid-3" });
  });

  it("captures validated auxiliary controls in the complete supplement", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: "x",
        stream: true,
        service_tier: "priority",
        prompt_cache_key: "cache-key",
        parallel_tool_calls: false,
        truncation: "auto",
        context_management: [{ type: "compaction", compact_threshold: 1000 }],
        text: { format: { type: "text" }, verbosity: "low" },
        include: ["reasoning.encrypted_content"],
        unknown_top_level: "ignored",
      },
      1,
      policy(),
    );
    expect(invocation.client.renderState.stream).toBe(true);
    expect(invocation.invocation.pi.options.samplingParams).toBeUndefined();
    expect(invocation.invocation.pi.options.cacheRetention).toBeUndefined();
    expect(invocation.invocation.pi.context.tools).toBeUndefined();
    expect(invocation.invocation.supplement).toMatchObject({
      output: {
        format: { value: { type: "text" } },
        verbosity: { value: "low" },
        include: { value: ["reasoning.encrypted_content"] },
      },
      tools: {
        parallelCalls: { value: false },
      },
      cache: { key: { value: "cache-key" } },
      lifecycle: {
        serviceTier: { value: "priority" },
        truncation: { value: "auto" },
      },
    });
    expect(invocation.client.notices).toContainEqual({
      adapter: "openai-responses",
      direction: "request",
      code: "openai-responses_context_management_omitted",
      jsonPath: "$.context_management",
      action: "ignore",
    });
    // Unknown auxiliary fields must not appear in the typed invocation.
    expect(invocation.invocation.pi.options).not.toHaveProperty("service_tier");
  });

  it("keeps top_logprobs out of Provider projection and warns when logprobs are requested", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", top_logprobs: 3 },
      1,
      policy(),
    );

    expect(invocation.invocation.supplement.output).toBeUndefined();
    expect(invocation.client.notices).toContainEqual({
      adapter: "openai-responses",
      direction: "request",
      code: "openai-responses_top_logprobs_omitted",
      jsonPath: "$.top_logprobs",
      action: "ignore",
    });
  });

  it("maps reasoning effort minimal through xhigh directly", () => {
    for (const effort of ["minimal", "low", "medium", "high", "xhigh"]) {
      const invocation = convertResponsesRequest(
        { model: "m", input: "x", reasoning: { effort } },
        1,
        policy(),
      );
      expect(invocation.invocation.pi.options.reasoning).toBe(effort);
    }
  });

  it("preserves explicit none separately from absent provider-default", () => {
    const none = convertResponsesRequest(
      { model: "m", input: "x", reasoning: { effort: "none" } },
      1,
      policy(),
    );
    expect(none.invocation.pi.options.reasoning).toBeUndefined();
    expect(none.invocation.reasoning.request.effort).toEqual({ kind: "disabled" });
    expect(none.client.notices).toEqual([]);
    const absent = convertResponsesRequest(
      { model: "m", input: "x" },
      1,
      policy(),
    );
    expect(absent.invocation.pi.options.reasoning).toBeUndefined();
    expect(absent.client.notices).toEqual([]);
  });

  it("maps ultra and max to Pi max", () => {
    const ultra = convertResponsesRequest(
      { model: "m", input: "x", reasoning: { effort: "ultra" } },
      1,
      policy(),
    );
    expect(ultra.invocation.pi.options.reasoning).toBe("max");
    expect(
      ultra.client.notices.some((n) => n.code === "openai-responses_effort_ultra_alias"),
    ).toBe(true);
    const max = convertResponsesRequest(
      { model: "m", input: "x", reasoning: { effort: "max" } },
      1,
      policy(),
    );
    expect(max.invocation.pi.options.reasoning).toBe("max");
    expect(max.client.notices).toEqual([]);
  });

  it("applies futureReasoningEffort=max to a future effort value with a notice", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", reasoning: { effort: "future-level" } },
      1,
      policy({ futureReasoningEffort: "max" }),
    );
    expect(invocation.invocation.pi.options.reasoning).toBe("max");
    expect(
      invocation.client.notices.some((n) => n.code === "openai-responses_future_effort"),
    ).toBe(true);
  });

  it("applies futureReasoningEffort=omit with a notice", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", reasoning: { effort: "future-level" } },
      1,
      policy({ futureReasoningEffort: "omit" }),
    );
    expect(invocation.invocation.pi.options.reasoning).toBeUndefined();
    expect(
      invocation.client.notices.some((n) => n.code === "openai-responses_future_effort"),
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
    expect(none.invocation.pi.context.tools).toBeUndefined();
    const auto = convertResponsesRequest(
      { model: "m", input: "x", tools, tool_choice: "auto" },
      1,
      policy(),
    );
    expect(auto.invocation.pi.context.tools?.map((t) => t.name)).toEqual(["a", "b"]);
    const allowed = convertResponsesRequest(
      {
        model: "m",
        input: "x",
        tools,
        tool_choice: {
          type: "allowed_tools",
          mode: "auto",
          tools: [{ type: "function", name: "b" }],
        },
      },
      1,
      policy(),
    );
    expect(allowed.invocation.pi.context.tools?.map((t) => t.name)).toEqual(["b"]);
  });

  it("preserves a named tool_choice for target projection", () => {
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
    expect(invocation.invocation.pi.context.tools?.map((t) => t.name)).toEqual(["a"]);
    expect(invocation.client.renderState.toolChoice).toBe("required");
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

  it("keeps background out of Provider projection and degrades true to synchronous", () => {
    const background = convertResponsesRequest(
      { model: "m", input: "x", background: true },
      1,
      policy(),
    );
    expect(background.invocation.supplement.lifecycle).toBeUndefined();
    expect(background.client.notices).toContainEqual({
      adapter: "openai-responses",
      direction: "request",
      code: "openai-responses_background_synchronous",
      jsonPath: "$.background",
      action: "degrade",
    });
    const sync = convertResponsesRequest(
      { model: "m", input: "x", background: false },
      1,
      policy(),
    );
    expect(sync.client.renderState.stream).toBe(false);
    expect(sync.client.notices).toEqual([]);
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
    expect(invocation.invocation.pi.context.messages[0]).toMatchObject({
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
      invocation.client.notices.some(
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

  it("retains valid source metadata only for request-local response echo", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: "x",
        metadata: { thread: "t-1" },
      },
      1,
      policy(),
    );
    expect(invocation.client.renderState.metadataEcho).toEqual({ thread: "t-1" });
    expect(invocation.invocation.pi.options.metadata).toBeUndefined();
    expect(invocation.invocation.pi.context).not.toHaveProperty("metadata");
  });

  it("rejects invalid metadata values and SDK count/length overflow", () => {
    for (const metadata of [
      { numeric: 42 },
      { nested: { a: 1 } },
      Object.fromEntries(
        Array.from({ length: 17 }, (_, index) => [`key-${index}`, "value"]),
      ),
      { ["k".repeat(65)]: "value" },
      { key: "v".repeat(513) },
    ]) {
      expect(() =>
        convertResponsesRequest(
          { model: "m", input: "x", metadata },
          1,
          policy(),
        ),
      ).toThrow(/metadata/u);
    }
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
    expect(ignored.invocation.pi.context.messages).toHaveLength(1);
    expect(
      ignored.client.notices.some(
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
    expect(invocation.invocation.pi.context.systemPrompt).toContain("resolved rules");
    expect(invocation.invocation.pi.context.messages.map((m) => m.role)).toEqual(["user"]);
  });
});

describe("13 recheck: effort none retains explicit-off intent", () => {
  it("does not claim degradation before target projection", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", reasoning: { effort: "none" } },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.options.reasoning).toBeUndefined();
    expect(invocation.invocation.reasoning.request.effort).toEqual({
      kind: "disabled",
    });
    expect(invocation.client.notices).toEqual([]);
  });

  it("emits no notice for absent or null reasoning", () => {
    const absent = convertResponsesRequest(
      { model: "m", input: "x" },
      1,
      policy(),
    );
    expect(absent.client.notices).toEqual([]);
    const nulled = convertResponsesRequest(
      { model: "m", input: "x", reasoning: null },
      1,
      policy(),
    );
    expect(nulled.client.notices).toEqual([]);
    const effortNull = convertResponsesRequest(
      { model: "m", input: "x", reasoning: { effort: null } },
      1,
      policy(),
    );
    expect(effortNull.client.notices).toEqual([]);
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

describe("13 recheck: tool_choice is retained for target projection", () => {
  it("retains a named choice without a premature degradation notice", () => {
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
    expect(invocation.invocation.pi.context.tools?.map((t) => t.name)).toEqual(["a"]);
    expect(invocation.invocation.supplement.tools?.choice?.value).toEqual({
      kind: "named",
      toolType: "function",
      name: "a",
    });
    expect(invocation.client.notices).toEqual([]);
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
    expect(none.client.notices).toEqual([]);
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
    expect(auto.client.notices).toEqual([]);
    const allowed = convertResponsesRequest(
      {
        model: "m",
        input: "x",
        tools: [{ type: "function", name: "a", parameters: { type: "object" } }],
        tool_choice: {
          type: "allowed_tools",
          mode: "auto",
          tools: [{ type: "function", name: "a" }],
        },
      },
      1,
      policy(),
    );
    expect(allowed.client.notices).toEqual([]);
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
          tool_choice: {
            type: "allowed_tools",
            mode: "auto",
            tools: "not-an-array",
          },
        },
        1,
        policy(),
      ),
    ).toThrow(/tool_choice\.tools/);
  });

  it("rejects an allowed_tools array with a non-string entry", () => {
    expect(() =>
      convertResponsesRequest(
        {
          model: "m",
          input: "x",
          tools: [{ type: "function", name: "a", parameters: { type: "object" } }],
          tool_choice: {
            type: "allowed_tools",
            mode: "auto",
            tools: [{ type: "function", name: "a" }, 42],
          },
        },
        1,
        policy(),
      ),
    ).toThrow(/tool_choice\.tools/);
  });
});

describe("13 recheck: temperature range is validated", () => {
  it("accepts temperature within the valid range", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", temperature: 1.5 },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.options.temperature).toBe(1.5);
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
    expect(valid.invocation.pi.options.samplingParams).toEqual({ top_p: 0.5 });
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
    const echo = invocation.client.renderState.metadataEcho ?? {};
    expect(Object.keys(echo).sort()).toEqual(["constructor", "normal"]);
    // The echo object is null-prototype: hostile keys cannot pollute it.
    expect(Object.getPrototypeOf(echo)).toBeNull();
    expect((echo as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("13 recheck: prototype pollution via JSON.parse input", () => {
  it("does not pollute when metadata arrives from JSON.parse with __proto__ as own key", () => {
    const raw = '{"model":"m","input":"x","metadata":{"__proto__":"proto-value","constructor":"ctor-value","normal":"safe"}}';
    const value = JSON.parse(raw) as Record<string, unknown>;
    const invocation = convertResponsesRequest(value, 1, policy());
    const echo = invocation.client.renderState.metadataEcho ?? {};
    const keys = Object.keys(echo).sort();
    // __proto__ remains a harmless own string key on a null-prototype object.
    expect(keys).toEqual(["__proto__", "constructor", "normal"]);
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
      invocation.client.notices.some(
        (n) => n.code === "openai-responses_reference_unresolved",
      ),
    ).toBe(true);
    expect(invocation.invocation.pi.context.messages).toHaveLength(1);
    expect(invocation.invocation.pi.context.messages[0]).toMatchObject({
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
    expect(invocation.invocation.pi.context.systemPrompt).toBe("s1\nd1\ns2");
    expect(invocation.invocation.pi.context.messages).toHaveLength(0);
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
    expect(invocation.invocation.pi.context.systemPrompt).toBe("a\nb\nc");
    expect(invocation.invocation.pi.context.systemPrompt).not.toContain("\n\n");
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
    expect(invocation.invocation.pi.context.systemPrompt).toBe("line1\nline2\n\nline4");
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
    expect(invocation.invocation.pi.context.systemPrompt).toBeUndefined();
    expect(invocation.invocation.pi.context.messages.map((m) => m.role)).toEqual(["user", "user"]);
    expect(
      invocation.invocation.pi.context.messages.map(
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
      expect(invocation.invocation.pi.options.reasoning).toBe(expected);
    }
  });

  it("maps future effort per every futureReasoningEffort policy", () => {
    const max = convertResponsesRequest(
      { model: "m", input: "x", reasoning: { effort: "future-level" } },
      1,
      policy({ futureReasoningEffort: "max" }),
    );
    expect(max.invocation.pi.options.reasoning).toBe("max");
    expect(
      max.client.notices.some((n) => n.code === "openai-responses_future_effort"),
    ).toBe(true);

    const omit = convertResponsesRequest(
      { model: "m", input: "x", reasoning: { effort: "future-level" } },
      1,
      policy({ futureReasoningEffort: "omit" }),
    );
    expect(omit.invocation.pi.options.reasoning).toBeUndefined();
    expect(
      omit.client.notices.some((n) => n.code === "openai-responses_future_effort"),
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
    expect(invocation.invocation.pi.context.tools).toBeUndefined();
    expect(invocation.client.renderState.toolChoice).toBe("none");
    expect(invocation.client.notices).toEqual([]);
  });

  it("auto keeps the full catalog", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", tools, tool_choice: "auto" },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.context.tools?.map((t) => t.name)).toEqual([
      "a",
      "b",
      "apply_patch",
    ]);
    expect(invocation.client.renderState.toolChoice).toBe("auto");
  });

  it("absence/null keeps the full catalog with no effective choice", () => {
    const absent = convertResponsesRequest(
      { model: "m", input: "x", tools },
      1,
      policy(),
    );
    expect(absent.invocation.pi.context.tools?.map((t) => t.name)).toEqual([
      "a",
      "b",
      "apply_patch",
    ]);
    expect(absent.client.renderState.toolChoice).toBeUndefined();
    const nulled = convertResponsesRequest(
      { model: "m", input: "x", tools, tool_choice: null },
      1,
      policy(),
    );
    expect(nulled.invocation.pi.context.tools?.map((t) => t.name)).toEqual([
      "a",
      "b",
      "apply_patch",
    ]);
  });

  it("allowed filters deterministically and records the effective choice", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: "x",
        tools,
        tool_choice: {
          type: "allowed_tools",
          mode: "auto",
          tools: [
            { type: "function", name: "a" },
            { type: "function", name: "b" },
          ],
        },
      },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.context.tools?.map((t) => t.name)).toEqual(["a", "b"]);
    // The SDK has no bare "allowed" tool_choice string; the filter is
    // auto-mode filtering, so the effective echo is "auto".
    expect(invocation.client.renderState.toolChoice).toBe("auto");
  });

  it("allowed with an unknown name filters it out", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: "x",
        tools,
        tool_choice: {
          type: "allowed_tools",
          mode: "auto",
          tools: [
            { type: "function", name: "a" },
            { type: "function", name: "zzz" },
          ],
        },
      },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.context.tools?.map((t) => t.name)).toEqual(["a"]);
  });

  it("rejects an empty current allowed_tools list", () => {
    expect(() =>
      convertResponsesRequest(
        {
          model: "m",
          input: "x",
          tools,
          tool_choice: { type: "allowed_tools", mode: "auto", tools: [] },
        },
        1,
        policy(),
      ),
    ).toThrow(/non-empty array/u);
  });

  it("named choice with an available tool is retained", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", tools, tool_choice: { type: "function", name: "a" } },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.context.tools?.map((t) => t.name)).toEqual([
      "a",
      "b",
      "apply_patch",
    ]);
    expect(invocation.client.renderState.toolChoice).toBe("required");
    expect(invocation.client.notices).toEqual([]);
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

  it("required string is retained for target projection", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", tools, tool_choice: "required" },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.context.tools?.map((t) => t.name)).toEqual([
      "a",
      "b",
      "apply_patch",
    ]);
    expect(invocation.client.renderState.toolChoice).toBe("required");
    expect(invocation.client.notices).toEqual([]);
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
    const texts = invocation.invocation.pi.context.messages
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
    expect(invocation.invocation.pi.context.messages).toHaveLength(0);
    expect(
      invocation.client.notices.some(
        (n) => n.code === "openai-responses_unknown_input_item_ignored",
      ),
    ).toBe(true);
  });
});
