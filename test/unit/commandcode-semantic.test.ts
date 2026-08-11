import type { Model, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import type { CommandCodeResult } from "../../src/providers/commandcode-private/assembler.js";
import {
  applyCommandCodeCapturedPricing,
  captureCommandCodeResponseAuthority,
  convertCommittedCommandCodeResult,
} from "../../src/providers/commandcode-private/semantic.js";

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

function result(
  rawUsage: Record<string, unknown> | undefined,
  overrides: Partial<CommandCodeResult> = {},
): CommandCodeResult {
  return {
    content: [],
    finish: { type: "finish", finishReason: "stop" },
    ...(rawUsage === undefined ? {} : { rawUsage }),
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    ...overrides,
  };
}

describe("committed CommandCode to Pi semantics", () => {
  it.each([
    {
      name: "uncached input only",
      raw: { inputTokens: 10, outputTokens: 2 },
      expected: { input: 10, cacheRead: 0, cacheWrite: 0, output: 2 },
    },
    {
      name: "cache read",
      raw: {
        inputTokens: 10,
        inputTokenDetails: { cacheReadTokens: 3 },
        outputTokens: 2,
      },
      expected: { input: 7, cacheRead: 3, cacheWrite: 0, output: 2 },
    },
    {
      name: "cache write",
      raw: {
        inputTokens: 10,
        inputTokenDetails: { cacheWriteTokens: 2 },
        outputTokens: 2,
      },
      expected: { input: 8, cacheRead: 0, cacheWrite: 2, output: 2 },
    },
    {
      name: "read and write",
      raw: {
        inputTokens: 10,
        inputTokenDetails: { cacheReadTokens: 3, cacheWriteTokens: 2 },
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

  it("uses normalized zero usage when final usage is completely absent", () => {
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

  it("validates reasoning as an output subset and ignores raw totalTokens", () => {
    const authority = captureCommandCodeResponseAuthority(model(), () => 10);
    const message = convertCommittedCommandCodeResult(
      result({
        inputTokens: 4,
        outputTokens: 6,
        outputTokenDetails: { reasoningTokens: 3 },
        totalTokens: 999,
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
  ])("uses zero failure accounting for $name", ({ raw }) => {
    const authority = captureCommandCodeResponseAuthority(model(), () => 10);
    const message = convertCommittedCommandCodeResult(result(raw), authority);
    expect(message).toMatchObject({
      content: [],
      stopReason: "error",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
      },
    });
  });

  it("ignores raw inputTokens when an explicit noCache partition is present", () => {
    const authority = captureCommandCodeResponseAuthority(model(), () => 10);
    const message = convertCommittedCommandCodeResult(
      result({
        inputTokens: 11,
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

  it("does not read top-level reasoningTokens as an alias", () => {
    const authority = captureCommandCodeResponseAuthority(model(), () => 10);
    const message = convertCommittedCommandCodeResult(
      result({
        inputTokens: 1,
        outputTokens: 2,
        reasoningTokens: 3,
      }),
      authority,
    );
    expect(message.usage.reasoning).toBeUndefined();
  });

  it("preserves ordered content and finish diagnostics without signatures", () => {
    const authority = captureCommandCodeResponseAuthority(model(), () => 10);
    const message = convertCommittedCommandCodeResult(
      result(
        { inputTokens: 1, outputTokens: 2 },
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
        },
      ),
      authority,
    );

    expect(message).toMatchObject({
      stopReason: "toolUse",
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
    ["length", "length"],
    ["stop", "stop"],
  ])("maps finish %s to %s", (finishReason, expected) => {
    const authority = captureCommandCodeResponseAuthority(model(), () => 10);
    const message = convertCommittedCommandCodeResult(
      result(undefined, {
        finish: { type: "finish", finishReason },
      }),
      authority,
    );
    expect(message.stopReason).toBe(expected);
    expect(message.rawStopReason).toBe(finishReason);
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
          { inputTokens: 4, outputTokens: 2 },
          {
            content: [
              { type: "text", id: "discarded", text: "partial" },
              { type: "tool_use", id: "call", toolName: "tool", input },
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
        { inputTokens: 1, outputTokens: 1 },
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
          { inputTokens: 4, outputTokens: 2 },
          {
            content: [
              { type: "tool_use", id: "call", toolName: "tool", input },
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

  it("fails reasoning from a non-reasoning route and converts ordinary tool calls", () => {
    const nonReasoning = model();
    nonReasoning.reasoning = false;
    const authority = captureCommandCodeResponseAuthority(nonReasoning, () => 10);
    const failed = convertCommittedCommandCodeResult(
      result(
        { inputTokens: 1, outputTokens: 1 },
        {
          content: [{ type: "reasoning" as const, id: "r", text: "hidden" }],
          finish: { type: "finish", finishReason: "stop" },
        },
      ),
      authority,
    );
    expect(failed).toMatchObject({ content: [], stopReason: "error" });

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
      result({
        inputTokens: 3,
        inputTokenDetails: { cacheReadTokens: 1 },
        outputTokens: 1,
      }),
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
