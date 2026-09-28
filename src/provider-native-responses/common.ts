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

function topLevelModelStringSpans(
  rawBody: string,
): ReadonlyArray<readonly [number, number]> {
  let index = skipWhitespace(rawBody, 0);
  if (rawBody[index] !== "{") return [];
  index += 1;
  const spans: Array<readonly [number, number]> = [];
  while (index < rawBody.length) {
    index = skipWhitespace(rawBody, index);
    if (rawBody[index] === "}") break;
    const keyStart = index;
    const keyEnd = endOfString(rawBody, keyStart);
    const key = JSON.parse(rawBody.slice(keyStart, keyEnd)) as unknown;
    index = skipWhitespace(rawBody, keyEnd);
    if (rawBody[index] !== ":") throw new Error("Expected JSON property separator");
    index = skipWhitespace(rawBody, index + 1);
    const valueStart = index;
    const valueEnd = endOfValue(rawBody, valueStart);
    if (key === "model" && rawBody[valueStart] === '"') {
      spans.push([valueStart, valueEnd] as const);
    }
    index = skipWhitespace(rawBody, valueEnd);
    if (rawBody[index] === ",") {
      index += 1;
      continue;
    }
    if (rawBody[index] === "}") break;
    throw new Error("Expected JSON property delimiter");
  }
  return spans;
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
