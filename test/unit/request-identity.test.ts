import { describe, expect, it, vi } from "vitest";

import { resolveRequestIdentity } from "../../src/request-identity.js";

const headerPrecedence = [
  ["x-session-id", "00000000-0000-4000-8000-000000000001"],
  ["x-claude-code-session-id", "00000000-0000-4000-8000-000000000002"],
  ["session-id", "00000000-0000-7000-8000-000000000003"],
  ["thread-id", "00000000-0000-4000-8000-000000000004"],
  ["x-client-request-id", "00000000-0000-4000-8000-000000000005"],
  ["x-session-affinity", "00000000-0000-4000-8000-000000000006"],
] as const;

describe("request identity session headers", () => {
  it("selects the first valid UUID using the fixed header precedence", () => {
    for (let index = 0; index < headerPrecedence.length; index += 1) {
      const headers = new Headers();
      for (const [name, value] of headerPrecedence.slice(index)) {
        headers.set(name, value);
      }
      const expected = headerPrecedence[index]![1];

      expect(resolveRequestIdentity(headers)).toEqual({
        clientSessionId: expected,
        effectiveSessionId: expected,
      });
    }
  });

  it("skips invalid higher-precedence values", () => {
    const claudeSessionId = headerPrecedence[1][1];
    const identity = resolveRequestIdentity(
      new Headers({
        "x-session-id": "not-a-uuid",
        "x-claude-code-session-id": `  ${claudeSessionId}  `,
      }),
    );

    expect(identity).toEqual({
      clientSessionId: claudeSessionId,
      effectiveSessionId: claudeSessionId,
    });
  });

  it("generates exactly one fallback only when no client UUID is usable", () => {
    const fallback = "00000000-0000-4000-8000-000000000099";
    const createSessionId = vi.fn(() => fallback);

    const identity = resolveRequestIdentity(
      new Headers({ "session-id": "invalid" }),
      createSessionId,
    );

    expect(identity).toEqual({ effectiveSessionId: fallback });
    expect(createSessionId).toHaveBeenCalledOnce();
    expect(Object.isFrozen(identity)).toBe(true);
  });

  it("rejects an invalid generated fallback", () => {
    expect(() =>
      resolveRequestIdentity(new Headers(), () => "not-a-uuid"),
    ).toThrow("Request identity generator returned an invalid UUID");
  });
});
