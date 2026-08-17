import type {
  RuntimeDiagnosticEvent,
  RuntimeDiagnosticLevel,
  RuntimeDiagnosticQuery,
  RuntimeDiagnosticRecord,
} from "./diagnostics-contract.js";
import { isRecord } from "./wire.js";

/**
 * Wire codecs for the diagnostics surface (Ticket 07). These are pure
 * allowlist decoders: unknown fields are dropped, and every string value is
 * bounded so no credential can be smuggled through a wire payload.
 */

const MAX_WIRE_TEXT = 4_096;

function decodeLevel(value: unknown): RuntimeDiagnosticLevel | undefined {
  return value === "info" ||
    value === "warning" ||
    value === "error" ||
    value === "critical"
    ? value
    : undefined;
}

function boundedText(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length <= maximum
    ? value
    : undefined;
}

export function decodeDiagnosticQuery(
  value: unknown,
): RuntimeDiagnosticQuery | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  const minimumLevel = decodeLevel(value.minimumLevel);
  if (
    value.minimumLevel !== undefined &&
    minimumLevel === undefined
  ) {
    return undefined;
  }
  const afterId =
    value.afterId === undefined
      ? 0
      : Number.isSafeInteger(value.afterId) && (value.afterId as number) >= 0
        ? (value.afterId as number)
        : undefined;
  if (afterId === undefined) return undefined;
  const limit =
    value.limit === undefined
      ? 100
      : Number.isSafeInteger(value.limit) &&
          (value.limit as number) >= 1 &&
          (value.limit as number) <= 1_000
        ? (value.limit as number)
        : undefined;
  if (limit === undefined) return undefined;
  // Ticket 23: inclusive time-range endpoints; both must be valid when
  // present and from must not exceed to.
  const from =
    value.from === undefined
      ? undefined
      : Number.isSafeInteger(value.from) && (value.from as number) >= 0
        ? (value.from as number)
        : undefined;
  const to =
    value.to === undefined
      ? undefined
      : Number.isSafeInteger(value.to) && (value.to as number) >= 0
        ? (value.to as number)
        : undefined;
  if (
    (value.from !== undefined && from === undefined) ||
    (value.to !== undefined && to === undefined) ||
    (from !== undefined && to !== undefined && from > to)
  ) {
    return undefined;
  }
  return {
    ...(minimumLevel === undefined ? {} : { minimumLevel }),
    ...(afterId === 0 ? {} : { afterId }),
    ...(limit === 100 ? {} : { limit }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };
}

export function decodeDiagnosticRecord(
  value: unknown,
): RuntimeDiagnosticRecord | undefined {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.id) ||
    (value.id as number) < 0
  ) {
    return undefined;
  }
  const level = decodeLevel(value.level);
  if (level === undefined) return undefined;
  const time = value.time;
  if (!Number.isSafeInteger(time) || (time as number) < 0) return undefined;
  const text = boundedText(value.text, MAX_WIRE_TEXT);
  if (text === undefined) return undefined;
  const requestId =
    value.requestId === undefined
      ? undefined
      : boundedText(value.requestId, 128);
  if (value.requestId !== undefined && requestId === undefined) {
    return undefined;
  }
  const fingerprint =
    value.fingerprint === undefined
      ? undefined
      : boundedText(value.fingerprint, 128);
  if (value.fingerprint !== undefined && fingerprint === undefined) {
    return undefined;
  }
  const details =
    value.details === undefined
      ? undefined
      : decodeDetails(value.details);
  if (value.details !== undefined && details === undefined) return undefined;
  const errors =
    value.errors === undefined ? undefined : decodeErrorChain(value.errors);
  if (value.errors !== undefined && errors === undefined) return undefined;
  const record: RuntimeDiagnosticRecord = {
    id: value.id as number,
    level,
    time: time as number,
    text,
    ...(requestId === undefined ? {} : { requestId }),
    ...(fingerprint === undefined ? {} : { fingerprint }),
    ...(details === undefined ? {} : { details }),
    ...(errors === undefined ? {} : { errors }),
  };
  return Object.freeze(record);
}

function decodeDetails(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(value)) return undefined;
  const output: Record<string, unknown> = Object.create(null);
  let entries = 0;
  for (const [name, entry] of Object.entries(value)) {
    if (entries >= 128) return undefined;
    if (typeof name !== "string" || name.length === 0 || name.length > 128) {
      return undefined;
    }
    if (typeof entry !== "string" || entry.length <= 4_096) {
      output[name] = entry;
      entries += 1;
    } else {
      return undefined;
    }
  }
  return Object.freeze(output);
}

function decodeErrorChain(
  value: unknown,
): readonly Readonly<Record<string, unknown>>[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    return undefined;
  }
  const output: Readonly<Record<string, unknown>>[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    const name = typeof entry.name === "string" ? entry.name.slice(0, 128) : undefined;
    const message =
      typeof entry.message === "string" && entry.message.length <= 4_096
        ? entry.message
        : undefined;
    if (name === undefined || message === undefined) return undefined;
    output.push(
      Object.freeze({
        name,
        message,
        ...(entry.code === undefined
          ? {}
          : {
              code:
                typeof entry.code === "string"
                  ? entry.code.slice(0, 128)
                  : undefined,
            }),
        ...(entry.cause === undefined ? {} : { cause: entry.cause }),
      }),
    );
  }
  return Object.freeze(output);
}

export function decodeDiagnosticEvent(
  value: unknown,
): RuntimeDiagnosticEvent | undefined {
  if (!isRecord(value) || value.type !== "diagnostic") return undefined;
  const record = decodeDiagnosticRecord(value.record);
  return record === undefined ? undefined : { type: "diagnostic", record };
}
