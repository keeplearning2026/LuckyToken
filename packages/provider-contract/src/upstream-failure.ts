import type { AssistantMessageDiagnostic } from "@earendil-works/pi-ai";

export const UPSTREAM_FAILURE_DIAGNOSTIC_TYPE =
  "token_upstream_failure";

export const MAX_FAILURE_MESSAGE_LENGTH = 1_024;
export const MAX_FAILURE_METADATA_LENGTH = 256;
export const MAX_FAILURE_HEADER_VALUE_LENGTH = 1_024;
export const MAX_FAILURE_SNAPSHOT_BYTES = 65_536;

export type UpstreamFailureKind =
  | "http"
  | "upstream_stream"
  | "transport"
  | "timeout"
  | "configuration"
  | "protocol"
  | "conversion"
  | "callback"
  | "caller_cancellation";

export type UpstreamFailurePhase =
  | "request"
  | "connect"
  | "request_body"
  | "response_headers"
  | "response_body"
  | "stream"
  | "unexpected_eof"
  | "retry_delay"
  | "payload_callback";

export interface UpstreamFailureSnapshotMetadata {
  readonly mediaType?: string;
  readonly capturedBytes: number;
  readonly totalBytes?: number;
  readonly sha256?: string;
  readonly truncated: boolean;
}

/**
 * The complete, safe failure fact allowed to cross the Provider -> Pi ->
 * execution boundary. It deliberately has no raw body, request, prompt, tool
 * output, credential, cause, or stack slot.
 */
export interface UpstreamFailureFact {
  readonly kind: UpstreamFailureKind;
  readonly phase?: UpstreamFailurePhase;
  readonly status?: number;
  readonly statusText?: string;
  readonly providerType?: string;
  readonly providerCode?: string;
  readonly message: string;
  readonly snapshot?: UpstreamFailureSnapshotMetadata;
  readonly headers: Readonly<Record<string, string>>;
  readonly retryable?: boolean;
  readonly attemptCount?: number;
  /** True when any safe field or the upstream capture was truncated. */
  readonly truncated: boolean;
}

export interface UpstreamFailureFactInput {
  readonly kind: UpstreamFailureKind;
  readonly phase?: UpstreamFailurePhase;
  readonly status?: number;
  readonly statusText?: string;
  readonly providerType?: string;
  readonly providerCode?: string;
  readonly message: string;
  readonly snapshot?: {
    readonly mediaType?: string;
    readonly capturedBytes: number;
    readonly totalBytes?: number;
    readonly sha256?: string;
    readonly truncated: boolean;
  };
  readonly headers?: Headers | Readonly<Record<string, string>>;
  readonly retryable?: boolean;
  readonly attemptCount?: number;
  readonly truncated?: boolean;
}

const SAFE_FAILURE_HEADERS = new Set([
  "request-id",
  "retry-after",
  "trace-id",
  "x-request-id",
  "x-trace-id",
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
  "x-ratelimit-limit-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
]);

const FAILURE_KINDS: ReadonlySet<string> = new Set([
  "http",
  "upstream_stream",
  "transport",
  "timeout",
  "configuration",
  "protocol",
  "conversion",
  "callback",
  "caller_cancellation",
]);

const FAILURE_PHASES: ReadonlySet<string> = new Set([
  "request",
  "connect",
  "request_body",
  "response_headers",
  "response_body",
  "stream",
  "unexpected_eof",
  "retry_delay",
  "payload_callback",
]);

const FAILURE_INPUT_KEYS = new Set([
  "kind",
  "phase",
  "status",
  "statusText",
  "providerType",
  "providerCode",
  "message",
  "snapshot",
  "headers",
  "retryable",
  "attemptCount",
  "truncated",
]);

const createdFailureFacts = new WeakSet<object>();

