import { describe, expect, it } from "vitest";

import {
  CommandCodeAbortError,
  CommandCodeContentAssembler,
  CommandCodePauseTurnError,
  CommandCodeProtocolError,
  CommandCodeStreamError,
  CommandCodeTransportError,
} from "../../packages/provider-commandcode-private/src/assembler.js";
import { CommandCodeNeutralFailureError } from "../../packages/provider-commandcode-private/src/failure.js";

function line(event: Record<string, unknown>): string {
  return JSON.stringify(event);
}

function assemble(
  events: Array<Record<string, unknown>>,
  policy?: { pauseTurn: "stop" | "error"; unknownEvent: "error" | "ignore" },
) {
  const assembler = new CommandCodeContentAssembler(policy);
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
    expect(result.rawUsage).toMatchObject({ inputTokens: 2, outputTokens: 3 });
  });

  it("uses final tool authority and never repairs it from preview input", () => {
    const fromArgs = assemble([
      { type: "tool-input-start", id: "tool", toolName: "start-name" },
      { type: "tool-input-delta", id: "tool", delta: "{\"preview\":true}" },
      { type: "tool-input-end", id: "tool" },
      {
        type: "tool-call",
        toolCallId: "tool",
        toolName: "final",
        args: { exact: 7 },
      },
      { type: "finish", finishReason: "tool-calls" },
    ]);
    expect(fromArgs.content).toEqual([
      {
        type: "tool_use",
        id: "tool",
        toolName: "final",
        input: { exact: 7 },
      },
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

    for (const input of [null, 7, "value", [], true]) {
      expect(() =>
        assemble([
          { type: "tool-input-start", id: "tool", toolName: "start" },
          { type: "tool-input-end", id: "tool" },
          { type: "tool-call", toolCallId: "tool", toolName: "final", input },
          { type: "finish", finishReason: "tool-calls" },
        ]),
      ).toThrow(CommandCodeProtocolError);
    }
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

  it("validates known non-content events and commits last finish-step identity", () => {
    const result = assemble([
      { type: "start", arbitrary: true },
      { type: "start-step", request: {} },
      { type: "provider-metadata", providerMetadata: { provider: "x" } },
      {
        type: "finish-step",
        usage: { ignored: true },
        response: { id: "response-1", modelId: "model-1" },
      },
      {
        type: "finish-step",
        usage: { mustNotWin: true },
        response: { id: "response-2", modelId: "model-2" },
      },
      { type: "tool-result", toolCallId: "ignored", output: {} },
      {
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 2, outputTokens: 3 },
      },
    ]);

    expect(result.content).toEqual([]);
    expect(result.responseIdentity).toEqual({
      responseId: "response-2",
      responseModel: "model-2",
    });
    expect(result.rawUsage).toEqual({ inputTokens: 2, outputTokens: 3 });
  });

  it("applies unknown-event policy without allowing an ignored event to finish", () => {
    expect(() => assemble([{ type: "future-event" }])).toThrow(
      CommandCodeProtocolError,
    );

    const ignored = assemble(
      [{ type: "future-event", bounded: true }, { type: "finish" }],
      { pauseTurn: "stop", unknownEvent: "ignore" },
    );
    expect(ignored.notices).toEqual([
      {
        adapter: "commandcode-private",
        direction: "response",
        code: "unknown_event_ignored",
        action: "ignore",
      },
    ]);

    const noFinish = new CommandCodeContentAssembler({
      pauseTurn: "stop",
      unknownEvent: "ignore",
    });
    noFinish.consumeRawLine(line({ type: "future-event" }));
    expect(() => noFinish.finalizeAfterTransportEnd()).toThrow(
      CommandCodeTransportError,
    );

    for (const raw of [
      line({ type: "text-start" }),
      line({ type: "finish", totalUsage: [] }),
      line({ type: "finish-step", response: {} }),
      line({ type: "start-step", request: [] }),
      line({ type: "provider-metadata", providerMetadata: [] }),
      line({ type: "tool-result", toolCallId: "" }),
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
  });

  it("classifies EOF, open blocks, pause policies, abort, and stream errors", () => {
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

    const paused = assemble([
      { type: "text-start", id: "pause" },
      { type: "text-delta", id: "pause", text: "retained" },
      { type: "text-end", id: "pause" },
      {
        type: "finish-step",
        response: { id: "pause-id", modelId: "pause-model" },
      },
      {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: "pause_turn",
        totalUsage: { inputTokens: 1, outputTokens: 2 },
      },
    ]);
    expect(paused.content).toEqual([
      { type: "text", id: "pause", text: "retained" },
    ]);
    expect(paused.responseIdentity).toEqual({
      responseId: "pause-id",
      responseModel: "pause-model",
    });
    expect(paused.notices).toContainEqual({
      adapter: "commandcode-private",
      direction: "response",
      code: "pause_turn_degraded",
      action: "degrade",
    });

    expect(() =>
      assemble(
        [{ type: "finish", rawFinishReason: "pause_turn" }],
        { pauseTurn: "error", unknownEvent: "error" },
      ),
    ).toThrow(CommandCodePauseTurnError);

    expect(
      assemble([{ type: "finish", finishReason: "pause_turn" }]).notices,
    ).toEqual([]);

    const aborted = new CommandCodeContentAssembler();
    try {
      aborted.consumeRawLine(line({ type: "abort" }));
      throw new Error("expected abort failure");
    } catch (error) {
      expect(error).toBeInstanceOf(CommandCodeAbortError);
      expect(error).toBeInstanceOf(CommandCodeNeutralFailureError);
      expect((error as CommandCodeAbortError).failure).toMatchObject({
        kind: "upstream_stream",
        providerType: "abort",
        retryable: false,
      });
    }

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

    for (const statusCode of [429, 200, 299, 600, 429.5]) {
      const failed = new CommandCodeContentAssembler();
      try {
        failed.consumeRawLine(
          line({
            type: "error",
            error: {
              message: "failed\nwithout controls",
              statusCode,
              type: "rate_limit",
              code: "quota_exhausted",
              isRetryable: true,
              body: { mustNotCross: true },
            },
            isRetryable: true,
          }),
        );
        throw new Error("expected stream error");
      } catch (error) {
        expect(error).toBeInstanceOf(CommandCodeStreamError);
        expect((error as CommandCodeStreamError).failure).toMatchObject({
          kind: "upstream_stream",
          ...(statusCode === 429 ? { status: 429 } : {}),
          providerType: "rate_limit",
          providerCode: "quota_exhausted",
          message: "failed without controls",
          retryable: true,
        });
        expect((error as CommandCodeStreamError).message).toBe(
          (error as CommandCodeStreamError).failure.message,
        );
        if (statusCode !== 429) {
          expect((error as CommandCodeStreamError).failure.status).toBeUndefined();
        }
        expect(JSON.stringify((error as CommandCodeStreamError).failure)).not
          .toContain("mustNotCross");
      }
    }
  });

  it("deep-freezes committed results without sharing response state", () => {
    const first = assemble([
      { type: "tool-input-start", id: "tool", toolName: "preview" },
      { type: "tool-input-end", id: "tool" },
      {
        type: "tool-call",
        toolCallId: "tool",
        toolName: "final",
        input: { nested: { exact: true } },
      },
      {
        type: "finish-step",
        response: { id: "first", modelId: "first-model" },
      },
      {
        type: "finish",
        totalUsage: { inputTokenDetails: { cacheReadTokens: 1 } },
      },
    ]);
    const second = assemble([
      {
        type: "finish-step",
        response: { id: "second", modelId: "second-model" },
      },
      { type: "finish" },
    ]);

    expect(first.responseIdentity?.responseId).toBe("first");
    expect(second.responseIdentity?.responseId).toBe("second");
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.content)).toBe(true);
    expect(Object.isFrozen(first.content[0])).toBe(true);
    expect(
      Object.isFrozen(
        (first.content[0] as unknown as { input: { nested: object } }).input
          .nested,
      ),
    ).toBe(true);
    expect(Object.isFrozen(first.finish)).toBe(true);
    expect(Object.isFrozen(first.rawUsage)).toBe(true);
    expect(Object.isFrozen(first.responseIdentity)).toBe(true);
    expect(Object.isFrozen(first.notices)).toBe(true);
  });

  it("isolates interleaved assemblers and clears every staged fact on rollback", () => {
    const first = new CommandCodeContentAssembler({
      pauseTurn: "stop",
      unknownEvent: "ignore",
    });
    const second = new CommandCodeContentAssembler();
    first.consumeRawLine(line({ type: "text-start", id: "first" }));
    second.consumeRawLine(line({ type: "text-start", id: "second" }));
    first.consumeRawLine(
      line({ type: "text-delta", id: "first", text: "A" }),
    );
    second.consumeRawLine(
      line({ type: "text-delta", id: "second", text: "B" }),
    );
    first.consumeRawLine(line({ type: "text-end", id: "first" }));
    second.consumeRawLine(line({ type: "text-end", id: "second" }));
    first.consumeRawLine(line({ type: "future-event" }));
    first.consumeRawLine(
      line({
        type: "finish-step",
        response: { id: "first-id", modelId: "first-model" },
      }),
    );
    second.consumeRawLine(
      line({
        type: "finish-step",
        response: { id: "second-id", modelId: "second-model" },
      }),
    );
    first.consumeRawLine(line({ type: "finish" }));
    second.consumeRawLine(line({ type: "finish" }));

    expect(first.finalizeAfterTransportEnd()).toMatchObject({
      content: [{ text: "A" }],
      responseIdentity: { responseId: "first-id" },
      notices: [{ code: "unknown_event_ignored" }],
    });
    expect(second.finalizeAfterTransportEnd()).toMatchObject({
      content: [{ text: "B" }],
      responseIdentity: { responseId: "second-id" },
      notices: [],
    });

    const rolledBack = new CommandCodeContentAssembler({
      pauseTurn: "stop",
      unknownEvent: "ignore",
    });
    rolledBack.consumeRawLine(line({ type: "text-start", id: "discarded" }));
    rolledBack.consumeRawLine(line({ type: "future-event" }));
    expect(() =>
      rolledBack.consumeRawLine(line({ type: "text-delta", id: "discarded" })),
    ).toThrow(CommandCodeProtocolError);
    rolledBack.consumeRawLine(line({ type: "finish" }));
    expect(rolledBack.finalizeAfterTransportEnd()).toMatchObject({
      content: [],
      notices: [],
    });
  });

  it("omits a whitespace-only text block that precedes a tool call", () => {
    // Real upstreams (DeepSeek via the CommandCode gateway) emit a blank
    // text block ("\n\n") immediately before the tool input; that block
    // carries no information and must not fail the response.
    const result = assemble([
      { type: "text-start", id: "lead" },
      { type: "text-delta", id: "lead", text: "\n\n" },
      { type: "tool-input-start", id: "tool", toolName: "shell_command" },
      { type: "tool-input-delta", id: "tool", delta: "{\"command\":\"echo OK\"}" },
      { type: "text-end", id: "lead" },
      { type: "tool-input-end", id: "tool" },
      {
        type: "tool-call",
        toolCallId: "tool",
        toolName: "shell_command",
        input: { command: "echo OK" },
      },
      { type: "finish", finishReason: "tool-calls" },
    ]);

    expect(result.content).toEqual([
      {
        type: "tool_use",
        id: "tool",
        toolName: "shell_command",
        input: { command: "echo OK" },
      },
    ]);
    expect(result.notices).toEqual([
      { adapter: "commandcode-private", direction: "response", code: "empty_text_block_omitted", action: "ignore" },
    ]);
  });

  it("still rejects a whitespace-only reasoning block", () => {
    expect(() =>
      assemble([
        { type: "reasoning-start", id: "r" },
        { type: "reasoning-delta", id: "r", text: "  " },
        { type: "reasoning-end", id: "r" },
        { type: "finish" },
      ]),
    ).toThrow(CommandCodeProtocolError);
  });
});
