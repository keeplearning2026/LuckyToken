import type { FetchFunction, Models } from "@earendil-works/pi-ai";

import type { ClientProtocolHandler } from "../../http.js";
import {
  readResponsesRequestBody,
  ResponsesRequestBodyTooLargeError,
  UnsupportedResponsesContentEncodingError,
} from "../../protocols/openai-responses/request-body.js";
import {
  renderResponsesError,
  type PreparedHttpResponse,
} from "../../protocols/openai-responses/response.js";
import type {
  CodexLocalCredentialAuthority,
  CodexNativeModelSource,
} from "../../codex-native-seam.js";
import {
  resolveDataPlaneModel,
  type AliasModelSource,
} from "../../alias-model-seam.js";
import {
  identityRequestModelResolver,
  type RequestModelResolver,
} from "../../protocols/options.js";
import {
  bufferResponsesPassthroughResponse,
  passthroughResponsesRequestHeaders,
  ResponsesPassthroughBodyReadError,
  ResponsesPassthroughTransportError,
  type ResponsesNativePassthrough,
} from "../../protocols/openai-responses/passthrough.js";
import {
  CodexResponsesPassthroughBodyReadError,
  CodexResponsesPassthroughTransportError,
  passthroughCodexResponsesCompact,
} from "../../codex-responses-passthrough.js";

export const CODEX_COMPACT_PROMPT = `Create a concise handoff summary of the conversation so another model can continue the task. Preserve current progress, key decisions, constraints, important facts, and clear next steps. Do not continue solving the task; summarize the state needed to resume it.`;

export const CODEX_COMPACT_SUMMARY_PREFIX =
  "Another language model summarized the earlier conversation so work can continue from this checkpoint. Here is that summary:";

const RETAINED_USER_CHAR_BUDGET = 80_000;

export interface CodexResponsesCompactHandlerOptions {
  readonly codexLocalAuth?: CodexLocalCredentialAuthority;
  readonly codexNativeModels?: CodexNativeModelSource;
  readonly models?: Models;
  readonly aliasSource?: AliasModelSource;
  readonly nativePassthrough?: ResponsesNativePassthrough;
  readonly resolveRequestModel?: RequestModelResolver;
  readonly responsesHandler: ClientProtocolHandler;
  readonly fetch: FetchFunction;
  readonly maxRequestBytes: number;
}

function toResponse(prepared: PreparedHttpResponse): Response {
  return new Response(prepared.body, {
    status: prepared.status,
    headers: { "content-type": prepared.contentType },
  });
}

function errorResponse(status: number, message: string): Response {
  return toResponse(renderResponsesError(status, "api_error", message));
}

function jsonError(status: number, message: string): Response {
  return toResponse(renderResponsesError(status, "invalid_request_error", message));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.set("content-type", "application/json");
  return headers;
}

function textFromUserContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!isRecord(part)) return "";
      if (
        (part.type === "input_text" || part.type === "text") &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
      return "";
    })
    .join("");
}

function retainedUserMessages(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const messages = input.flatMap((item): string[] => {
    if (!isRecord(item)) return [];
    if (item.type !== undefined && item.type !== "message") return [];
    if (item.role !== "user") return [];
    const text = textFromUserContent(item.content);
    return text.trim().length === 0 ? [] : [text];
  });
  const selected: string[] = [];
  let remaining = RETAINED_USER_CHAR_BUDGET;
  for (let index = messages.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const message = messages[index] as string;
    if (message.length <= remaining) {
      selected.push(message);
      remaining -= message.length;
      continue;
    }
    selected.push(message.slice(message.length - remaining));
    remaining = 0;
  }
  return selected.reverse();
}

function compactMessage(text: string): Record<string, unknown> {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  };
}

function buildCompactOutput(input: unknown, summary: string): Record<string, unknown>[] {
  return [
    ...retainedUserMessages(input).map(compactMessage),
    compactMessage(`${CODEX_COMPACT_SUMMARY_PREFIX}\n${summary}`),
  ];
}

function extractSummary(response: unknown): string | undefined {
  if (!isRecord(response) || response.status !== "completed" || !Array.isArray(response.output)) {
    return undefined;
  }
  const fragments: string[] = [];
  for (const item of response.output) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (!isRecord(part)) continue;
      if (
        (part.type === "output_text" || part.type === "text") &&
        typeof part.text === "string"
      ) {
        fragments.push(part.text);
      }
    }
  }
  const summary = fragments.join("").trim();
  return summary.length === 0 ? undefined : summary;
}

async function nativeCompact(
  options: CodexResponsesCompactHandlerOptions,
  request: Request,
  rawBody: string,
): Promise<Response | undefined> {
  if (options.codexLocalAuth === undefined) return undefined;
  const forwardAuth = await options.codexLocalAuth.resolveForwardAuth(request.headers);
  if (forwardAuth === undefined) return undefined;
  try {
    const upstream = await passthroughCodexResponsesCompact({
      rawBody,
      requestHeaders: request.headers,
      forwardAuth,
      signal: request.signal,
      fetch: options.fetch,
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...upstream.headers },
    });
  } catch (error) {
    if (request.signal.aborted) throw error;
    if (
      error instanceof CodexResponsesPassthroughTransportError ||
      error instanceof CodexResponsesPassthroughBodyReadError
    ) {
      return errorResponse(502, "Upstream compact request failed");
    }
    throw error;
  }
}

