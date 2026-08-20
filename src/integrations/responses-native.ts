import type {
  AuthResult,
  FetchFunction,
  Model,
  ProviderHeaders,
} from "@earendil-works/pi-ai";
import { arch, platform, release } from "node:os";
import { constants as zlibConstants, zstdCompressSync } from "node:zlib";

import { resolveRequestModel } from "../providers/request-composition.js";
import type {
  ResponsesNativePassthrough,
  ResponsesNativePassthroughRequest,
} from "../protocols/openai-responses/passthrough.js";

export type ResponsesNativeOperation = "responses" | "compact";

export interface ResponsesNativeSender {
  readonly supportsNativeCompact: boolean;
  send(
    operation: ResponsesNativeOperation,
    rawBody: string,
    signal: AbortSignal,
  ): Promise<Response>;
}

export interface CreateResponsesNativeSenderOptions {
  readonly model: Model<string>;
  readonly auth: AuthResult;
  readonly fetch: FetchFunction;
  readonly forwardedHeaders?: Readonly<Record<string, string>>;
}

const REQUEST_COMPRESSION_ZSTD_LEVEL = 3;

function parseBody(rawBody: string): Record<string, unknown> {
  const parsed = JSON.parse(rawBody) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Responses passthrough body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function rewriteModel(
  rawBody: string,
  modelId: string,
): { readonly parsed: Record<string, unknown>; readonly text: string } {
  const parsed = parseBody(rawBody);
  const next =
    typeof parsed.model === "string" && parsed.model !== modelId
      ? { ...parsed, model: modelId }
      : parsed;
  return { parsed: next, text: JSON.stringify(next) };
}

function appendEndpoint(baseUrl: string, endpoint: string): string {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/u, "");
  url.pathname = `${basePath}${endpoint}`;
  url.hash = "";
  return url.toString();
}

function applyHeaders(
  target: Headers,
  source: ProviderHeaders | Readonly<Record<string, string>> | undefined,
): void {
  if (source === undefined) return;
  for (const [name, value] of Object.entries(source)) {
    if (value === null) target.delete(name);
    else target.set(name, value);
  }
}

function hasHeader(
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

/** Derived from pi-ai 0.84.1 api/openai-responses.ts getClientApiKey(). */
function assertOpenAITransportAuth(
  provider: string,
  apiKey: string | undefined,
  headers: ProviderHeaders | undefined,
): void {
  if (apiKey) return;
  if (
    hasHeader(headers, "authorization") ||
    hasHeader(headers, "cf-aig-authorization")
  ) {
    return;
  }
  throw new Error(`No API key for provider: ${provider}`);
}

function hasImageInput(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (Array.isArray(value)) {
    return value.some((entry) => hasImageInput(entry, depth + 1));
  }
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (
    record.type === "input_image" ||
    record.type === "image" ||
    record.type === "image_url"
  ) {
    return true;
  }
  return Object.values(record).some((entry) => hasImageInput(entry, depth + 1));
}

function inferCopilotInitiator(body: Record<string, unknown>): "user" | "agent" {
  if (typeof body.input === "string") return "user";
  if (!Array.isArray(body.input) || body.input.length === 0) return "user";
  const last = body.input[body.input.length - 1];
  if (typeof last !== "object" || last === null || Array.isArray(last)) return "agent";
  return (last as Record<string, unknown>).role === "user" ? "user" : "agent";
}

function copilotDynamicHeaders(
  body: Record<string, unknown>,
): Record<string, string> {
  return {
    "X-Initiator": inferCopilotInitiator(body),
    "Openai-Intent": "conversation-edits",
    ...(hasImageInput(body.input)
      ? { "Copilot-Vision-Request": "true" }
      : {}),
  };
}

/**
 * OpenAI-style Responses sender derived from pi-ai 0.84.1
 * api/openai-responses.ts. LuckyToken mirrors the provider-relevant SDK
 * request rules (baseURL path, bearer/header-owned auth, model/default
 * headers, and Copilot dynamic headers) but performs the final fetch itself
 * so non-2xx upstream bodies remain byte-preservable passthrough responses.
 */
function createOpenAIResponsesSender(
  options: CreateResponsesNativeSenderOptions,
): ResponsesNativeSender {
  const model = resolveRequestModel(options.model, options.auth) as Model<string>;
  const supportsNativeCompact = true;
  assertOpenAITransportAuth(
    model.provider,
    options.auth.auth.apiKey,
    options.auth.auth.headers,
  );

  const sender: ResponsesNativeSender = {
    supportsNativeCompact,
    async send(
      operation: ResponsesNativeOperation,
      rawBody: string,
      signal: AbortSignal,
    ) {
      const rewritten = rewriteModel(rawBody, model.id);
      const headers = new Headers({
        accept: "application/json",
        "content-type": "application/json",
      });
      const apiKey = options.auth.auth.apiKey;
      if (apiKey !== undefined && apiKey.length > 0) {
        headers.set("authorization", `Bearer ${apiKey}`);
      }
      applyHeaders(headers, model.headers);
      if (model.provider === "github-copilot") {
        applyHeaders(headers, copilotDynamicHeaders(rewritten.parsed));
      }
      applyHeaders(headers, options.auth.auth.headers);
      applyHeaders(headers, options.forwardedHeaders);
      headers.set("content-type", "application/json");

      const endpoint =
        operation === "compact" ? "/responses/compact" : "/responses";
      return options.fetch(appendEndpoint(model.baseUrl, endpoint), {
        method: "POST",
        headers,
        body: rewritten.text,
        signal,
      });
    },
  };
  return Object.freeze(sender);
}

/**
 * Codex request helpers derived from pi-ai 0.84.1
 * api/openai-codex-responses.ts. Normal Responses uses Pi's SSE + optional
 * zstd wire; compact keeps LuckyToken's already-verified JSON compact wire
 * because pi-ai has no compact operation to mirror.
 */
function extractCodexAccountId(token: string): string {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Invalid token");
    const payload = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const auth = payload["https://api.openai.com/auth"];
    if (typeof auth !== "object" || auth === null || Array.isArray(auth)) {
      throw new Error("Missing auth claim");
    }
    const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
    if (typeof accountId !== "string" || accountId.length === 0) {
      throw new Error("Missing account id");
    }
    return accountId;
  } catch {
    throw new Error("Failed to extract accountId from token");
  }
}

