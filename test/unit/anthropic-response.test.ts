import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  assertOutboundResponseFidelity,
  CLIENT_USAGE_CACHE_SPLIT_UNAVAILABLE_NOTICE_CODE,
  CLIENT_USAGE_REASONING_UNAVAILABLE_NOTICE_CODE,
  CLIENT_USAGE_UNAVAILABLE_NOTICE_CODE,
  CLIENT_USAGE_UNKNOWN_FIELDS_NOTICE_CODE,
  convertAssistantMessageToAnthropic,
  convertAssistantMessageToAnthropicWithPolicy,
} from "../../src/protocols/anthropic/response.js";

function usage(overrides: Partial<Usage> = {}): Usage {
  return {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 3,
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    ...overrides,
  };
}

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    api: "internal-api",
    provider: "internal-provider",
    model: "internal-model",
    usage: usage(),
    stopReason: "stop",
    timestamp: 1,
    ...overrides,
  };
}

describe("schema-complete Anthropic JSON response", () => {
  it.each(["", " ", "\t", "\n", "A ", " A", "A\nB"])(
    "preserves exact text fixture %j",
    (text) => {
      const target = convertAssistantMessageToAnthropic(
        message({ content: [{ type: "text", text }] }),
        "client-selector",
        "opaque-id",
      );
      expect(target.content).toEqual([{ citations: null, text, type: "text" }]);
    },
  );

  it("preserves ordered direct tool identity and a validated object tree", () => {
    const input = {
      text: "exact",
      nested: { array: [1, true, null, { value: "x" }] },
    };
    const target = convertAssistantMessageToAnthropic(
      message({
        content: [
          { type: "text", text: "before" },
          {
            type: "toolCall",
            id: "call_Exact",
            name: "Tool_Exact",
            arguments: input,
          },
          { type: "text", text: "after" },
        ],
        stopReason: "toolUse",
      }),
      "client-selector",
      "opaque-id",
    );

    expect(target.content).toEqual([
      { citations: null, text: "before", type: "text" },
      {
        id: "call_Exact",
        caller: { type: "direct" },
        input,
        name: "Tool_Exact",
        type: "tool_use",
      },
      { citations: null, text: "after", type: "text" },
    ]);
    expect(target.stop_reason).toBe("tool_use");
  });

  it("preserves ordinary thinking and its opaque signature in content order", () => {
    const target = convertAssistantMessageToAnthropic(
      message({
        content: [
          { type: "text", text: "before" },
          {
            type: "thinking",
            thinking: "private reasoning",
            thinkingSignature: "opaque-signature",
          },
          { type: "thinking", thinking: "unsigned reasoning" },
          { type: "text", text: "after" },
        ],
      }),
      "client-selector",
      "opaque-id",
    );

    expect(target.content).toEqual([
      { citations: null, text: "before", type: "text" },
      {
        type: "thinking",
        thinking: "private reasoning",
        signature: "opaque-signature",
      },
      {
        type: "thinking",
        thinking: "unsigned reasoning",
        signature: "",
      },
      { citations: null, text: "after", type: "text" },
    ]);
  });

  it.each([
    ["non-string thinking", { type: "thinking", thinking: 1 }],
    [
      "non-string signature",
      { type: "thinking", thinking: "reasoning", thinkingSignature: 1 },
    ],
    [
      "non-boolean redacted marker",
      { type: "thinking", thinking: "reasoning", redacted: "yes" },
    ],
    [
      "unknown thinking state",
      { type: "thinking", thinking: "reasoning", futureState: true },
    ],
  ])("rejects malformed Pi thinking: %s", (_name, block) => {
    expect(() =>
      convertAssistantMessageToAnthropic(
        message({
          content: [
            block as unknown as AssistantMessage["content"][number],
          ],
        }),
        "client-selector",
        "opaque-id",
      ),
    ).toThrow();
  });

  it("rejects non-object roots and every non-JSON nested semantic", () => {
    const invalid: unknown[] = [
      null,
      [],
      "string",
      1,
      true,
      { value: undefined },
      { value: BigInt(1) },
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
      { value: () => undefined },
      { value: Symbol("x") },
      { value: new Date(0) },
      { value: { toJSON: () => ({ repaired: true }) } },
    ];
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    invalid.push(cyclic);

    for (const argumentsValue of invalid) {
      expect(() =>
        convertAssistantMessageToAnthropic(
          message({
            content: [
              {
                type: "toolCall",
                id: "call",
                name: "tool",
                arguments: argumentsValue,
              } as AssistantMessage["content"][number],
            ],
            stopReason: "toolUse",
          }),
          "client-selector",
          "opaque-id",
        ),
      ).toThrow();
    }
  });

  it("renders every required-nullable usage field and exact optional breakdowns", () => {
    const target = convertAssistantMessageToAnthropic(
      message({
        usage: usage({
          input: 4,
          output: 8,
          cacheRead: 3,
          cacheWrite: 7,
          cacheWrite1h: 2,
          reasoning: 5,
          totalTokens: 999,
        }),
      }),
      "client-selector",
      "opaque-id",
    );

    expect(target.usage).toEqual({
      cache_creation: {
        ephemeral_1h_input_tokens: 2,
        ephemeral_5m_input_tokens: 5,
      },
      cache_creation_input_tokens: 7,
      cache_read_input_tokens: 3,
      inference_geo: null,
      input_tokens: 4,
      output_tokens: 8,
      output_tokens_details: { thinking_tokens: 5 },
      server_tool_use: null,
      service_tier: null,
    });
    expect(target.usage).not.toHaveProperty("totalTokens");
    expect(target.usage).not.toHaveProperty("cost");

    const baseline = convertAssistantMessageToAnthropic(
      message(),
      "client-selector",
      "opaque-id",
    );
    expect(baseline.usage.cache_creation).toBeNull();
    expect(baseline.usage.output_tokens_details).toBeNull();
  });

  // Ticket 20 additive: malformed usage is observability, not model-visible
  // semantics — it must never discard an otherwise valid response. Each of
  // these malformed shapes still yields a schema-valid target message.
  it.each([
    ["input", { input: -1 }],
    ["output", { output: 1.5 }],
    ["cache read", { cacheRead: Number.NaN }],
    ["cache write", { cacheWrite: Number.POSITIVE_INFINITY }],
    ["reasoning subset", { output: 1, reasoning: 2 }],
    ["cache one-hour subset", { cacheWrite: 1, cacheWrite1h: 2 }],
  ])("does not discard a valid response for malformed usage: %s", (_name, overrides) => {
    const converted = convertAssistantMessageToAnthropicWithPolicy(
      message({ usage: usage(overrides) }),
      { selector: "client-selector", createMessageId: () => "opaque-id" },
      { unknownPiContent: "error" },
    );
    expect(converted.message.type).toBe("message");
    expect(converted.message.content).toEqual([
      { citations: null, text: "hello", type: "text" },
    ]);
    expect(converted.notices.length).toBeGreaterThan(0);
  });

  it.each([
    ["negative input", { input: -1 }],
    ["fractional output", { output: 1.5 }],
    ["NaN cache read", { cacheRead: Number.NaN }],
    ["infinite cache write", { cacheWrite: Number.POSITIVE_INFINITY }],
  ])(
    "falls back to the atomic all-zero usage for an invalid required component (%s)",
    (_name, overrides) => {
      const converted = convertAssistantMessageToAnthropicWithPolicy(
        message({ usage: usage(overrides) }),
        { selector: "client-selector", createMessageId: () => "opaque-id" },
        { unknownPiContent: "error" },
      );
      expect(converted.message.usage).toEqual({
        cache_creation: null,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        inference_geo: null,
        input_tokens: 0,
        output_tokens: 0,
        output_tokens_details: null,
        server_tool_use: null,
        service_tier: null,
      });
      const notice = converted.notices.find(
        (entry) => entry.code === CLIENT_USAGE_UNAVAILABLE_NOTICE_CODE,
      );
      expect(notice).toBeDefined();
      expect(notice).toMatchObject({
        adapter: "anthropic-messages",
        direction: "response",
        action: "degrade",
      });
    },
  );

  it("fallbacks for a missing required component and for a non-object usage object", () => {
    const missing = convertAssistantMessageToAnthropicWithPolicy(
      message({
        usage: { ...usage(), cacheRead: undefined } as unknown as Usage,
      }),
      { selector: "client-selector" },
      { unknownPiContent: "error" },
    );
    expect(missing.message.usage).toEqual({
      cache_creation: null,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      inference_geo: null,
      input_tokens: 0,
      output_tokens: 0,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    });
    expect(missing.notices.map((notice) => notice.code)).toContain(
      CLIENT_USAGE_UNAVAILABLE_NOTICE_CODE,
    );

    const nonObject = convertAssistantMessageToAnthropicWithPolicy(
      message({ usage: null as unknown as Usage }),
      { selector: "client-selector" },
      { unknownPiContent: "error" },
    );
    expect(nonObject.message.usage).toEqual({
      cache_creation: null,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      inference_geo: null,
      input_tokens: 0,
      output_tokens: 0,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    });
    expect(nonObject.notices.map((notice) => notice.code)).toContain(
      CLIENT_USAGE_UNAVAILABLE_NOTICE_CODE,
    );
  });

  it.each([
    ["reasoning exceeding output", { output: 1, reasoning: 2 }, 1],
    ["fractional reasoning", { reasoning: 1.5 }, 8],
    ["negative reasoning", { reasoning: -1 }, 8],
  ])(
    "omits invalid optional reasoning and keeps valid required components (%s)",
    (_name, overrides, expectedOutput) => {
      const converted = convertAssistantMessageToAnthropicWithPolicy(
        message({
          usage: usage({ input: 4, output: 8, ...(overrides as Partial<Usage>) }),
        }),
        { selector: "client-selector" },
        { unknownPiContent: "error" },
      );
      expect(converted.message.usage.output_tokens_details).toBeNull();
      expect(converted.message.usage.input_tokens).toBe(4);
      expect(converted.message.usage.output_tokens).toBe(expectedOutput);
      const notice = converted.notices.find(
        (entry) => entry.code === CLIENT_USAGE_REASONING_UNAVAILABLE_NOTICE_CODE,
      );
      expect(notice).toBeDefined();
      expect(notice!.jsonPath).toBe("$.usage.reasoning");
    },
  );

  it.each([
    ["exceeding total cache write", { cacheWrite: 1, cacheWrite1h: 2 }, 1],
    ["fractional cache write", { cacheWrite: 3, cacheWrite1h: 1.5 }, 3],
    ["negative cache write", { cacheWrite: 3, cacheWrite1h: -1 }, 3],
  ])(
    "drops only the invalid 1h/5m split and retains total cache write (%s)",
    (_name, overrides, expectedWrite) => {
      const converted = convertAssistantMessageToAnthropicWithPolicy(
        message({ usage: usage(overrides as Partial<Usage>) }),
        { selector: "client-selector" },
        { unknownPiContent: "error" },
      );
      expect(converted.message.usage.cache_creation).toBeNull();
      expect(converted.message.usage.cache_creation_input_tokens).toBe(
        expectedWrite,
      );
      const notice = converted.notices.find(
        (entry) => entry.code === CLIENT_USAGE_CACHE_SPLIT_UNAVAILABLE_NOTICE_CODE,
      );
      expect(notice).toBeDefined();
      expect(notice!.jsonPath).toBe("$.usage.cacheWrite1h");
    },
  );

  it("ignores extra usage-only keys with a bounded warning while preserving allowlisted components", () => {
    const hostile = usage({ input: 4, output: 8, cacheRead: 3, cacheWrite: 7 }) as Usage & {
      providerNativeUsage?: unknown;
    };
    hostile.providerNativeUsage = { inputTokens: -5, secret: "nope" };
    const converted = convertAssistantMessageToAnthropicWithPolicy(
      message({ usage: hostile }),
      { selector: "client-selector" },
      { unknownPiContent: "error" },
    );
    expect(converted.message.usage.input_tokens).toBe(4);
    expect(converted.message.usage.output_tokens).toBe(8);
    expect(converted.message.usage.cache_read_input_tokens).toBe(3);
    expect(converted.message.usage.cache_creation_input_tokens).toBe(7);
    expect(JSON.stringify(converted.message.usage)).not.toContain(
      "providerNativeUsage",
    );
    expect(JSON.stringify(converted.message.usage)).not.toContain("secret");
    expect(converted.notices.map((notice) => notice.code)).toContain(
      CLIENT_USAGE_UNKNOWN_FIELDS_NOTICE_CODE,
    );
  });

  it("keeps totalTokens out of the Anthropic wire without a warning (no target total exists)", () => {
    const converted = convertAssistantMessageToAnthropicWithPolicy(
      message({
        usage: usage({ input: 1, output: 2, totalTokens: -7 }),
      }),
      { selector: "client-selector" },
      { unknownPiContent: "error" },
    );
    expect(converted.message.usage).not.toHaveProperty("totalTokens");
    expect(converted.message.usage.input_tokens).toBe(1);
    expect(converted.message.usage.output_tokens).toBe(2);
    expect(converted.notices).toHaveLength(0);
  });

  it.each([
    ["stop", "end_turn"],
    ["length", "max_tokens"],
  ] as const)("maps %s to %s", (stopReason, expected) => {
    const target = convertAssistantMessageToAnthropic(
      message({ stopReason }),
      "client-selector",
      "opaque-id",
    );
    expect(target.stop_reason).toBe(expected);
    expect(target.stop_details).toBeNull();
    expect(target.stop_sequence).toBeNull();
  });

  it("derives tool_use from actual toolCall content, not the Pi stop reason", () => {
    const target = convertAssistantMessageToAnthropic(
      message({
        stopReason: "toolUse",
        content: [
          { type: "toolCall", id: "call", name: "tool", arguments: { x: 1 } },
        ],
      }),
      "client-selector",
      "opaque-id",
    );
    expect(target.stop_reason).toBe("tool_use");

    const noTool = convertAssistantMessageToAnthropic(
      message({ stopReason: "toolUse" }),
      "client-selector",
      "opaque-id",
    );
    expect(noTool.stop_reason).toBe("end_turn");
  });

  it("echoes only client identity and includes all required Message fields", () => {
    const source = message({
      responseModel: "provider-response-model",
      responseId: "provider-response-id",
      diagnostics: [
        { type: "provider-detail", timestamp: 1, details: { secret: "hidden" } },
      ],
      errorMessage: "diagnostic only",
      rawStopReason: "provider-raw-reason",
      content: [
        { type: "text", text: "text", textSignature: "opaque-text" },
        {
          type: "toolCall",
          id: "call",
          name: "tool",
          arguments: {},
          thoughtSignature: "opaque-thought",
        } as AssistantMessage["content"][number],
      ],
    }) as AssistantMessage & { endTurn?: boolean };
    source.endTurn = true;

    const target = convertAssistantMessageToAnthropic(
      source,
      "original-client-selector",
      "client-owned-id",
    );
    // Ticket 09: a valid Pi responseId is preserved; the generator is only a
    // fallback. The source carries provider-response-id, so that wins.
    expect(target).toMatchObject({
      id: "provider-response-id",
      container: null,
      model: "original-client-selector",
      role: "assistant",
      stop_details: null,
      stop_sequence: null,
      type: "message",
    });
    expect(Object.keys(target).sort()).toEqual(
      [
        "id",
        "container",
        "content",
        "model",
        "role",
        "stop_details",
        "stop_reason",
        "stop_sequence",
        "type",
        "usage",
      ].sort(),
    );
    const wire = JSON.stringify(target);
    for (const internal of [
      "internal-api",
      "internal-provider",
      "internal-model",
      "opaque-text",
      "opaque-thought",
      "secret",
    ]) {
      expect(wire).not.toContain(internal);
    }
    expect(JSON.parse(wire)).toEqual(target);
  });

  it("rejects a Pi 0.84.2 ToolCall namespace that Anthropic cannot represent", () => {
    expect(() =>
      convertAssistantMessageToAnthropic(
        message({
          stopReason: "toolUse",
          content: [
            {
              type: "toolCall",
              id: "call_ns",
              name: "read",
              namespace: "crm",
              arguments: {},
            },
          ],
        }),
        "client-selector",
        "client-owned-id",
      ),
    ).toThrow(/namespace/i);
  });

  it("projects redacted thinking as redacted_thinking in content order", () => {
    const target = convertAssistantMessageToAnthropic(
      message({
        content: [
          { type: "text", text: "A" },
          {
            type: "thinking",
            thinking: "",
            thinkingSignature: "redacted-payload",
            redacted: true,
          },
          { type: "text", text: "B" },
        ],
      }),
      "client-selector",
      "opaque-id",
    );
    expect(target.content).toEqual([
      { citations: null, text: "A", type: "text" },
      { data: "redacted-payload", type: "redacted_thinking" },
      { citations: null, text: "B", type: "text" },
    ]);
  });

  it("succeeds for a redacted-only projected message", () => {
    const target = convertAssistantMessageToAnthropic(
      message({
        content: [
          {
            type: "thinking",
            thinking: "",
            thinkingSignature: "redacted-payload",
            redacted: true,
          },
        ],
      }),
      "client-selector",
      "opaque-id",
    );
    expect(target.content).toEqual([
      { data: "redacted-payload", type: "redacted_thinking" },
    ]);
  });

  it("fails deferred state and unclassified future fields", () => {
    expect(() =>
      assertOutboundResponseFidelity(
        message({
          stopReason: "deferred",
          deferred: { provider: "p", modelId: "m", api: "a", id: "handle" },
        }),
      ),
    ).toThrow("Deferred");
    const future = message() as AssistantMessage & { futureField?: boolean };
    future.futureField = true;
    expect(() => assertOutboundResponseFidelity(future)).toThrow(
      "unclassified field",
    );
  });
});
