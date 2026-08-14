import { describe, expect, it } from "vitest";

import {
  MAX_TIMER_DELAY_MS,
  resolveCommandCodeExecutionControls,
  resolveCommandCodeRetryDelayMs,
} from "../../src/providers/commandcode-private/attempts.js";

describe("CommandCode attempt controls", () => {
  it("applies frozen defaults and accepts timer-domain boundaries", () => {
    expect(resolveCommandCodeExecutionControls(undefined)).toEqual({
      maxRetries: 0,
      timeoutMs: undefined,
      maxRetryDelayMs: 60_000,
      onResponse: undefined,
    });
    expect(
      resolveCommandCodeExecutionControls({
        maxRetries: 2,
        timeoutMs: MAX_TIMER_DELAY_MS,
        maxRetryDelayMs: 0,
      }),
    ).toMatchObject({
      maxRetries: 2,
      timeoutMs: MAX_TIMER_DELAY_MS,
      maxRetryDelayMs: 0,
    });
  });

  it.each([
    ["negative retries", { maxRetries: -1 }],
    ["fractional retries", { maxRetries: 1.5 }],
    ["too many retries", { maxRetries: 101 }],
    ["zero timeout", { timeoutMs: 0 }],
    ["negative timeout", { timeoutMs: -1 }],
    ["fractional timeout", { timeoutMs: 1.5 }],
    ["large timeout", { timeoutMs: MAX_TIMER_DELAY_MS + 1 }],
    ["negative delay cap", { maxRetryDelayMs: -1 }],
    ["fractional delay cap", { maxRetryDelayMs: 1.5 }],
    ["large delay cap", { maxRetryDelayMs: MAX_TIMER_DELAY_MS + 1 }],
  ])("rejects %s", (_name, options) => {
    expect(() => resolveCommandCodeExecutionControls(options)).toThrow();
  });

  it("uses retry-after-ms, seconds, dates, then deterministic fallback", () => {
    expect(
      resolveCommandCodeRetryDelayMs(
        new Headers({ "retry-after-ms": "1500.1", "retry-after": "9" }),
        0,
        10_000,
        1_000,
      ),
    ).toBe(1501);
    expect(
      resolveCommandCodeRetryDelayMs(
        new Headers({ "retry-after-ms": "bad", "retry-after": "2" }),
        0,
        10_000,
        1_000,
      ),
    ).toBe(2_000);
    expect(
      resolveCommandCodeRetryDelayMs(
        new Headers({
          "retry-after-ms": "bad",
          "retry-after": new Date(3_500).toUTCString(),
        }),
        0,
        10_000,
        1_000,
      ),
    ).toBe(2_000);
    expect(
      resolveCommandCodeRetryDelayMs(
        new Headers({ "retry-after": "-1" }),
        0,
        10_000,
        1_000,
      ),
    ).toBe(500);
    expect(
      resolveCommandCodeRetryDelayMs(
        new Headers({ "retry-after": "malformed" }),
        2,
        10_000,
        1_000,
      ),
    ).toBe(2_000);
    expect(
      resolveCommandCodeRetryDelayMs(
        new Headers({ "retry-after": new Date(0).toUTCString() }),
        0,
        10_000,
        1_000,
      ),
    ).toBe(0);
  });

  it("fails valid but unacceptable server delays instead of clamping", () => {
    expect(() =>
      resolveCommandCodeRetryDelayMs(
        new Headers({ "retry-after-ms": "1500" }),
        0,
        1_000,
        0,
      ),
    ).toThrow("max: 1000ms");
    expect(() =>
      resolveCommandCodeRetryDelayMs(
        new Headers({ "retry-after-ms": String(MAX_TIMER_DELAY_MS + 1) }),
        0,
        0,
        0,
      ),
    ).toThrow("timer domain");
  });
});