/** Construct and deeply freeze one sanitized request-local failure fact. */
export function createUpstreamFailureFact(
  input: UpstreamFailureFactInput,
): UpstreamFailureFact {
  if (!isPlainRecord(input)) {
    throw new TypeError("failure input must be a plain object");
  }
  for (const key of Object.keys(input)) {
    if (!FAILURE_INPUT_KEYS.has(key)) {
      throw new TypeError(`unsupported failure field: ${key}`);
    }
  }
  if (!FAILURE_KINDS.has(input.kind)) {
    throw new TypeError(`unsupported failure kind: ${String(input.kind)}`);
  }
  if (input.phase !== undefined && !FAILURE_PHASES.has(input.phase)) {
    throw new TypeError(`unsupported failure phase: ${String(input.phase)}`);
  }
  if (input.retryable !== undefined && typeof input.retryable !== "boolean") {
    throw new TypeError("retryable must be boolean when present");
  }
  if (input.truncated !== undefined && typeof input.truncated !== "boolean") {
    throw new TypeError("truncated must be boolean when present");
  }
  validateFailureStatus(input.kind, input.status);
  validateFailurePhase(input.kind, input.phase);

  let truncated = input.truncated === true;
  const message = sanitizeRequiredText(
    input.message,
    "message",
    MAX_FAILURE_MESSAGE_LENGTH,
  );
  truncated ||= message.truncated;
  const statusText = sanitizeOptionalText(
    input.statusText,
    "statusText",
    MAX_FAILURE_METADATA_LENGTH,
  );
  truncated ||= statusText.truncated;
  const providerType = sanitizeOptionalText(
    input.providerType,
    "providerType",
    MAX_FAILURE_METADATA_LENGTH,
  );
  truncated ||= providerType.truncated;
  const providerCode = sanitizeOptionalText(
    input.providerCode,
    "providerCode",
    MAX_FAILURE_METADATA_LENGTH,
  );
  truncated ||= providerCode.truncated;
  const headers = sanitizeHeaders(input.headers);
  truncated ||= headers.truncated;
  const snapshot = sanitizeSnapshot(input.snapshot);
  truncated ||= snapshot?.truncated === true;
  validateAttemptCount(input.attemptCount);

  const fact: UpstreamFailureFact = {
    kind: input.kind,
    ...(input.phase === undefined ? {} : { phase: input.phase }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(statusText.value === undefined ? {} : { statusText: statusText.value }),
    ...(providerType.value === undefined
      ? {}
      : { providerType: providerType.value }),
    ...(providerCode.value === undefined
      ? {}
      : { providerCode: providerCode.value }),
    message: message.value,
    ...(snapshot === undefined ? {} : { snapshot }),
    headers: headers.value,
    ...(input.retryable === undefined
      ? {}
      : { retryable: input.retryable }),
    ...(input.attemptCount === undefined
      ? {}
      : { attemptCount: input.attemptCount }),
    truncated,
  };
  Object.freeze(fact);
  createdFailureFacts.add(fact);
  return fact;
}

/** Attach an already-sanitized fact through Pi's public diagnostic contract. */
export function createUpstreamFailureDiagnostic(
  failure: UpstreamFailureFact,
  timestamp = Date.now(),
): AssistantMessageDiagnostic {
  assertConstructedFailureFact(failure);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError("failure diagnostic timestamp must be a non-negative integer");
  }
  const details = Object.freeze({ failure });
  return Object.freeze({
    type: UPSTREAM_FAILURE_DIAGNOSTIC_TYPE,
    timestamp,
    details,
  });
}

/**
 * Return the last neutral failure attached to an error terminal. Unknown Pi
 * diagnostics and forged/mutable objects are ignored, never interpreted.
 */
export function findUpstreamFailureFact(
  diagnostics: readonly AssistantMessageDiagnostic[] | undefined,
): UpstreamFailureFact | undefined {
  if (diagnostics === undefined) return undefined;
  for (let index = diagnostics.length - 1; index >= 0; index -= 1) {
    const diagnostic = diagnostics[index];
    if (diagnostic?.type !== UPSTREAM_FAILURE_DIAGNOSTIC_TYPE) continue;
    const candidate = diagnostic.details?.failure;
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      createdFailureFacts.has(candidate)
    ) {
      return candidate as UpstreamFailureFact;
    }
  }
  return undefined;
}

function assertConstructedFailureFact(
  failure: UpstreamFailureFact,
): asserts failure is UpstreamFailureFact {
  if (!createdFailureFacts.has(failure)) {
    throw new TypeError(
      "failure must be created by createUpstreamFailureFact",
    );
  }
}

function validateFailureStatus(
  kind: UpstreamFailureKind,
  status: number | undefined,
): void {
  if (status === undefined) {
    if (kind === "http") throw new TypeError("HTTP failure requires status");
    return;
  }
  if (
    (kind !== "http" && kind !== "upstream_stream") ||
    !Number.isInteger(status) ||
    status < 300 ||
    status > 599
  ) {
    throw new TypeError(
      "status must be an HTTP error status on an HTTP or upstream-stream failure",
    );
  }
}

