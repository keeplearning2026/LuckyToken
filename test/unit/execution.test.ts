import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  Models,
  ModelsSimpleStreamOptions,
  Usage,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import {
  execute,
  ExecutionAbortedError,
  ExecutionFailure,
  MalformedExecutionStreamError,
  UnsupportedExecutionOutcomeError,
} from "../../src/execution.js";

const usage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const model: Model<string> = {
  id: "model",
  name: "model",
  api: "api",
  provider: "provider",
  baseUrl: "https://fixture.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100,
  maxTokens: 10,
};
const context: Context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

function message(
  stopReason: AssistantMessage["stopReason"],
  errorMessage?: string,
): AssistantMessage {
  const value: AssistantMessage = {
    role: "assistant",
    api: "api",
    provider: "provider",
    model: "model",
    content: [{ type: "text", text: "complete" }],
    usage,
    stopReason,
    timestamp: 1,
  };
  if (errorMessage !== undefined) value.errorMessage = errorMessage;
  return value;
}

function streamFrom(
  events: AssistantMessageEvent[],
  onNext?: () => void,
): AssistantMessageEventStream {
  let index = 0;
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        onNext?.();
        const event = events[index];
        index += 1;
        return event === undefined
          ? { done: true as const, value: undefined }
          : { done: false as const, value: event };
      },
    }),
  } as AssistantMessageEventStream;
}

function modelsFor(stream: AssistantMessageEventStream): {
  models: Models;
  streamSimple: ReturnType<typeof vi.fn>;
} {
  const streamSimple = vi.fn(() => stream);
  return {
    models: { streamSimple } as unknown as Models,
    streamSimple,
  };
}

describe("Core atomic execution", () => {
  it.each(["stop", "length", "toolUse"] as const)(
    "commits one consistent %s success after actively draining",
    async (reason) => {
      const complete = message(reason);
      const partial = message("pending");
      const intermediates = Array.from(
        { length: 2_000 },
        (): AssistantMessageEvent => ({
          type: "text_delta",
          contentIndex: 0,
          delta: "x",
          partial,
        }),
      );
      let nextCalls = 0;
      const stream = streamFrom(
        [...intermediates, { type: "done", reason, message: complete }],
        () => {
          nextCalls += 1;
        },
      );
      const fixture = modelsFor(stream);
      const options: ModelsSimpleStreamOptions = { maxTokens: 10 };

      const result = await execute(
        fixture.models,
        model,
        context,
        options,
      );

      expect(result).toBe(complete);
      expect(nextCalls).toBe(2_001);
      expect(fixture.streamSimple).toHaveBeenCalledWith(model, context, options);
    },
  );

  it("rejects deferred and inconsistent or unknown done terminals", async () => {
    const deferred = modelsFor(
      streamFrom([
        { type: "done", reason: "deferred", message: message("deferred") },
      ]),
    );
    await expect(
      execute(deferred.models, model, context, { maxTokens: 10 }),
    ).rejects.toBeInstanceOf(UnsupportedExecutionOutcomeError);

    const mismatch = modelsFor(
      streamFrom([
        { type: "done", reason: "stop", message: message("length") },
      ]),
    );
    await expect(
      execute(mismatch.models, model, context, { maxTokens: 10 }),
    ).rejects.toBeInstanceOf(MalformedExecutionStreamError);

    const unknown = modelsFor(
      streamFrom([
        {
          type: "done",
          reason: "future",
          message: message("stop"),
        } as unknown as AssistantMessageEvent,
      ]),
    );
    await expect(
      execute(unknown.models, model, context, { maxTokens: 10 }),
    ).rejects.toBeInstanceOf(MalformedExecutionStreamError);
  });

  it("preserves only error/aborted failure classes without reparsing diagnostics", async () => {
    const failedMessage = message("error", "auth-looking diagnostic text");
    const failed = modelsFor(
      streamFrom([{ type: "error", reason: "error", error: failedMessage }]),
    );
    try {
      await execute(failed.models, model, context, { maxTokens: 10 });
      throw new Error("expected execution failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ExecutionFailure);
      expect((error as ExecutionFailure).reason).toBe("error");
      expect((error as ExecutionFailure).diagnostic).toBe(
        "auth-looking diagnostic text",
      );
    }

    const aborted = modelsFor(
      streamFrom([
        { type: "error", reason: "aborted", error: message("aborted") },
      ]),
    );
    await expect(
      execute(aborted.models, model, context, { maxTokens: 10 }),
    ).rejects.toBeInstanceOf(ExecutionAbortedError);

    const inconsistent = modelsFor(
      streamFrom([
        { type: "error", reason: "error", error: message("stop") },
      ]),
    );
    await expect(
      execute(inconsistent.models, model, context, { maxTokens: 10 }),
    ).rejects.toBeInstanceOf(MalformedExecutionStreamError);
  });

  it("races every stalled progress wait against cancellation", async () => {
    const controller = new AbortController();
    let settleNext: ((value: IteratorResult<AssistantMessageEvent>) => void) | undefined;
    const next = new Promise<IteratorResult<AssistantMessageEvent>>((resolve) => {
      settleNext = resolve;
    });
    const stream = {
      [Symbol.asyncIterator]: () => ({ next: () => next }),
    } as AssistantMessageEventStream;
    const fixture = modelsFor(stream);
    const executing = execute(fixture.models, model, context, {
      maxTokens: 10,
      signal: controller.signal,
    });
    controller.abort(new Error("request disconnected"));

    await expect(executing).rejects.toBeInstanceOf(ExecutionAbortedError);
    settleNext?.({
      done: false,
      value: { type: "done", reason: "stop", message: message("stop") },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("lets cancellation beat a late ordinary iterator failure", async () => {
    const controller = new AbortController();
    let rejectNext: ((reason: Error) => void) | undefined;
    const next = new Promise<IteratorResult<AssistantMessageEvent>>(
      (_resolve, reject) => {
        rejectNext = reject;
      },
    );
    const fixture = modelsFor({
      [Symbol.asyncIterator]: () => ({ next: () => next }),
    } as AssistantMessageEventStream);
    const executing = execute(fixture.models, model, context, {
      maxTokens: 10,
      signal: controller.signal,
    });
    controller.abort(new Error("cancel wins"));
    rejectNext?.(new Error("late ordinary failure"));

    await expect(executing).rejects.toBeInstanceOf(ExecutionAbortedError);
  });

  it("fails an observed EOF without terminal and never treats partial tool state as result", async () => {
    const partial = message("pending");
    const fixture = modelsFor(
      streamFrom([
        { type: "toolcall_start", contentIndex: 0, partial },
      ]),
    );
    await expect(
      execute(fixture.models, model, context, { maxTokens: 10 }),
    ).rejects.toBeInstanceOf(MalformedExecutionStreamError);
  });

  it("commits once, ignores a second terminal, and is not reversed by later abort", async () => {
    const controller = new AbortController();
    const complete = message("stop");
    let nextCalls = 0;
    const fixture = modelsFor(
      streamFrom(
        [
          { type: "done", reason: "stop", message: complete },
          { type: "error", reason: "error", error: message("error") },
        ],
        () => {
          nextCalls += 1;
        },
      ),
    );

    const result = await execute(fixture.models, model, context, {
      maxTokens: 10,
      signal: controller.signal,
    });
    controller.abort(new Error("delivery closed after commit"));

    expect(result).toBe(complete);
    expect(nextCalls).toBe(1);
  });
});
