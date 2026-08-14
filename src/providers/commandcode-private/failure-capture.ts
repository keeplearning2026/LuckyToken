import { createHash } from "node:crypto";

import {
  MAX_FAILURE_MESSAGE_LENGTH,
  MAX_FAILURE_SNAPSHOT_BYTES,
  type UpstreamFailureFactInput,
} from "../../protocols/upstream-failure.js";

export interface CommandCodeFailureCapturePolicy {
  readonly bodyReadTimeoutMs: number;
  readonly maxBodyBytes: number;
  readonly maxClientMessageChars: number;
}

export const DEFAULT_COMMANDCODE_FAILURE_CAPTURE_POLICY: CommandCodeFailureCapturePolicy =
  Object.freeze({
    bodyReadTimeoutMs: 5_000,
    maxBodyBytes: 65_536,
    maxClientMessageChars: 4_096,
  });

type FailureSnapshot = NonNullable<UpstreamFailureFactInput["snapshot"]>;

export interface CapturedCommandCodeFailurePayload {
  readonly message: string;
  readonly providerType?: string;
  readonly providerCode?: string;
  readonly snapshot?: FailureSnapshot;
  readonly truncated: boolean;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedMessage(
  candidate: string | undefined,
  fallback: string,
  maximum: number,
): { readonly message: string; readonly truncated: boolean } {
  const effective =
    candidate
      ?.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
      .trim() || fallback;
  return effective.length <= maximum
    ? { message: effective, truncated: false }
    : { message: effective.slice(0, maximum), truncated: true };
}

function opaqueIdentifier(value: unknown): string | undefined {
  const candidate =
    typeof value === "string"
      ? value
      : typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : undefined;
  if (candidate === undefined) return undefined;
  const sanitized = candidate
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .trim();
  return sanitized.length === 0 ? undefined : sanitized;
}

function snapshotBytes(
  bytes: Uint8Array,
  totalBytes: number | undefined,
  mediaType: string | undefined,
  truncated: boolean,
): FailureSnapshot | undefined {
  if (bytes.byteLength === 0 && !truncated) return undefined;
  return {
    ...(mediaType === undefined ? {} : { mediaType }),
    capturedBytes: bytes.byteLength,
    ...(totalBytes === undefined ? {} : { totalBytes }),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    truncated,
  };
}

function parseFailureText(text: string): {
  readonly message?: string;
  readonly providerType?: string;
  readonly providerCode?: string;
} {
  const trimmed = text.trim();
  if (trimmed.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const root = isRecord(parsed) ? parsed : undefined;
    const nested = isRecord(root?.error) ? root.error : undefined;
    const detail = nested ?? root;
    const nestedString = typeof root?.error === "string" ? root.error : undefined;
    const providerType = opaqueIdentifier(detail?.type);
    const providerCode = opaqueIdentifier(detail?.code);
    return {
      ...(typeof detail?.message === "string"
        ? { message: detail.message }
        : nestedString === undefined
          ? {}
          : { message: nestedString }),
      ...(providerType === undefined ? {} : { providerType }),
      ...(providerCode === undefined ? {} : { providerCode }),
    };
  } catch {
    return { message: trimmed };
  }
}

function concatBytes(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function validContentLength(value: string | null): number | undefined {
  if (value === null || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

type ReadOutcome =
  | { readonly kind: "read"; readonly value: ReadableStreamReadResult<Uint8Array> }
  | { readonly kind: "read_error" }
  | { readonly kind: "timeout" }
  | { readonly kind: "aborted"; readonly reason: unknown };

async function readBoundedResponseBody(
  response: Response,
  policy: CommandCodeFailureCapturePolicy,
  signal: AbortSignal,
): Promise<{
  readonly bytes: Uint8Array;
  readonly totalBytes?: number;
  readonly truncated: boolean;
}> {
  if (response.body === null) {
    return { bytes: new Uint8Array(), totalBytes: 0, truncated: false };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let capturedBytes = 0;
  let completed = false;
  let truncated = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timedOut = new Promise<ReadOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), policy.bodyReadTimeoutMs);
  });
  const aborted = new Promise<ReadOutcome>((resolve) => {
    onAbort = () => resolve({ kind: "aborted", reason: signal.reason });
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    while (capturedBytes < policy.maxBodyBytes) {
      const read: Promise<ReadOutcome> = reader.read().then(
        (value): ReadOutcome => ({ kind: "read", value }),
        (): ReadOutcome => ({ kind: "read_error" }),
      );
      const outcome = await Promise.race([read, timedOut, aborted]);
      if (outcome.kind === "aborted") throw outcome.reason;
      if (outcome.kind === "timeout" || outcome.kind === "read_error") {
        truncated = true;
        break;
      }
      if (outcome.value.done) {
        completed = true;
        break;
      }
      const remaining = policy.maxBodyBytes - capturedBytes;
      const chunk = outcome.value.value;
      if (chunk.byteLength > remaining) {
        chunks.push(chunk.slice(0, remaining));
        capturedBytes += remaining;
        truncated = true;
        break;
      }
      chunks.push(chunk);
      capturedBytes += chunk.byteLength;
    }
    if (!completed && capturedBytes >= policy.maxBodyBytes) truncated = true;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    if (!completed) void reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // A pending read may retain the lock until best-effort cancellation settles.
    }
  }

  const declaredTotal = validContentLength(response.headers.get("content-length"));
  const totalBytes = completed
    ? capturedBytes
    : declaredTotal !== undefined && declaredTotal >= capturedBytes
      ? declaredTotal
      : undefined;
  if (totalBytes !== undefined && totalBytes > capturedBytes) truncated = true;
  return {
    bytes: concatBytes(chunks, capturedBytes),
    ...(totalBytes === undefined ? {} : { totalBytes }),
    truncated,
  };
}

export async function captureCommandCodeHttpFailurePayload(
  response: Response,
  policy: CommandCodeFailureCapturePolicy,
  signal: AbortSignal,
): Promise<CapturedCommandCodeFailurePayload> {
  const neutralPolicy = {
    ...policy,
    maxBodyBytes: Math.min(policy.maxBodyBytes, MAX_FAILURE_SNAPSHOT_BYTES),
    maxClientMessageChars: Math.min(
      policy.maxClientMessageChars,
      MAX_FAILURE_MESSAGE_LENGTH,
    ),
  };
  let captured: Awaited<ReturnType<typeof readBoundedResponseBody>>;
  try {
    captured = await readBoundedResponseBody(response, neutralPolicy, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    captured = { bytes: new Uint8Array(), truncated: true };
  }
  const text = new TextDecoder().decode(captured.bytes);
  const parsed = parseFailureText(text);
  const bounded = boundedMessage(
    parsed.message,
    `CommandCode returned HTTP ${response.status}`,
    neutralPolicy.maxClientMessageChars,
  );
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  const snapshot = snapshotBytes(
    captured.bytes,
    captured.totalBytes,
    mediaType || undefined,
    captured.truncated,
  );
  return Object.freeze({
    message: bounded.message,
    ...(parsed.providerType === undefined
      ? {}
      : { providerType: parsed.providerType }),
    ...(parsed.providerCode === undefined
      ? {}
      : { providerCode: parsed.providerCode }),
    ...(snapshot === undefined ? {} : { snapshot }),
    truncated: captured.truncated || bounded.truncated,
  });
}

export function captureCommandCodeStreamFailurePayload(
  body: unknown,
  message: string,
  policy: CommandCodeFailureCapturePolicy,
): CapturedCommandCodeFailurePayload {
  const maximumMessageChars = Math.min(
    policy.maxClientMessageChars,
    MAX_FAILURE_MESSAGE_LENGTH,
  );
  const maximumBodyBytes = Math.min(
    policy.maxBodyBytes,
    MAX_FAILURE_SNAPSHOT_BYTES,
  );
  const bounded = boundedMessage(
    message,
    "CommandCode stream failed",
    maximumMessageChars,
  );
  if (body === undefined) {
    return Object.freeze({ message: bounded.message, truncated: bounded.truncated });
  }
  const encoded = encodeBoundedFailureBody(body, maximumBodyBytes);
  const captured = encoded.bytes;
  const bodyTruncated = encoded.truncated;
  const snapshot = snapshotBytes(
    captured,
    encoded.truncated ? undefined : captured.byteLength,
    typeof body === "string" ? "text/plain" : "application/json",
    bodyTruncated,
  );
  return Object.freeze({
    message: bounded.message,
    ...(snapshot === undefined ? {} : { snapshot }),
    truncated: bodyTruncated || bounded.truncated,
  });
}

class BoundedTextWriter {
  private readonly buffer: Uint8Array;
  private readonly encoder = new TextEncoder();
  private offset = 0;
  truncated = false;

  constructor(maximumBytes: number) {
    this.buffer = new Uint8Array(maximumBytes);
  }

  write(value: string): boolean {
    if (this.truncated) return false;
    const target = this.buffer.subarray(this.offset);
    const result = this.encoder.encodeInto(value, target);
    this.offset += result.written;
    if (result.read < value.length) {
      this.truncated = true;
      return false;
    }
    return true;
  }

  writeJsonString(value: string): boolean {
    if (!this.write('"')) return false;
    for (const character of value) {
      const escaped = JSON.stringify(character);
      if (escaped === undefined || !this.write(escaped.slice(1, -1))) return false;
    }
    return this.write('"');
  }

  fail(): void {
    this.truncated = true;
  }

  bytes(): Uint8Array {
    return this.buffer.slice(0, this.offset);
  }
}

function writeBoundedJson(
  writer: BoundedTextWriter,
  value: unknown,
  seen: Set<object>,
  depth: number,
): void {
  if (writer.truncated) return;
  if (depth > 64) {
    writer.fail();
    return;
  }
  if (value === null) {
    writer.write("null");
    return;
  }
  if (typeof value === "string") {
    writer.writeJsonString(value);
    return;
  }
  if (typeof value === "boolean") {
    writer.write(value ? "true" : "false");
    return;
  }
  if (typeof value === "number") {
    writer.write(Number.isFinite(value) ? String(value) : "null");
    return;
  }
  if (typeof value !== "object" || seen.has(value)) {
    writer.fail();
    return;
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (!writer.write("[")) return;
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0 && !writer.write(",")) return;
        writeBoundedJson(writer, value[index], seen, depth + 1);
        if (writer.truncated) return;
      }
      writer.write("]");
      return;
    }
    if (!writer.write("{")) return;
    let first = true;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (!first && !writer.write(",")) return;
      first = false;
      if (!writer.writeJsonString(key) || !writer.write(":")) return;
      let nested: unknown;
      try {
        nested = (value as Record<string, unknown>)[key];
      } catch {
        writer.fail();
        return;
      }
      writeBoundedJson(writer, nested, seen, depth + 1);
      if (writer.truncated) return;
    }
    writer.write("}");
  } finally {
    seen.delete(value);
  }
}

function encodeBoundedFailureBody(
  body: unknown,
  maximumBytes: number,
): { readonly bytes: Uint8Array; readonly truncated: boolean } {
  const writer = new BoundedTextWriter(maximumBytes);
  if (typeof body === "string") writer.write(body);
  else writeBoundedJson(writer, body, new Set<object>(), 0);
  return { bytes: writer.bytes(), truncated: writer.truncated };
}
