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

function skipWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/u.test(text[index]!)) index += 1;
  return index;
}

function endOfString(text: string, start: number): number {
  if (text[start] !== '"') throw new Error("Expected JSON string");
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') return index + 1;
  }
  throw new Error("Unterminated JSON string");
}

function endOfValue(text: string, start: number): number {
  if (text[start] === '"') return endOfString(text, start);
  const opening = text[start];
  if (opening !== "{" && opening !== "[") {
    let index = start;
    while (index < text.length && text[index] !== "," && text[index] !== "}") {
      index += 1;
    }
    return index;
  }
  const stack: string[] = [opening === "{" ? "}" : "]"];
  let index = start + 1;
  while (index < text.length && stack.length > 0) {
    const char = text[index]!;
    if (char === '"') {
      index = endOfString(text, index);
      continue;
    }
    if (char === "{") stack.push("}");
    else if (char === "[") stack.push("]");
    else if (char === stack[stack.length - 1]) stack.pop();
    index += 1;
  }
  if (stack.length !== 0) throw new Error("Unterminated JSON value");
  return index;
}

function topLevelModelStringSpans(
  text: string,
): ReadonlyArray<readonly [number, number]> {
  let index = skipWhitespace(text, 0);
  if (text[index] !== "{") return [];
  index += 1;
  const spans: Array<readonly [number, number]> = [];
  while (index < text.length) {
    index = skipWhitespace(text, index);
    if (text[index] === "}") break;
    const keyStart = index;
    const keyEnd = endOfString(text, keyStart);
    const key = JSON.parse(text.slice(keyStart, keyEnd)) as unknown;
    index = skipWhitespace(text, keyEnd);
    if (text[index] !== ":") throw new Error("Expected JSON property separator");
    index = skipWhitespace(text, index + 1);
    const valueStart = index;
    const valueEnd = endOfValue(text, valueStart);
    if (key === "model" && text[valueStart] === '"') {
      spans.push([valueStart, valueEnd] as const);
    }
    index = skipWhitespace(text, valueEnd);
    if (text[index] === ",") {
      index += 1;
      continue;
    }
    if (text[index] === "}") break;
    throw new Error("Expected JSON property delimiter");
  }
  return spans;
}

function modelSpan(
  text: string,
  missingMessage: string,
  ambiguousMessage: string,
  nonStringMessage: string,
): { readonly span: readonly [number, number] } | { readonly error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: missingMessage };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: missingMessage };
  }
  const record = parsed as Record<string, unknown>;
  const paths = collectModelPaths(parsed);
  if (paths.length !== 1 || paths[0] !== "model") {
    return { error: ambiguousMessage };
  }
  if (typeof record.model !== "string") return { error: nonStringMessage };
  let spans: ReadonlyArray<readonly [number, number]>;
  try {
    spans = topLevelModelStringSpans(text);
  } catch {
    return { error: ambiguousMessage };
  }
  if (spans.length !== 1) return { error: ambiguousMessage };
  return { span: spans[0]! };
}

function replaceSpan(
  text: string,
  span: readonly [number, number],
  replacement: string,
): string {
  return `${text.slice(0, span[0])}${replacement}${text.slice(span[1])}`;
}

function projectJson(
  text: string,
  alias: string,
): { readonly body: Uint8Array<ArrayBuffer> } | { readonly error: string } {
  const located = modelSpan(
    text,
    "Responses native response is not valid JSON",
    "Responses native response carries an ambiguous model position",
    "Responses native response carries no model identity",
  );
  if ("error" in located) return located;
  const projected = replaceSpan(text, located.span, JSON.stringify(alias));
  return { body: new TextEncoder().encode(projected) };
}

interface RawSseLine {
  readonly contentStart: number;
  readonly contentEnd: number;
  readonly end: number;
}

function rawSseLines(text: string): readonly RawSseLine[] {
  const lines: RawSseLine[] = [];
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === "\r" || char === "\n") {
      const contentEnd = index;
      if (char === "\r" && text[index + 1] === "\n") index += 2;
      else index += 1;
      lines.push({ contentStart: start, contentEnd, end: index });
      start = index;
      continue;
    }
    index += 1;
  }
  if (start < text.length) {
    lines.push({ contentStart: start, contentEnd: text.length, end: text.length });
  }
  return lines;
}

interface DataPayloadPart {
  readonly joinedStart: number;
  readonly joinedEnd: number;
  readonly rawStart: number;
  readonly rawEnd: number;
  readonly text: string;
}

function frameModelRawSpan(
  text: string,
  lines: readonly RawSseLine[],
): { readonly span?: readonly [number, number] } | { readonly error: string } {
  const parts: DataPayloadPart[] = [];
  let joinedLength = 0;
  for (const line of lines) {
    const rawLine = text.slice(line.contentStart, line.contentEnd);
    if (rawLine !== "data" && !rawLine.startsWith("data:")) continue;
    let rawStart = line.contentStart + 5;
    if (text[rawStart] === " ") rawStart += 1;
    const payload = text.slice(rawStart, line.contentEnd);
    if (parts.length > 0) joinedLength += 1;
    const joinedStart = joinedLength;
    joinedLength += payload.length;
    parts.push({
      joinedStart,
      joinedEnd: joinedLength,
      rawStart,
      rawEnd: line.contentEnd,
      text: payload,
    });
  }
  if (parts.length === 0) return {};
  const payload = parts.map((part) => part.text).join("\n");
  if (payload.length === 0) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { error: "Responses native SSE event is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const paths = collectModelPaths(parsed);
  if (paths.length === 0) return {};
  if (paths.length !== 1 || paths[0] !== "model") {
    return { error: "Responses SSE event carries an ambiguous model position" };
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.model !== "string") {
    return { error: "Responses SSE event carries a non-string model" };
  }

  let spans: ReadonlyArray<readonly [number, number]>;
  try {
    spans = topLevelModelStringSpans(payload);
  } catch {
    return { error: "Responses SSE event carries an ambiguous model position" };
  }
  if (spans.length !== 1) {
    return { error: "Responses SSE event carries an ambiguous model position" };
  }
  const [start, end] = spans[0]!;
  const part = parts.find(
    (candidate) => start >= candidate.joinedStart && end <= candidate.joinedEnd,
  );
  if (part === undefined) {
    return { error: "Responses SSE event carries an ambiguous model position" };
  }
  return {
    span: [
      part.rawStart + (start - part.joinedStart),
      part.rawStart + (end - part.joinedStart),
    ],
  };
}

function projectSse(
  text: string,
  alias: string,
): { readonly body: Uint8Array<ArrayBuffer> } | { readonly error: string } {
  const lines = rawSseLines(text);
  const spans: Array<readonly [number, number]> = [];
  let frame: RawSseLine[] = [];
  const inspect = (): string | undefined => {
    if (frame.length === 0) return undefined;
    const located = frameModelRawSpan(text, frame);
    frame = [];
    if ("error" in located) return located.error;
    if (located.span !== undefined) spans.push(located.span);
    return undefined;
  };

  for (const line of lines) {
    const content = text.slice(line.contentStart, line.contentEnd);
    if (content.length === 0) {
      const error = inspect();
      if (error !== undefined) return { error };
      continue;
    }
    frame.push(line);
  }
  const trailingError = inspect();
  if (trailingError !== undefined) return { error: trailingError };

  let projected = text;
  const replacement = JSON.stringify(alias);
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    projected = replaceSpan(projected, spans[index]!, replacement);
  }
  return { body: new TextEncoder().encode(projected) };
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
