import type {
  CaptureEvent,
  CaptureEventFact,
  CaptureQuery,
  CaptureQueryResult,
  CaptureRecord,
  CaptureState,
  CaptureTimingEntry,
} from "./capture-contract.js";
import { assertCaptureState } from "./capture-contract.js";
import { maxControlPlaneFrameBytes } from "./framing.js";
import { isRecord } from "./wire.js";

/**
 * Wire codecs for the Deep Diagnostics capture surface (Ticket 22). Strict
 * allowlist decoders: a frame carrying an unknown key or a value outside the
 * bounded grammar is rejected, never projected. Committed capture rows are
 * payload-budgeted by the store below the frame ceiling, so every legally
 * committed record passes these bounds; every body string is bounded by the
 * frame size and unknown keys are never accepted.
 */

const CAPTURE_REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Wire cap for a single body string: the frame ceiling, above which no
 *  committed record can ever grow (the store budgets the complete record
 *  below this). */
const MAX_WIRE_BODY_BYTES = maxControlPlaneFrameBytes;
const MAX_WIRE_TIMING = 64;
const MAX_WIRE_HEADERS = 128;

const CAPTURE_QUERY_KEYS: ReadonlySet<string> = new Set(["requestId"]);

const CAPTURE_RECORD_KEYS: ReadonlySet<string> = new Set([
  "requestId",
  "protocolId",
  "state",
  "acceptedAt",
  "capturedAt",
  "clientHttpStatus",
  "failure",
  "requestBody",
  "responseBody",
  "requestHeaders",
  "responseHeaders",
  "timing",
]);

const CAPTURE_TIMING_KEYS: ReadonlySet<string> = new Set(["stage", "time"]);

const CAPTURE_RESULT_KEYS: ReadonlySet<string> = new Set([
  "state",
  "record",
  "evictedAt",
  "evictionReason",
]);

const CAPTURE_EVENT_KEYS: ReadonlySet<string> = new Set(["type", "fact"]);

const CAPTURE_FACT_KEYS: ReadonlySet<string> = new Set([
  "requestId",
  "protocolId",
  "state",
  "acceptedAt",
  "clientHttpStatus",
]);

function boundedText(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    ? value
    : undefined;
}

function optionalTime(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : undefined;
}

function decodeHeaderMap(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value)) return undefined;
  const output: Record<string, string> = Object.create(null);
  let entries = 0;
  for (const [name, entry] of Object.entries(value)) {
    if (entries >= MAX_WIRE_HEADERS) return undefined;
    const safeName = boundedText(name, 128);
    const safeValue = boundedText(entry, MAX_WIRE_BODY_BYTES);
    if (safeName === undefined || safeValue === undefined) return undefined;
    output[safeName] = safeValue;
    entries += 1;
  }
  return Object.freeze(output);
}

function decodeTiming(value: unknown): readonly CaptureTimingEntry[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_WIRE_TIMING) {
    return undefined;
  }
  const timing: CaptureTimingEntry[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    for (const key of Object.keys(entry)) {
      if (!CAPTURE_TIMING_KEYS.has(key)) return undefined;
    }
    const stage = boundedText(entry.stage, 128);
    const time = optionalTime(entry.time);
    if (stage === undefined || time === undefined) return undefined;
    timing.push(Object.freeze({ stage, time }));
  }
  return Object.freeze(timing);
}

function decodePersistedState(value: unknown): "captured" | "partial" | "failed" | undefined {
  return value === "captured" || value === "partial" || value === "failed"
    ? value
    : undefined;
}

/** Strict capture record decoder: the allowed key set is exact and every
 *  field is bounded. Body strings are sanitized at the store before commit,
 *  so the wire only validates shape and bounds. */
export function decodeCaptureRecord(
  value: unknown,
): CaptureRecord | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of Object.keys(value)) {
    if (!CAPTURE_RECORD_KEYS.has(key)) return undefined;
  }
  const requestId = boundedText(value.requestId, 36);
  if (requestId === undefined || !CAPTURE_REQUEST_ID_PATTERN.test(requestId)) {
    return undefined;
  }
  const protocolId = boundedText(value.protocolId, 128);
  const state = decodePersistedState(value.state);
  const acceptedAt = optionalTime(value.acceptedAt);
  const capturedAt = optionalTime(value.capturedAt);
  if (
    protocolId === undefined ||
    state === undefined ||
    acceptedAt === undefined ||
    capturedAt === undefined
  ) {
    return undefined;
  }
  const clientHttpStatus = value.clientHttpStatus;
  if (clientHttpStatus !== undefined) {
    if (
      !Number.isSafeInteger(clientHttpStatus) ||
      (clientHttpStatus as number) < 100 ||
      (clientHttpStatus as number) > 599
    ) {
      return undefined;
    }
  }
  const failure =
    value.failure === undefined
      ? undefined
      : boundedText(value.failure, 128);
  if (value.failure !== undefined && failure === undefined) return undefined;
  const requestBody =
    value.requestBody === undefined
      ? undefined
      : boundedText(value.requestBody, MAX_WIRE_BODY_BYTES);
  const responseBody =
    value.responseBody === undefined
      ? undefined
      : boundedText(value.responseBody, MAX_WIRE_BODY_BYTES);
  if (
    (value.requestBody !== undefined && requestBody === undefined) ||
    (value.responseBody !== undefined && responseBody === undefined)
  ) {
    return undefined;
  }
  const requestHeaders =
    value.requestHeaders === undefined
      ? undefined
      : decodeHeaderMap(value.requestHeaders);
  const responseHeaders =
    value.responseHeaders === undefined
      ? undefined
      : decodeHeaderMap(value.responseHeaders);
  if (
    (value.requestHeaders !== undefined && requestHeaders === undefined) ||
    (value.responseHeaders !== undefined && responseHeaders === undefined)
  ) {
    return undefined;
  }
  const timing =
    value.timing === undefined ? undefined : decodeTiming(value.timing);
  if (value.timing !== undefined && timing === undefined) return undefined;
  return Object.freeze({
    requestId,
    protocolId,
    state,
    acceptedAt,
    capturedAt,
    ...(clientHttpStatus === undefined
      ? {}
      : { clientHttpStatus: clientHttpStatus as number }),
    ...(failure === undefined ? {} : { failure }),
    ...(requestBody === undefined ? {} : { requestBody }),
    ...(responseBody === undefined ? {} : { responseBody }),
    ...(requestHeaders === undefined ? {} : { requestHeaders }),
    ...(responseHeaders === undefined ? {} : { responseHeaders }),
    ...(timing === undefined ? {} : { timing }),
  });
}

