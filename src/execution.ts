import type {
  AssistantMessage,
  Context,
  Model,
  Models,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  createUpstreamFailureFact,
  findUpstreamFailureFact,
  type UpstreamFailureFact,
} from "./protocols/upstream-failure.js";
import {
  submitExecutionFacts,
  type ExecutionFactsSink,
} from "./execution-facts.js";

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreezeInvocationData(
  value: unknown,
  seen: Set<object> = new Set(),
): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  if (!Array.isArray(value) && !isPlainObject(value)) return;
  seen.add(value);
  for (const nested of Object.values(value)) {
    deepFreezeInvocationData(nested, seen);
  }
  Object.freeze(value);
}

export function freezePiInvocation(
  model: Model<string>,
  context: Context,
  options: ModelsSimpleStreamOptions,
): void {
  deepFreezeInvocationData(model);
  deepFreezeInvocationData(context);
  deepFreezeInvocationData(options);
}

export async function execute(
  models: Models,
  model: Model<string>,
  context: Context,
  options: ModelsSimpleStreamOptions,
  factsSink?: ExecutionFactsSink,
): Promise<AssistantMessage> {
  const stream = models.streamSimple(model, context, options);
  const iterator = stream[Symbol.asyncIterator]();
  const signal = options.signal;

  while (true) {
    let next: IteratorResult<Awaited<ReturnType<typeof iterator.next>>["value"]>;
    try {
      next = await nextWithAbort(iterator, signal);
    } catch (error) {
      if (signal?.aborted === true) {
        throw new ExecutionAbortedError(signal.reason);
      }
      throw new ExecutionFailure("Pi execution stream failed", error);
    }
    if (signal?.aborted === true) {
      throw new ExecutionAbortedError(signal.reason);
    }
    if (next.done) {
      throw new MalformedExecutionStreamError(
        "Pi execution ended without a semantic terminal event",
      );
    }
    const event = next.value;
    if (event.type === "error") {
      submitExecutionFacts(event.error.diagnostics, factsSink);
      if (event.reason === "aborted") {
        const diagnosticFailure = findUpstreamFailureFact(
          event.error.diagnostics,
        );
        if (
          diagnosticFailure !== undefined &&
          diagnosticFailure.kind !== "caller_cancellation"
        ) {
          throw new MalformedExecutionStreamError(
            "Pi aborted terminal carried a non-cancellation failure",
          );
        }
        const failure = diagnosticFailure ?? createCallerCancellationFact();
        throw new ExecutionAbortedError(signal?.reason, failure);
      }
      if (event.reason !== "error") {
        throw new MalformedExecutionStreamError(
          `Pi error terminal used unsupported reason: ${String(event.reason)}`,
        );
      }
      if (event.error.stopReason !== "error") {
        throw new MalformedExecutionStreamError(
          "Pi error terminal reason did not match its AssistantMessage",
        );
      }
      const failure = findUpstreamFailureFact(event.error.diagnostics);
      if (failure?.kind === "caller_cancellation") {
        throw new MalformedExecutionStreamError(
          "Pi error terminal carried a caller-cancellation failure",
        );
      }
      throw new ExecutionFailure(
        "Pi execution reported an error",
        event.error.errorMessage,
        failure,
      );
    }
    if (event.type === "done") {
      submitExecutionFacts(event.message.diagnostics, factsSink);
      if (event.reason === "deferred") {
        throw new UnsupportedExecutionOutcomeError(
          "Pi deferred completion is outside LuckyToken Core v1",
        );
      }
      if (
        event.reason !== "stop" &&
        event.reason !== "length" &&
        event.reason !== "toolUse"
      ) {
        throw new MalformedExecutionStreamError(
          `Pi done terminal used unsupported reason: ${String(event.reason)}`,
        );
      }
      if (event.message.stopReason !== event.reason) {
        throw new MalformedExecutionStreamError(
          "Pi done terminal reason did not match its AssistantMessage",
        );
      }
      return event.message;
    }
  }
}

export class ExecutionAbortedError extends Error {
  readonly reason: unknown;
  readonly failure: UpstreamFailureFact;

  constructor(
    reason?: unknown,
    failure: UpstreamFailureFact = createCallerCancellationFact(),
  ) {
    super("Pi execution was aborted");
    this.name = "ExecutionAbortedError";
    this.reason = reason;
    this.failure = failure;
  }
}

function createCallerCancellationFact(): UpstreamFailureFact {
  return createUpstreamFailureFact({
    kind: "caller_cancellation",
    message: "Request was cancelled by its caller",
  });
}

export class ExecutionFailure extends Error {
  readonly kind: string = "ExecutionFailure";
  readonly reason = "error";
  readonly diagnostic: unknown;
  readonly failure: UpstreamFailureFact | undefined;

  constructor(
    message: string,
    diagnostic?: unknown,
    failure?: UpstreamFailureFact,
  ) {
    super(message, diagnostic instanceof Error ? { cause: diagnostic } : undefined);
    this.name = "ExecutionFailure";
    this.diagnostic = diagnostic;
    this.failure = failure;
  }
}

export class UnsupportedExecutionOutcomeError extends ExecutionFailure {
  readonly kind = "UnsupportedExecutionOutcomeError";

  constructor(message: string) {
    super(message);
    this.name = "UnsupportedExecutionOutcomeError";
  }
}

export class MalformedExecutionStreamError extends ExecutionFailure {
  readonly kind = "MalformedExecutionStreamError";

  constructor(message: string) {
    super(message);
    this.name = "MalformedExecutionStreamError";
  }
}

async function nextWithAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal | undefined,
): Promise<IteratorResult<T>> {
  if (signal === undefined) return await iterator.next();
  if (signal.aborted) throw new ExecutionAbortedError(signal.reason);

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new ExecutionAbortedError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([iterator.next(), aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}
