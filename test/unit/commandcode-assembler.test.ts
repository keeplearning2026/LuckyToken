import { describe, expect, it } from "vitest";

import {
  CommandCodeAbortError,
  CommandCodeContentAssembler,
  CommandCodePauseTurnError,
  CommandCodeProtocolError,
  CommandCodeStreamError,
  CommandCodeTransportError,
} from "../../src/providers/commandcode-private/assembler.js";

function line(event: Record<string, unknown>): string {
  return JSON.stringify(event);
}

function assemble(events: Array<Record<string, unknown>>) {
  const assembler = new CommandCodeContentAssembler();
  for (const event of events) assembler.consumeRawLine(line(event));
  return assembler.finalizeAfterTransportEnd();
}

describe("CommandCode atomic content assembler", () => {
  it("preserves start order across interleaved content namespaces", () => {
    const result = assemble([
      { type: "text-start", id: "same" },
      { type: "reasoning-start", id: "same", providerMetadata: { ignored: true } },
      { type: "tool-input-start", id: "tool", toolName: "preview" },
      { type: "reasoning-delta", id: "same", text: "reason" },
      { type: "text-delta", id: "same", text: "answer" },
      { type: "tool-input-delta", id: "tool", delta: "not authoritative" },
      { type: "reasoning-end", id: "same" },
      { type: "tool-input-end", id: "tool" },
      { type: "text-end", id: "same" },
      {
        type: "tool-call",
        toolCallId: "tool",
        toolName: "final-name",
        input: { exact: true },
      },
      {
        type: "finish",
        finishReason: "tool-calls",
        totalUsage: { inputTokens: 2, outputTokens: 3 },
      },
    ]);

    expect(result.content).toEqual([
      { type: "text", id: "same", text: "answer" },
      { type: "reasoning", id: "same", text: "reason" },
      {
        type: "tool_use",
        id: "tool",
        toolName: "final-name",
        input: { exact: true },
      },
    ]);
    expect(result.usage).toEqual({
      inputTokens: 2,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("uses final tool authority and never repairs it from preview input", () => {
    const fromArgs = assemble([
      { type: "tool-input-start", id: "tool", toolName: "start-name" },
      { type: "tool-input-delta", id: "tool", delta: "{\"preview\":true}" },
      { type: "tool-input-end", id: "tool" },
      { type: "tool-call", toolCallId: "tool", toolName: "final", args: 7 },
      { type: "finish", finishReason: "tool-calls" },
    ]);
    expect(fromArgs.content).toEqual([
      { type: "tool_use", id: "tool", toolName: "final", input: 7 },
    ]);

    const defaulted = assemble([
      { type: "tool-input-start", id: "tool", toolName: "start" },
      { type: "tool-input-delta", id: "tool", delta: "preview" },
      { type: "tool-input-end", id: "tool" },
      { type: "tool-call", toolCallId: "tool", toolName: "final" },
      { type: "finish", finishReason: "tool-calls" },
    ]);
    expect(defaulted.content[0]).toEqual({
      type: "tool_use",
      id: "tool",
      toolName: "final",
      input: {},
    });

    const explicitNull = assemble([
      { type: "tool-input-start", id: "tool", toolName: "start" },
      { type: "tool-input-end", id: "tool" },
      { type: "tool-call", toolCallId: "tool", toolName: "final", input: null },
      { type: "finish", finishReason: "tool-calls" },
    ]);
    expect(explicitNull.content[0]).toEqual({
      type: "tool_use",
      id: "tool",
      toolName: "final",
      input: null,
    });
  });

  it("does not preserve server-execution and dynamic-tool facts in the committed response", () => {
    const result = assemble([
      {
        type: "tool-input-start",
        id: "tool",
        toolName: "start",
      },
      { type: "tool-input-end", id: "tool" },
      {
        type: "tool-call",
        toolCallId: "tool",
        toolName: "final",
        input: {},
      },
      { type: "finish", finishReason: "tool-calls" },
    ]);

    expect(result.content[0]).toEqual({
      type: "tool_use",
      id: "tool",
      toolName: "final",
      input: {},
    });
  });

  it.each([
    ["text delta without start", [{ type: "text-delta", id: "x", text: "x" }]],
    ["text end without start", [{ type: "text-end", id: "x" }]],
    [
      "duplicate text start",
      [
        { type: "text-start", id: "x" },
        { type: "text-start", id: "x" },
      ],
    ],
    [
      "text mutation after close",
      [
        { type: "text-start", id: "x" },
        { type: "text-delta", id: "x", text: "x" },
        { type: "text-end", id: "x" },
        { type: "text-delta", id: "x", text: "late" },
      ],
    ],
    [
      "empty text",
      [
        { type: "text-start", id: "x" },
        { type: "text-delta", id: "x", text: "   " },
        { type: "text-end", id: "x" },
      ],
    ],
    [
      "empty reasoning",
      [
        { type: "reasoning-start", id: "x" },
        { type: "reasoning-end", id: "x" },
      ],
    ],
    ["tool delta without start", [{ type: "tool-input-delta", id: "x", delta: "x" }]],
    ["tool end without start", [{ type: "tool-input-end", id: "x" }]],
    [
      "repeated tool end",
      [
        { type: "tool-input-start", id: "x", toolName: "tool" },
        { type: "tool-input-end", id: "x" },
        { type: "tool-input-end", id: "x" },
      ],
    ],
    [
      "tool call before end",
      [
        { type: "tool-input-start", id: "x", toolName: "tool" },
        { type: "tool-call", toolCallId: "x", toolName: "tool", input: {} },
      ],
    ],
    ["final-only tool call", [{ type: "tool-call", toolCallId: "x", toolName: "tool" }]],
    [
      "tool call after close",
      [
        { type: "tool-input-start", id: "x", toolName: "tool" },
        { type: "tool-input-end", id: "x" },
        { type: "tool-call", toolCallId: "x", toolName: "tool", input: {} },
        { type: "tool-call", toolCallId: "x", toolName: "tool", input: {} },
      ],
    ],
  ])("rejects invalid lifecycle: %s", (_name, events) => {
    const assembler = new CommandCodeContentAssembler();
    expect(() => {
      for (const event of events) assembler.consumeRawLine(line(event));
    }).toThrow(CommandCodeProtocolError);
  });

  it("distinguishes known ignored events from unknown and malformed events", () => {
    expect(
      assemble([
        { type: "start", arbitrary: true },
        { type: "start-step" },
        { type: "provider-metadata", provider: "x" },
        { type: "finish-step", usage: { ignored: true } },
        { type: "finish", finishReason: "stop" },
      ]).content,
    ).toEqual([]);

    for (const raw of [
      line({ type: "future-event" }),
      line({ type: "tool-result", toolCallId: "ignored" }),
      line({ type: "text-start" }),
      line({ type: "finish", totalUsage: [] }),
      "data: {}",
      "[DONE]",
      "42",
    ]) {
      const assembler = new CommandCodeContentAssembler();
      expect(() => assembler.consumeRawLine(raw)).toThrow(
        CommandCodeProtocolError,
      );
    }
  });

  it("treats finish as replaceable candidate and waits until EOF to commit", () => {
    const result = assemble([
      {
        type: "finish",
        finishReason: "length",
        totalUsage: { inputTokens: 99, outputTokens: 99 },
      },
      { type: "text-start", id: "late" },
      { type: "text-delta", id: "late", text: "after finish" },
      { type: "text-end", id: "late" },
      { type: "finish", finishReason: "stop" },
    ]);

    expect(result.content).toEqual([
      { type: "text", id: "late", text: "after finish" },
    ]);
    expect(result.finish.finishReason).toBe("stop");
    expect(result.rawUsage).toBeUndefined();
    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("classifies EOF, open blocks, pause, abort, and stream errors", () => {
    const truncated = new CommandCodeContentAssembler();
    truncated.consumeRawLine(line({ type: "text-start", id: "x" }));
    expect(() => truncated.finalizeAfterTransportEnd()).toThrow(
      CommandCodeTransportError,
    );

    for (const start of [
      { type: "text-start", id: "x" },
      { type: "reasoning-start", id: "x" },
      { type: "tool-input-start", id: "x", toolName: "tool" },
    ]) {
      const open = new CommandCodeContentAssembler();
      open.consumeRawLine(line(start));
      open.consumeRawLine(line({ type: "finish", finishReason: "stop" }));
      expect(() => open.finalizeAfterTransportEnd()).toThrow(
        CommandCodeProtocolError,
      );
    }

    expect(() =>
      assemble([{ type: "finish", rawFinishReason: "pause_turn" }]),
    ).toThrow(CommandCodePauseTurnError);

    const aborted = new CommandCodeContentAssembler();
    expect(() => aborted.consumeRawLine(line({ type: "abort" }))).toThrow(
      CommandCodeAbortError,
    );

    for (const retryable of [false, true]) {
      const failed = new CommandCodeContentAssembler();
      try {
        failed.consumeRawLine(
          line({
            type: "error",
            error: { message: "failed", isRetryable: retryable },
          }),
        );
        throw new Error("expected stream error");
      } catch (error) {
        expect(error).toBeInstanceOf(CommandCodeStreamError);
        expect((error as CommandCodeStreamError).retryable).toBe(retryable);
      }
    }
  });
});
