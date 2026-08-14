import type {
  FetchFunction,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";

import {
  CommandCodeContentAssembler,
  type CommandCodeResult,
  type CommandCodeResponsePolicy,
} from "./assembler.js";
import {
  attachCommandCodeRetryHeaders,
  commandCodeNeutralFailure,
  commandCodeRetryHeaders,
  CommandCodeNeutralFailureError,
  withCommandCodeAttemptSummaries,
} from "./failure.js";
import {
  captureCommandCodeHttpFailurePayload,
  DEFAULT_COMMANDCODE_FAILURE_CAPTURE_POLICY,
  type CommandCodeFailureCapturePolicy,
} from "./failure-capture.js";
import type {
  ConversionNotice,
  InvocationAttempt,
} from "../../invocation-diagnostics/index.js";
import type { UpstreamFailurePhase } from "../../protocols/upstream-failure.js";

export const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const TRACE_ID_PATTERN = /^(?!0{32}$)[0-9a-f]{32}$/u;
const SPAN_ID_PATTERN = /^(?!0{16}$)[0-9a-f]{16}$/u;
const SAFE_ATTEMPT_ID_PATTERN = /^[A-Za-z0-9_.:/-]{1,256}$/u;

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
  responsePolicy?: CommandCodeResponsePolicy;
  errorCapture?: CommandCodeFailureCapturePolicy;
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
  constructor(
    timeoutMs: number,
    readonly phase: UpstreamFailurePhase,
  ) {
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
  if (maxRetries > 100) {
    throw new Error("maxRetries must be no greater than 100");
  }
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
  currentPhase: () => UpstreamFailurePhase,
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
        controller.abort(new AttemptTimeoutError(timeoutMs, currentPhase()));
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
  responsePolicy?: CommandCodeResponsePolicy,
  errorCapture: CommandCodeFailureCapturePolicy =
    DEFAULT_COMMANDCODE_FAILURE_CAPTURE_POLICY,
): Promise<CommandCodeResult> {
  if (response.body === null) {
    throw new RetryableAttemptError(
      "CommandCode returned a successful response without a body",
      response.headers,
    );
  }
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch (error) {
    throw new RetryableAttemptError(
      "CommandCode response body reader failed",
      response.headers,
      { cause: error },
    );
  }
  const decoder = new TextDecoder();
  const assembler = new CommandCodeContentAssembler(responsePolicy, errorCapture);
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
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Preserve the attempt's semantic or transport result.
    }
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
): Promise<{
  readonly result: CommandCodeAttemptResult;
  readonly responseStatus: number;
  readonly responseHeaders: Headers;
}> {
  let phase: UpstreamFailurePhase = "request";
  const scope = createAttemptScope(
    prepared.signal,
    controls.timeoutMs,
    () => phase,
  );
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
      phase = "connect";
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
    phase = "response_headers";
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
      phase = "response_body";
      const captured = await captureCommandCodeHttpFailurePayload(
        receivedResponse,
        dependencies.errorCapture ?? DEFAULT_COMMANDCODE_FAILURE_CAPTURE_POLICY,
        // Once response headers establish a non-2xx HTTP failure, the
        // capture policy owns its short best-effort body deadline. Preserve
        // that primary HTTP fact if the broader attempt timer expires; only
        // the caller lifecycle signal may still cancel capture.
        prepared.signal,
      );
      bodyConsumed = true;
      throw attachCommandCodeRetryHeaders(
        commandCodeNeutralFailure({
          kind: "http",
          status: receivedResponse.status,
          ...(receivedResponse.statusText.length === 0
            ? {}
            : { statusText: receivedResponse.statusText }),
          ...(captured.providerType === undefined
            ? {}
            : { providerType: captured.providerType }),
          ...(captured.providerCode === undefined
            ? {}
            : { providerCode: captured.providerCode }),
          message: captured.message,
          ...(captured.snapshot === undefined
            ? {}
            : { snapshot: captured.snapshot }),
          headers: receivedResponse.headers,
          retryable,
          truncated: captured.truncated,
        }),
        receivedResponse.headers,
      );
    }
    phase = "response_body";
    const result = await consumeCommandCodeResponse(
      receivedResponse,
      scope.signal,
      dependencies.responsePolicy,
      dependencies.errorCapture,
    );
    bodyConsumed = true;
    scope.signal.throwIfAborted();
    return {
      result,
      responseStatus: receivedResponse.status,
      responseHeaders: receivedResponse.headers,
    };
  } catch (error) {
    if (
      prepared.signal.aborted &&
      !(error instanceof CommandCodeNeutralFailureError)
    ) {
      const cancelled = commandCodeNeutralFailure(
        {
          kind: "caller_cancellation",
          message: "CommandCode invocation was cancelled by its caller",
          retryable: false,
        },
        error,
      );
      attemptStageByError.set(cancelled, phase);
      throw cancelled;
    }
    throw error;
  } finally {
    if ((!bodyConsumed || scope.signal.aborted) && response?.body !== null) {
      try {
        void response?.body?.cancel(scope.signal.reason).catch(() => undefined);
      } catch {
        // A locked body is cancelled by its owning reader.
      }
    }
    scope.dispose();
  }
}

