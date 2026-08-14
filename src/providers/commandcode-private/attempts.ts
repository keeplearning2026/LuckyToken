import type {
  FetchFunction,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";

import {
  CommandCodeContentAssembler,
  CommandCodeProtocolError,
  isRetryableCommandCodeResponseError,
  type CommandCodeResult,
} from "./assembler.js";
import type { ConversionNotice } from "../../invocation-diagnostics/index.js";

export const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const TRACE_ID_PATTERN = /^(?!0{32}$)[0-9a-f]{32}$/u;
const SPAN_ID_PATTERN = /^(?!0{16}$)[0-9a-f]{16}$/u;

export type CommandCodeAttemptResult = CommandCodeResult;

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
  readonly conversionNotices?: readonly ConversionNotice[];
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
  defaults: Readonly<{
    timeoutMs: number | null;
    maxRetries: number;
    maxRetryDelayMs: number;
  }> = { timeoutMs: null, maxRetries: 0, maxRetryDelayMs: DEFAULT_MAX_RETRY_DELAY_MS },
): CommandCodeExecutionControls {
  const maxRetries = requireNonNegativeInteger(
    options?.maxRetries ?? defaults.maxRetries,
    "maxRetries",
  );
  const timeoutMs = options?.timeoutMs ?? defaults.timeoutMs ?? undefined;
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
  const maxRetryDelayMs = options?.maxRetryDelayMs ?? defaults.maxRetryDelayMs;
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

function consumeDecodedLines(
  buffer: string,
  assembler: CommandCodeContentAssembler,
): string {
  let remaining = buffer;
  while (true) {
    const newline = remaining.indexOf("\n");
    if (newline < 0) return remaining;
    assembler.consumeRawLine(remaining.slice(0, newline));
    remaining = remaining.slice(newline + 1);
  }
}

export async function consumeCommandCodeResponse(
  response: Response,
  signal: AbortSignal,
): Promise<CommandCodeResult> {
  if (response.body === null) {
    throw new RetryableAttemptError(
      "CommandCode returned a successful response without a body",
      response.headers,
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const assembler = new CommandCodeContentAssembler();
  let buffer = "";
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
      buffer += decoder.decode(next.value, { stream: true });
      buffer = consumeDecodedLines(buffer, assembler);
    }
    buffer += decoder.decode();
    buffer = consumeDecodedLines(buffer, assembler);
    if (buffer.trim().length > 0) assembler.consumeRawLine(buffer);
    return assembler.finalizeAfterTransportEnd();
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
        "INVALID_EVENT",
        `CommandCode returned HTTP ${receivedResponse.status}`,
      );
    }
    const result = await consumeCommandCodeResponse(
      receivedResponse,
      scope.signal,
    );
    bodyConsumed = true;
    scope.signal.throwIfAborted();
    return result;
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
      const retryable =
        error instanceof RetryableAttemptError ||
        isRetryableCommandCodeResponseError(error);
      if (!retryable || retryIndex >= controls.maxRetries) {
        throw error;
      }
      const delayMs = resolveCommandCodeRetryDelayMs(
        error instanceof RetryableAttemptError ? error.headers : undefined,
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
