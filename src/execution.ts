import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  Models,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  createUpstreamFailureFact,
  findUpstreamFailureFact,
  submitExecutionFacts,
  type ExecutionFactsSink,
  type UpstreamFailureFact,
} from "@luckytoken/provider-contract/diagnostics";
import {
  normalizeTerminalUsage,
  type TerminalUsageClass,
  type UsageSemanticsResolver,
} from "@luckytoken/provider-contract/usage";

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

/**
 * Ticket 20: the neutral Pi execution operation Client Protocol handlers
 * call. It is the plain `execute` surface without the usage-semantics
 * resolver parameter: the handler never names or carries any usage-semantics
 * type — the Provider/composition side binds the resolver into the operation
 * via `createExecutionOperation` and hands the bound operation to the
 * handler through its options.
 */
export type ExecutionOperation = (
  models: Models,
  model: Model<string>,
  context: Context,
  options: ModelsSimpleStreamOptions,
  factsSink?: ExecutionFactsSink,
) => Promise<AssistantMessage>;

/**
 * Binds the narrow usage-semantics resolver (Provider integration side) into
 * a neutral execution operation. `createExecutionOperation()` with no
 * resolver is the honest default: every api is undeclared and every
 * terminal-usage snapshot is Partial (`undeclared_semantics`).
 */
export function createExecutionOperation(
  resolveUsageSemantics?: UsageSemanticsResolver,
): ExecutionOperation {
  return (models, model, context, options, factsSink) =>
    execute(
      models,
      model,
      context,
      options,
      factsSink,
      resolveUsageSemantics,
    );
}

export async function execute(
  models: Models,
  model: Model<string>,
  context: Context,
  options: ModelsSimpleStreamOptions,
  factsSink?: ExecutionFactsSink,
  /**
   * Ticket 20: the narrow Provider/composition-side operation that resolves
   * the declared usage semantics for one Pi api id. Core never imports the
   * Provider integration directory; the composition root wires this through
   * the handler seam (same pattern as `resolveRequestModel`). Absent means
   * every api is undeclared (Partial undeclared_semantics snapshots).
   */
  resolveUsageSemantics?: UsageSemanticsResolver,
): Promise<AssistantMessage> {
  const signal = options.signal;
  throwIfExecutionAborted(signal);
  /** Ticket 20: capture the canonical terminal-usage snapshot at the Pi
   *  terminal, before execute() returns or throws, so the error-terminal
   *  message is never discarded. Delivered only to an opted-in sink. */
  const observeTerminal = (
    terminalClass: TerminalUsageClass,
    message: AssistantMessage,
  ): void => {
    factsSink?.terminalUsage?.(
      normalizeTerminalUsage(
        model.api,
        message.usage,
        terminalClass,
        resolveUsageSemantics?.(model.api),
      ),
    );
  };
  let iterator: AsyncIterator<AssistantMessageEvent>;
  try {
    const stream = models.streamSimple(model, context, options);
    iterator = stream[Symbol.asyncIterator]();
  } catch (error) {
    throwIfExecutionAborted(signal);
    throw new ExecutionFailure("Pi execution stream failed", error);
  }

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
        observeTerminal("aborted", event.error);
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
      observeTerminal("failed", event.error);
      throw new ExecutionFailure(
        "Pi execution reported an error",
        event.error.errorMessage,
        failure,
      );
    }
    if (event.type === "done") {
      submitExecutionFacts(event.message.diagnostics, factsSink);
      if (event.reason === "deferred") {
        observeTerminal("unsupported", event.message);
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
      observeTerminal("done", event.message);
      return event.message;
    }
  }
}

function throwIfExecutionAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new ExecutionAbortedError(signal.reason);
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
