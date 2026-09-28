import type { FetchFunction, ProviderHeaders } from "@earendil-works/pi-ai";

import { ProviderResponsesNetworkError } from "./contract.js";

export async function executeProviderFetch(
  fetch: FetchFunction,
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    throw new ProviderResponsesNetworkError(error);
  }
}

export function appendEndpoint(baseUrl: string, endpoint: string): string {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/u, "");
  url.pathname = `${basePath}${endpoint}`;
  url.hash = "";
  return url.toString();
}

export function applyHeaders(
  target: Headers,
  source: ProviderHeaders | Readonly<Record<string, string>> | undefined,
): void {
  if (source === undefined) return;
  for (const [name, value] of Object.entries(source)) {
    if (value === null) target.delete(name);
    else target.set(name, value);
  }
}

export function hasHeader(
  headers: ProviderHeaders | undefined,
  name: string,
): boolean {
  if (headers === undefined) return false;
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (
      key.toLowerCase() === expected &&
      value !== null &&
      value.trim().length > 0
    ) {
      return true;
    }
  }
  return false;
}

export function parseJsonObject(rawBody: string): Record<string, unknown> {
  const parsed = JSON.parse(rawBody) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Responses passthrough body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
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

interface TopLevelEntry {
  readonly key: string;
  readonly keyStart: number;
  readonly valueStart: number;
  readonly valueEnd: number;
}

interface TopLevelScan {
  readonly entries: readonly TopLevelEntry[];
  readonly duplicate: boolean;
}

/** Span-only scan of the caller's top-level JSON object. Returns null when the
 *  text is not a plain object or cannot be walked unambiguously. */
function scanTopLevelObject(rawBody: string): TopLevelScan | null {
  let index = skipWhitespace(rawBody, 0);
  if (rawBody[index] !== "{") return null;
  index = skipWhitespace(rawBody, index + 1);
  const entries: TopLevelEntry[] = [];
  const seen = new Set<string>();
  let duplicate = false;
  if (rawBody[index] === "}") return { entries, duplicate };
  for (;;) {
    const keyStart = index;
    let keyEnd: number;
    let key: unknown;
    try {
      keyEnd = endOfString(rawBody, keyStart);
      key = JSON.parse(rawBody.slice(keyStart, keyEnd)) as unknown;
    } catch {
      return null;
    }
    if (typeof key !== "string") return null;
    if (seen.has(key)) duplicate = true;
    seen.add(key);
    index = skipWhitespace(rawBody, keyEnd);
    if (rawBody[index] !== ":") return null;
    index = skipWhitespace(rawBody, index + 1);
    let valueEnd: number;
    try {
      valueEnd = endOfValue(rawBody, index);
    } catch {
      return null;
    }
    entries.push({ key, keyStart, valueStart: index, valueEnd });
    index = skipWhitespace(rawBody, valueEnd);
    if (rawBody[index] === ",") {
      index = skipWhitespace(rawBody, index + 1);
      continue;
    }
    if (rawBody[index] === "}") return { entries, duplicate };
    return null;
  }
}

function topLevelModelStringSpans(
  rawBody: string,
): ReadonlyArray<readonly [number, number]> {
  const scanned = scanTopLevelObject(rawBody);
  if (scanned === null) {
    throw new Error("Responses passthrough body must be a JSON object");
  }
  return scanned.entries
    .filter((entry) => entry.key === "model" && rawBody[entry.valueStart] === '"')
    .map((entry) => [entry.valueStart, entry.valueEnd] as const);
}

export function rewriteModelJson(
  rawBody: string,
  modelId: string,
): { readonly parsed: Record<string, unknown>; readonly text: string } {
  const parsed = parseJsonObject(rawBody);
  if (typeof parsed.model !== "string" || parsed.model === modelId) {
    return { parsed, text: rawBody };
  }
  const replacement = JSON.stringify(modelId);
  const spans = topLevelModelStringSpans(rawBody);
  if (spans.length === 0) throw new Error("Responses passthrough model must be a string");
  let text = rawBody;
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const [start, end] = spans[index]!;
    text = `${text.slice(0, start)}${replacement}${text.slice(end)}`;
  }
  return { parsed: { ...parsed, model: modelId }, text };
}

export interface TopLevelPropertyRemoval {
  /** The caller's document without the removed property. */
  readonly parsed: Record<string, unknown>;
  /** Byte-identical to the input whenever `removed` is false. */
  readonly text: string;
  readonly removed: boolean;
}

/**
 * Remove exactly one top-level JSON property while keeping every other byte of
 * the caller's request text: nested properties with the same name, string
 * escapes, number literals, and whitespace all survive unchanged. Any
 * ambiguity — an absent property, a duplicate top-level key, text that cannot
 * be walked, or a splice that no longer parses back to the same remaining
 * document — returns the original bytes instead of rewriting the whole body.
 */
export function removeTopLevelJsonProperty(
  rawBody: string,
  name: string,
): TopLevelPropertyRemoval {
  const parsed = parseJsonObject(rawBody);
  const unchanged = (): TopLevelPropertyRemoval => ({
    parsed,
    text: rawBody,
    removed: false,
  });
  if (!Object.hasOwn(parsed, name)) return unchanged();
  const scanned = scanTopLevelObject(rawBody);
  if (scanned === null || scanned.duplicate) return unchanged();
  const index = scanned.entries.findIndex((entry) => entry.key === name);
  const entry = scanned.entries[index];
  if (entry === undefined) return unchanged();
  const next = scanned.entries[index + 1];
  const start =
    next === undefined
      ? (scanned.entries[index - 1]?.valueEnd ?? entry.keyStart)
      : entry.keyStart;
  const end = next === undefined ? entry.valueEnd : next.keyStart;
  const text = `${rawBody.slice(0, start)}${rawBody.slice(end)}`;
  const expected: Record<string, unknown> = { ...parsed };
  delete expected[name];
  let projected: unknown;
  try {
    projected = JSON.parse(text) as unknown;
  } catch {
    return unchanged();
  }
  if (
    typeof projected !== "object" ||
    projected === null ||
    Array.isArray(projected) ||
    JSON.stringify(projected) !== JSON.stringify(expected)
  ) {
    return unchanged();
  }
  return { parsed: projected as Record<string, unknown>, text, removed: true };
}
