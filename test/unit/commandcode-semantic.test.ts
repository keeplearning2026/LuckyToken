import type { Model, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import type { CommandCodeResult } from "../../packages/provider-commandcode-private/src/assembler.js";
import {
  applyCommandCodeCapturedPricing,
  captureCommandCodeResponseAuthority,
  convertCommittedCommandCodeResult,
} from "../../packages/provider-commandcode-private/src/semantic.js";
import { findUpstreamFailureFact } from "@token/provider-contract/diagnostics";

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function model(): Model<string> {
  return {
    id: "model",
    name: "model",
    api: "api",
    provider: "provider",
    baseUrl: "https://fixture.test",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 100,
  };
}

function trustedUsage(
  input: number,
  output: number,
  cacheRead = 0,
  cacheWrite = 0,
): Record<string, unknown> {
  return {
    inputTokens: input + cacheRead + cacheWrite,
    inputTokenDetails: {
      noCacheTokens: input,
      cacheReadTokens: cacheRead,
      ...(cacheWrite === 0 ? {} : { cacheWriteTokens: cacheWrite }),
    },
    outputTokens: output,
    totalTokens: input + cacheRead + cacheWrite + output,
  };
}

function result(
  rawUsage: Record<string, unknown> | undefined,
  overrides: Partial<CommandCodeResult> = {},
): CommandCodeResult {
  return deepFreeze({
    content: [],
    finish: { type: "finish", finishReason: "stop" },
    ...(rawUsage === undefined ? {} : { rawUsage }),
    notices: [],
    ...overrides,
  });
}

describe("committed CommandCode to Pi semantics", () => {
  it.each([
    {
      name: "uncached input only",
      raw: {
        inputTokens: 10,
        inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 0 },
        outputTokens: 2,
      },
      expected: { input: 10, cacheRead: 0, cacheWrite: 0, output: 2 },
    },
    {
      name: "cache read",
      raw: {
        inputTokens: 10,
        inputTokenDetails: { noCacheTokens: 7, cacheReadTokens: 3 },
        outputTokens: 2,
      },
      expected: { input: 7, cacheRead: 3, cacheWrite: 0, output: 2 },
    },
    {
      name: "explicit cache write",
      raw: {
        inputTokens: 10,
        inputTokenDetails: {
          noCacheTokens: 8,
          cacheReadTokens: 0,
          cacheWriteTokens: 2,
        },
        outputTokens: 2,
      },
      expected: { input: 8, cacheRead: 0, cacheWrite: 2, output: 2 },
    },
    {
      name: "read and write",
      raw: {
        inputTokens: 10,
        inputTokenDetails: {
          noCacheTokens: 5,
          cacheReadTokens: 3,
          cacheWriteTokens: 2,
        },
        outputTokens: 2,
      },
      expected: { input: 5, cacheRead: 3, cacheWrite: 2, output: 2 },
    },
    {
      name: "explicit no-cache partition",
      raw: {
        inputTokens: 10,
        inputTokenDetails: {
          noCacheTokens: 5,
          cacheReadTokens: 3,
          cacheWriteTokens: 2,
        },
        outputTokens: 2,
      },
      expected: { input: 5, cacheRead: 3, cacheWrite: 2, output: 2 },
    },
    {
      name: "partial partition without raw total",
      raw: {
        inputTokenDetails: {
          noCacheTokens: 5,
          cacheReadTokens: 3,
          cacheWriteTokens: 2,
        },
        outputTokens: 2,
      },
      expected: { input: 5, cacheRead: 3, cacheWrite: 2, output: 2 },
    },
  ])("partitions $name without double counting", ({ raw, expected }) => {
    const authority = captureCommandCodeResponseAuthority(model(), () => 10);
    const message = convertCommittedCommandCodeResult(result(raw), authority);

    expect(message.stopReason).toBe("stop");
    expect(message.usage).toMatchObject(expected);
    expect(message.usage.totalTokens).toBe(
      expected.input + expected.cacheRead + expected.cacheWrite + expected.output,
    );
  });

  it("uses Pi all-zero usage when final usage is completely absent", () => {
    const authority = captureCommandCodeResponseAuthority(model(), () => 10);
    const message = convertCommittedCommandCodeResult(
      result(undefined),
      authority,
    );
    expect(message.usage).toMatchObject({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
    });
  });

  it("rejects a mutable value at the committed-result seam", () => {
    const authority = captureCommandCodeResponseAuthority(model(), () => 10);
    const mutable: CommandCodeResult = {
      content: [],
      finish: { type: "finish", finishReason: "stop" },
      notices: [],
    };

    const message = convertCommittedCommandCodeResult(mutable, authority);
    expect(message.stopReason).toBe("error");
    expect(findUpstreamFailureFact(message.diagnostics)?.kind).toBe("conversion");
  });

  it("captures an owned pricing snapshot without freezing caller-owned model fields", () => {
    const selected = model();
    const authority = captureCommandCodeResponseAuthority(selected, () => 10);

    expect(Object.isFrozen(authority)).toBe(true);
    expect(Object.isFrozen(authority.pricingModel)).toBe(true);
    expect(Object.isFrozen(selected.input)).toBe(false);
    selected.input.push("image");
    expect(authority.pricingModel.input).toEqual(["text"]);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid response timestamp %s at authority capture",
    (timestamp) => {
      expect(() =>
        captureCommandCodeResponseAuthority(model(), () => timestamp),
      ).toThrow("response timestamp must be a non-negative safe integer");
    },
  );

  it("validates reasoning as an output subset and consumes raw totalTokens", () => {
    const authority = captureCommandCodeResponseAuthority(model(), () => 10);
    const message = convertCommittedCommandCodeResult(
      result({
        inputTokens: 4,
        inputTokenDetails: { noCacheTokens: 4, cacheReadTokens: 0 },
        outputTokens: 6,
        outputTokenDetails: { reasoningTokens: 3 },
        totalTokens: 10,
      }),
      authority,
    );
    expect(message.usage).toMatchObject({
      input: 4,
      output: 6,
      reasoning: 3,
      totalTokens: 10,
    });
  });

  it.each([
    {
      name: "cached tokens exceed total",
      raw: {
        inputTokens: 2,
        inputTokenDetails: { cacheReadTokens: 3 },
        outputTokens: 1,
      },
    },
    {
      name: "reasoning exceeds output",
      raw: {
        inputTokens: 1,
        outputTokens: 2,
        outputTokenDetails: { reasoningTokens: 3 },
      },
    },
    {
      name: "present null cache evidence",
      raw: {
        inputTokens: 1,
        inputTokenDetails: { cacheReadTokens: null },
        outputTokens: 1,
      },
    },
    { name: "fractional output", raw: { inputTokens: 1, outputTokens: 1.5 } },
    {
      name: "derived total overflow",
      raw: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 },
    },
    {
      name: "inconsistent source total",
      raw: { inputTokens: 1, outputTokens: 1, totalTokens: 999 },
    },
    {
      name: "inconsistent explicit input partition",
      raw: {
        inputTokens: 11,
        inputTokenDetails: {
          noCacheTokens: 5,
          cacheReadTokens: 3,
          cacheWriteTokens: 2,
        },
        outputTokens: 1,
      },
    },
  ])("degrades invalid usage for $name without failing model semantics", ({ raw }) => {
    const authority = captureCommandCodeResponseAuthority(model(), () => 10);
    const message = convertCommittedCommandCodeResult(
      result(raw, { content: [{ type: "text", id: "t", text: "ok" }] }),
      authority,
    );
    expect(message).toMatchObject({
      content: [{ type: "text", text: "ok" }],
      stopReason: "stop",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
      },
    });
    expect(findUpstreamFailureFact(message.diagnostics)).toBeUndefined();
    expect(
      message.diagnostics?.some(
        (diagnostic) =>
          diagnostic.type === "Token.conversion_notice.v1" &&
          diagnostic.details?.notice &&
          (diagnostic.details.notice as { code?: unknown }).code ===
            "usage_unavailable_degraded",
      ),
    ).toBe(true);
  });

  it("cross-checks raw inputTokens when an explicit noCache partition is present", () => {
    const authority = captureCommandCodeResponseAuthority(model(), () => 10);
    const message = convertCommittedCommandCodeResult(
      result({
        inputTokens: 10,
        inputTokenDetails: {
          noCacheTokens: 5,
          cacheReadTokens: 3,
          cacheWriteTokens: 2,
        },
        outputTokens: 1,
      }),
      authority,
    );
    expect(message.usage).toMatchObject({
      input: 5,
      cacheRead: 3,
      cacheWrite: 2,
      output: 1,
    });
    expect(message.stopReason).toBe("stop");
  });

  it("consumes and cross-checks known cache and reasoning aliases", () => {
    const authority = captureCommandCodeResponseAuthority(model(), () => 10);
    const message = convertCommittedCommandCodeResult(
      result({
        inputTokens: 1,
        inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 1 },
        cachedInputTokens: 1,
        outputTokens: 2,
        outputTokenDetails: { reasoningTokens: 1, textTokens: 1 },
        reasoningTokens: 1,
        totalTokens: 3,
      }),
      authority,
    );
    expect(message.usage).toMatchObject({
      input: 0,
      cacheRead: 1,
      output: 2,
      reasoning: 1,
      totalTokens: 3,
    });
    expect(message.usage.cacheWrite1h).toBeUndefined();
  });

  it("does not infer trusted input/cache fields from aliases when direct usage fields are absent", () => {
    const authority = captureCommandCodeResponseAuthority(model(), () => 10);
    const message = convertCommittedCommandCodeResult(
      result(
        {
          inputTokens: 4,
          cachedInputTokens: 1,
          outputTokens: 3,
          reasoningTokens: 2,
          totalTokens: 7,
        },
        { content: [{ type: "text", id: "t", text: "ok" }] },
      ),
      authority,
    );

    expect(message.stopReason).toBe("stop");
    expect(message.content).toEqual([{ type: "text", text: "ok" }]);
    expect(message.usage).toMatchObject({
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      totalTokens: 0,
    });
  });

  it.each([
    {
      name: "cache-read alias conflict",
      raw: {
        inputTokens: 3,
        inputTokenDetails: { cacheReadTokens: 1 },
        cachedInputTokens: 2,
        outputTokens: 1,
      },
    },
    {
      name: "reasoning alias conflict",
      raw: {
        inputTokens: 1,
        outputTokens: 2,
        outputTokenDetails: { reasoningTokens: 1 },
        reasoningTokens: 2,
      },
    },
    {
      name: "text and reasoning output conflict",
      raw: {
        inputTokens: 1,
        outputTokens: 4,
        outputTokenDetails: { textTokens: 2, reasoningTokens: 1 },
      },
    },
  ])("degrades $name without failing the response", ({ raw }) => {
    const authority = captureCommandCodeResponseAuthority(model(), () => 10);
    const message = convertCommittedCommandCodeResult(
      result(raw, { content: [{ type: "text", id: "t", text: "ok" }] }),
      authority,
    );
    expect(message.stopReason).toBe("stop");
    expect(message.content).toEqual([{ type: "text", text: "ok" }]);
    expect(findUpstreamFailureFact(message.diagnostics)).toBeUndefined();
    expect(message.usage.totalTokens).toBe(0);
  });

  it("preserves ordered content and finish diagnostics without signatures", () => {
    const authority = captureCommandCodeResponseAuthority(model(), () => 10);
    const message = convertCommittedCommandCodeResult(
      result(
        {
          inputTokens: 1,
          inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0 },
          outputTokens: 2,
        },
        {
          content: [
            { type: "text", id: "t", text: "text" },
            { type: "reasoning", id: "r", text: "reason" },
            {
              type: "tool_use",
              id: "call",
              toolName: "lookup",
              input: { q: "x" },
            },
          ],
          finish: {
            type: "finish",
            finishReason: "tool-calls",
            rawFinishReason: "raw-tool-reason",
          },
          systemPromptTokens: 99,
          responseIdentity: {
            responseId: "response-2",
            responseModel: "wire-model",
          },
        },
      ),
      authority,
    );

    expect(message).toMatchObject({
      stopReason: "toolUse",
      timestamp: 10,
      responseId: "response-2",
      responseModel: "wire-model",
      rawStopReason: "raw-tool-reason",
      content: [
        { type: "text", text: "text" },
        { type: "thinking", thinking: "reason" },
        { type: "toolCall", id: "call", name: "lookup", arguments: { q: "x" } },
      ],
      diagnostics: [
        {
          type: "commandcode.system_prompt_tokens",
          details: { systemPromptTokens: 99 },
        },
      ],
    });
    expect(message.content[0]).not.toHaveProperty("textSignature");
    expect(message.content[1]).not.toHaveProperty("thinkingSignature");
  });

  it.each([
    ["length", false, "length"],
    ["length", true, "length"],
    ["stop", false, "stop"],
    ["stop", true, "toolUse"],
    ["tool-calls", false, "stop"],
    ["tool-calls", true, "toolUse"],
  ])("maps finish %s with tool=%s to %s", (finishReason, withTool, expected) => {
    const authority = captureCommandCodeResponseAuthority(model(), () => 10);
    const message = convertCommittedCommandCodeResult(
      result(undefined, {
        content: withTool
          ? [{ type: "tool_use", id: "call", toolName: "tool", input: {} }]
          : [],
        finish: { type: "finish", finishReason },
      }),
      authority,
    );
    expect(message.stopReason).toBe(expected);
    expect(message.rawStopReason).toBe(finishReason);
    const mismatch = message.diagnostics?.find(
      (diagnostic) => {
        const notice = diagnostic.details?.notice as
          | { code?: unknown }
          | undefined;
        return (
          diagnostic.type === "Token.conversion_notice.v1" &&
          notice?.code === "finish_content_mismatch_degraded"
        );
      },
    );
    expect(mismatch !== undefined).toBe(withTool !== (finishReason === "tool-calls"));
  });

  it.each(["content-filter", "error", "other", "future-reason", undefined])(
    "maps unknown or missing finish category %s to ordinary end_turn",
    (finishReason) => {
      const authority = captureCommandCodeResponseAuthority(model(), () => 10);
      const message = convertCommittedCommandCodeResult(
        result(undefined, {
          finish: {
            type: "finish",
            ...(finishReason === undefined ? {} : { finishReason }),
          },
        }),
        authority,
      );
      expect(message.stopReason).toBe("stop");
    },
  );

  it.each(["refusal", "model_context_window_exceeded", "pause_turn", "raw-tool"])(
    "does not read rawFinishReason for terminal classification",
    (rawFinishReason) => {
      const authority = captureCommandCodeResponseAuthority(model(), () => 10);
      const message = convertCommittedCommandCodeResult(
        result(undefined, {
          finish: { type: "finish", finishReason: "stop", rawFinishReason },
        }),
        authority,
      );
      expect(message.stopReason).toBe("stop");
      expect(message.rawStopReason).toBe(rawFinishReason);
    },
  );

  it.each([null, [], "bad", 1])(
    "preserves trustworthy usage when tool input %j is unrepresentable",
    (input) => {
      const authority = captureCommandCodeResponseAuthority(model(), () => 10);
      const message = convertCommittedCommandCodeResult(
        result(
          trustedUsage(4, 2),
          {
            content: [
              { type: "text", id: "discarded", text: "partial" },
              {
                type: "tool_use",
                id: "call",
                toolName: "tool",
                input: input as never,
              },
            ],
          },
        ),
        authority,
      );

      expect(message).toMatchObject({
        content: [],
        stopReason: "error",
        usage: { input: 4, output: 2, totalTokens: 6 },
      });
    },
  );

  it("validates and clones the complete runtime tool argument object tree", () => {
    const authority = captureCommandCodeResponseAuthority(model(), () => 10);
    const validInput = { nested: [1, true, null, { text: "exact" }] };
    const valid = convertCommittedCommandCodeResult(
      result(
        trustedUsage(1, 1),
        {
          content: [
            {
              type: "tool_use",
              id: "call",
              toolName: "tool",
              input: validInput,
            },
          ],
          finish: { type: "finish", finishReason: "tool-calls" },
        },
      ),
      authority,
    );
    expect(valid.content[0]).toEqual({
      type: "toolCall",
      id: "call",
      name: "tool",
      arguments: validInput,
    });
    expect((valid.content[0] as { arguments: unknown }).arguments).not.toBe(
      validInput,
    );

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const input of [
      { nested: undefined },
      { nested: BigInt(1) },
      { nested: Number.NaN },
      { nested: new Date(0) },
      { nested: { toJSON: () => ({ repaired: true }) } },
      cycle,
    ]) {
      const failed = convertCommittedCommandCodeResult(
        result(
          trustedUsage(4, 2),
          {
            content: [
              {
                type: "tool_use",
                id: "call",
                toolName: "tool",
                input: input as never,
              },
            ],
            finish: { type: "finish", finishReason: "tool-calls" },
          },
        ),
        authority,
      );
      expect(failed).toMatchObject({
        content: [],
        stopReason: "error",
        usage: { input: 4, output: 2, totalTokens: 6 },
      });
    }
  });

  it("preserves received reasoning from a non-reasoning route and converts ordinary tool calls", () => {
    const nonReasoning = model();
    nonReasoning.reasoning = false;
    const authority = captureCommandCodeResponseAuthority(nonReasoning, () => 10);
    const reasoning = convertCommittedCommandCodeResult(
      result(
        { inputTokens: 1, outputTokens: 1 },
        {
          content: [{ type: "reasoning" as const, id: "r", text: "hidden" }],
          finish: { type: "finish", finishReason: "stop" },
        },
      ),
      authority,
    );
    expect(reasoning).toMatchObject({
      content: [{ type: "thinking", thinking: "hidden" }],
      stopReason: "stop",
    });

    const tool = convertCommittedCommandCodeResult(
      result(
        { inputTokens: 1, outputTokens: 1 },
        {
          content: [
            {
              type: "tool_use" as const,
              id: "call",
              toolName: "tool",
              input: {},
            },
          ],
          finish: { type: "finish", finishReason: "tool-calls" },
        },
      ),
      authority,
    );
    expect(tool).toMatchObject({
      stopReason: "toolUse",
      content: [
        { type: "toolCall", id: "call", name: "tool", arguments: {} },
      ],
    });
  });

  it("omits absent response identity and deep-freezes every returned message", () => {
    const authority = captureCommandCodeResponseAuthority(model(), () => 10);
    const notice = Object.freeze({
      adapter: "commandcode-private",
      direction: "response" as const,
      code: "fixture_notice",
      action: "degrade" as const,
    });
    const message = convertCommittedCommandCodeResult(
      result(
        { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        {
          content: [
            {
              type: "tool_use",
              id: "call",
              toolName: "tool",
              input: { nested: [1, { exact: true }] },
            },
          ],
          finish: { type: "finish", finishReason: "tool-calls" },
        },
      ),
      authority,
      [notice],
    );

    expect(message).not.toHaveProperty("responseId");
    expect(message).not.toHaveProperty("responseModel");
    expect(Object.isFrozen(message)).toBe(true);
    expect(Object.isFrozen(message.content)).toBe(true);
    expect(Object.isFrozen(message.content[0])).toBe(true);
    expect(Object.isFrozen((message.content[0] as { arguments: object }).arguments)).toBe(true);
    expect(Object.isFrozen(message.usage)).toBe(true);
    expect(Object.isFrozen(message.usage.cost)).toBe(true);
    expect(Object.isFrozen(message.diagnostics)).toBe(true);
    expect(Object.isFrozen(message.diagnostics?.[0])).toBe(true);
  });

  it("deep-freezes usage degradation notices without manufacturing a neutral failure", () => {
    const authority = captureCommandCodeResponseAuthority(model(), () => 10);
    const notice = Object.freeze({
      adapter: "commandcode-private",
      direction: "response" as const,
      code: "fixture_notice",
      action: "degrade" as const,
    });
    const message = convertCommittedCommandCodeResult(
      result(
        { inputTokens: 1, outputTokens: 1, totalTokens: 999 },
        { content: [{ type: "text", id: "t", text: "ok" }] },
      ),
      authority,
      [notice],
    );

    expect(message.stopReason).toBe("stop");
    expect(findUpstreamFailureFact(message.diagnostics)).toBeUndefined();
    expect(
      message.diagnostics?.some(
        (diagnostic) => diagnostic.type === "Token.conversion_notice.v1",
      ),
    ).toBe(true);
    expect(Object.isFrozen(message)).toBe(true);
    expect(Object.isFrozen(message.diagnostics)).toBe(true);
    expect(Object.isFrozen(message.diagnostics?.[0])).toBe(true);
  });

  it("uses deep pre-hook tier pricing and Pi one-hour cache-write semantics", () => {
    const selected = model();
    selected.cost = {
      input: 1_000_000,
      output: 2_000_000,
      cacheRead: 500_000,
      cacheWrite: 3_000_000,
      tiers: [
        {
          inputTokensAbove: 0,
          input: 4_000_000,
          output: 5_000_000,
          cacheRead: 6_000_000,
          cacheWrite: 7_000_000,
        },
      ],
    };
    const authority = captureCommandCodeResponseAuthority(selected, () => 10);
    selected.cost.input = 0;
    selected.cost.tiers?.splice(0);

    const message = convertCommittedCommandCodeResult(
      result(trustedUsage(2, 1, 1)),
      authority,
    );
    expect(message.usage.cost).toMatchObject({
      input: 8,
      output: 5,
      cacheRead: 6,
      total: 19,
    });

    const oneHourUsage: Usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 3,
      cacheWrite1h: 2,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    applyCommandCodeCapturedPricing(authority, oneHourUsage);
    expect(oneHourUsage.cost.cacheWrite).toBe(23);
  });
});
