import type { FetchFunction, Model, Models } from "@earendil-works/pi-ai";
import {
  isManagedProviderAuthBindingCapture,
  MAX_PROFILE_ATTEMPTS_PER_REQUEST,
  type ProviderAuthBindingAuthority,
  type ProviderAuthBindingCapture,
} from "../credentials/profile-contract.js";
import type { CredentialActivitySink } from "../credentials/activity.js";
import type {
  RequestJourneyLocation,
  RequestJourneyObservationInput,
  RequestJourneyObserver,
} from "../diagnostics/contract.js";

import type {
  AnthropicNativeExecutionResult,
  AnthropicProviderNativeLane,
} from "../protocols/anthropic/native-lane-contract.js";
import type { RequestModelResolver } from "../protocols/anthropic/options.js";
import { AnthropicNativeBodyProjectionError } from "./body-projection.js";
import {
  AnthropicPassthroughBodyReadError,
  AnthropicPassthroughTransportError,
  isAnthropicNativePassthroughModel,
  passthroughAnthropicRequest,
  projectAnthropicPassthroughBody,
} from "./transport.js";
import { extractAnthropicNativeTerminalUsage } from "./usage.js";

export interface AnthropicProviderNativeLaneOptions {
  readonly models: Pick<Models, "getAuth">;
  readonly bindings: Pick<
    ProviderAuthBindingAuthority,
    "capture" | "runBound" | "advanceAfterFinal429"
  >;
  readonly resolveRequestModel: RequestModelResolver;
  readonly fetch: FetchFunction;
}

function observeAnthropicProviderNative(
  journey: RequestJourneyObserver | undefined,
  observation: RequestJourneyObservationInput,
): void {
  try {
    journey?.observe(observation);
  } catch {
    // Provider Native execution remains authoritative over observation.
  }
}

function enterAnthropicProviderNativeStep(
  journey: RequestJourneyObserver | undefined,
  stepInstanceId: string,
  location: RequestJourneyLocation,
): void {
  observeAnthropicProviderNative(journey, {
    kind: "step_entered",
    stepInstanceId,
    location,
  });
}

function completeAnthropicProviderNativeStep(
  journey: RequestJourneyObserver | undefined,
  stepInstanceId: string,
  location: RequestJourneyLocation,
  completion: "success" | "failed" | "aborted",
): void {
  observeAnthropicProviderNative(journey, {
    kind: "step_completed",
    stepInstanceId,
    completion,
    location,
  });
}

function observeCapturedProviderProfile(
  journey: RequestJourneyObserver | undefined,
  attempt: number,
): void {
  const location = {
    phase: "lane_request_preparation",
    lane: "provider_native",
    step: "capture_provider_profile",
    attempt,
  } as const;
  const stepInstanceId = `p3.capture_provider_profile.${attempt}`;
  enterAnthropicProviderNativeStep(journey, stepInstanceId, location);
  completeAnthropicProviderNativeStep(
    journey,
    stepInstanceId,
    location,
    "success",
  );
}

function observeUnavailablePreservedResponse(
  journey: RequestJourneyObserver | undefined,
  location: RequestJourneyLocation,
  reason: string,
): void {
  observeAnthropicProviderNative(journey, {
    kind: "artifact_observed",
    artifactId: "provider_native_preserved_response_wire",
    artifactKind: "provider_native_preserved_response_wire",
    state: "unavailable",
    reason,
    location,
  });
}

