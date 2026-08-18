import type { FetchFunction } from "@earendil-works/pi-ai";

import type { CodexForwardAuth } from "./codex-native-seam.js";

export const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
export const CODEX_RESPONSES_COMPACT_URL =
  "https://chatgpt.com/backend-api/codex/responses/compact";

export interface CodexResponsesPassthroughResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array<ArrayBuffer>;
}

export interface CodexResponsesPassthroughOptions {
  readonly rawBody: string;
  readonly requestHeaders: Headers;
  readonly forwardAuth: CodexForwardAuth;
  readonly signal: AbortSignal;
  readonly fetch: FetchFunction;
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

const RESPONSE_FORBIDDEN = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "www-authenticate",
]);

const EXACT_FORWARD_HEADERS = new Set([
  "chatgpt-account-id",
  "openai-beta",
  "originator",
  "session_id",
  "session-id",
  "thread-id",
  "x-client-request-id",
  "x-oai-attestation",
  "x-openai-subagent",
  "x-responsesapi-include-timing-metrics",
]);

function shouldForwardRequestHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return EXACT_FORWARD_HEADERS.has(lower) || lower.startsWith("x-codex-");
}

function buildRequestHeaders(source: Headers, auth: CodexForwardAuth): Headers {
  const headers = new Headers({
    "content-type": "application/json",
    authorization: auth.authorization,
  });
  for (const [name, value] of source) {
    const lower = name.toLowerCase();
    if (!shouldForwardRequestHeader(lower)) continue;
    headers.set(lower, value);
  }
  if (
    headers.get("chatgpt-account-id") === null &&
    auth.accountId !== undefined
  ) {
    headers.set("chatgpt-account-id", auth.accountId);
  }
  return headers;
}

function responseHeaders(source: Headers): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [name, value] of source) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || RESPONSE_FORBIDDEN.has(lower)) continue;
    result[lower] = value;
  }
  return Object.freeze(result);
}

export class CodexResponsesPassthroughTransportError extends Error {
  readonly kind = "CodexResponsesPassthroughTransportError" as const;

  constructor(cause: unknown) {
    super("Codex upstream request failed", { cause });
    this.name = "CodexResponsesPassthroughTransportError";
  }
}

export class CodexResponsesPassthroughBodyReadError extends Error {
  readonly kind = "CodexResponsesPassthroughBodyReadError" as const;

  constructor(cause: unknown) {
    super("Codex upstream response could not be read", { cause });
    this.name = "CodexResponsesPassthroughBodyReadError";
  }
}

/** Client-owned Codex OAuth passthrough. No Pi credential or Pi Model participates. */
async function passthroughCodexRequest(
  url: string,
  options: CodexResponsesPassthroughOptions,
): Promise<CodexResponsesPassthroughResult> {
  let response: Response;
  try {
    response = await options.fetch(url, {
      method: "POST",
      headers: buildRequestHeaders(options.requestHeaders, options.forwardAuth),
      body: options.rawBody,
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal.aborted) throw error;
    throw new CodexResponsesPassthroughTransportError(error);
  }

  let body: Uint8Array<ArrayBuffer>;
  try {
    body = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (options.signal.aborted) throw error;
    throw new CodexResponsesPassthroughBodyReadError(error);
  }
  return Object.freeze({
    status: response.status,
    headers: responseHeaders(response.headers),
    body,
  });
}

export function passthroughCodexResponses(
  options: CodexResponsesPassthroughOptions,
): Promise<CodexResponsesPassthroughResult> {
  return passthroughCodexRequest(CODEX_RESPONSES_URL, options);
}

export function passthroughCodexResponsesCompact(
  options: CodexResponsesPassthroughOptions,
): Promise<CodexResponsesPassthroughResult> {
  return passthroughCodexRequest(CODEX_RESPONSES_COMPACT_URL, options);
}
