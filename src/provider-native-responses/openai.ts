import type { Model } from "@earendil-works/pi-ai";

import { resolveRequestModel } from "../providers/request-composition.js";
import {
  appendEndpoint,
  applyHeaders,
  executeProviderFetch,
  hasHeader,
  rewriteModelJson,
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
  observeProviderResponses,
  observeProviderResponsesArtifact,
} from "./observation.js";
import { publishSafeHttpEnvelopeArtifact } from "../diagnostics/http-envelope.js";

function assertTransportAuth(
  provider: string,
  apiKey: string | undefined,
  headers: CreateProviderResponsesSenderOptions["auth"]["auth"]["headers"],
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
  if (Array.isArray(value)) return value.some((entry) => hasImageInput(entry, depth + 1));
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

function copilotDynamicHeaders(body: Record<string, unknown>): Record<string, string> {
  return {
    "X-Initiator": inferCopilotInitiator(body),
    "Openai-Intent": "conversation-edits",
    ...(hasImageInput(body.input) ? { "Copilot-Vision-Request": "true" } : {}),
  };
}

function applySessionAffinityHeaders(
  headers: Headers,
  model: Model<string>,
  sessionId: string,
): void {
  const format =
    (model as Model<"openai-responses">).compat?.sessionAffinityFormat ??
    (model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai")
      ? "openrouter"
      : "openai");
  if (format === "openrouter") {
    headers.set("x-session-id", sessionId);
    return;
  }
  if (format === "openai") headers.set("session_id", sessionId);
  headers.set("x-client-request-id", sessionId);
}

export function createOpenAIResponsesSender(
  options: CreateProviderResponsesSenderOptions,
): ProviderResponsesSender {
  const model = resolveRequestModel(options.model, options.auth) as Model<string>;
  assertTransportAuth(
    model.provider,
    options.auth.auth.apiKey,
    options.auth.auth.headers,
  );

  return Object.freeze({
    supportsNativeCompact: true,
    async send(
      operation: ProviderResponsesOperation,
      rawBody: string,
      signal: AbortSignal,
      observation?: ProviderResponsesPhysicalAttemptObservation,
    ): Promise<Response> {
      const attempt = observation?.attempt ?? 1;
      const projectionLocation = {
        phase: "lane_request_preparation",
        lane: "provider_native",
        step: "project_native_body",
        attempt,
      } as const;
      const projectionStep = `p3.project_native_body.${attempt}`;
      enterProviderResponsesStep(
        observation?.journey,
        projectionStep,
        projectionLocation,
      );
      let rewritten: ReturnType<typeof rewriteModelJson>;
      try {
        rewritten = rewriteModelJson(rawBody, model.id);
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

      const envelopeLocation = {
        phase: "lane_request_preparation",
        lane: "provider_native",
        step: "reconstruct_provider_envelope",
        attempt,
      } as const;
      const envelopeStep = `p3.reconstruct_provider_envelope.${attempt}`;
      enterProviderResponsesStep(
        observation?.journey,
        envelopeStep,
        envelopeLocation,
      );
      let headers: Headers;
      let url: string;
      try {
        headers = new Headers({
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
        if (operation === "responses") {
          if (options.sessionId === undefined) {
            throw new Error("Provider Native Responses requires a session ID");
          }
          applySessionAffinityHeaders(headers, model, options.sessionId);
        }
        applyHeaders(headers, options.auth.auth.headers);
        headers.set("content-type", "application/json");

        const endpoint =
          operation === "compact" ? "/responses/compact" : "/responses";
        url = appendEndpoint(model.baseUrl, endpoint);
        if (observation !== undefined) {
          publishSafeHttpEnvelopeArtifact(observation.journey, {
            artifactId: `provider_native_outbound_request_envelope.${attempt}`,
            artifactKind: "provider_native_outbound_request_envelope",
            method: "POST",
            url,
            headers,
            location: envelopeLocation,
          });
          observeProviderResponsesArtifact(observation.journey, {
            artifactId: `provider_native_outbound_request_wire.${attempt}`,
            artifactKind: "provider_native_outbound_request_wire",
            bytes: new TextEncoder().encode(rewritten.text),
            mediaType: "application/json",
            location: envelopeLocation,
          });
        }
        completeProviderResponsesStep(
          observation?.journey,
          envelopeStep,
          envelopeLocation,
          "success",
        );
      } catch (error) {
        completeProviderResponsesStep(
          observation?.journey,
          envelopeStep,
          envelopeLocation,
          "failed",
        );
        throw error;
      }

      const dispatchLocation = {
        phase: "upstream_execution",
        lane: "provider_native",
        step: "dispatch_provider_native",
        attempt,
      } as const;
      const dispatchStep = `p4.dispatch_provider_native.${attempt}`;
      enterProviderResponsesStep(
        observation?.journey,
        dispatchStep,
        dispatchLocation,
      );
      observeProviderResponses(observation?.journey, {
        kind: "attempt_observed",
        attempt,
        ...(observation?.profileId === undefined
          ? {}
          : { profileId: observation.profileId }),
        transition: "started",
        location: dispatchLocation,
      });
      let response: Response;
      try {
        response = await executeProviderFetch(options.fetch, url, {
          method: "POST",
          headers,
          body: rewritten.text,
          signal,
        });
        publishSafeHttpEnvelopeArtifact(observation?.journey, {
          artifactId: `provider_native_upstream_response_envelope.${attempt}`,
          artifactKind: "provider_native_upstream_response_envelope",
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
          location: dispatchLocation,
        });
        completeProviderResponsesStep(
          observation?.journey,
          dispatchStep,
          dispatchLocation,
          "success",
        );
      } catch (error) {
        completeProviderResponsesStep(
          observation?.journey,
          dispatchStep,
          dispatchLocation,
          signal.aborted ? "aborted" : "failed",
        );
        throw error;
      }

      const readLocation = {
        phase: "upstream_execution",
        lane: "provider_native",
        step: "read_provider_native_response",
        attempt,
      } as const;
      const readStep = `p4.read_provider_native_response.${attempt}`;
      enterProviderResponsesStep(
        observation?.journey,
        readStep,
        readLocation,
      );
      observeProviderResponses(observation?.journey, {
        kind: "attempt_observed",
        attempt,
        ...(observation?.profileId === undefined
          ? {}
          : { profileId: observation.profileId }),
        status: response.status,
        transition: "response",
        location: readLocation,
      });
      completeProviderResponsesStep(
        observation?.journey,
        readStep,
        readLocation,
        "success",
      );
      return response;
    },
  });
}