function resolveCodexUrl(baseUrl?: string): string {
  const raw =
    baseUrl && baseUrl.trim().length > 0
      ? baseUrl
      : "https://chatgpt.com/backend-api";
  const normalized = raw.replace(/\/+$/u, "");
  if (normalized.endsWith("/codex/responses")) return normalized;
  if (normalized.endsWith("/codex")) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

function compressCodexBody(bodyJson: string): ArrayBuffer | undefined {
  try {
    const compressed = zstdCompressSync(bodyJson, {
      params: {
        [zlibConstants.ZSTD_c_compressionLevel]: REQUEST_COMPRESSION_ZSTD_LEVEL,
      },
    });
    const copy = new Uint8Array(compressed.byteLength);
    copy.set(compressed);
    return copy.buffer;
  } catch {
    return undefined;
  }
}

function createCodexResponsesSender(
  options: CreateResponsesNativeSenderOptions,
): ResponsesNativeSender {
  const model = resolveRequestModel(options.model, options.auth) as Model<string>;
  const token = options.auth.auth.apiKey;
  if (token === undefined || token.length === 0) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }
  const accountId = extractCodexAccountId(token);

  const sender: ResponsesNativeSender = {
    supportsNativeCompact: true,
    async send(
      operation: ResponsesNativeOperation,
      rawBody: string,
      signal: AbortSignal,
    ) {
      const rewritten = rewriteModel(rawBody, model.id);
      const headers = new Headers();
      applyHeaders(headers, model.headers);
      applyHeaders(headers, options.auth.auth.headers);
      applyHeaders(headers, options.forwardedHeaders);
      headers.set("authorization", `Bearer ${token}`);
      headers.set("chatgpt-account-id", accountId);
      headers.set("originator", "pi");
      headers.set(
        "user-agent",
        `pi (${platform()} ${release()}; ${arch()})`,
      );
      headers.set("content-type", "application/json");

      const isCompact = operation === "compact";
      const compressed = isCompact ? undefined : compressCodexBody(rewritten.text);
      if (isCompact) {
        headers.delete("openai-beta");
        headers.set("accept", "application/json");
        headers.delete("content-encoding");
      } else {
        headers.set("openai-beta", "responses=experimental");
        headers.set("accept", "text/event-stream");
        if (compressed !== undefined) {
          headers.set("content-encoding", "zstd");
        } else {
          headers.delete("content-encoding");
        }
      }
      const url = isCompact
        ? `${resolveCodexUrl(model.baseUrl)}/compact`
        : resolveCodexUrl(model.baseUrl);
      return options.fetch(url, {
        method: "POST",
        headers,
        body: compressed ?? rewritten.text,
        signal,
      });
    },
  };
  return Object.freeze(sender);
}

function providerEnv(
  name: string,
  auth: AuthResult,
): string | undefined {
  return auth.env?.[name] || process.env[name] || undefined;
}

function parseAzureDeploymentNameMap(value: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!value) return map;
  for (const entry of value.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const [modelId, deploymentName] = trimmed.split("=", 2);
    if (!modelId || !deploymentName) continue;
    map.set(modelId.trim(), deploymentName.trim());
  }
  return map;
}

function normalizeAzureBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/u, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid Azure OpenAI base URL: ${baseUrl}`);
  }
  const isAzureHost =
    url.hostname.endsWith(".openai.azure.com") ||
    url.hostname.endsWith(".cognitiveservices.azure.com") ||
    url.hostname.endsWith(".ai.azure.com");
  const normalizedPath = url.pathname.replace(/\/+$/u, "");
  if (
    isAzureHost &&
    (normalizedPath === "" ||
      normalizedPath === "/" ||
      normalizedPath === "/openai" ||
      normalizedPath === "/openai/v1/responses")
  ) {
    url.pathname = "/openai/v1";
    url.search = "";
  }
  return url.toString().replace(/\/+$/u, "");
}

function resolveAzureBaseUrl(model: Model<string>, auth: AuthResult): string {
  const configured =
    providerEnv("AZURE_OPENAI_BASE_URL", auth)?.trim() ||
    auth.auth.baseUrl?.trim() ||
    undefined;
  if (configured) return normalizeAzureBaseUrl(configured);
  const resourceName = providerEnv("AZURE_OPENAI_RESOURCE_NAME", auth);
  if (resourceName) {
    return `https://${resourceName}.openai.azure.com/openai/v1`;
  }
  if (model.baseUrl) return normalizeAzureBaseUrl(model.baseUrl);
  throw new Error(
    "Azure OpenAI base URL is required. Set AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME, or provide model.baseUrl.",
  );
}

/**
 * Azure Responses sender derived from pi-ai 0.84.1
 * api/azure-openai-responses.ts. Pi's base URL / deployment / api-version
 * resolution and Azure `api-key` auth are mirrored here; the final fetch is
 * LuckyToken-owned so upstream error bodies remain raw passthrough bytes.
 */
function createAzureResponsesSender(
  options: CreateResponsesNativeSenderOptions,
): ResponsesNativeSender {
  const apiKey = options.auth.auth.apiKey;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("No API key for provider: azure-openai-responses");
  }
  const baseUrl = resolveAzureBaseUrl(options.model, options.auth);
  const apiVersion =
    providerEnv("AZURE_OPENAI_API_VERSION", options.auth) || "v1";
  const deploymentName =
    parseAzureDeploymentNameMap(
      providerEnv("AZURE_OPENAI_DEPLOYMENT_NAME_MAP", options.auth),
    ).get(options.model.id) || options.model.id;

  const sender: ResponsesNativeSender = {
    supportsNativeCompact: true,
    async send(
      operation: ResponsesNativeOperation,
      rawBody: string,
      signal: AbortSignal,
    ) {
      const rewritten = rewriteModel(rawBody, deploymentName);
      const headers = new Headers({
        accept: "application/json",
        "api-key": apiKey,
        "content-type": "application/json",
      });
      applyHeaders(headers, options.model.headers);
      applyHeaders(headers, options.auth.auth.headers);
      applyHeaders(headers, options.forwardedHeaders);
      headers.set("content-type", "application/json");

      const endpoint =
        operation === "compact" ? "/responses/compact" : "/responses";
      const url = new URL(appendEndpoint(baseUrl, endpoint));
      url.searchParams.set("api-version", apiVersion);
      return options.fetch(url, {
        method: "POST",
        headers,
        body: rewritten.text,
        signal,
      });
    },
  };
  return Object.freeze(sender);
}

export function createResponsesNativeSender(
  options: CreateResponsesNativeSenderOptions,
): ResponsesNativeSender | undefined {
  if (options.model.api === "openai-responses") {
    return createOpenAIResponsesSender(options);
  }
  if (
    options.model.provider === "openai-codex" &&
    options.model.api === "openai-codex-responses"
  ) {
    return createCodexResponsesSender(options);
  }
  if (
    options.model.provider === "azure-openai-responses" &&
    options.model.api === "azure-openai-responses"
  ) {
    return createAzureResponsesSender(options);
  }
  return undefined;
}

export function createResponsesNativePassthrough(
  fetch: FetchFunction,
): ResponsesNativePassthrough {
  const supports = (model: Model<string>): boolean =>
    model.api === "openai-responses" ||
    (model.provider === "openai-codex" &&
      model.api === "openai-codex-responses") ||
    (model.provider === "azure-openai-responses" &&
      model.api === "azure-openai-responses");

  const senderFor = (
    request: ResponsesNativePassthroughRequest,
  ): ResponsesNativeSender => {
    const sender = createResponsesNativeSender({
      model: request.model,
      auth: request.auth,
      fetch,
      ...(request.forwardedHeaders === undefined
        ? {}
        : { forwardedHeaders: request.forwardedHeaders }),
    });
    if (sender === undefined) {
      throw new Error(
        `No native Responses sender for ${request.model.provider}/${request.model.api}`,
      );
    }
    return sender;
  };

  const passthrough: ResponsesNativePassthrough = {
    supports,
    supportsCompact(model: Model<string>) {
      return supports(model);
    },
    send(request: ResponsesNativePassthroughRequest) {
      return senderFor(request).send(
        "responses",
        request.rawBody,
        request.signal,
      );
    },
    compact(request: ResponsesNativePassthroughRequest) {
      return senderFor(request).send("compact", request.rawBody, request.signal);
    },
  };
  return Object.freeze(passthrough);
}