function errorResponse(
  status: number,
  message: string,
  requestId?: string,
): Response {
  return new Response(
    JSON.stringify({
      type: "error",
      error: { type: "api_error", message },
      ...(requestId === undefined ? {} : { request_id: requestId }),
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

async function raceWithSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

function hasHeaderAuth(
  headers: Readonly<Record<string, string | null>> | undefined,
): boolean {
  if (headers === undefined) return false;
  return Object.entries(headers).some(([name, value]) => {
    const normalized = name.toLowerCase();
    return (
      (normalized === "authorization" ||
        normalized === "x-api-key" ||
        normalized === "cf-aig-authorization") &&
      value !== null &&
      value.trim().length > 0
    );
  });
}

function safeRequestId(headers: Readonly<Record<string, string>>): string | undefined {
  const value = headers["request-id"] ?? headers["x-request-id"];
  return value !== undefined && /^[A-Za-z0-9._:-]{1,256}$/u.test(value)
    ? value
    : undefined;
}

function retryAfterMs(response: Response): number | undefined {
  const milliseconds = response.headers.get("retry-after-ms");
  if (milliseconds !== null) {
    const parsed = Number(milliseconds);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter === null) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const timestamp = Date.parse(retryAfter);
  return Number.isNaN(timestamp) ? undefined : Math.max(0, timestamp - Date.now());
}

export function createAnthropicProviderNativeLane(
  options: AnthropicProviderNativeLaneOptions,
): AnthropicProviderNativeLane {
  return Object.freeze({
    claims: isAnthropicNativePassthroughModel,
    async execute(input: {
      readonly model: Model<string>;
      readonly rawBody: string;
      readonly request: Request;
      readonly alias?: string;
      readonly requestId: string;
      readonly sessionId?: string;
      readonly onExecutionStart: () => void;
      readonly credentialActivity?: CredentialActivitySink;
      readonly journey?: RequestJourneyObserver;
    }): Promise<AnthropicNativeExecutionResult> {
      const signal = input.request.signal;
      const initialCaptureLocation = {
        phase: "lane_request_preparation",
        lane: "provider_native",
        step: "capture_provider_profile",
        attempt: 1,
      } as const;
      enterAnthropicProviderNativeStep(
        input.journey,
        "p3.capture_provider_profile.1",
        initialCaptureLocation,
      );
      let capture: ProviderAuthBindingCapture;
      try {
        capture = await options.bindings.capture(input.model.provider);
        completeAnthropicProviderNativeStep(
          input.journey,
          "p3.capture_provider_profile.1",
          initialCaptureLocation,
          "success",
        );
      } catch (error) {
        completeAnthropicProviderNativeStep(
          input.journey,
          "p3.capture_provider_profile.1",
          initialCaptureLocation,
          signal.aborted ? "aborted" : "failed",
        );
        throw error;
      }
      const attemptedCredentialIds: string[] = [];
      let profileAttempt = 1;
      let selectionReason: "active" | "http_429_switch" = "active";
      if (capture.facts.kind === "managed") {
        input.credentialActivity?.credentialCaptured({
          ...capture.facts,
          lane: "provider_native",
          selectionReason,
        });
      }
      let started = false;
      for (;;) {
        let result: AnthropicNativeExecutionResult;
        try {
          result = await options.bindings.runBound(
            capture,
            async (): Promise<AnthropicNativeExecutionResult> => {
              const authLocation = {
                phase: "lane_request_preparation",
                lane: "provider_native",
                step: "resolve_provider_auth",
                attempt: profileAttempt,
              } as const;
              const authStep = `p3.resolve_provider_auth.${profileAttempt}`;
              enterAnthropicProviderNativeStep(
                input.journey,
                authStep,
                authLocation,
              );
              let auth: Awaited<
                ReturnType<Pick<Models, "getAuth">["getAuth"]>
              >;
              try {
                auth = await raceWithSignal(
                  options.models.getAuth(input.model),
                  signal,
                );
              } catch (error) {
                completeAnthropicProviderNativeStep(
                  input.journey,
                  authStep,
                  authLocation,
                  signal.aborted ? "aborted" : "failed",
                );
                if (signal.aborted) throw error;
                return {
                  outcome: "failed",
                  response: errorResponse(
                    500,
                    "Internal server error",
                    input.requestId,
                  ),
                  diagnostic: { error },
                };
              }
              const apiKey = auth?.auth.apiKey;
              if (apiKey === undefined && !hasHeaderAuth(auth?.auth.headers)) {
                completeAnthropicProviderNativeStep(
                  input.journey,
                  authStep,
                  authLocation,
                  "failed",
                );
                return {
                  outcome: "failed",
                  response: errorResponse(
                    502,
                    `Provider is not configured: ${input.model.provider}`,
                    input.requestId,
                  ),
                };
              }
              completeAnthropicProviderNativeStep(
                input.journey,
                authStep,
                authLocation,
                "success",
              );

              let upstream: Awaited<
                ReturnType<typeof passthroughAnthropicRequest>
              >;
              try {
                if (!started) {
                  started = true;
                  input.onExecutionStart();
                }
                upstream = await raceWithSignal(
                  passthroughAnthropicRequest({
                    model: options.resolveRequestModel(input.model, auth),
                    rawBody: input.rawBody,
                    apiKey,
                    signal,
                    fetch: options.fetch,
                    attempt: profileAttempt,
                    ...(capture.facts.kind === "managed"
                      ? { profileId: capture.facts.credentialId }
                      : {}),
                    ...(input.journey === undefined
                      ? {}
                      : { journey: input.journey }),
                    bodyProjectionMode:
                      capture.facts.kind === "managed" &&
                      input.model.provider === "anthropic" &&
                      input.model.api === "anthropic-messages" &&
                      capture.facts.authType === "oauth"
                        ? "anthropic_oauth"
                        : "model_only",
                    authMode:
                      input.model.provider === "github-copilot"
                        ? "github_copilot"
                        : capture.facts.kind === "managed"
                          ? capture.facts.authType
                          : "ambient",
                    ...(input.sessionId === undefined
                      ? {}
                      : { sessionId: input.sessionId }),
                    ...(auth?.auth.headers === undefined
                      ? {}
                      : { composedHeaders: auth.auth.headers }),
                  }),
                  signal,
                );
              } catch (error) {
                if (signal.aborted) throw error;
                if (
                  error instanceof AnthropicPassthroughTransportError ||
                  error instanceof AnthropicPassthroughBodyReadError ||
                  error instanceof AnthropicNativeBodyProjectionError
                ) {
                  return {
                    outcome: "failed",
                    response: errorResponse(
                      502,
                      error instanceof AnthropicPassthroughTransportError
                        ? "Upstream provider request failed"
                        : error instanceof AnthropicPassthroughBodyReadError
                          ? "Upstream provider response could not be read"
                          : "Provider Native request could not be projected safely",
                      input.requestId,
                    ),
                    diagnostic: { error },
                  };
                }
                throw error;
              }

              signal.throwIfAborted();
              const upstreamRequestId = safeRequestId(upstream.headers);
              if (upstream.status >= 400) {
                if (input.alias === undefined) {
                  return {
                    outcome: "failed",
                    response: new Response(upstream.body, {
                      status: upstream.status,
                      headers: { ...upstream.headers },
                    }),
                    diagnostic: {
                      upstreamStatus: upstream.status,
                      ...(upstreamRequestId === undefined
                        ? {}
                        : { safeRequestId: upstreamRequestId }),
                    },
                  };
                }
                return {
                  outcome: "failed",
                  response: errorResponse(
                    502,
                    "Upstream provider failed",
                    input.requestId,
                  ),
                  diagnostic: {
                    upstreamStatus: upstream.status,
                    ...(upstreamRequestId === undefined
                      ? {}
                      : { safeRequestId: upstreamRequestId }),
                  },
                };
              }

              let body = upstream.body;
              if (input.alias !== undefined) {
                const projected = projectAnthropicPassthroughBody(
                  body,
                  upstream.headers["content-type"] ?? "",
                  input.alias,
                );
                if ("error" in projected) {
                  const error = new Error(projected.error);
                  return {
                    outcome: "failed",
                    response: errorResponse(
                      502,
                      "Upstream response could not be projected safely",
                      input.requestId,
                    ),
                    diagnostic: { error },
                  };
                }
                body = projected.body;
              }
              const terminalUsage = extractAnthropicNativeTerminalUsage(
                body,
                upstream.headers["content-type"] ?? "",
              );
              if (terminalUsage !== undefined) {
                observeAnthropicProviderNative(input.journey, {
                  kind: "terminal_usage_observed",
                  usage: terminalUsage,
                  location: {
                    phase: "lane_response_processing",
                    lane: "provider_native",
                    step: "observe_provider_native_usage",
                  },
                });
              }
              return {
                outcome: "success",
                response: new Response(body, {
                  status: upstream.status,
                  headers: { ...upstream.headers },
                }),
              };
            },
          );
        } catch (error) {
          if (capture.facts.kind === "managed") {
            input.credentialActivity?.credentialAttempt({
              ...capture.facts,
              lane: "provider_native",
              selectionReason,
              attempt: profileAttempt,
              outcome: signal.aborted ? "aborted" : "failed",
            });
          }
          throw error;
        }
        if (capture.facts.kind === "managed") {
          input.credentialActivity?.credentialAttempt({
            ...capture.facts,
            lane: "provider_native",
            selectionReason,
            attempt: profileAttempt,
            outcome:
              result.outcome === "success"
                ? "success"
                : result.diagnostic?.upstreamStatus === 429
                  ? "http_429"
                  : "failed",
          });
        }
        if (
          result.outcome !== "failed" ||
          result.diagnostic === undefined ||
          !("upstreamStatus" in result.diagnostic) ||
          result.diagnostic.upstreamStatus !== 429
        ) {
          return result;
        }

        const classifyLocation = {
          phase: "upstream_execution",
          lane: "provider_native",
          step: "classify_native_retry",
          attempt: profileAttempt,
        } as const;
        const classifyStep = `p4.classify_native_retry.${profileAttempt}`;
        enterAnthropicProviderNativeStep(
          input.journey,
          classifyStep,
          classifyLocation,
        );
        const managedCapture = isManagedProviderAuthBindingCapture(capture)
          ? capture
          : undefined;
        observeAnthropicProviderNative(input.journey, {
          kind: "failure_detected",
          failureId: `${input.requestId}:provider_http_429:${profileAttempt}`,
          role: managedCapture === undefined ? "primary" : "supporting",
          classification: "provider_http_429",
          origin: "provider",
          originPrecision: "external_boundary",
          location: classifyLocation,
        });
        completeAnthropicProviderNativeStep(
          input.journey,
          classifyStep,
          classifyLocation,
          "success",
        );
        if (managedCapture === undefined) return result;

        attemptedCredentialIds.push(managedCapture.facts.credentialId);
        const advanceLocation = {
          phase: "upstream_execution",
          lane: "provider_native",
          step: "advance_provider_profile",
          attempt: profileAttempt,
        } as const;
        const advanceStep = `p4.advance_provider_profile.${profileAttempt}`;
        enterAnthropicProviderNativeStep(
          input.journey,
          advanceStep,
          advanceLocation,
        );
        if (profileAttempt >= MAX_PROFILE_ATTEMPTS_PER_REQUEST) {
          completeAnthropicProviderNativeStep(
            input.journey,
            advanceStep,
            advanceLocation,
            "failed",
          );
          observeAnthropicProviderNative(input.journey, {
            kind: "failure_detected",
            failureId: `${input.requestId}:provider_profile_attempt_limit_exhausted_after_final_429`,
            role: "primary",
            classification:
              "provider_profile_attempt_limit_exhausted_after_final_429",
            origin: "Token",
            originPrecision: "exact",
            location: advanceLocation,
          });
          observeUnavailablePreservedResponse(
            input.journey,
            advanceLocation,
            "profile_attempt_limit_before_response_preservation",
          );
          return result;
        }
        const requestedDelay = retryAfterMs(result.response);
        let transition: Awaited<
          ReturnType<
            Pick<
              ProviderAuthBindingAuthority,
              "advanceAfterFinal429"
            >["advanceAfterFinal429"]
          >
        >;
        try {
          transition = await options.bindings.advanceAfterFinal429({
            capture: managedCapture,
            attemptedCredentialIds,
            signal,
            ...(requestedDelay === undefined
              ? {}
              : { retryAfterMs: requestedDelay }),
          });
        } catch (error) {
          completeAnthropicProviderNativeStep(
            input.journey,
            advanceStep,
            advanceLocation,
            signal.aborted ? "aborted" : "failed",
          );
          if (!signal.aborted) {
            observeAnthropicProviderNative(input.journey, {
              kind: "failure_detected",
              failureId: `${input.requestId}:provider_profile_transition_failed`,
              role: "primary",
              classification: "provider_profile_transition_failed",
              origin: "Token",
              originPrecision: "exact",
              location: advanceLocation,
            });
            observeUnavailablePreservedResponse(
              input.journey,
              advanceLocation,
              "profile_transition_failed_before_response_preservation",
            );
          }
          throw error;
        }
        if (transition.outcome !== "switched") {
          completeAnthropicProviderNativeStep(
            input.journey,
            advanceStep,
            advanceLocation,
            "failed",
          );
          const classification =
            transition.outcome === "exhausted"
              ? "provider_profile_exhausted_after_final_429"
              : `provider_profile_${transition.outcome}_after_final_429`;
          observeAnthropicProviderNative(input.journey, {
            kind: "failure_detected",
            failureId: `${input.requestId}:${classification}`,
            role: "primary",
            classification,
            origin: "Token",
            originPrecision: "exact",
            location: advanceLocation,
          });
          observeUnavailablePreservedResponse(
            input.journey,
            advanceLocation,
            transition.outcome === "exhausted"
              ? "profile_exhausted_before_response_preservation"
              : "profile_transition_unavailable_before_response_preservation",
          );
          return result;
        }
        completeAnthropicProviderNativeStep(
          input.journey,
          advanceStep,
          advanceLocation,
          "success",
        );
        await result.response.body?.cancel().catch(() => undefined);
        capture = transition.capture;
        profileAttempt += 1;
        selectionReason = "http_429_switch";
        observeCapturedProviderProfile(input.journey, profileAttempt);
      }
    },
  });
}
