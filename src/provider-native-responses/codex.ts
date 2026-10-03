import type { Model } from "@earendil-works/pi-ai";
import { buildBaseCodexHeaders, buildSSEHeaders, compressRequestBodyZstd, resolveCodexUrl } from "./pi-codex.generated.js";

import { resolveCodexAccountIdentity } from "../credentials/codex-auth.js";
import { resolveRequestModel } from "../providers/request-composition.js";
import {
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


function extractAccountId(token: string): string {
  // The account-claim intersection contract is shared with external
  // credential parsing: the nested claim is required, and a present top-level
  // claim must match. Token never rewrites the JWT or injects headers to widen
  // acceptance.
  const identity = resolveCodexAccountIdentity(token, undefined);
  if ("error" in identity) {
    throw new Error("Failed to extract accountId from token");
  }
  return identity.accountId;
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
      const isCompact = operation === "compact";
      if (!isCompact && options.sessionId === undefined) {
        throw new Error("Provider Native Responses requires a session ID");
      }
      const headers: Headers = isCompact
        ? buildBaseCodexHeaders(model.headers, options.auth.auth.headers, accountId, token)
        : buildSSEHeaders(model.headers, options.auth.auth.headers, accountId, token, options.sessionId);
      const compressed: Uint8Array | null = isCompact ? null : compressRequestBodyZstd(rewritten.text);
      if (isCompact) {
        headers.set("content-type", "application/json");
        headers.delete("openai-beta");
        headers.set("accept", "application/json");
        headers.delete("content-encoding");
      } else {
        if (compressed !== null) headers.set("content-encoding", "zstd");
        else headers.delete("content-encoding");
      }
      const url = isCompact
        ? `${resolveCodexUrl(model.baseUrl)}/compact`
        : resolveCodexUrl(model.baseUrl);
      return executeProviderFetch(options.fetch, url, {
        method: "POST",
        headers,
        body: compressed === null ? rewritten.text : new Uint8Array(compressed).buffer,
        signal,
      });
    },
  });
}
