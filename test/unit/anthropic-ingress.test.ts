import { describe, expect, it } from "vitest";

import { InvalidRequest, UnsupportedFeature } from "../../src/protocols/anthropic/failures.js";
import {
  assertImplementedAnthropicProfile,
  resolveAnthropicSourceProfile,
} from "../../src/protocols/anthropic/profile.js";
import { parseAnthropicTextInvocation } from "../../src/protocols/anthropic/request.js";

function baselineHeaders(extra?: Record<string, string>): Headers {
  return new Headers({ "anthropic-version": "2023-06-01", ...extra });
}

function minimalBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    model: "model",
    max_tokens: 32,
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

describe("Anthropic profile and semantic-header classification", () => {
  it("recognizes the exact baseline case-insensitively and retains unknown Anthropic markers", () => {
    const profile = resolveAnthropicSourceProfile(
      new Headers([
        ["AnThRoPiC-VeRsIoN", "2023-06-01"],
        ["X-AnThRoPiC-Future-Control", "enabled"],
        ["X-Unrelated-Header", "ignored"],
      ]),
    );

    expect(profile.version).toBe("2023-06-01");
    expect([...profile.betas]).toEqual([]);
    expect(profile.unclassifiedAnthropicHeaders).toEqual([
      "anthropic-future-control",
    ]);
    expect(profile.userProfileIdPresent).toBe(false);
    expect(() => assertImplementedAnthropicProfile(profile)).not.toThrow();
  });

  it("separates malformed envelopes from valid but unsupported profiles", () => {
    expect(() => resolveAnthropicSourceProfile(new Headers())).toThrow(
      InvalidRequest,
    );
    expect(() =>
      resolveAnthropicSourceProfile(
        new Headers({ "anthropic-version": "not-a-date" }),
      ),
    ).toThrow(InvalidRequest);
    expect(() =>
      resolveAnthropicSourceProfile(
        baselineHeaders({ "anthropic-beta": "valid-beta,,another-beta" }),
      ),
    ).toThrow(InvalidRequest);

    const futureVersion = resolveAnthropicSourceProfile(
      new Headers({ "anthropic-version": "2024-01-01" }),
    );
    expect(() => assertImplementedAnthropicProfile(futureVersion)).toThrow(
      UnsupportedFeature,
    );
    const futureBeta = resolveAnthropicSourceProfile(
      baselineHeaders({ "anthropic-beta": "future-feature-2026-01-01" }),
    );
    expect(() => assertImplementedAnthropicProfile(futureBeta)).toThrow(
      UnsupportedFeature,
    );
  });

  it("owns the user-profile beta/header legality without implementing that grammar", () => {
    const missingBeta = resolveAnthropicSourceProfile(
      baselineHeaders({ "anthropic-user-profile-id": "profile_1" }),
    );
    expect(() => assertImplementedAnthropicProfile(missingBeta)).toThrow(
      InvalidRequest,
    );

    const activeBeta = resolveAnthropicSourceProfile(
      baselineHeaders({
        "anthropic-beta": "user-profiles-2026-03-24",
        "anthropic-user-profile-id": "profile_1",
      }),
    );
    expect(() => assertImplementedAnthropicProfile(activeBeta)).toThrow(
      UnsupportedFeature,
    );
  });
});

describe("Anthropic closed-world body acceptance", () => {
  it("lets known source invalidity beat retained unknown header/body semantics", () => {
    expect(() =>
      parseAnthropicTextInvocation(
        minimalBody({ max_tokens: "invalid", future_control: true }),
        1,
        ["anthropic-future-control"],
      ),
    ).toThrow(InvalidRequest);
  });

  it("rejects unknown body and Anthropic-owned header semantics as unsupported", () => {
    expect(() =>
      parseAnthropicTextInvocation(minimalBody({ future_control: true }), 1, []),
    ).toThrow(UnsupportedFeature);
    expect(() =>
      parseAnthropicTextInvocation(minimalBody(), 1, [
        "anthropic-future-control",
      ]),
    ).toThrow(UnsupportedFeature);
    expect(() =>
      parseAnthropicTextInvocation(
        minimalBody({
          messages: [{ role: "user", content: "hello", future_field: true }],
        }),
        1,
        [],
      ),
    ).toThrow(UnsupportedFeature);
  });

  it("finishes known field-shape validity before feature rejection", () => {
    expect(() =>
      parseAnthropicTextInvocation(
        minimalBody({
          future_control: true,
          thinking: "malformed",
        }),
        1,
        [],
      ),
    ).toThrow(InvalidRequest);
  });

  it("preserves the frozen explicit-empty-array grammar boundaries", () => {
    expect(() =>
      parseAnthropicTextInvocation(
        minimalBody({ messages: [{ role: "user", content: [] }] }),
        1,
        [],
      ),
    ).toThrow(UnsupportedFeature);

    expect(() =>
      parseAnthropicTextInvocation(
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
        [],
      ),
    ).toThrow(UnsupportedFeature);
  });
});
