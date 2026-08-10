import type {
  FetchFunction,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";

export const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const TRACE_ID_PATTERN = /^(?!0{32}$)[0-9a-f]{32}$/u;
const SPAN_ID_PATTERN = /^(?!0{16}$)[0-9a-f]{16}$/u;

export interface CommandCodeAttemptResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface CommandCodeTraceContextCapability {
  resolveLogicalTraceId(telemetryContext: unknown): string | undefined;
  createSpanId(): string;
}

export interface PreparedCommandCodeRequest {
  readonly endpoint: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyText: string;
  readonly signal: AbortSignal;
  readonly fetchImpl: FetchFunction;
  readonly logicalTraceId?: string;
}

export interface CommandCodeExecutionControls {
  maxRetries: number;
  timeoutMs: number | undefined;
  maxRetryDelayMs: number;
  onResponse: SimpleStreamOptions["onResponse"];
}

export interface CommandCodeAttemptDependencies {
  now(): number;
  traceContext?: CommandCodeTraceContextCapability;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

class RetryableAttemptError extends Error {
  readonly headers: Headers | undefined;

  constructor(message: string, headers?: Headers, options?: ErrorOptions) {
    super(message, options);
    this.name = "RetryableAttemptError";
    this.headers = headers;
  }
}

class AttemptTimeoutError extends RetryableAttemptError {
  constructor(timeoutMs: number) {
    super(`CommandCode attempt timed out after ${timeoutMs}ms`);
    this.name = "AttemptTimeoutError";
  }
}

class CommandCodeProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CommandCodeProtocolError";
  }
}

class CommandCodeResponseCallbackError extends Error {
  constructor(options?: ErrorOptions) {
    super("CommandCode onResponse callback failed", options);
    this.name = "CommandCodeResponseCallbackError";
  }
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

export function resolveCommandCodeExecutionControls(
  options: SimpleStreamOptions | undefined,
): CommandCodeExecutionControls {
  const maxRetries = requireNonNegativeInteger(
    options?.maxRetries ?? 0,
    "maxRetries",
  );
  const timeoutMs = options?.timeoutMs;
  if (
    timeoutMs !== undefined &&
    (!Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > MAX_TIMER_DELAY_MS)
  ) {
    throw new Error(
      `timeoutMs must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}`,
    );
  }
  const maxRetryDelayMs = options?.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  if (
    !Number.isSafeInteger(maxRetryDelayMs) ||
    maxRetryDelayMs < 0 ||
    maxRetryDelayMs > MAX_TIMER_DELAY_MS
  ) {
    throw new Error(
      `maxRetryDelayMs must be a non-negative safe integer no greater than ${MAX_TIMER_DELAY_MS}`,
    );
  }
  return { maxRetries, timeoutMs, maxRetryDelayMs, onResponse: options?.onResponse };
}

function normalizeRetryDelay(
  value: number,
  maxRetryDelayMs: number,
  serverRequested: boolean,
): number {
  const normalized = Math.ceil(value);
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < 0 ||
    normalized > MAX_TIMER_DELAY_MS
  ) {
    throw new Error("CommandCode retry delay exceeds the JavaScript timer domain");
  }
  if (
    serverRequested &&
    maxRetryDelayMs > 0 &&
    normalized > maxRetryDelayMs
  ) {
    throw new Error(
      `CommandCode server requested ${normalized}ms retry delay (max: ${maxRetryDelayMs}ms)`,
    );
  }
  return normalized;
}

export function resolveCommandCodeRetryDelayMs(
  headers: Headers | undefined,
  retryIndex: number,
  maxRetryDelayMs: number,
  nowMs: number,
): number {
  const retryAfterMs = headers?.get("retry-after-ms");
  if (retryAfterMs !== null && retryAfterMs !== undefined) {
    const parsed = Number.parseFloat(retryAfterMs);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return normalizeRetryDelay(parsed, maxRetryDelayMs, true);
    }
  }

  const retryAfter = headers?.get("retry-after");
  if (retryAfter !== null && retryAfter !== undefined) {
    const seconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(seconds)) {
      if (seconds >= 0) {
        return normalizeRetryDelay(seconds * 1_000, maxRetryDelayMs, true);
      }
    } else {
      const dateMs = Date.parse(retryAfter);
      if (Number.isFinite(dateMs)) {
        return normalizeRetryDelay(
          Math.max(0, dateMs - nowMs),
          maxRetryDelayMs,
          true,
        );
      }
    }
  }

  const fallback = Math.min(500 * 2 ** retryIndex, 8_000);
  return normalizeRetryDelay(fallback, maxRetryDelayMs, false);
}