async function providerNativeCompact(
  options: CodexResponsesCompactHandlerOptions,
  request: Request,
  rawBody: string,
  selector: string,
): Promise<Response | undefined> {
  if (options.models === undefined || options.nativePassthrough === undefined) {
    return undefined;
  }
  const resolution = await resolveDataPlaneModel(
    options.models,
    options.aliasSource,
    selector,
  );
  if (resolution.kind !== "model") return undefined;
  if (!options.nativePassthrough.supportsCompact(resolution.model)) {
    return undefined;
  }
  const auth = await options.models.getAuth(resolution.model);
  if (auth === undefined) {
    return errorResponse(502, `Provider is not configured: ${resolution.model.provider}`);
  }
  const resolveRequestModel =
    options.resolveRequestModel ?? identityRequestModelResolver;
  try {
    let upstream: Response;
    try {
      upstream = await options.nativePassthrough.compact({
        model: resolveRequestModel(resolution.model, auth),
        auth,
        rawBody,
        signal: request.signal,
        forwardedHeaders: passthroughResponsesRequestHeaders(request),
      });
    } catch (error) {
      if (request.signal.aborted) throw error;
      throw new ResponsesPassthroughTransportError(error);
    }
    const buffered = await bufferResponsesPassthroughResponse(
      upstream,
      request.signal,
    );
    return new Response(buffered.body, {
      status: buffered.status,
      headers: { ...buffered.headers },
    });
  } catch (error) {
    if (request.signal.aborted) throw error;
    if (
      error instanceof ResponsesPassthroughTransportError ||
      error instanceof ResponsesPassthroughBodyReadError
    ) {
      return errorResponse(502, "Upstream compact request failed");
    }
    throw error;
  }
}

async function routedCompact(
  options: CodexResponsesCompactHandlerOptions,
  request: Request,
  body: Record<string, unknown>,
): Promise<Response> {
  const input = Array.isArray(body.input) ? body.input : [];
  const internalBody = {
    ...body,
    stream: false,
    store: false,
    input: [
      ...input,
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: CODEX_COMPACT_PROMPT }],
      },
    ],
  };
  const internalRequest = new Request("http://luckytoken.internal/v1/responses", {
    method: "POST",
    headers: jsonHeaders(request.headers),
    body: JSON.stringify(internalBody),
    signal: request.signal,
  });
  const summarized = await options.responsesHandler.handle(internalRequest);
  if (!summarized.ok) return summarized;
  let parsed: unknown;
  try {
    parsed = await summarized.json();
  } catch {
    return errorResponse(502, "Compaction summary response was not valid JSON");
  }
  const summary = extractSummary(parsed);
  if (summary === undefined) {
    return errorResponse(502, "Compaction summary response contained no text");
  }
  const headers = new Headers({ "content-type": "application/json" });
  const requestId = summarized.headers.get("x-luckytoken-request-id");
  if (requestId !== null) headers.set("x-luckytoken-request-id", requestId);
  return new Response(
    JSON.stringify({ output: buildCompactOutput(body.input, summary) }),
    { status: 200, headers },
  );
}

export function createCodexResponsesCompactHandler(
  options: CodexResponsesCompactHandlerOptions,
): ClientProtocolHandler {
  return Object.freeze({
    method: "POST",
    pathname: "/v1/responses/compact",
    async handle(request: Request): Promise<Response> {
      try {
        const contentType = request.headers.get("content-type")
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase();
        if (contentType !== "application/json") {
          return jsonError(415, "Content-Type must be application/json");
        }
        const decoded = await readResponsesRequestBody(request, options.maxRequestBytes);
        if (!isRecord(decoded.json)) {
          return jsonError(400, "Invalid compaction request body");
        }
        const body = decoded.json;
        if (typeof body.model !== "string" || body.model.length === 0) {
          return jsonError(400, "Compaction request requires a model");
        }
        if (options.codexNativeModels?.has(body.model) === true) {
          const native = await nativeCompact(options, request, decoded.text);
          if (native !== undefined) return native;
        }
        const providerNative = await providerNativeCompact(
          options,
          request,
          decoded.text,
          body.model,
        );
        if (providerNative !== undefined) return providerNative;
        return await routedCompact(options, request, body);
      } catch (error) {
        if (request.signal.aborted) throw error;
        if (error instanceof ResponsesRequestBodyTooLargeError) {
          return toResponse(
            renderResponsesError(
              413,
              "request_too_large",
              "Request exceeds the configured maximum size",
            ),
          );
        }
        if (error instanceof UnsupportedResponsesContentEncodingError) {
          return jsonError(415, "Unsupported Content-Encoding");
        }
        if (error instanceof SyntaxError) {
          return jsonError(400, "Request body is not valid JSON");
        }
        throw error;
      }
    },
  });
}
