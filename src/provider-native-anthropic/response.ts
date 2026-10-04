import {
  parseSseFrames,
  renderSseFrame,
  sseFramePayload,
  type SseFrameLine,
} from "../protocols/sse-lines.js";
import { HOP_BY_HOP } from "./http-headers.js";

const FORBIDDEN_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "cookie",
  "authorization",
  "proxy-authorization",
  "www-authenticate",
  // The upstream credential must never be echoed back toward the client even
  // if the upstream mislabels it as a response header.
  "x-api-key",
]);

function isSafeResponseHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (HOP_BY_HOP.has(lower)) return false;
  if (FORBIDDEN_RESPONSE_HEADERS.has(lower)) return false;
  return true;
}

export function filterHeaders(
  source: Headers | Readonly<Record<string, string>>,
  allow: (name: string) => boolean,
): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  const entries =
    source instanceof Headers ? source.entries() : Object.entries(source);
  for (const [rawName, rawValue] of entries) {
    const name = rawName.toLowerCase();
    if (!allow(name)) continue;
    output[name] = rawValue;
  }
  return Object.freeze(output);
}

/** Upstream headers the lane may hand back to the Client Protocol handler. */
export function safeResponseHeaders(
  source: Headers,
): Readonly<Record<string, string>> {
  return filterHeaders(source, isSafeResponseHeader);
}

export interface BufferedAnthropicNativeResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array<ArrayBuffer>;
}

/** A pre-commit failure while the protocol-side response owner buffers the
 * upstream body. The transport itself never consumes Provider response bytes. */
export class AnthropicPassthroughBodyReadError extends Error {
  readonly kind = "AnthropicPassthroughBodyReadError";

