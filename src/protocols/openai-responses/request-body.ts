import {
  gunzipSync,
  inflateRawSync,
  inflateSync,
  zstdDecompressSync,
} from "node:zlib";
import type { ArtifactRecorder } from "../../diagnostics/contract.js";

export class ResponsesRequestBodyTooLargeError extends Error {
  readonly kind = "ResponsesRequestBodyTooLargeError" as const;

  constructor(readonly observedBytes: number, readonly limitBytes: number) {
    super(`Responses request body exceeds ${limitBytes} bytes`);
    this.name = "ResponsesRequestBodyTooLargeError";
  }
}

export class UnsupportedResponsesContentEncodingError extends Error {
  readonly kind = "UnsupportedResponsesContentEncodingError" as const;

  constructor(readonly encoding: string) {
    super(`Unsupported Content-Encoding: ${encoding}`);
    this.name = "UnsupportedResponsesContentEncodingError";
  }
}

export interface ResponsesRequestBody {
  readonly wireBytes: Uint8Array<ArrayBuffer>;
  readonly text: string;
  readonly json: unknown;
}

function declaredLength(request: Request): number | undefined {
  const value = request.headers.get("content-length")?.trim();
  if (value === undefined || value.length === 0 || !/^\d+$/u.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

async function readBoundedBytes(
  stream: ReadableStream<Uint8Array> | null,
  maximumBytes: number,
  signal: AbortSignal,
  recorder?: ArtifactRecorder,
): Promise<Uint8Array<ArrayBuffer>> {
  signal.throwIfAborted();
  if (stream === null) return new Uint8Array(0);
  const reader = stream.getReader();
  let buffer = new Uint8Array(Math.min(Math.max(maximumBytes, 1), 64 * 1024));
  let length = 0;
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (value === undefined || value.byteLength === 0) continue;
      const required = length + value.byteLength;
      if (required > maximumBytes) {
        const error = new ResponsesRequestBodyTooLargeError(required, maximumBytes);
        void reader.cancel(error).catch(() => undefined);
        throw error;
      }
      recorder?.append(value);
      if (required > buffer.byteLength) {
        const next = new Uint8Array(
          Math.min(maximumBytes, Math.max(required, buffer.byteLength * 2)),
        );
        next.set(buffer.subarray(0, length));
        buffer = next;
      }
      buffer.set(value, length);
      length = required;
    }
    return buffer.slice(0, length) as Uint8Array<ArrayBuffer>;
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // Cancellation may retain the lock briefly; request teardown owns it.
    }
  }
}

function inflateDeflate(
  value: Uint8Array<ArrayBuffer>,
  maximumBytes: number,
): Uint8Array<ArrayBuffer> {
  const options = { maxOutputLength: maximumBytes };
  try {
    return new Uint8Array(inflateSync(value, options));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") throw error;
    return new Uint8Array(inflateRawSync(value, options));
  }
}

function decodeBytes(
  value: Uint8Array<ArrayBuffer>,
  encodingHeader: string | null,
  maximumBytes: number,
): Uint8Array<ArrayBuffer> {
  const encoding = (encodingHeader ?? "identity").trim().toLowerCase();
  if (encoding === "" || encoding === "identity") return value;
  const options = { maxOutputLength: maximumBytes };
  try {
    if (encoding === "zstd") {
      return new Uint8Array(zstdDecompressSync(value, options));
    }
    if (encoding === "gzip" || encoding === "x-gzip") {
      return new Uint8Array(gunzipSync(value, options));
    }
    if (encoding === "deflate") return inflateDeflate(value, maximumBytes);
    throw new UnsupportedResponsesContentEncodingError(encoding);
  } catch (error) {
    if (error instanceof UnsupportedResponsesContentEncodingError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
      throw new ResponsesRequestBodyTooLargeError(maximumBytes + 1, maximumBytes);
    }
    throw error;
  }
}

/**
 * Read one Responses request once, bounding both transport and decoded bytes.
 * Transport compression is removed at ingress; passthrough branches forward
 * the decoded JSON text with a fresh Content-Length/encoding chosen by fetch.
 */
export async function readResponsesRequestBody(
  request: Request,
  maximumBytes: number,
  recorder?: ArtifactRecorder,
): Promise<ResponsesRequestBody> {
  try {
    const declared = declaredLength(request);
    if (declared !== undefined && declared > maximumBytes) {
      throw new ResponsesRequestBodyTooLargeError(declared, maximumBytes);
    }
    const encoding =
      (request.headers.get("content-encoding") ?? "identity")
        .trim()
        .toLowerCase();
    const identity = encoding === "" || encoding === "identity";
    const raw = await readBoundedBytes(
      request.body,
      maximumBytes,
      request.signal,
      identity ? recorder : undefined,
    );
    const decoded = decodeBytes(raw, encoding, maximumBytes);
    if (decoded.byteLength > maximumBytes) {
      throw new ResponsesRequestBodyTooLargeError(decoded.byteLength, maximumBytes);
    }
    if (!identity) recorder?.append(decoded);
    recorder?.finish({ originalBytes: decoded.byteLength, complete: true });
    const text = new TextDecoder().decode(decoded);
    return Object.freeze({ wireBytes: raw, text, json: JSON.parse(text) as unknown });
  } catch (error) {
    recorder?.abandon(
      error instanceof ResponsesRequestBodyTooLargeError
        ? "request_body_exceeds_limit"
        : "request_body_read_or_decode_failed",
    );
    throw error;
  }
}
