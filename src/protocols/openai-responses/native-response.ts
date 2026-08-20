import {
  parseSseFrames,
  renderSseFrame,
  sseFramePayload,
  type SseFrameLine,
} from "../sse-lines.js";

export interface NativeResponsesResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array<ArrayBuffer>;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "content-encoding",
]);
const FORBIDDEN_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "proxy-authorization",
  "www-authenticate",
]);

function safeResponseHeaders(source: Headers): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const [rawName, value] of source.entries()) {
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP.has(name) || FORBIDDEN_HEADERS.has(name)) continue;
    output[name] = value;
  }
  return Object.freeze(output);
}

export class ResponsesNativeBodyReadError extends Error {
  readonly kind = "ResponsesNativeBodyReadError";

  constructor(cause: unknown) {
    super(
      `Failed to read the upstream response body: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = "ResponsesNativeBodyReadError";
  }
}

export async function bufferNativeResponsesResponse(
  upstream: Response,
  signal: AbortSignal,
): Promise<NativeResponsesResult> {
  let body: Uint8Array<ArrayBuffer>;
  try {
    body = new Uint8Array(await upstream.arrayBuffer());
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ResponsesNativeBodyReadError(error);
  }
  return {
    status: upstream.status,
    headers: safeResponseHeaders(upstream.headers),
    body,
  };
}

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

function projectJson(
  text: string,
  alias: string,
): { readonly body: Uint8Array<ArrayBuffer> } | { readonly error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "Responses native response is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: "Responses native response is not a JSON object" };
  }
  const record = parsed as Record<string, unknown>;
  const paths = collectModelPaths(parsed);
  if (paths.length !== 1 || paths[0] !== "model") {
    return { error: "Responses native response carries an ambiguous model position" };
  }
  if (typeof record.model !== "string") {
    return { error: "Responses native response carries no model identity" };
  }
  record.model = alias;
  return { body: new TextEncoder().encode(JSON.stringify(record)) };
}

function rewriteSseEvent(
  parsed: unknown,
  alias: string,
): { readonly json: string } | { readonly unchanged: true } | { readonly error: string } {
  if (typeof parsed !== "object" || parsed === null) return { unchanged: true };
  const record = parsed as Record<string, unknown>;
  const paths = collectModelPaths(parsed);
  if (paths.length === 0) return { unchanged: true };
  if (paths.length !== 1 || paths[0] !== "model") {
    return { error: "Responses SSE event carries an ambiguous model position" };
  }
  if (typeof record.model !== "string") {
    return { error: "Responses SSE event carries a non-string model" };
  }
  record.model = alias;
  return { json: JSON.stringify(record) };
}

function projectSse(
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
      return { error: "Responses native SSE event is not valid JSON" };
    }
    const rewritten = rewriteSseEvent(parsed, alias);
    if ("error" in rewritten) return { error: rewritten.error };
    if ("unchanged" in rewritten) {
      out.push(renderSseFrame(frame));
      continue;
    }
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

export function projectNativeResponsesBody(
  body: Uint8Array,
  contentType: string,
  alias: string,
): { readonly body: Uint8Array<ArrayBuffer> } | { readonly error: string } {
  const text = new TextDecoder().decode(body);
  return contentType.toLowerCase().includes("text/event-stream")
    ? projectSse(text, alias)
    : projectJson(text, alias);
}