export function decodeCaptureQuery(value: unknown): CaptureQuery | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  for (const key of Object.keys(value)) {
    if (!CAPTURE_QUERY_KEYS.has(key)) return undefined;
  }
  const requestId = boundedText(value.requestId, 36);
  if (requestId === undefined || !CAPTURE_REQUEST_ID_PATTERN.test(requestId)) {
    return undefined;
  }
  return Object.freeze({ requestId });
}

export function decodeCaptureQueryResult(
  value: unknown,
): CaptureQueryResult | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of Object.keys(value)) {
    if (!CAPTURE_RESULT_KEYS.has(key)) return undefined;
  }
  let state: CaptureState;
  try {
    state = assertCaptureState(value.state);
  } catch {
    return undefined;
  }
  const record =
    value.record === undefined ? undefined : decodeCaptureRecord(value.record);
  if (value.record !== undefined && record === undefined) return undefined;
  const evictedAt =
    value.evictedAt === undefined ? undefined : optionalTime(value.evictedAt);
  if (value.evictedAt !== undefined && evictedAt === undefined) {
    return undefined;
  }
  const evictionReason =
    value.evictionReason === undefined
      ? undefined
      : value.evictionReason === "age" || value.evictionReason === "capacity"
        ? value.evictionReason
        : undefined;
  if (
    value.evictionReason !== undefined &&
    evictionReason === undefined
  ) {
    return undefined;
  }
  // State/facts coherence: committed rows carry their record; expired rows
  // carry the eviction facts; no-capture carries neither.
  if (
    (state === "captured" || state === "partial" || state === "failed") &&
    record === undefined
  ) {
    return undefined;
  }
  if (
    state !== "expired" &&
    (evictedAt !== undefined || evictionReason !== undefined)
  ) {
    return undefined;
  }
  if (state === "expired" && evictedAt === undefined) return undefined;
  if (
    (state === "no-capture" || state === "expired") &&
    record !== undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    state,
    ...(record === undefined ? {} : { record }),
    ...(evictedAt === undefined ? {} : { evictedAt }),
    ...(evictionReason === undefined ? {} : { evictionReason }),
  });
}

export function decodeCaptureEvent(value: unknown): CaptureEvent | undefined {
  if (!isRecord(value) || value.type !== "capture_state_changed") {
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (!CAPTURE_EVENT_KEYS.has(key)) return undefined;
  }
  const fact = value.fact;
  if (!isRecord(fact)) return undefined;
  for (const key of Object.keys(fact)) {
    if (!CAPTURE_FACT_KEYS.has(key)) return undefined;
  }
  const requestId = boundedText(fact.requestId, 36);
  if (requestId === undefined || !CAPTURE_REQUEST_ID_PATTERN.test(requestId)) {
    return undefined;
  }
  const protocolId = boundedText(fact.protocolId, 128);
  let state: CaptureState;
  try {
    state = assertCaptureState(fact.state);
  } catch {
    return undefined;
  }
  const acceptedAt = optionalTime(fact.acceptedAt);
  if (protocolId === undefined || acceptedAt === undefined) return undefined;
  const clientHttpStatus = fact.clientHttpStatus;
  if (clientHttpStatus !== undefined) {
    if (
      !Number.isSafeInteger(clientHttpStatus) ||
      (clientHttpStatus as number) < 100 ||
      (clientHttpStatus as number) > 599
    ) {
      return undefined;
    }
  }
  const eventFact: CaptureEventFact = Object.freeze({
    requestId,
    protocolId,
    state,
    acceptedAt,
    ...(clientHttpStatus === undefined
      ? {}
      : { clientHttpStatus: clientHttpStatus as number }),
  });
  return Object.freeze({ type: "capture_state_changed", fact: eventFact });
}
