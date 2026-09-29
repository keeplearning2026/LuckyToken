import Anthropic from "@anthropic-ai/sdk";
import type { FetchFunction, Model, ProviderHeaders } from "@earendil-works/pi-ai";

import type {
  RequestJourneyLocation,
  RequestJourneyObservationInput,
  RequestJourneyObserver,
} from "../diagnostics/contract.js";
import { publishSafeHttpEnvelopeArtifact } from "../diagnostics/http-envelope.js";

import {
  projectAnthropicNativeBody,
  type AnthropicNativeBodyProjectionMode,
} from "./body-projection.js";
import {
  anthropicRequestParams,
  createAnthropicSdkClient,
  type AnthropicNativeAuthMode,
} from "./envelope.js";
import { runShieldedAnthropicRequest } from "./sdk-dispatch.js";

export interface PassthroughAnthropicRequestOptions {
  readonly model: Model<string>;
  readonly rawBody: string;
  readonly apiKey: string | undefined;
  readonly signal: AbortSignal;
  readonly fetch: FetchFunction;
  readonly bodyProjectionMode: AnthropicNativeBodyProjectionMode;
  readonly authMode: AnthropicNativeAuthMode;
  readonly sessionId?: string;
  readonly attempt: number;
  readonly profileId?: string;
  readonly journey?: RequestJourneyObserver;
  /** Effective Provider request timeout, the same fact the Semantic lane
   *  passes to Pi. Provider Native mirrors it so the SDK timeout/identity
   *  headers match Pi's envelope instead of inventing a different value. */
  readonly requestTimeoutMs?: number;
  /**
   * Composed Provider-facing request facts (Ticket 10): the auth result's
   * merged headers (built-in static model headers, configured provider/
   * model headers, authHeader Authorization). These are Pi/Provider-owned
   * request facts. No generic inbound request header enters this transport.
   * Null values (ProviderHeaders) are ignored.
   */
  readonly composedHeaders?: Readonly<Record<string, string | null>>;
}

function observeAnthropicNativeTransport(
  journey: RequestJourneyObserver | undefined,
  observation: RequestJourneyObservationInput,
): void {
  try {
    journey?.observe(observation);
  } catch {
    // Provider Native transport remains authoritative over observation.
  }
}

function enterAnthropicNativeTransportStep(
  journey: RequestJourneyObserver | undefined,
  stepInstanceId: string,
  location: RequestJourneyLocation,
): void {
  observeAnthropicNativeTransport(journey, {
    kind: "step_entered",
    stepInstanceId,
    location,
  });
}

function completeAnthropicNativeTransportStep(
  journey: RequestJourneyObserver | undefined,
  stepInstanceId: string,
  location: RequestJourneyLocation,
  completion: "success" | "failed" | "aborted",
): void {
  observeAnthropicNativeTransport(journey, {
    kind: "step_completed",
    stepInstanceId,
    location,
    completion,
  });
}

/**
 * Forward an Anthropic Messages request to an upstream Anthropic endpoint
 * under the native passthrough profile.
 *
 * B2′ (`doc/Spec/TokenProviderNativeEnvelopeParityPlan.md` §3.4): the
 * Anthropic SDK builds the outbound envelope — endpoint with its `beta=true`
 * query, auth form, version/beta/session headers, timeout and SDK identity —
 * from the same client construction Pi uses, so Provider Native never
 * re-implements those rules. The lane keeps ownership of the body (projected
 * once for model identity / the certified OAuth differential) and of the
 * response (buffered once, filtered to the safe header set, returned for
 * atomic delivery).
 */
