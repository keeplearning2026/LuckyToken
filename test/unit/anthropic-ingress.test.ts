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
    expect(invocation.context.messages[0]?.content).toEqual([
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
    expect(emptyUser.context.messages[0]).toMatchObject({
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
    const result = invocation.context.messages.find(
      (m) => m.role === "toolResult",
    );
    expect(result?.content).toEqual([]);
  });
});

describe("Anthropic system-role degradation", () => {
  it("promotes the first messages[].role=system into the systemPrompt", () => {
    const invocation = parseAnthropicTextInvocation(
      minimalBody({ messages: [{ role: "system", content: "runtime hint" }] }),
      1,
    );
    expect(invocation.context.systemPrompt).toBe("runtime hint");
    expect(invocation.context.messages).toHaveLength(0);
  });

  it("promotes only the first system message and degrades later ones to user", () => {
    const invocation = parseAnthropicTextInvocation(
      minimalBody({
        messages: [
          { role: "user", content: "hello" },
          { role: "system", content: "first instruction" },
          { role: "system", content: "second instruction" },
        ],
      }),
      1,
    );
    expect(invocation.context.systemPrompt).toBe("first instruction");
    const users = invocation.context.messages.filter(
      (message) => message.role === "user",
    );
    expect(users).toHaveLength(1);
    const content = users[0]?.content as Array<{ text: string }>;
    expect(content.map((entry) => entry.text)).toEqual([
      "hello",
      "second instruction",
    ]);
  });

  it("preserves relative ordering of degraded later system messages", () => {
    const invocation = parseAnthropicTextInvocation(
      minimalBody({
        messages: [
          { role: "user", content: "A" },
          { role: "system", content: "B" },
          { role: "assistant", content: "C" },
          { role: "system", content: "D" },
        ],
      }),
      1,
    );
    expect(invocation.context.systemPrompt).toBe("B");
    const roles = invocation.context.messages.map((message) => message.role);
    expect(roles).toEqual(["user", "assistant", "user"]);
  });

  it("appends the first system message after the top-level system prompt", () => {
    const invocation = parseAnthropicTextInvocation(
      minimalBody({
        system: "stable root prompt",
        messages: [
          { role: "user", content: "hello" },
          { role: "system", content: "runtime context" },
        ],
      }),
      1,
    );
    expect(invocation.context.systemPrompt).toBe(
      "stable root prompt\nruntime context",
    );
    const userMessages = invocation.context.messages.filter(
      (m) => m.role === "user",
    );
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.content).toEqual([
      { type: "text", text: "hello" },
    ]);
  });

  it("rejects unknown role values that are not user/assistant/system", () => {
    expect(() =>
      parseAnthropicTextInvocation(
        minimalBody({ messages: [{ role: "tool", content: "x" }] }),
        1,
      ),
    ).toThrow(InvalidRequest);
  });

  it("validates system message content blocks as user", () => {
    expect(() =>
      parseAnthropicTextInvocation(
        minimalBody({
          messages: [
            {
              role: "system",
              content: [{ type: "thinking", thinking: "x", signature: "sig" }],
            },
          ],
        }),
        1,
      ),
    ).toThrow(InvalidRequest);
  });
});