function validateFailurePhase(
  kind: UpstreamFailureKind,
  phase: UpstreamFailurePhase | undefined,
): void {
  if (kind === "transport" && phase === undefined) {
    throw new TypeError("transport failure requires phase");
  }
  if (
    phase !== undefined &&
    kind !== "transport" &&
    kind !== "timeout" &&
    kind !== "callback"
  ) {
    throw new TypeError(
      "phase is only valid for transport, timeout, or callback failures",
    );
  }
}

function validateAttemptCount(value: number | undefined): void {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || value < 1 || value > 10_000)
  ) {
    throw new TypeError("attemptCount must be an integer from 1 through 10000");
  }
}

function sanitizeRequiredText(
  value: string,
  name: string,
  maximumLength: number,
): { value: string; truncated: boolean } {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return sanitizeText(value, name, maximumLength);
}

function sanitizeOptionalText(
  value: string | undefined,
  name: string,
  maximumLength: number,
): { value?: string; truncated: boolean } {
  if (value === undefined) return { truncated: false };
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string when present`);
  }
  return sanitizeText(value, name, maximumLength);
}

function sanitizeText(
  value: string,
  name: string,
  maximumLength: number,
): { value: string; truncated: boolean } {
  if (/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/u.test(value)) {
    throw new TypeError(`${name} contains unsafe control characters`);
  }
  const redacted = value
    .replace(/\b(?:bearer|basic)\s+\S+/giu, "[REDACTED]")
    .replace(/\b(?:sk|key|token|secret)[-_][A-Za-z0-9._-]{8,}\b/giu, "[REDACTED]");
  if (redacted.length <= maximumLength) {
    return { value: redacted, truncated: redacted !== value };
  }
  return { value: redacted.slice(0, maximumLength), truncated: true };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sanitizeHeaders(
  source: Headers | Readonly<Record<string, string>> | undefined,
): { value: Readonly<Record<string, string>>; truncated: boolean } {
  const safe: Record<string, string> = {};
  let truncated = false;
  if (source === undefined) return { value: Object.freeze(safe), truncated };
  const entries = source instanceof Headers
    ? source.entries()
    : Object.entries(source);
  for (const [rawName, rawValue] of entries) {
    const name = rawName.toLowerCase();
    if (!SAFE_FAILURE_HEADERS.has(name)) continue;
    if (typeof rawValue !== "string") {
      throw new TypeError(`failure header ${name} must be a string`);
    }
    if (rawValue.length === 0) continue;
    const value = sanitizeRequiredText(
      rawValue,
      `failure header ${name}`,
      MAX_FAILURE_HEADER_VALUE_LENGTH,
    );
    safe[name] = value.value;
    truncated ||= value.truncated;
  }
  return { value: Object.freeze(safe), truncated };
}

function sanitizeSnapshot(
  input: UpstreamFailureFactInput["snapshot"],
): UpstreamFailureSnapshotMetadata | undefined {
  if (input === undefined) return undefined;
  if (typeof input.truncated !== "boolean") {
    throw new TypeError("snapshot truncated must be boolean");
  }
  if (
    !Number.isSafeInteger(input.capturedBytes) ||
    input.capturedBytes < 0 ||
    input.capturedBytes > MAX_FAILURE_SNAPSHOT_BYTES
  ) {
    throw new TypeError(
      `snapshot capturedBytes must be from 0 through ${MAX_FAILURE_SNAPSHOT_BYTES}`,
    );
  }
  if (
    input.totalBytes !== undefined &&
    (!Number.isSafeInteger(input.totalBytes) ||
      input.totalBytes < input.capturedBytes)
  ) {
    throw new TypeError(
      "snapshot totalBytes must be an integer no smaller than capturedBytes",
    );
  }
  if (
    input.sha256 !== undefined &&
    !/^[a-f0-9]{64}$/u.test(input.sha256)
  ) {
    throw new TypeError("snapshot sha256 must be 64 lowercase hexadecimal characters");
  }
  const mediaType = sanitizeOptionalText(
    input.mediaType,
    "snapshot mediaType",
    MAX_FAILURE_METADATA_LENGTH,
  );
  const snapshot: UpstreamFailureSnapshotMetadata = {
    ...(mediaType.value === undefined ? {} : { mediaType: mediaType.value }),
    capturedBytes: input.capturedBytes,
    ...(input.totalBytes === undefined ? {} : { totalBytes: input.totalBytes }),
    ...(input.sha256 === undefined ? {} : { sha256: input.sha256 }),
    truncated:
      input.truncated ||
      mediaType.truncated ||
      (input.totalBytes !== undefined &&
        input.totalBytes > input.capturedBytes),
  };
  return Object.freeze(snapshot);
}