export async function passthroughAnthropicRequest(
  options: PassthroughAnthropicRequestOptions,
): Promise<Response> {
  const { model, rawBody, apiKey, signal } = options;
  if (apiKey === undefined || apiKey.length === 0) {
    // Header-owned auth (e.g. ANTHROPIC_AUTH_TOKEN, authHeader) is a valid
    // Provider-facing credential; mirror the pinned API-layer
    // assertRequestAuth which accepts authorization/x-api-key/cf-aig-
    // authorization without an apiKey.
    const composed = options.composedHeaders ?? {};
    const hasHeaderAuth = Object.entries(composed).some(([name, value]) => {
      const lower = name.toLowerCase();
      return (
        (lower === "authorization" ||
          lower === "x-api-key" ||
          lower === "cf-aig-authorization") &&
        value !== undefined &&
        value !== null &&
        value.trim().length > 0
      );
    });
    if (!hasHeaderAuth) {
      throw new Error(
        `No API key configured for passthrough provider: ${model.provider}`,
      );
    }
  }
  const projectionLocation = {
    phase: "lane_request_preparation",
    lane: "provider_native",
    step: "project_native_body",
    attempt: options.attempt,
  } as const;
  const projectionStep = `p3.project_native_body.${options.attempt}`;
  enterAnthropicNativeTransportStep(
    options.journey,
    projectionStep,
    projectionLocation,
  );
  let forwardedBody: string;
  try {
    forwardedBody = projectAnthropicNativeBody({
      rawBody,
      modelId: model.id,
      mode: options.bodyProjectionMode,
    }).body;
    completeAnthropicNativeTransportStep(
      options.journey,
      projectionStep,
      projectionLocation,
      "success",
    );
  } catch (error) {
    completeAnthropicNativeTransportStep(
      options.journey,
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
    attempt: options.attempt,
  } as const;
  const envelopeStep = `p3.reconstruct_provider_envelope.${options.attempt}`;
  enterAnthropicNativeTransportStep(
    options.journey,
    envelopeStep,
    envelopeLocation,
  );
  let params: Anthropic.MessageCreateParamsNonStreaming;
  try {
    params = anthropicRequestParams(
      {
        model,
        apiKey,
        authMode: options.authMode,
        sessionId: options.sessionId,
        composedHeaders: options.composedHeaders as ProviderHeaders | undefined,
      },
      forwardedBody,
    );
    completeAnthropicNativeTransportStep(
      options.journey,
      envelopeStep,
      envelopeLocation,
      "success",
    );
  } catch (error) {
    completeAnthropicNativeTransportStep(
      options.journey,
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
    attempt: options.attempt,
  } as const;
  const dispatchStep = `p4.dispatch_provider_native.${options.attempt}`;
  enterAnthropicNativeTransportStep(
    options.journey,
    dispatchStep,
    dispatchLocation,
  );
  observeAnthropicNativeTransport(options.journey, {
    kind: "attempt_observed",
    attempt: options.attempt,
    ...(options.profileId === undefined
      ? {}
      : { profileId: options.profileId }),
    transition: "started",
    location: dispatchLocation,
  });
  let upstream: Response;
  try {
    upstream = await runShieldedAnthropicRequest(
      {
        fetch: options.fetch,
        signal,
        onRequest: (url, init) => {
          if (options.journey === undefined) return;
          const headers = new Headers(init.headers);
          publishSafeHttpEnvelopeArtifact(options.journey, {
            artifactId: `provider_native_outbound_request_envelope.${options.attempt}`,
            artifactKind: "provider_native_outbound_request_envelope",
            method: init.method ?? "POST",
            url,
            headers,
            location: envelopeLocation,
          });
          observeAnthropicNativeTransport(options.journey, {
            kind: "artifact_observed",
            artifactId: `provider_native_outbound_request_wire.${options.attempt}`,
            artifactKind: "provider_native_outbound_request_wire",
            state: "captured",
            bytes:
              typeof init.body === "string"
                ? new TextEncoder().encode(init.body)
                : new Uint8Array(),
            mediaType: headers.get("content-type") ?? "application/json",
            location: envelopeLocation,
          });
        },
      },
      async (fetchForSdk) => {
        const client = createAnthropicSdkClient(
          {
            model,
            apiKey,
            authMode: options.authMode,
            sessionId: options.sessionId,
            composedHeaders: options.composedHeaders as ProviderHeaders | undefined,
          },
          forwardedBody,
          fetchForSdk,
        );
        await client.beta.messages.create(params, {
          signal,
          maxRetries: 0,
          ...(options.requestTimeoutMs === undefined
            ? {}
            : { timeout: options.requestTimeoutMs }),
        });
      },
    );
  } catch (error) {
    // The upstream request never reached a response (pre-commit transport
    // failure: connection refused, DNS, TLS, or abort). The client has not
    // received a single byte, so this follows the pre-commit error lifecycle:
    // the handler turns it into a legal Anthropic error, never a raw
    // exception. Caller cancellation keeps its own identity so the handler
    // can rethrow it as cancellation rather than as a transport failure.
    completeAnthropicNativeTransportStep(
      options.journey,
      dispatchStep,
      dispatchLocation,
      signal.aborted ? "aborted" : "failed",
    );
    if (signal.aborted) throw error;
    throw error instanceof Anthropic.APIConnectionError
      ? new AnthropicPassthroughTransportError(error)
      : error;
  }
  completeAnthropicNativeTransportStep(
    options.journey,
    dispatchStep,
    dispatchLocation,
    "success",
  );
  publishSafeHttpEnvelopeArtifact(options.journey, {
    artifactId: `provider_native_upstream_response_envelope.${options.attempt}`,
    artifactKind: "provider_native_upstream_response_envelope",
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
    location: dispatchLocation,
  });

  return upstream;
}

/**
 * A pre-commit transport failure: the upstream request itself rejected
 * (connection refused, DNS/TLS failure, network reset) before any response
 * header arrived. The handler renders a legal Anthropic error instead of a
 * raw transport exception. Caller cancellation keeps its own identity so the
 * handler can rethrow it as cancellation rather than as a transport failure.
 * Request-local; never crosses into a shared boundary.
 */
export class AnthropicPassthroughTransportError extends Error {
  readonly kind = "AnthropicPassthroughTransportError";

  constructor(cause: unknown) {
    super(
      `Upstream passthrough request failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = "AnthropicPassthroughTransportError";
  }
}
