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
  createExecutionOperation,
  ExecutionAbortedError,
  ExecutionFailure,
  MalformedExecutionStreamError,
  UnsupportedExecutionOutcomeError,
} from "../../src/execution.js";
import {
  createConversionNoticeDiagnostic,
  createInvocationAttemptDiagnostic,
  type ExecutionFactsSink,
} from "@token/provider-contract/diagnostics";
import {
  createUpstreamFailureDiagnostic,
  createUpstreamFailureFact,
} from "@token/provider-contract/diagnostics";

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
  it("promotes synchronous stream construction failures into ExecutionFailure", async () => {
    const diagnostic = new Error("synchronous provider construction failed");
    const models = {
      streamSimple: vi.fn(() => {
        throw diagnostic;
      }),
    } as unknown as Models;

    await expect(
      execute(models, model, context, { maxTokens: 10 }),
    ).rejects.toMatchObject({
      kind: "ExecutionFailure",
      reason: "error",
      diagnostic,
    });
  });

  it("promotes synchronous iterator construction failures into ExecutionFailure", async () => {
    const diagnostic = new Error("iterator construction failed");
    const stream = {
      [Symbol.asyncIterator]: () => {
        throw diagnostic;
      },
    } as unknown as AssistantMessageEventStream;
    const fixture = modelsFor(stream);

    await expect(
      execute(fixture.models, model, context, { maxTokens: 10 }),
    ).rejects.toMatchObject({
      kind: "ExecutionFailure",
      reason: "error",
      diagnostic,
    });
  });

  it("lets an already-aborted caller win over synchronous stream construction failure", async () => {
    const controller = new AbortController();
    controller.abort(new Error("caller cancelled"));
    const models = {
      streamSimple: vi.fn(() => {
        throw new Error("provider construction failed");
      }),
    } as unknown as Models;

    await expect(
      execute(models, model, context, {
        maxTokens: 10,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(ExecutionAbortedError);
  });

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

  it("preserves the complete neutral Provider fact by identity through Pi execution", async () => {
    const failure = createUpstreamFailureFact({
      kind: "upstream_stream",
      status: 503,
      providerType: "opaque_type",
      providerCode: "opaque_code",
      message: "safe provider failure",
      headers: { "request-id": "req-123", "retry-after": "2" },
      retryable: true,
      attemptCount: 2,
      snapshot: {
        capturedBytes: 12,
        totalBytes: 40,
        truncated: true,
      },
    });
    const failedMessage = message("error", "human fallback only");
    failedMessage.diagnostics = [
      createUpstreamFailureDiagnostic(failure, 1),
    ];
    const fixture = modelsFor(
      streamFrom([
        { type: "error", reason: "error", error: failedMessage },
      ]),
    );

    try {
      await execute(fixture.models, model, context, { maxTokens: 10 });
      throw new Error("expected execution failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ExecutionFailure);
      expect((error as ExecutionFailure).diagnostic).toBe(
        "human fallback only",
      );
      expect((error as ExecutionFailure).failure).toBe(failure);
    }

    expect(context.messages).toEqual([
      { role: "user", content: "hello", timestamp: 1 },
    ]);
    expect(context.messages).not.toContain(failedMessage);
  });

  it("submits trusted Provider conversion notices through the narrow facts sink", async () => {
    const notice = Object.freeze({
      adapter: "commandcode-private",
      direction: "request" as const,
      code: "missing_tool_result_xrepair",
      jsonPath: "$.messages",
      action: "xrepair" as const,
    });
    const complete = message("stop");
    const attempt = Object.freeze({
      attempt: 1,
      classification: "success",
      stage: "complete",
      status: 200,
    });
    complete.diagnostics = [
      createConversionNoticeDiagnostic(notice, 1),
      createInvocationAttemptDiagnostic(attempt, 1),
      Object.freeze({
        type: "Token.invocation_attempt.v1",
        timestamp: 1,
        details: Object.freeze({ attempt }),
      }),
    ];
    const fixture = modelsFor(
      streamFrom([{ type: "done", reason: "stop", message: complete }]),
    );
    const sink: ExecutionFactsSink = {
      notice: vi.fn(),
      attempt: vi.fn(),
    };

    await execute(fixture.models, model, context, { maxTokens: 10 }, sink);

    expect(sink.notice).toHaveBeenCalledOnce();
    expect(sink.notice).toHaveBeenCalledWith(notice);
    expect(sink.attempt).toHaveBeenCalledOnce();
    expect(sink.attempt).toHaveBeenCalledWith(attempt);
  });

  it("submits every trusted Provider attempt summary before promoting failure", async () => {
    const first = Object.freeze({
      attempt: 1,
      classification: "http",
      stage: "response_headers",
      status: 503,
      retryable: true,
    });
    const second = Object.freeze({
      attempt: 2,
      classification: "timeout",
      stage: "response_body",
      retryable: true,
    });
    const failure = createUpstreamFailureFact({
      kind: "timeout",
      phase: "response_body",
      message: "timed out",
      retryable: true,
      attemptCount: 2,
    });
    const failedMessage = message("error", "fallback");
    failedMessage.diagnostics = [
      createUpstreamFailureDiagnostic(failure, 1),
      createInvocationAttemptDiagnostic(first, 1),
      createInvocationAttemptDiagnostic(second, 1),
    ];
    const fixture = modelsFor(
      streamFrom([{ type: "error", reason: "error", error: failedMessage }]),
    );
    const sink: ExecutionFactsSink = {
      notice: vi.fn(),
      attempt: vi.fn(),
    };

    await expect(
      execute(fixture.models, model, context, { maxTokens: 10 }, sink),
    ).rejects.toMatchObject({ failure });
    expect(sink.attempt).toHaveBeenNthCalledWith(1, first);
    expect(sink.attempt).toHaveBeenNthCalledWith(2, second);
    expect(sink.notice).not.toHaveBeenCalled();
  });

  it("keeps caller cancellation structurally distinct from upstream abort", async () => {
    const callerCancellation = createUpstreamFailureFact({
      kind: "caller_cancellation",
      message: "caller disconnected",
    });
    const cancelledMessage = message("aborted");
    cancelledMessage.diagnostics = [
      createUpstreamFailureDiagnostic(callerCancellation, 1),
    ];
    const cancelled = modelsFor(
      streamFrom([
        {
          type: "error",
          reason: "aborted",
          error: cancelledMessage,
        },
      ]),
    );

    try {
      await execute(cancelled.models, model, context, { maxTokens: 10 });
      throw new Error("expected caller cancellation");
    } catch (error) {
      expect(error).toBeInstanceOf(ExecutionAbortedError);
      expect((error as ExecutionAbortedError).failure).toBe(callerCancellation);
    }

    const upstreamAbort = createUpstreamFailureFact({
      kind: "upstream_stream",
      message: "upstream event named abort",
    });
    const upstreamMessage = message("error", "upstream abort");
    upstreamMessage.diagnostics = [
      createUpstreamFailureDiagnostic(upstreamAbort, 2),
    ];
    const upstream = modelsFor(
      streamFrom([
        { type: "error", reason: "error", error: upstreamMessage },
      ]),
    );

    await expect(
      execute(upstream.models, model, context, { maxTokens: 10 }),
    ).rejects.toMatchObject({
      failure: upstreamAbort,
      reason: "error",
    });

    const mislabeledMessage = message("aborted");
    mislabeledMessage.diagnostics = [
      createUpstreamFailureDiagnostic(upstreamAbort, 3),
    ];
    const mislabeled = modelsFor(
      streamFrom([
        {
          type: "error",
          reason: "aborted",
          error: mislabeledMessage,
        },
      ]),
    );
    await expect(
      execute(mislabeled.models, model, context, { maxTokens: 10 }),
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

  it("submits the terminal-usage snapshot on a done terminal before returning", async () => {
    const complete = message("stop");
    const fixture = modelsFor(
      streamFrom([{ type: "done", reason: "stop", message: complete }]),
    );
    const sink: ExecutionFactsSink = {
      notice: vi.fn(),
      attempt: vi.fn(),
      terminalUsage: vi.fn(),
    };

    const result = await execute(fixture.models, model, context, { maxTokens: 10 }, sink);

    expect(result).toBe(complete);
    expect(sink.terminalUsage).toHaveBeenCalledOnce();
    expect(sink.terminalUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        input: 0,
        cacheRead: 0,
        output: 0,
        terminalClass: "done",
      }),
    );
  });

  it("submits a failed-terminal snapshot before promoting failure", async () => {
    const failedMessage = message("error", "fallback");
    const fixture = modelsFor(
      streamFrom([{ type: "error", reason: "error", error: failedMessage }]),
    );
    const sink: ExecutionFactsSink = {
      notice: vi.fn(),
      attempt: vi.fn(),
      terminalUsage: vi.fn(),
    };

    await expect(
      execute(fixture.models, model, context, { maxTokens: 10 }, sink),
    ).rejects.toBeInstanceOf(ExecutionFailure);
    expect(sink.terminalUsage).toHaveBeenCalledOnce();
    expect(sink.terminalUsage).toHaveBeenCalledWith(
      expect.objectContaining({ terminalClass: "failed" }),
    );
  });

  it("submits an aborted-terminal snapshot before the abort throws", async () => {
    const abortedMessage = message("aborted");
    const fixture = modelsFor(
      streamFrom([
        { type: "error", reason: "aborted", error: abortedMessage },
      ]),
    );
    const sink: ExecutionFactsSink = {
      notice: vi.fn(),
      attempt: vi.fn(),
      terminalUsage: vi.fn(),
    };

    await expect(
      execute(fixture.models, model, context, { maxTokens: 10 }, sink),
    ).rejects.toBeInstanceOf(ExecutionAbortedError);
    expect(sink.terminalUsage).toHaveBeenCalledOnce();
    expect(sink.terminalUsage).toHaveBeenCalledWith(
      expect.objectContaining({ terminalClass: "aborted" }),
    );
  });

  it("submits an unsupported-terminal snapshot before rejecting deferred", async () => {
    const fixture = modelsFor(
      streamFrom([
        { type: "done", reason: "deferred", message: message("deferred") },
      ]),
    );
    const sink: ExecutionFactsSink = {
      notice: vi.fn(),
      attempt: vi.fn(),
      terminalUsage: vi.fn(),
    };

    await expect(
      execute(fixture.models, model, context, { maxTokens: 10 }, sink),
    ).rejects.toBeInstanceOf(UnsupportedExecutionOutcomeError);
    expect(sink.terminalUsage).toHaveBeenCalledOnce();
    expect(sink.terminalUsage).toHaveBeenCalledWith(
      expect.objectContaining({ terminalClass: "unsupported" }),
    );
  });

  it("submits no snapshot for malformed terminals whose message is untrustworthy", async () => {
    const mismatch = modelsFor(
      streamFrom([
        { type: "done", reason: "stop", message: message("length") },
      ]),
    );
    const sink: ExecutionFactsSink = {
      notice: vi.fn(),
      attempt: vi.fn(),
      terminalUsage: vi.fn(),
    };

    await expect(
      execute(mismatch.models, model, context, { maxTokens: 10 }, sink),
    ).rejects.toBeInstanceOf(MalformedExecutionStreamError);
    expect(sink.terminalUsage).not.toHaveBeenCalled();
  });

  it("copies only product usage from the terminal Pi AssistantMessage", async () => {
    const declaredModel: Model<string> = {
      ...model,
      api: "anthropic-messages",
    };
    const complete = message("stop");
    complete.usage = {
      input: 5,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 7,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const fixture = modelsFor(
      streamFrom([{ type: "done", reason: "stop", message: complete }]),
    );
    const sink: ExecutionFactsSink = {
      notice: vi.fn(),
      attempt: vi.fn(),
      terminalUsage: vi.fn(),
    };

    const result = await execute(
      fixture.models,
      declaredModel,
      context,
      { maxTokens: 10 },
      sink,
    );

    expect(result).toBe(complete);
    expect(sink.terminalUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        input: 5,
        output: 2,
        cacheRead: 0,
        terminalClass: "done",
      }),
    );
  });

  it("exposes the same narrow contract through the handler operation", async () => {
    const declaredModel: Model<string> = {
      ...model,
      api: "anthropic-messages",
    };
    const complete = message("stop");
    complete.usage = {
      input: 5,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 7,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const fixture = modelsFor(
      streamFrom([{ type: "done", reason: "stop", message: complete }]),
    );
    const boundSink: ExecutionFactsSink = {
      notice: vi.fn(),
      attempt: vi.fn(),
      terminalUsage: vi.fn(),
    };

    const bound = createExecutionOperation();
    const result = await bound(
      fixture.models,
      declaredModel,
      context,
      { maxTokens: 10 },
      boundSink,
    );

    expect(result).toBe(complete);
    expect(boundSink.terminalUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        input: 5,
        output: 2,
        cacheRead: 0,
        terminalClass: "done",
      }),
    );
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
