import type { Model } from "@earendil-works/pi-ai";
import { getPiUserAgent } from "@earendil-works/pi-ai/utils/pi-user-agent";
import OpenAI from "openai";

import { publishSafeHttpEnvelopeArtifact } from "../diagnostics/http-envelope.js";
import { resolveRequestModel } from "../providers/request-composition.js";
import type {
  CreateProviderResponsesSenderOptions,
  ProviderResponsesPhysicalAttemptObservation,
  ProviderResponsesOperation,
  ProviderResponsesSender,
} from "./contract.js";
import { ProviderResponsesNetworkError } from "./contract.js";
import {
  completeProviderResponsesStep,
  enterProviderResponsesStep,
  observeProviderResponses,
  observeProviderResponsesArtifact,
  observeProviderResponsesBodyProjection,
} from "./observation.js";
import { runShieldedSdkRequest } from "./sdk-dispatch.js";
import {
  projectProviderNativeBody,
  type ProviderNativeBodyProjection,
} from "./tool-call-adjacency.js";

function assertTransportAuth(
  provider: string,
  apiKey: string | undefined,
  headers: CreateProviderResponsesSenderOptions["auth"]["auth"]["headers"],
): void {
  if (apiKey) return;
  const has = (name: string): boolean =>
    headers !== undefined &&
    Object.entries(headers).some(
      ([key, value]) =>
        key.toLowerCase() === name &&
        value !== null &&
        value !== undefined &&
        value.trim().length > 0,
    );
  if (has("authorization") || has("cf-aig-authorization")) return;
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

/**
 * GitHub Copilot request headers. Pi derives them from the Pi `Context`; the
 * preservation lane has no `Context`, so the same facts are read from the
 * client-authored body (the lane already owns the body for projection).
 */
function copilotDynamicHeaders(body: Record<string, unknown>): Record<string, string> {
  const initiator = ((): "user" | "agent" => {
    if (typeof body.input === "string") return "user";
    if (!Array.isArray(body.input) || body.input.length === 0) return "user";
    const last = body.input[body.input.length - 1];
    if (typeof last !== "object" || last === null || Array.isArray(last)) return "agent";
    return (last as Record<string, unknown>).role === "user" ? "user" : "agent";
  })();
  return {
    "X-Initiator": initiator,
    "Openai-Intent": "conversation-edits",
    ...(hasImageInput(body.input) ? { "Copilot-Vision-Request": "true" } : {}),
  };
}

/** Pi's `createClient` session-affinity block, format-for-format. */
function applySessionAffinityHeaders(
  headers: Record<string, string | null | undefined>,
  model: Model<string>,
  sessionId: string,
): void {
  const format =
    (model as Model<"openai-responses">).compat?.sessionAffinityFormat ??
    (model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai")
      ? "openrouter"
      : "openai");
  if (format === "openrouter") {
    headers["x-session-id"] = sessionId;
    return;
  }
  if (format === "openai") headers.session_id = sessionId;
  headers["x-client-request-id"] = sessionId;
}

/**
 * Build the same default headers Pi's `createClient` builds, in the same
 * order: Pi user agent, model headers, Copilot dynamic headers, session
 * affinity, then the composed Provider/auth headers last.
 */
function buildDefaultHeaders(
  model: Model<string>,
  body: Record<string, unknown>,
  options: CreateProviderResponsesSenderOptions,
  sessionId: string | undefined,
): Record<string, string | null | undefined> {
  const headers: Record<string, string | null | undefined> = {
    "User-Agent": getPiUserAgent(),
    ...model.headers,
  };
  if (model.provider === "github-copilot") {
    Object.assign(headers, copilotDynamicHeaders(body));
  }
  if (sessionId !== undefined) {
    applySessionAffinityHeaders(headers, model, sessionId);
  }
  Object.assign(headers, options.auth.auth.headers);
  return headers;
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
      const params = rewritten.parsed;
      const defaultHeaders = buildDefaultHeaders(
        model,
        params,
        options,
        operation === "responses" ? options.sessionId : undefined,
      );
      completeProviderResponsesStep(
        observation?.journey,
        envelopeStep,
        envelopeLocation,
        "success",
      );

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
        response = await runShieldedSdkRequest(
          {
            fetch: options.fetch,
            signal,
            onRequest: (url, init) => {
              if (observation === undefined) return;
              const outboundHeaders = new Headers(init.headers);
              publishSafeHttpEnvelopeArtifact(observation.journey, {
                artifactId: `provider_native_outbound_request_envelope.${attempt}`,
                artifactKind: "provider_native_outbound_request_envelope",
                method: init.method ?? "POST",
                url,
                headers: outboundHeaders,
                location: envelopeLocation,
              });
              const body =
                typeof init.body === "string" ? init.body : undefined;
              if (body === undefined) return;
              observeProviderResponsesArtifact(observation.journey, {
                artifactId: `provider_native_outbound_request_wire.${attempt}`,
                artifactKind: "provider_native_outbound_request_wire",
                bytes: new TextEncoder().encode(body),
                mediaType:
                  outboundHeaders.get("content-type") ?? "application/json",
                location: envelopeLocation,
              });
            },
          },
          async (fetchForSdk) => {
            const client = new OpenAI({
              apiKey: options.auth.auth.apiKey ?? "unused",
              baseURL: model.baseUrl,
              dangerouslyAllowBrowser: true,
              fetch: fetchForSdk,
              defaultHeaders,
            });
            const requestOptions = {
              signal,
              maxRetries: 0,
              ...(options.requestTimeoutMs === undefined
                ? {}
                : { timeout: options.requestTimeoutMs }),
            };
            if (operation === "compact") {
              await client.responses.compact(
                params as unknown as Parameters<
                  typeof client.responses.compact
                >[0],
                requestOptions,
              );
            } else {
              await client.responses.create(params, requestOptions);
            }
          },
        );
      } catch (error) {
        completeProviderResponsesStep(
          observation?.journey,
          dispatchStep,
          dispatchLocation,
          signal.aborted ? "aborted" : "failed",
        );
        throw error instanceof OpenAI.APIConnectionError
          ? new ProviderResponsesNetworkError(error)
          : error;
      }
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

      const readLocation = {
        phase: "upstream_execution",
        lane: "provider_native",
        step: "read_provider_native_response",
        attempt,
      } as const;
      const readStep = `p4.read_provider_native_response.${attempt}`;
      enterProviderResponsesStep(observation?.journey, readStep, readLocation);
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
