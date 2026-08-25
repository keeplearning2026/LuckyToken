import type { Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  createTerminalUsageFact,
  decodeTerminalUsageFact,
  type TerminalUsageClass,
} from "@token/provider-contract/usage";

function usage(input: number, output: number, cacheRead: number): Usage {
  return {
    input,
    output,
    cacheRead,
    cacheWrite: 999,
    reasoning: 888,
    totalTokens: 777,
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
  };
}

describe("TerminalUsageFact", () => {
  it.each([
    { input: 7_768, output: 13, cacheRead: 0 },
    { input: 88, output: 27, cacheRead: 7_680 },
  ])(
    "copies the OpenCode Go Pi fixture ($input/$output/$cacheRead) without Provider interpretation",
    ({ input, output, cacheRead }) => {
      expect(createTerminalUsageFact(usage(input, output, cacheRead), "done")).toEqual({
        input,
        output,
        cacheRead,
        terminalClass: "done",
      });
    },
  );

  it("preserves an all-zero Pi usage as a real observation", () => {
    expect(createTerminalUsageFact(usage(0, 0, 0), "done")).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      terminalClass: "done",
    });
  });

  it.each<TerminalUsageClass>(["done", "failed", "aborted", "unsupported"])(
    "keeps the %s terminal class independently of token values",
    (terminalClass) => {
      expect(createTerminalUsageFact(usage(5, 2, 1), terminalClass)).toEqual({
        input: 5,
        output: 2,
        cacheRead: 1,
        terminalClass,
      });
    },
  );

  it.each([
    { name: "negative input", value: { ...usage(1, 2, 3), input: -1 } },
    { name: "fractional output", value: { ...usage(1, 2, 3), output: 1.5 } },
    {
      name: "unsafe cache read",
      value: { ...usage(1, 2, 3), cacheRead: Number.MAX_SAFE_INTEGER + 1 },
    },
    { name: "non-object", value: null },
  ])("drops $name without repairing it", ({ value }) => {
    expect(
      createTerminalUsageFact(value as unknown as Usage, "done"),
    ).toBeUndefined();
  });

  it("round-trips the exact persistence/wire shape", () => {
    const fact = createTerminalUsageFact(usage(88, 27, 7_680), "done");
    expect(decodeTerminalUsageFact(JSON.parse(JSON.stringify(fact)))).toEqual(fact);
  });

  it.each([
    { input: 1, output: 2, cacheRead: 3 },
    { input: 1, output: 2, cacheRead: 3, terminalClass: "done", extra: true },
    { input: 1, output: -2, cacheRead: 3, terminalClass: "done" },
    { input: 1, output: 2, cacheRead: 3, terminalClass: "partial" },
  ])("rejects an invalid decoded fact", (value) => {
    expect(decodeTerminalUsageFact(value)).toBeUndefined();
  });
});
