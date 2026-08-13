import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  assertOutboundResponseFidelity,
  convertAssistantMessageToAnthropic,
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

  it.each([
    ["input", { input: -1 }],
    ["output", { output: 1.5 }],
    ["cache read", { cacheRead: Number.NaN }],
    ["cache write", { cacheWrite: Number.POSITIVE_INFINITY }],
    ["reasoning subset", { output: 1, reasoning: 2 }],
    ["cache one-hour subset", { cacheWrite: 1, cacheWrite1h: 2 }],
  ])("rejects malformed usage: %s", (_name, overrides) => {
    expect(() =>
      convertAssistantMessageToAnthropic(
        message({ usage: usage(overrides) }),
        "client-selector",
        "opaque-id",
      ),
    ).toThrow();
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
          namespace: "internal-namespace",
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
      "internal-namespace",
      "secret",
    ]) {
      expect(wire).not.toContain(internal);
    }
    expect(JSON.parse(wire)).toEqual(target);
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
