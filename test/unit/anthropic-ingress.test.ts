import { describe, expect, it } from "vitest";

import { InvalidRequest, UnsupportedFeature } from "../../src/protocols/anthropic/failures.js";
import {
  assertImplementedAnthropicProfile,
  resolveAnthropicSourceProfile,
} from "../../src/protocols/anthropic/profile.js";
import { parseAnthropicTextInvocation } from "../../src/protocols/anthropic/request.js";

function minimalBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    model: "model",
    max_tokens: 32,
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

describe("Anthropic version header gate", () => {
  it("accepts the implemented version and ignores every other header", () => {
    for (const extra of [
      { "anthropic-beta": "anything" },
      { "anthropic-beta": "valid-beta,,malformed-list" },
      { "anthropic-dangerous-direct-browser-access": "true" },
      { "x-arbitrary-agent-header": "anything" },
      { "anthropic-user-profile-id": "profile_1" },
    ]) {
      const profile = resolveAnthropicSourceProfile(
        new Headers({
          "AnThRoPiC-VeRsIoN": "2023-06-01",
          ...extra,
        }),
      );

      expect(profile).toEqual({ version: "2023-06-01" });
      expect(() => assertImplementedAnthropicProfile(profile)).not.toThrow();
    }
  });

  it("rejects unsupported versions", () => {
    const futureVersion = resolveAnthropicSourceProfile(
      new Headers({ "anthropic-version": "2024-01-01" }),
    );
    expect(() => assertImplementedAnthropicProfile(futureVersion)).toThrow(
      UnsupportedFeature,
    );
  });

  it("rejects a missing or malformed anthropic-version", () => {
    expect(() => resolveAnthropicSourceProfile(new Headers())).toThrow(
      InvalidRequest,
    );
    expect(() =>
      resolveAnthropicSourceProfile(
        new Headers({ "anthropic-version": "not-a-date" }),
      ),
    ).toThrow(InvalidRequest);
  });
});

describe("Anthropic closed-world body acceptance", () => {
  it("lets known source invalidity beat unsupported body semantics", () => {
    expect(() =>
      parseAnthropicTextInvocation(
        minimalBody({ max_tokens: "invalid", future_control: true }),
        1,
      ),
    ).toThrow(InvalidRequest);
  });

  it("ignores unknown body and message fields per doc §7", () => {
    const invocation = parseAnthropicTextInvocation(
      minimalBody({
        future_control: true,
        messages: [
          {
            role: "user",
            content: "hello",
            future_field: true,
          },
        ],
      }),
      1,
    );
    expect(invocation.invocation.pi.context.messages[0]?.content).toEqual([
      { type: "text", text: "hello" },
    ]);
  });

  it("finishes known field-shape validity before feature rejection", () => {
    expect(() =>
      parseAnthropicTextInvocation(
        minimalBody({
          future_control: true,
          thinking: "malformed",
        }),
        1,
      ),
    ).toThrow(InvalidRequest);
  });

  it("preserves the frozen explicit-empty-array grammar boundaries", () => {
    const emptyUser = parseAnthropicTextInvocation(
      minimalBody({ messages: [{ role: "user", content: [] }] }),
      1,
    );
    expect(emptyUser.invocation.pi.context.messages[0]).toMatchObject({
      role: "user",
      content: [],
    });

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
              { type: "tool_result", tool_use_id: "tool_1", content: [] },
            ],
          },
        ],
      }),
      1,
    );
    const result = invocation.invocation.pi.context.messages.find(
      (m) => m.role === "toolResult",
    );
    expect(result?.content).toEqual([]);
  });
});

describe("Anthropic message-role validation", () => {
  it("accepts the Token-compatible message-level system role", () => {
    const invocation = parseAnthropicTextInvocation(
      minimalBody({ messages: [{ role: "system", content: "runtime hint" }] }),
      1,
    );
    expect(invocation.invocation.pi.context.systemPrompt).toBe("runtime hint");
    expect(invocation.client.notices).toContainEqual({
      adapter: "anthropic-messages",
      direction: "request",
      code: "anthropic_message_system_degraded",
      jsonPath: "$.messages",
      action: "degrade",
    });
  });

  it("rejects unknown role values that are not user/assistant", () => {
    expect(() =>
      parseAnthropicTextInvocation(
        minimalBody({ messages: [{ role: "tool", content: "x" }] }),
        1,
      ),
    ).toThrow(InvalidRequest);
  });

});
