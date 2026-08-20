import type { Models } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";

import {
  resolveDataPlaneModel,
  type AliasModelSource,
} from "../../alias-model-seam.js";
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
  bufferNativeResponsesResponse,
  projectNativeResponsesBody,
  ResponsesNativeBodyReadError,
} from "./native-response.js";
import {
  createResponseSessionState,
  type ResponseSessionState,
} from "./session-state.js";
import { executeSemanticCompact } from "./compact-semantic.js";
import type { ExecutionOperation } from "../../execution.js";
import type { RouterOptionDefaults } from "../options.js";

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

async function providerCompact(
  lane: ProviderResponsesLane,
  request: Request,
  rawBody: string,
  model: Parameters<ProviderResponsesLane["claims"]>[0],
  alias: string | undefined,
): Promise<Response> {
  let upstream: Awaited<ReturnType<typeof bufferNativeResponsesResponse>>;
  try {
    const response = await lane.execute({
      model,
      rawBody,
      request,
      operation: "compact",
    });
    upstream = await bufferNativeResponsesResponse(response, request.signal);
  } catch (error) {
    if (request.signal.aborted) throw error;
    return errorResponse(
      502,
      error instanceof ResponsesNativeBodyReadError
        ? "Upstream compact response could not be read"
        : "Upstream compact request failed",
    );
  }
  if (upstream.status >= 400 && alias !== undefined) {
    return errorResponse(502, "Upstream provider failed");
  }
  if (alias === undefined || upstream.status >= 400) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...upstream.headers },
    });
  }
  const contentType = upstream.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().includes("json")) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...upstream.headers },
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(upstream.body)) as unknown;
  } catch {
    return errorResponse(502, "Upstream response could not be projected safely");
  }
  let body = upstream.body;
  if (isRecord(parsed) && Object.hasOwn(parsed, "model")) {
    const projected = projectNativeResponsesBody(body, contentType, alias);
    if ("error" in projected) {
      return errorResponse(502, "Upstream response could not be projected safely");
    }
    body = projected.body;
  }
  return new Response(body, {
    status: upstream.status,
    headers: { ...upstream.headers },
  });
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

        return executeSemanticCompact({
          request,
          body,
          model,
          models: options.models,
          configuration,
          sessionState,
          createSessionId,
          createResponseId,
          ...(options.executeOperation === undefined
            ? {}
            : { executeOperation: options.executeOperation }),
          routerDefaults,
          now,
        });
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