function abortReason(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(fallback);
}

async function raceWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  fallback: string,
): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    throw abortReason(signal, fallback);
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal, fallback));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } catch (error) {
    if (signal.aborted) void promise.catch(() => undefined);
    throw error;
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

interface AttemptScope {
  signal: AbortSignal;
  dispose(): void;
}

function createAttemptScope(
  callerSignal: AbortSignal,
  timeoutMs: number | undefined,
): AttemptScope {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onCallerAbort = (): void => {
    if (!controller.signal.aborted) controller.abort(callerSignal.reason);
  };
  if (callerSignal.aborted) onCallerAbort();
  else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => {
      if (!controller.signal.aborted) {
        controller.abort(new AttemptTimeoutError(timeoutMs));
      }
    }, timeoutMs);
  }
  return {
    signal: controller.signal,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      callerSignal.removeEventListener("abort", onCallerAbort);
    },
  };
}

function responseHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

async function readResponseBody(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  if (response.body === null) {
    throw new RetryableAttemptError(
      "CommandCode returned a successful response without a body",
      response.headers,
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await raceWithSignal(
          reader.read(),
          signal,
          "CommandCode response body was cancelled",
        );
      } catch (error) {
        if (signal.aborted) throw error;
        throw new RetryableAttemptError(
          "CommandCode response body transport failed",
          response.headers,
          { cause: error },
        );
      }
      if (next.done) break;
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // Preserve the original attempt failure.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCommandCodeTextResult(textBody: string): CommandCodeAttemptResult {
  const lines = textBody
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  let textId: string | undefined;
  let text = "";
  let textClosed = false;
  let finish: Record<string, unknown> | undefined;

  for (const line of lines) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new CommandCodeProtocolError("CommandCode emitted malformed JSON", {
        cause: error,
      });
    }
    if (!isRecord(event) || typeof event.type !== "string") {
      throw new CommandCodeProtocolError("CommandCode emitted a malformed event");
    }
    switch (event.type) {
      case "text-start":
        if (typeof event.id !== "string" || textId !== undefined) {
          throw new CommandCodeProtocolError(
            "Invalid CommandCode text-start lifecycle",
          );
        }
        textId = event.id;
        break;
      case "text-delta":
        if (event.id !== textId || textClosed || typeof event.text !== "string") {
          throw new CommandCodeProtocolError(
            "Invalid CommandCode text-delta lifecycle",
          );
        }
        text += event.text;
        break;
      case "text-end":
        if (event.id !== textId || textClosed || text.trim().length === 0) {
          throw new CommandCodeProtocolError(
            "Invalid CommandCode text-end lifecycle",
          );
        }
        textClosed = true;
        break;
      case "finish":
        finish = event;
        break;
      case "error": {
        const detail = isRecord(event.error) ? event.error.message : undefined;
        const message =
          typeof detail === "string" ? detail : "CommandCode emitted a stream error";
        if (event.isRetryable === true) throw new RetryableAttemptError(message);
        throw new CommandCodeProtocolError(message);
      }
      case "abort":
        throw new CommandCodeProtocolError("CommandCode emitted a wire abort");
      default:
        throw new CommandCodeProtocolError(
          `Unsupported CommandCode event: ${event.type}`,
        );
    }
  }

  if (finish === undefined) {
    throw new RetryableAttemptError("CommandCode response ended without finish");
  }
  if (!textClosed) {
    throw new CommandCodeProtocolError(
      "CommandCode finish arrived with an incomplete text block",
    );
  }
  if (finish.rawFinishReason === "pause_turn") {
    throw new CommandCodeProtocolError("CommandCode pause_turn is unsupported");
  }
  if (finish.finishReason !== "stop") {
    throw new CommandCodeProtocolError(
      `Unsupported CommandCode finish reason: ${String(finish.finishReason)}`,
    );
  }
  const totalUsage = finish.totalUsage;
  if (!isRecord(totalUsage)) {
    throw new CommandCodeProtocolError(
      "CommandCode finish must include totalUsage",
    );
  }
  return {
    text,
    inputTokens: requireNonNegativeInteger(totalUsage.inputTokens, "inputTokens"),
    outputTokens: requireNonNegativeInteger(
      totalUsage.outputTokens,
      "outputTokens",
    ),
  };
}

