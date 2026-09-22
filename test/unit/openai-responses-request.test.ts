import { describe, expect, it } from "vitest";

import {
  convertResponsesRequest,
  convertResponsesRequestAsync,
  type ResponseRequestConversionPolicy,
} from "../../src/protocols/openai-responses/request.js";

function policy(
  overrides: Partial<ResponseRequestConversionPolicy> = {},
): ResponseRequestConversionPolicy {
  return {
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
    expect(() => convertResponsesRequest({ input: "x" }, 1, policy())).toThrow(
      "model must be a non-empty string",
    );
    expect(() =>
      convertResponsesRequest(
        { model: "m", input: "x", max_output_tokens: -1 },
        1,
        policy(),
      ),
    ).toThrow("max_output_tokens must be a positive safe integer");
  });

  it("ignores an unconsumed Codex stream option without reading its value", () => {
    const body: Record<string, unknown> = {
      model: "commandcode-goat/deepseek-v4-flash",
      input: "hello",
      stream: true,
    };
    Object.defineProperty(body, "stream_options", {
      enumerable: true,
      get(): never {
        throw new Error("stream_options must remain unread");
      },
    });

    const invocation = convertResponsesRequest(body, 1, policy());

    expect(invocation.invocation.pi.context.messages).toHaveLength(1);
    expect(invocation.client.notices).toContainEqual({
      adapter: "openai-responses",
      direction: "request",
      code: "openai-responses_unconsumed_request_field_ignored",
      jsonPath: "$.stream_options",
      action: "ignore",
    });
  });

  it("uses the same demand-driven extraction in the async conversion entry", async () => {
    const body: Record<string, unknown> = { model: "m", input: "hello" };
    Object.defineProperty(body, "future_extension", {
      enumerable: true,
      get(): never {
        throw new Error("future_extension must remain unread");
      },
    });

    const invocation = await convertResponsesRequestAsync(
      body,
      1,
      policy(),
      { resolveItemReference: async () => [] },
    );

    expect(invocation.client.notices).toContainEqual({
      adapter: "openai-responses",
      direction: "request",
      code: "openai-responses_unconsumed_request_field_ignored",
      jsonPath: "$.future_extension",
      action: "ignore",
    });
  });

  it("bounds unconsumed top-level field warnings deterministically", () => {
    const body: Record<string, unknown> = { model: "m", input: "hello" };
    for (let index = 0; index < 20; index += 1) {
      body[`future_${index}`] = index;
    }

    const invocation = convertResponsesRequest(body, 1, policy());

    expect(invocation.client.notices).toHaveLength(16);
    expect(invocation.client.notices.slice(0, 15).map((notice) => notice.jsonPath)).toEqual(
      Array.from({ length: 15 }, (_, index) => `$.future_${index}`),
    );
    expect(invocation.client.notices[15]).toEqual({
      adapter: "openai-responses",
      direction: "request",
      code: "openai-responses_additional_unconsumed_request_fields_ignored",
      action: "ignore",
    });
  });

  it("uses bracket JSONPath syntax for non-identifier request keys", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "hello", "future.option": true },
      1,
      policy(),
    );

    expect(invocation.client.notices).toContainEqual({
      adapter: "openai-responses",
      direction: "request",
      code: "openai-responses_unconsumed_request_field_ignored",
      jsonPath: '$["future.option"]',
      action: "ignore",
    });
  });

  it("produces equivalent sync and async invocations from the same consumer views", async () => {
    const body = {
      model: "m",
      input: "hello",
      reasoning: { effort: "medium" },
      max_output_tokens: 256,
      text: { format: { type: "text" } },
      future_transport_control: true,
    };

    const syncInvocation = convertResponsesRequest(body, 1, policy());
    const asyncInvocation = await convertResponsesRequestAsync(
      body,
      1,
      policy(),
      { resolveItemReference: async () => [] },
    );

    expect(asyncInvocation).toEqual(syncInvocation);
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

  it("flushes pending reasoning before a following system message so source order is preserved", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          { type: "reasoning", summary: [{ type: "summary_text", text: "thinking hard" }] },
          { type: "message", role: "system", content: "later rule" },
          { type: "message", role: "user", content: "next" },
        ],
      },
      1,
    );

    expect(invocation.invocation.pi.context.messages.map((message) => message.role)).toEqual([
      "assistant",
      "system",
      "user",
    ]);
  });

  it("preserves a system message between a tool call and its result", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "function_call",
            call_id: "call_1",
            name: "lookup",
            arguments: "{}",
          },
          { type: "message", role: "system", content: "mid-tool rule" },
          {
            type: "function_call_output",
            call_id: "call_1",
            output: "done",
          },
        ],
      },
      1,
    );

    expect(invocation.invocation.pi.context.messages.map((message) => message.role)).toEqual([
      "assistant",
      "system",
      "toolResult",
    ]);
  });

  it("keeps a leading system before reasoning that attaches to the next assistant", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          { type: "message", role: "system", content: "rule" },
          { type: "reasoning", summary: [{ type: "summary_text", text: "thought" }] },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "answer" }],
          },
        ],
      },
      1,
    );

    expect(invocation.invocation.pi.context.messages.map((message) => message.role)).toEqual([
      "system",
      "assistant",
    ]);
    const assistantMessage = invocation.invocation.pi.context.messages[1];
    expect(assistantMessage).toMatchObject({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "thought" },
        { type: "text", text: "answer" },
      ],
    });
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

  it("maps a named unpaired function_call_output to user transcript content", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "function_call_output",
            name: "create_thread",
            namespace: "codex_app",
            output: "child thread started",
          },
        ],
      },
      1,
      policy(),
    );

    expect(invocation.invocation.pi.context.messages).toMatchObject([
      {
        role: "user",
        content: [{ type: "text", text: "child thread started" }],
      },
    ]);
  });

  it("keeps a nameless unpaired function_call_output malformed", () => {
    expect(() =>
      convertResponsesRequest(
        {
          model: "m",
          input: [{ type: "function_call_output", output: "missing identity" }],
        },
        1,
        policy(),
      ),
    ).toThrow(/function_call_output\.call_id/u);
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
    expect(invocation.invocation.pi.options.reasoning).toBeUndefined();
    expect(invocation.invocation.reasoning.request.effort).toEqual({
      kind: "enabled",
      level: "max",
    });
  });

  it("rejects malformed previous_response_id, store, and tool_choice shapes", () => {
    expect(() =>
      convertResponsesRequest(
        { model: "m", input: "x", previous_response_id: 42 },
        1,
        policy(),
      ),
    ).toThrow("previous_response_id must be a non-empty string");
    expect(() =>
      convertResponsesRequest(
        { model: "m", input: "x", store: "yes" },
        1,
        policy(),
      ),
    ).toThrow("store must be a boolean");
    expect(() =>
      convertResponsesRequest(
        { model: "m", input: "x", tool_choice: 42 },
        1,
        policy(),
      ),
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
    expect(invocation.invocation.pi.options.reasoning).toBeUndefined();
    expect(invocation.invocation.reasoning.request.effort).toEqual({
      kind: "enabled",
      level: "max",
    });
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
  it("keeps top-level instructions in systemPrompt and preserves developer messages as Pi SystemMessage entries", () => {
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
    expect(invocation.invocation.pi.context.systemPrompt).toBe("You are helpful");
    expect(invocation.invocation.pi.context.messages).toEqual([
      {
        role: "system",
        content: [{ type: "text", text: "code rules" }],
        timestamp: 1,
      },
      {
        role: "user",
        content: [{ type: "text", text: "hi" }],
        timestamp: 1,
      },
    ]);
  });

  it("preserves all system/developer messages at their original Pi positions", () => {
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
      policy(),
    );
    expect(invocation.invocation.pi.context.systemPrompt).toBe("top");
    expect(invocation.invocation.pi.context.messages.map((m) => m.role)).toEqual([
      "system",
      "system",
      "user",
      "system",
      "user",
    ]);
    expect(
      invocation.invocation.pi.context.messages.map((m) =>
        Array.isArray(m.content) ? (m.content[0] as { text?: string } | undefined)?.text : undefined,
      ),
    ).toEqual(["s1", "d1", "u1", "d2", "u2"]);
  });

  it("maps Pi-native output controls and warns for unrepresented top_p", () => {
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
    expect(invocation.invocation.pi.options.samplingParams).toBeUndefined();
    expect(invocation.client.notices).toContainEqual(
      expect.objectContaining({ jsonPath: "$.top_p", action: "ignore" }),
    );
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

  it("does not smuggle identity controls through Pi metadata", () => {
    const fromSafety = convertResponsesRequest(
      { model: "m", input: "x", safety_identifier: "sid-1" },
      1,
      policy(),
    );
    expect(fromSafety.invocation.pi.options.metadata).toBeUndefined();
    expect(fromSafety.client.notices).toContainEqual(
      expect.objectContaining({ jsonPath: "$.safety_identifier", action: "ignore" }),
    );
    const fromUser = convertResponsesRequest(
      { model: "m", input: "x", user: "uid-2" },
      1,
      policy(),
    );
    expect(fromUser.invocation.pi.options.metadata).toBeUndefined();
    expect(fromUser.client.notices).toContainEqual(
      expect.objectContaining({ jsonPath: "$.user", action: "ignore" }),
    );
    const safetyWins = convertResponsesRequest(
      { model: "m", input: "x", safety_identifier: "sid-3", user: "uid-4" },
      1,
      policy(),
    );
    expect(safetyWins.invocation.pi.options.metadata).toBeUndefined();
  });

  it("preserves common parallel-tool intent and warns for private auxiliary controls", () => {
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
    expect(invocation.invocation.pi.options.parallelToolCalls).toBe(false);
    expect(invocation.client.renderState.parallelToolCalls).toBe(false);
    expect(invocation.invocation.pi.context.tools).toBeUndefined();
    expect(invocation.invocation).not.toHaveProperty("supplement");
    for (const jsonPath of [
      "$.service_tier",
      "$.prompt_cache_key",
      "$.truncation",
      "$.text",
      "$.include",
    ]) {
      expect(invocation.client.notices).toContainEqual(
        expect.objectContaining({ jsonPath, action: "ignore" }),
      );
    }
    expect(invocation.client.notices).toContainEqual({
      adapter: "openai-responses",
      direction: "request",
      code: "openai-responses_unconsumed_request_field_ignored",
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

    expect(invocation.invocation).not.toHaveProperty("supplement");
    expect(invocation.client.notices).toContainEqual({
      adapter: "openai-responses",
      direction: "request",
      code: "openai-responses_unconsumed_request_field_ignored",
      jsonPath: "$.top_logprobs",
      action: "ignore",
    });
  });

  it("normalizes reasoning intent without writing a model-unvalidated Pi option", () => {
    for (const effort of ["minimal", "low", "medium", "high", "xhigh"]) {
      const invocation = convertResponsesRequest(
        { model: "m", input: "x", reasoning: { effort } },
        1,
        policy(),
      );
      expect(invocation.invocation.pi.options.reasoning).toBeUndefined();
      expect(invocation.invocation.reasoning.request.effort).toEqual({
        kind: "enabled",
        level: effort,
      });
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
    expect(ultra.invocation.pi.options.reasoning).toBeUndefined();
    expect(ultra.invocation.reasoning.request.effort).toEqual({
      kind: "enabled",
      level: "max",
    });
    expect(
      ultra.client.notices.some((n) => n.code === "openai-responses_effort_ultra_alias"),
    ).toBe(true);
    const max = convertResponsesRequest(
      { model: "m", input: "x", reasoning: { effort: "max" } },
      1,
      policy(),
    );
    expect(max.invocation.pi.options.reasoning).toBeUndefined();
    expect(max.invocation.reasoning.request.effort).toEqual({
      kind: "enabled",
      level: "max",
    });
    expect(max.client.notices).toEqual([]);
  });

  it("applies futureReasoningEffort=max to a future effort value with a notice", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", reasoning: { effort: "future-level" } },
      1,
      policy({ futureReasoningEffort: "max" }),
    );
    expect(invocation.invocation.pi.options.reasoning).toBeUndefined();
    expect(invocation.invocation.reasoning.request.effort).toEqual({
      kind: "enabled",
      level: "max",
    });
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

  it("preserves the catalog for none/auto and filters only allowed_tools", () => {
    const tools = [
      { type: "function", name: "a", parameters: { type: "object" } },
      { type: "function", name: "b", parameters: { type: "object" } },
    ];
    const none = convertResponsesRequest(
      { model: "m", input: "x", tools, tool_choice: "none" },
      1,
      policy(),
    );
    expect(none.invocation.pi.context.tools?.map((t) => t.name)).toEqual(["a", "b"]);
    expect(none.invocation.pi.options.toolChoice).toBe("none");
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

  it("preserves a named tool_choice in the Pi common contract", () => {
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
    expect(invocation.invocation.pi.options.toolChoice).toEqual({
      type: "tool",
      name: "a",
    });
    expect(invocation.invocation.pi.context.tools?.map((tool) => tool.name)).toEqual(["a"]);
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
    ).toThrow(/undeclared tool/u);
  });

  it("keeps unconsumed background out of Provider projection", () => {
    const background = convertResponsesRequest(
      { model: "m", input: "x", background: true },
      1,
      policy(),
    );
    expect(background.invocation).not.toHaveProperty("supplement");
    expect(background.client.notices).toContainEqual({
      adapter: "openai-responses",
      direction: "request",
      code: "openai-responses_unconsumed_request_field_ignored",
      jsonPath: "$.background",
      action: "ignore",
    });
    const sync = convertResponsesRequest(
      { model: "m", input: "x", background: false },
      1,
      policy(),
    );
    expect(sync.client.renderState.stream).toBe(false);
    expect(sync.client.notices).toContainEqual({
      adapter: "openai-responses",
      direction: "request",
      code: "openai-responses_unconsumed_request_field_ignored",
      jsonPath: "$.background",
      action: "ignore",
    });
  });

  it("ignores unconsumed conversation and prompt when the main request is complete", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: "x",
        conversation: "conv_1",
        prompt: { id: "prompt_1" },
      },
      1,
      policy(),
    );

    expect(invocation.client.notices.map((notice) => notice.jsonPath)).toEqual([
      "$.conversation",
      "$.prompt",
    ]);
  });

  it("rejects a prompt-only request because the minimum Pi input is missing", () => {
    expect(() =>
      convertResponsesRequest(
        { model: "m", prompt: { id: "prompt_1" } },
        1,
        policy(),
      ),
    ).toThrow("input must be a string or an array");
  });

  it("rejects external item_reference and foreign encrypted compaction", () => {
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
            envelope: { authority: "Token", version: 1 },
          },
        ],
      },
      1,
      policy(),
      {
        resolveItemReference: async (reference, context) => {
          expect(reference.id).toBe("item_owned_1");
          expect(context.authority).toBe("Token");
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
            envelope: { authority: "Token", version: 1 },
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
            envelope: { authority: "Token", version: 1 },
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

describe("13 recheck: resolved references preserve privileged message positions", () => {
  it("keeps system/developer items returned by the resolver as Pi SystemMessage entries", async () => {
    const invocation = await convertResponsesRequestAsync(
      {
        model: "m",
        input: [
          {
            type: "item_reference",
            id: "ref_sys",
            envelope: { authority: "Token", version: 1 },
          },
          { type: "message", role: "user", content: "hi" },
        ],
      },
      1,
      policy(),
      {
        resolveItemReference: async () => [
          { type: "message", role: "system", content: "resolved rules" },
        ],
      },
    );
    expect(invocation.invocation.pi.context.systemPrompt).toBeUndefined();
    expect(invocation.invocation.pi.context.messages.map((m) => m.role)).toEqual([
      "system",
      "user",
    ]);
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
            envelope: { authority: "Token", version: 1 },
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

describe("13 recheck: tool_choice uses only the Pi common contract", () => {
  it("preserves a named choice without projecting Provider wire", () => {
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
    expect(invocation.invocation.pi.options.toolChoice).toEqual({
      type: "tool",
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

  it("leaves top_p unread and warns regardless of its shape", () => {
    const invalid = convertResponsesRequest(
      { model: "m", input: "x", top_p: 1.5 },
      1,
      policy(),
    );
    expect(invalid.client.notices).toContainEqual(
      expect.objectContaining({ jsonPath: "$.top_p", action: "ignore" }),
    );
    const valid = convertResponsesRequest(
      { model: "m", input: "x", top_p: 0.5 },
      1,
      policy(),
    );
    expect(valid.invocation.pi.options.samplingParams).toBeUndefined();
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
            envelope: { authority: "Token", version: 1 },
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
            envelope: { authority: "Token", version: 1 },
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
            envelope: { authority: "Token", version: 1 },
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

describe("13 recheck: system/developer position preservation", () => {
  it("keeps consecutive privileged messages as consecutive Pi SystemMessage entries", () => {
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
      policy(),
    );
    expect(invocation.invocation.pi.context.systemPrompt).toBeUndefined();
    expect(invocation.invocation.pi.context.messages.map((m) => m.role)).toEqual([
      "system",
      "system",
      "system",
    ]);
  });

  it("preserves exact privileged text including internal newlines", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          { type: "message", role: "developer", content: "line1\nline2\n\nline4" },
          { type: "message", role: "user", content: "u" },
        ],
      },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.context.messages[0]).toMatchObject({
      role: "system",
      content: [{ type: "text", text: "line1\nline2\n\nline4" }],
    });
  });
});

describe("13 recheck: effort full matrix", () => {
  it("normalizes every known effort value without writing a pre-model Pi option", () => {
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
      expect(invocation.invocation.pi.options.reasoning).toBeUndefined();
      expect(invocation.invocation.reasoning.request.effort).toEqual(
        expected === undefined
          ? { kind: "disabled" }
          : { kind: "enabled", level: expected },
      );
    }
  });

  it("maps future effort per every futureReasoningEffort policy", () => {
    const max = convertResponsesRequest(
      { model: "m", input: "x", reasoning: { effort: "future-level" } },
      1,
      policy({ futureReasoningEffort: "max" }),
    );
    expect(max.invocation.pi.options.reasoning).toBeUndefined();
    expect(max.invocation.reasoning.request.effort).toEqual({
      kind: "enabled",
      level: "max",
    });
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

  it("none preserves the catalog and carries an explicit Pi disable", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", tools, tool_choice: "none" },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.context.tools?.map((tool) => tool.name)).toEqual([
      "a",
      "b",
      "apply_patch",
    ]);
    expect(invocation.invocation.pi.options.toolChoice).toBe("none");
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
    // Provider execution uses neutral Pi auto plus the filtered catalog;
    // the Responses-owned response state retains the equivalent Client echo.
    expect(invocation.client.renderState.toolChoice).toEqual({
      type: "allowed_tools",
      mode: "auto",
      tools: [
        { type: "function", name: "a" },
        { type: "function", name: "b" },
      ],
    });
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

  it("named choice with an available tool is preserved in Pi", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", tools, tool_choice: { type: "function", name: "a" } },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.options.toolChoice).toEqual({
      type: "tool",
      name: "a",
    });
  });

  it("forced with an unavailable tool errors", () => {
    expect(() =>
      convertResponsesRequest(
        { model: "m", input: "x", tools, tool_choice: { type: "function", name: "zzz" } },
        1,
        policy(),
      ),
    ).toThrow(/undeclared tool/u);
  });

  it("required string is preserved in Pi", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", tools, tool_choice: "required" },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.options.toolChoice).toBe("required");
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
            envelope: { authority: "Token", version: 1 },
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
            envelope: { authority: "Token", version: 1 },
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