  constructor(cause: unknown) {
    super(
      `Failed to read the upstream response body: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = "AnthropicPassthroughBodyReadError";
  }
}

export async function bufferAnthropicNativeResponse(
  upstream: Response,
  signal: AbortSignal,
): Promise<BufferedAnthropicNativeResponse> {
  let body: Uint8Array<ArrayBuffer>;
  try {
    body = new Uint8Array(await upstream.arrayBuffer());
  } catch (error) {
    if (signal.aborted) throw error;
    throw new AnthropicPassthroughBodyReadError(error);
  }
  return {
    status: upstream.status,
    headers: safeResponseHeaders(upstream.headers),
    body,
  };
}

/**
 * Project every externally visible model identity of a buffered upstream
 * Anthropic response to the requested alias (Ticket 15 native passthrough
 * symmetry).
 *
 * Supported shapes:
 *
 * - non-streaming (`application/json`): the top-level `model` field;
 * - streaming (`text/event-stream`): the nested `message.model` of the
 *   `message_start` event; other model positions fail closed.
 *
 * The response is buffered before projection, so a shape that cannot be
 * guaranteed symmetric fails with `{ error }` and the caller returns a
 * legal target-protocol error instead of leaking upstream bytes or the
 * canonical model id. Non-model-bearing SSE events pass through
 * with their payload text unchanged through canonical SSE framing; rewritten
 * events are re-serialized with only the model field changed.
 */
export function projectAnthropicPassthroughBody(
  body: Uint8Array,
  contentType: string,
  alias: string,
): { readonly body: Uint8Array<ArrayBuffer> } | { readonly error: string } {
  const text = new TextDecoder().decode(body);
  if (contentType.toLowerCase().includes("text/event-stream")) {
    return projectAnthropicSse(text, alias);
  }
  return projectAnthropicJsonObject(text, alias);
}

/**
 * Collect every path to a `model` property key in a parsed JSON tree.
 * Only keys are identity candidates; `model` text inside string values is
 * semantic content and is never scanned. A depth bound keeps adversarial
 * nesting bounded; the sentinel path fails every approved-position check.
 */
const MAX_MODEL_SCAN_DEPTH = 64;
const DEPTH_SENTINEL = "<max-depth>";

function collectModelPaths(
  value: unknown,
  path: string[] = [],
  out: string[] = [],
  depth = 0,
): string[] {
  if (depth > MAX_MODEL_SCAN_DEPTH) {
    out.push(DEPTH_SENTINEL);
    return out;
  }
  if (typeof value !== "object" || value === null) return out;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      collectModelPaths(value[index], [...path, String(index)], out, depth + 1);
    }
    return out;
  }
  for (const [key, entry] of Object.entries(value)) {
    const next = [...path, key];
    if (key === "model") out.push(next.join("."));
    collectModelPaths(entry, next, out, depth + 1);
  }
  return out;
}

function projectAnthropicJsonObject(
  text: string,
  alias: string,
): { readonly body: Uint8Array<ArrayBuffer> } | { readonly error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "Anthropic passthrough response is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: "Anthropic passthrough response is not a JSON object" };
  }
  const record = parsed as Record<string, unknown>;
  // The approved response-metadata position is exactly the top-level
  // `model`. Any other `model` key in the tree (tool inputs, nested
  // objects) cannot be told apart from semantic content: fail closed
  // rather than rewrite user/tool payloads or leak identity.
  const paths = collectModelPaths(parsed);
  if (paths.length !== 1 || paths[0] !== "model") {
    return {
      error: "Anthropic passthrough response carries an ambiguous model position",
    };
  }
  if (typeof record.model !== "string") {
    return {
      error: "Anthropic passthrough response carries no model identity",
    };
  }
  record.model = alias;
  return { body: new TextEncoder().encode(JSON.stringify(record)) };
}

/**
 * Rewrite model identity in one parsed Anthropic SSE event payload.
 *
 * The only approved position in the Anthropic streaming shape is
 * `message_start.message.model`. Any other `model` key anywhere in an
 * event (a simultaneous top-level `model`, a type-less nested
 * `message.model`, or a model inside any other event) is ambiguous: fail
 * closed so no structural model identity outside the approved position can
 * survive. Events without any model key pass through unchanged.
 */
function rewriteAnthropicSseEvent(
  parsed: unknown,
  alias: string,
): { readonly json: string } | { readonly unchanged: true } | { readonly error: string } {
  if (typeof parsed !== "object" || parsed === null) {
    // Non-object data cannot carry model keys: pass through unchanged.
    // Array roots fall through to the same structural model-key scan as
    // objects (an array element may carry a `model` key).
    return { unchanged: true };
  }
  const record = parsed as Record<string, unknown>;
  const paths = collectModelPaths(parsed);
  if (record.type === "message_start") {
    if (paths.length !== 1 || paths[0] !== "message.model") {
      return {
        error: "message_start carries an ambiguous model position",
      };
    }
    const message = record.message as Record<string, unknown>;
    if (typeof message.model !== "string") {
      return { error: "message_start carries no model identity" };
    }
    message.model = alias;
    return { json: JSON.stringify(record) };
  }
  if (paths.length !== 0) {
    return { error: "Anthropic SSE event carries an unsupported model position" };
  }
  return { unchanged: true };
}

function projectAnthropicSse(
  text: string,
  alias: string,
): { readonly body: Uint8Array<ArrayBuffer> } | { readonly error: string } {
  const out: string[] = [];
  for (const frame of parseSseFrames(text)) {
    const payload = sseFramePayload(frame);
    if (payload.length === 0) {
      out.push(renderSseFrame(frame));
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return { error: "Anthropic passthrough SSE event is not valid JSON" };
    }
    const rewritten = rewriteAnthropicSseEvent(parsed, alias);
    if ("error" in rewritten) return { error: rewritten.error };
    if ("unchanged" in rewritten) {
      out.push(renderSseFrame(frame));
      continue;
    }
    // Rewritten frames keep their non-data fields and carry the projected
    // payload as one canonical data line.
    const fields = frame.lines.filter(
      (line): line is Extract<SseFrameLine, { kind: "field" }> =>
        line.kind === "field",
    );
    out.push(
      renderSseFrame({
        lines: Object.freeze([
          ...fields,
          { kind: "data" as const, payload: rewritten.json },
        ]),
      }),
    );
  }
  return { body: new TextEncoder().encode(out.join("")) };
}
