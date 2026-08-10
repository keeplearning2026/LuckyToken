import type {
  AssistantMessage,
  Context,
  Model,
  Models,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";

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
    const next = await nextWithAbort(iterator, signal);
    if (next.done) {
      throw new Error("Pi execution ended without a terminal event");
    }
    const event = next.value;
    if (event.type === "error") {
      if (signal?.aborted === true || event.reason === "aborted") {
        throw new ExecutionAbortedError(signal?.reason);
      }
      throw new Error(event.error.errorMessage ?? "Pi execution failed");
    }
    if (event.type === "done") {
      if (event.reason === "deferred" || event.message.stopReason !== event.reason) {
        throw new Error("Pi terminal did not contain a supported consistent message");
      }
      if (signal?.aborted === true) {
        throw new ExecutionAbortedError(signal.reason);
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
