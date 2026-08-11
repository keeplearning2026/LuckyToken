import type {
  AssistantMessage,
  Context,
  Model,
  Models,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";

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
      if (event.reason === "aborted") {
        throw new ExecutionAbortedError(signal?.reason);
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
      throw new ExecutionFailure(
        "Pi execution reported an error",
        event.error.errorMessage,
      );
    }
    if (event.type === "done") {
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

  constructor(reason?: unknown) {
    super("Pi execution was aborted");
    this.name = "ExecutionAbortedError";
    this.reason = reason;
  }
}

export class ExecutionFailure extends Error {
  readonly reason = "error";
  readonly diagnostic: unknown;

  constructor(message: string, diagnostic?: unknown) {
    super(message, diagnostic instanceof Error ? { cause: diagnostic } : undefined);
    this.name = "ExecutionFailure";
    this.diagnostic = diagnostic;
  }
}

export class UnsupportedExecutionOutcomeError extends ExecutionFailure {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedExecutionOutcomeError";
  }
}

export class MalformedExecutionStreamError extends ExecutionFailure {
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
