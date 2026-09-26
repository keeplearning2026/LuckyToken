import type { Model } from "@earendil-works/pi-ai";
import { arch, platform, release } from "node:os";
import { constants as zlibConstants, zstdCompressSync } from "node:zlib";

import { resolveRequestModel } from "../providers/request-composition.js";
import {
  applyHeaders,
  executeProviderFetch,
} from "./common.js";
import type {
  CreateProviderResponsesSenderOptions,
  ProviderResponsesPhysicalAttemptObservation,
  ProviderResponsesOperation,
  ProviderResponsesSender,
} from "./contract.js";
import {
  completeProviderResponsesStep,
  enterProviderResponsesStep,
  observeProviderResponsesBodyProjection,
} from "./observation.js";
import {
  projectProviderNativeBody,
  type ProviderNativeBodyProjection,
} from "./tool-call-adjacency.js";


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
      observation?: ProviderResponsesPhysicalAttemptObservation,
    ): Promise<Response> {
      const projectionLocation = {
        phase: "lane_request_preparation",
        lane: "provider_native",
        step: "project_native_body",
        attempt: observation?.attempt ?? 1,
      } as const;
      const projectionStep = `p3.project_native_body.${projectionLocation.attempt}`;
      enterProviderResponsesStep(
        observation?.journey,
        projectionStep,
        projectionLocation,
      );
      let rewritten: ProviderNativeBodyProjection;
      try {
        rewritten = projectProviderNativeBody(rawBody, model.id, operation);
        observeProviderResponsesBodyProjection(
          observation?.journey,
          rewritten,
          projectionLocation,
        );
        completeProviderResponsesStep(
          observation?.journey,
          projectionStep,
          projectionLocation,
          "success",
        );
      } catch (error) {
        completeProviderResponsesStep(
          observation?.journey,
          projectionStep,
          projectionLocation,
          "failed",
        );
        throw error;
      }
      const headers = new Headers();
      applyHeaders(headers, model.headers);
      applyHeaders(headers, options.auth.auth.headers);
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
        if (options.sessionId === undefined) {
          throw new Error("Provider Native Responses requires a session ID");
        }
        headers.set("openai-beta", "responses=experimental");
        headers.set("accept", "text/event-stream");
        headers.set("session-id", options.sessionId);
        headers.set("x-client-request-id", options.sessionId);
        if (compressed !== undefined) headers.set("content-encoding", "zstd");
        else headers.delete("content-encoding");
      }
      const url = isCompact
        ? `${resolveCodexUrl(model.baseUrl)}/compact`
        : resolveCodexUrl(model.baseUrl);
      return executeProviderFetch(options.fetch, url, {
        method: "POST",
        headers,
        body: compressed ?? rewritten.text,
        signal,
      });
    },
  });
}