function normalizeAttemptFailure(error: unknown): CommandCodeNeutralFailureError {
  if (error instanceof CommandCodeNeutralFailureError) return error;
  if (error instanceof AttemptTimeoutError) {
    return commandCodeNeutralFailure(
      {
        kind: "timeout",
        phase: error.phase,
        message: error.message,
        retryable: true,
      },
      error,
    );
  }
  if (error instanceof CommandCodeResponseCallbackError) {
    return commandCodeNeutralFailure(
      {
        kind: "callback",
        phase: "response_headers",
        message: "CommandCode onResponse callback failed",
        retryable: false,
      },
      error,
    );
  }
  if (error instanceof RetryableAttemptError) {
    const responseBody = error.message.includes("body");
    const normalized = commandCodeNeutralFailure(
      {
        kind: "transport",
        phase: responseBody ? "response_body" : "connect",
        message: error.message,
        retryable: true,
      },
      error,
    );
    return error.headers === undefined
      ? normalized
      : attachCommandCodeRetryHeaders(normalized, error.headers);
  }
  return commandCodeNeutralFailure(
    {
      kind: "configuration",
      message: "CommandCode attempt configuration failed",
      retryable: false,
    },
    error,
  );
}

const attemptStageByError = new WeakMap<Error, string>();

function safeAttemptId(value: string): string {
  return SAFE_ATTEMPT_ID_PATTERN.test(value)
    ? value
    : `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function attemptSafeIdsFromEntries(
  entries: Iterable<readonly [string, string]>,
): Readonly<Record<string, string>> | undefined {
  const allowed = new Set([
    "request-id",
    "trace-id",
    "x-request-id",
    "x-trace-id",
  ]);
  const selected = [...entries]
    .filter(([name]) => allowed.has(name))
    .map(([name, value]) => [name, safeAttemptId(value)] as const);
  return selected.length === 0
    ? undefined
    : Object.freeze(Object.fromEntries(selected));
}

function attemptSafeIds(
  error: CommandCodeNeutralFailureError,
): Readonly<Record<string, string>> | undefined {
  const entries = Object.entries(error.failure.headers);
  return attemptSafeIdsFromEntries(entries);
}

function summarizeAttempt(
  error: CommandCodeNeutralFailureError,
  attempt: number,
): InvocationAttempt {
  const stage =
    attemptStageByError.get(error) ??
    error.failure.phase ??
    (error.failure.kind === "http" ? "response_headers" : "stream");
  const safeIds = attemptSafeIds(error);
  return Object.freeze({
    attempt,
    classification: error.failure.kind,
    stage,
    ...(error.failure.status === undefined ? {} : { status: error.failure.status }),
    ...(error.failure.retryable === undefined
      ? {}
      : { retryable: error.failure.retryable }),
    ...(safeIds === undefined ? {} : { safeIds }),
  });
}

function successAttempt(
  status: number,
  headers: Headers,
  attempt: number,
): InvocationAttempt {
  const safeIds = attemptSafeIdsFromEntries(
    ["request-id", "trace-id", "x-request-id", "x-trace-id"]
      .map((name) => [name, headers.get(name)] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== null),
  );
  return Object.freeze({
    attempt,
    classification: "success",
    stage: "complete",
    status,
    ...(safeIds === undefined ? {} : { safeIds }),
  });
}

function committedResultWithAttempts(
  result: CommandCodeAttemptResult,
  attempts: readonly InvocationAttempt[],
): CommandCodeAttemptResult {
  return Object.freeze({
    ...result,
    attempts: Object.freeze([...attempts]),
  });
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
  const attempts: InvocationAttempt[] = [];
  while (true) {
    if (prepared.signal.aborted) {
      const cancelled = commandCodeNeutralFailure(
        {
          kind: "caller_cancellation",
          message: "CommandCode invocation was cancelled by its caller",
          retryable: false,
        },
        abortReason(prepared.signal, "CommandCode invocation was cancelled"),
      );
      throw withCommandCodeAttemptSummaries(cancelled, attempts);
    }
    try {
      const completed = await runAttempt(prepared, model, controls, dependencies);
      attempts.push(
        successAttempt(
          completed.responseStatus,
          completed.responseHeaders,
          attempts.length + 1,
        ),
      );
      return committedResultWithAttempts(completed.result, attempts);
    } catch (error) {
      const normalized = normalizeAttemptFailure(error);
      attempts.push(summarizeAttempt(normalized, attempts.length + 1));
      const retryable = normalized.failure.retryable === true;
      if (!retryable || retryIndex >= controls.maxRetries) {
        throw withCommandCodeAttemptSummaries(normalized, attempts);
      }
      let delayMs: number;
      try {
        delayMs = resolveCommandCodeRetryDelayMs(
          commandCodeRetryHeaders(normalized),
          retryIndex,
          controls.maxRetryDelayMs,
          dependencies.now(),
        );
      } catch {
        throw withCommandCodeAttemptSummaries(normalized, attempts);
      }
      retryIndex += 1;
      try {
        await (dependencies.sleep ?? defaultSleep)(delayMs, prepared.signal);
      } catch (sleepError) {
        if (prepared.signal.aborted) {
          const cancelled = commandCodeNeutralFailure(
            {
              kind: "caller_cancellation",
              message: "CommandCode invocation was cancelled by its caller",
              attemptCount: attempts.length,
              retryable: false,
            },
            sleepError,
          );
          throw withCommandCodeAttemptSummaries(cancelled, attempts);
        }
        const retryDelayFailure = commandCodeNeutralFailure(
          {
            kind: "transport",
            phase: "retry_delay",
            message: "CommandCode retry delay failed",
            retryable: false,
            attemptCount: attempts.length,
          },
          sleepError,
        );
        throw withCommandCodeAttemptSummaries(retryDelayFailure, attempts);
      }
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
