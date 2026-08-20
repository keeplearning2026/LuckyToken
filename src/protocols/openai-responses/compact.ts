import type { Models } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";

import {
  resolveDataPlaneModel,
  type AliasModelSource,
} from "../../alias-model-seam.js";
import {
  createNoopInvocationDiagnosticsFactory,
} from "../../invocation-diagnostics/index.js";
import { resolveRequestIdentity } from "../../request-identity.js";
import { createNoopRequestLedger } from "../../request-ledger/handler-seam.js";
import type { ClientProtocolHandler } from "../../http.js";
import type { ProviderResponsesLane } from "../../provider-native-responses/contract.js";
import type { LocalResponsesCompactLane } from "./compact-contract.js";
import {
  bindOpenAIResponsesConfiguration,
  parseOpenAIResponsesConfiguration,
  type OpenAIResponsesConfiguration,
} from "./configuration.js";
import {
  readResponsesRequestBody,
  ResponsesRequestBodyTooLargeError,
  UnsupportedResponsesContentEncodingError,
} from "./request-body.js";
import {
  renderResponsesError,
  type PreparedHttpResponse,
} from "./response.js";
import {
  createResponseSessionState,
  type ResponseSessionState,
} from "./session-state.js";
import { executeSemanticResponses } from "./semantic.js";
import type { ExecutionOperation } from "../../execution.js";
import type { RouterOptionDefaults } from "../options.js";

export const CODEX_COMPACT_PROMPT = `Create a concise handoff summary of the conversation so another model can continue the task. Preserve current progress, key decisions, constraints, important facts, and clear next steps. Do not continue solving the task; summarize the state needed to resume it.`;
export const CODEX_COMPACT_SUMMARY_PREFIX =
  "Another language model summarized the earlier conversation so work can continue from this checkpoint. Here is that summary:";

const RETAINED_USER_CHAR_BUDGET = 80_000;

export interface OpenAIResponsesCompactHandlerOptions {
  readonly models: Models;
  readonly aliasSource?: AliasModelSource;
  readonly localNativeLane?: LocalResponsesCompactLane;
  readonly providerNativeLane?: ProviderResponsesLane;
  readonly configuration?: OpenAIResponsesConfiguration;
  readonly stateFile: string;
  readonly sessionState?: ResponseSessionState;
  readonly createSessionId?: () => string;
  readonly createResponseId?: () => string;
  readonly executeOperation?: ExecutionOperation;
  readonly routerDefaults?: RouterOptionDefaults;
  readonly now?: () => number;
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
    const message = messages[index]!;
    if (message.length <= remaining) {
      selected.push(message);
      remaining -= message.length;
    } else {
      selected.push(message.slice(message.length - remaining));
      remaining = 0;
    }
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

async function providerCompact(
  lane: ProviderResponsesLane,
  request: Request,
  rawBody: string,
  model: Parameters<ProviderResponsesLane["claims"]>[0],
  alias: string | undefined,
): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await lane.execute({
      model,
      rawBody,
      request,
      operation: "compact",
    });
  } catch (error) {
    if (request.signal.aborted) throw error;
    return errorResponse(502, "Upstream compact request failed");
  }
  if (upstream.status >= 400 && alias !== undefined) {
    return errorResponse(502, "Upstream provider failed");
  }
  const bytes = new Uint8Array(await upstream.arrayBuffer());
  if (alias === undefined || upstream.status >= 400) {
    return new Response(bytes, { status: upstream.status, headers: upstream.headers });
  }
  const contentType = upstream.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("json")) {
    return new Response(bytes, { status: upstream.status, headers: upstream.headers });
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (isRecord(parsed) && Object.hasOwn(parsed, "model")) {
      if (typeof parsed.model !== "string") {
        return errorResponse(502, "Upstream response could not be projected safely");
      }
      parsed.model = alias;
      return new Response(JSON.stringify(parsed), {
        status: upstream.status,
        headers: upstream.headers,
      });
    }
  } catch {
    return errorResponse(502, "Upstream response could not be projected safely");
  }
  return new Response(bytes, { status: upstream.status, headers: upstream.headers });
}

export function createOpenAIResponsesCompactHandler(
  options: OpenAIResponsesCompactHandlerOptions,
): ClientProtocolHandler {
  const configuration =
    options.configuration === undefined
      ? parseOpenAIResponsesConfiguration()
      : bindOpenAIResponsesConfiguration(options.configuration);
  const sessionState =
    options.sessionState ??
    createResponseSessionState({
      stateFile: options.stateFile,
      storeFalsePolicy: configuration.conversion.response.storeFalse,
    });
  const createSessionId = options.createSessionId ?? randomUUID;
  const createResponseId = options.createResponseId ?? (() => `resp_${randomUUID()}`);
  const now = options.now ?? Date.now;
  const routerDefaults = Object.freeze({ ...(options.routerDefaults ?? {}) });

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
        if (!isRecord(decoded.json)) return jsonError(400, "Invalid compaction request body");
        const body = decoded.json;
        if (typeof body.model !== "string" || body.model.length === 0) {
          return jsonError(400, "Compaction request requires a model");
        }
        const selector = body.model;
        if (options.localNativeLane?.claims(selector) === true) {
          return options.localNativeLane.execute({
            request,
            rawBody: decoded.text,
            selector,
          });
        }

        const resolution = await resolveDataPlaneModel(
          options.models,
          options.aliasSource,
          selector,
        );
        if (resolution.kind === "unknown") {
          return jsonError(400, `Unknown model: ${selector}`);
        }
        if (resolution.kind === "unavailable") {
          return errorResponse(503, "The requested model is not currently available");
        }
        const model = resolution.model;
        const alias = options.aliasSource === undefined ? undefined : resolution.alias;
        if (options.providerNativeLane?.claims(model, "compact") === true) {
          return providerCompact(
            options.providerNativeLane,
            request,
            decoded.text,
            model,
            alias,
          );
        }

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
        const diagnostics = createNoopInvocationDiagnosticsFactory().begin(
          "openai-responses",
        );
        const ledger = createNoopRequestLedger().begin("openai-responses");
        const summarized = await executeSemanticResponses({
          request,
          body: internalBody,
          model,
          requestIdentity: resolveRequestIdentity(request.headers, createSessionId),
          models: options.models,
          configuration,
          sessionState,
          routerDefaults,
          createResponseId,
          now,
          ...(options.executeOperation === undefined
            ? {}
            : { executeOperation: options.executeOperation }),
          diagnostics,
          ledger,
        });
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
        return new Response(
          JSON.stringify({ output: buildCompactOutput(body.input, summary) }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
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
        return errorResponse(500, "Internal server error");
      }
    },
  });
}