function buildAttemptHeaders(
  prepared: PreparedCommandCodeRequest,
  traceContext: CommandCodeTraceContextCapability | undefined,
): Record<string, string> {
  const headers = { ...prepared.headers };
  if (prepared.logicalTraceId !== undefined) {
    if (traceContext === undefined) {
      throw new Error("Prepared CommandCode trace lacks its bound capability");
    }
    const spanId = traceContext.createSpanId();
    if (!SPAN_ID_PATTERN.test(spanId)) {
      throw new Error("CommandCode trace capability returned an invalid span ID");
    }
    headers.traceparent = `00-${prepared.logicalTraceId}-${spanId}-01`;
  }
  return headers;
}

async function runAttempt(
  prepared: PreparedCommandCodeRequest,
  model: Model<string>,
  controls: CommandCodeExecutionControls,
  dependencies: CommandCodeAttemptDependencies,
): Promise<CommandCodeAttemptResult> {
  const scope = createAttemptScope(prepared.signal, controls.timeoutMs);
  let response: Response | undefined;
  let bodyConsumed = false;
  try {
    scope.signal.throwIfAborted();
    const headers = buildAttemptHeaders(prepared, dependencies.traceContext);
    const request = new Request(prepared.endpoint, {
      method: "POST",
      headers,
      body: prepared.bodyText,
      signal: scope.signal,
    });
    try {
      response = await raceWithSignal(
        Promise.resolve().then(() =>
          prepared.fetchImpl(request, { signal: scope.signal }),
        ),
        scope.signal,
        "CommandCode fetch was cancelled",
      );
    } catch (error) {
      if (scope.signal.aborted) throw error;
      throw new RetryableAttemptError("CommandCode network request failed", undefined, {
        cause: error,
      });
    }

    if (response === undefined) {
      throw new RetryableAttemptError(
        "CommandCode fetch completed without a Response",
      );
    }
    const receivedResponse = response;
    if (controls.onResponse !== undefined) {
      const callbackPromise = Promise.resolve().then(() =>
        controls.onResponse?.(
          {
            status: receivedResponse.status,
            headers: responseHeaders(receivedResponse.headers),
          },
          model,
        ),
      );
      try {
        await raceWithSignal(
          callbackPromise,
          scope.signal,
          "CommandCode onResponse was cancelled",
        );
      } catch (error) {
        if (scope.signal.aborted) throw error;
        throw new CommandCodeResponseCallbackError({ cause: error });
      }
    }

    if (!receivedResponse.ok) {
      const retryable =
        receivedResponse.status === 429 || receivedResponse.status >= 500;
      if (retryable) {
        throw new RetryableAttemptError(
          `CommandCode returned HTTP ${receivedResponse.status}`,
          receivedResponse.headers,
        );
      }
      throw new CommandCodeProtocolError(
        `CommandCode returned HTTP ${receivedResponse.status}`,
      );
    }
    const bodyText = await readResponseBody(receivedResponse, scope.signal);
    bodyConsumed = true;
    scope.signal.throwIfAborted();
    return parseCommandCodeTextResult(bodyText);
  } finally {
    if ((!bodyConsumed || scope.signal.aborted) && response?.body !== null) {
      try {
        await response?.body?.cancel(scope.signal.reason);
      } catch {
        // A locked body is cancelled by its owning reader.
      }
    }
    scope.dispose();
  }
}

async function defaultSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortReason(signal, "Retry sleep was cancelled");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal, "Retry sleep was cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function executeCommandCodeAttempts(
  prepared: PreparedCommandCodeRequest,
  model: Model<string>,
  controls: CommandCodeExecutionControls,
  dependencies: CommandCodeAttemptDependencies,
): Promise<CommandCodeAttemptResult> {
  let retryIndex = 0;
  while (true) {
    prepared.signal.throwIfAborted();
    try {
      return await runAttempt(prepared, model, controls, dependencies);
    } catch (error) {
      if (prepared.signal.aborted) {
        throw abortReason(prepared.signal, "CommandCode invocation was cancelled");
      }
      if (!(error instanceof RetryableAttemptError) || retryIndex >= controls.maxRetries) {
        throw error;
      }
      const delayMs = resolveCommandCodeRetryDelayMs(
        error.headers,
        retryIndex,
        controls.maxRetryDelayMs,
        dependencies.now(),
      );
      retryIndex += 1;
      await (dependencies.sleep ?? defaultSleep)(delayMs, prepared.signal);
    }
  }
}

export function resolveLogicalTraceId(
  capability: CommandCodeTraceContextCapability | undefined,
  telemetryContext: unknown,
): string | undefined {
  if (capability === undefined || telemetryContext === undefined) return undefined;
  const traceId = capability.resolveLogicalTraceId(telemetryContext);
  if (traceId !== undefined && !TRACE_ID_PATTERN.test(traceId)) {
    throw new Error("CommandCode trace capability returned an invalid trace ID");
  }
  return traceId;
}
