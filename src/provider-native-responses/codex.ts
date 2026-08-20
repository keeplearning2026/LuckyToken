import type { Model } from "@earendil-works/pi-ai";
import { arch, platform, release } from "node:os";
import { constants as zlibConstants, zstdCompressSync } from "node:zlib";

import { resolveRequestModel } from "../providers/request-composition.js";
import { applyHeaders, rewriteModelJson } from "./common.js";
import type {
  CreateProviderResponsesSenderOptions,
  ProviderResponsesOperation,
  ProviderResponsesSender,
} from "./contract.js";

const REQUEST_COMPRESSION_ZSTD_LEVEL = 3;

function extractAccountId(token: string): string {
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

function compressBody(bodyJson: string): ArrayBuffer | undefined {
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

export function createCodexResponsesSender(
  options: CreateProviderResponsesSenderOptions,
): ProviderResponsesSender {
  const model = resolveRequestModel(options.model, options.auth) as Model<string>;
  const token = options.auth.auth.apiKey;
  if (token === undefined || token.length === 0) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }
  const accountId = extractAccountId(token);

  return Object.freeze({
    supportsNativeCompact: true,
    async send(
      operation: ProviderResponsesOperation,
      rawBody: string,
      signal: AbortSignal,
    ): Promise<Response> {
      const rewritten = rewriteModelJson(rawBody, model.id);
      const headers = new Headers();
      applyHeaders(headers, model.headers);
      applyHeaders(headers, options.auth.auth.headers);
      applyHeaders(headers, options.forwardedHeaders);
      headers.set("authorization", `Bearer ${token}`);
      headers.set("chatgpt-account-id", accountId);
      headers.set("originator", "pi");
      headers.set("user-agent", `pi (${platform()} ${release()}; ${arch()})`);
      headers.set("content-type", "application/json");

      const isCompact = operation === "compact";
      const compressed = isCompact ? undefined : compressBody(rewritten.text);
      if (isCompact) {
        headers.delete("openai-beta");
        headers.set("accept", "application/json");
        headers.delete("content-encoding");
      } else {
        headers.set("openai-beta", "responses=experimental");
        headers.set("accept", "text/event-stream");
        if (compressed !== undefined) headers.set("content-encoding", "zstd");
        else headers.delete("content-encoding");
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
  });
}
