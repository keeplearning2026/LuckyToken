import type { FetchFunction, Model, Models } from "@earendil-works/pi-ai";
import {
  isManagedProviderAuthBindingCapture,
  MAX_PROFILE_ATTEMPTS_PER_REQUEST,
  type ProviderAuthBindingAuthority,
} from "../credentials/profile-contract.js";

import { renderResponsesError } from "../protocols/openai-responses/response.js";
import { createAzureResponsesSender } from "./azure.js";
import {
  bindProviderNativeResponsesConfiguration,
  parseProviderNativeResponsesConfiguration,
  type ProviderNativeResponsesConfiguration,
} from "./configuration.js";
import { createCodexResponsesSender } from "./codex.js";
import { ProviderResponsesNetworkError } from "./contract.js";
import type {
  CreateProviderResponsesSenderOptions,
  ProviderResponsesLane,
  ProviderResponsesObservationContext,
  ProviderResponsesPhysicalAttemptObservation,
  ProviderResponsesSender,
} from "./contract.js";
import { createOpenAIResponsesSender } from "./openai.js";
import {
  completeProviderResponsesStep,
  enterProviderResponsesStep,
  observeProviderResponses,
} from "./observation.js";

export type {
  CreateProviderResponsesSenderOptions,
  ProviderResponsesLane,
  ProviderResponsesOperation,
  ProviderResponsesSender,
} from "./contract.js";

export interface CreateProviderNativeResponsesOptions {
  readonly models: Pick<Models, "getAuth">;
  readonly bindings: Pick<
    ProviderAuthBindingAuthority,
    "capture" | "runBound" | "advanceAfterFinal429"
  >;
  readonly fetch: FetchFunction;
  readonly configuration?: ProviderNativeResponsesConfiguration;
  readonly retryDependencies?: Partial<ProviderNativeResponsesRetryDependencies>;
}

export interface ProviderNativeResponsesRetryDependencies {
  readonly random: () => number;
  readonly now: () => number;
  readonly sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

function safeProfileId(
  capture: Awaited<
    ReturnType<
      Pick<ProviderAuthBindingAuthority, "capture">["capture"]
    >
  >,
): string | undefined {
  if (capture.facts.kind !== "managed") return undefined;
  return /^[A-Za-z0-9._:-]{1,256}$/u.test(capture.facts.credentialId)
    ? capture.facts.credentialId
    : undefined;
}

function finishObservedResponse(
  observation: ProviderResponsesObservationContext | undefined,
  response: Response,
  attempt: number,
): Response {
  try {
    observation?.finalResponseAttempt(attempt);
  } catch {
    // Observation cannot change the selected Provider response.
  }
  return response;
}

function profileCaptureLocation(attempt: number) {
  return {
    phase: "lane_request_preparation",
    lane: "provider_native",
    step: "capture_provider_profile",
    attempt,
  } as const;
}

function enterProfileCapture(
  observation: ProviderResponsesObservationContext | undefined,
  attempt: number,
): void {
  enterProviderResponsesStep(
    observation?.journey,
    `p3.capture_provider_profile.${attempt}`,
    profileCaptureLocation(attempt),
  );
}

function completeProfileCapture(
  observation: ProviderResponsesObservationContext | undefined,
  attempt: number,
  completion: "success" | "failed" | "aborted",
): void {
  completeProviderResponsesStep(
    observation?.journey,
    `p3.capture_provider_profile.${attempt}`,
    profileCaptureLocation(attempt),
    completion,
  );
}

function observeManagedProfileAttribution(
  observation: ProviderResponsesObservationContext | undefined,
  capture: Awaited<
    ReturnType<
      Pick<ProviderAuthBindingAuthority, "capture">["capture"]
    >
  >,
  attempt: number,
): void {
  if (capture.facts.kind !== "managed") return;
  observeProviderResponses(observation?.journey, {
    kind: "profile_attributed",
    profileId: capture.facts.credentialId,
    displayName: capture.facts.displayName,
    location: profileCaptureLocation(attempt),
  });
}

function abortError(): Error {
  const error = new Error("Request aborted");
  error.name = "AbortError";
  return error;
}

function defaultSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, delayMs));
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function retryAfterMs(response: Response, now: () => number): number | undefined {
  const raw = response.headers.get("retry-after-ms");
  if (raw !== null) {
    const value = Number.parseFloat(raw);
    if (!Number.isNaN(value)) return Math.max(0, value);
  }
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) return undefined;
  const seconds = Number.parseFloat(retryAfter);
  if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(retryAfter);
  return Number.isNaN(date) ? 0 : Math.max(0, date - now());
}

function codexRetryAfterMs(response: Response, now: () => number): number | undefined {
  const raw = response.headers.get("retry-after-ms");
  if (raw !== null) {
    const value = Number(raw);
    if (Number.isFinite(value)) return Math.max(0, value);
  }
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(retryAfter);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now());
}

function openAIRetryDelayMs(
  response: Response | undefined,
  retryIndex: number,
  maxRetryDelayMs: number,
  random: () => number,
  now: () => number,
): number {
  const requested = response === undefined ? undefined : retryAfterMs(response, now);
  if (requested !== undefined) {
    if (maxRetryDelayMs > 0 && requested > maxRetryDelayMs) {
      throw new Error(
        `Server requested ${Math.ceil(requested / 1_000)}s retry delay (max: ${Math.ceil(maxRetryDelayMs / 1_000)}s)`,
      );
    }
    return requested;
  }
  const exponential = Math.min(0.5 * 2 ** retryIndex, 8) * 1_000;
  return exponential * (1 - random() * 0.25);
}

function shouldRetryOpenAIResponse(response: Response): boolean {
  const directive = response.headers.get("x-should-retry");
  if (directive === "true") return true;
  if (directive === "false") return false;
  return (
    response.status === 408 ||
    response.status === 409 ||
    response.status === 429 ||
    response.status >= 500
  );
}

const TERMINAL_CODEX_RATE_LIMIT =
  /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/iu;
const TRANSIENT_CODEX_ERROR =
  /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/iu;

async function shouldRetryCodexResponse(response: Response): Promise<boolean> {
  if (response.status === 429) {
    const errorText = await response.clone().text();
    return !TERMINAL_CODEX_RATE_LIMIT.test(errorText);
  }
  if ([500, 502, 503, 504].includes(response.status)) return true;
  return TRANSIENT_CODEX_ERROR.test(await response.clone().text());
}

async function releaseRetryResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A retry must not be replaced by a body-disposal failure.
  }
}

function validateRequestedRetryDelay(delayMs: number, maxRetryDelayMs: number): number {
  if (maxRetryDelayMs > 0 && delayMs > maxRetryDelayMs) {
    throw new Error(
      `Server requested ${Math.ceil(delayMs / 1_000)}s retry delay (max: ${Math.ceil(maxRetryDelayMs / 1_000)}s)`,
    );
  }
  return delayMs;
}

function codexRetryDelayMs(
  response: Response,
  retryIndex: number,
  maxRetryDelayMs: number,
  now: () => number,
): number {
  const requested = codexRetryAfterMs(response, now);
  return requested === undefined
    ? 1_000 * 2 ** retryIndex
    : validateRequestedRetryDelay(requested, maxRetryDelayMs);
}

function errorResponse(status: number, type: string, message: string): Response {
  const prepared = renderResponsesError(status, type, message);
  return new Response(prepared.body, {
    status: prepared.status,
    headers: { "content-type": prepared.contentType },
  });
}

type ProviderResponsesTransportKind = "openai" | "codex" | "azure";

const CERTIFIED_OPENAI_RESPONSES_PROVIDERS = new Set([
  "openai",
  "xai",
  "opencode",
  "opencode-go",
  "cloudflare-ai-gateway",
  "github-copilot",
]);

function providerResponsesTransportKind(
  model: Model<string>,
): ProviderResponsesTransportKind | undefined {
  if (
    model.api === "openai-responses" &&
    CERTIFIED_OPENAI_RESPONSES_PROVIDERS.has(model.provider)
  ) {
    return "openai";
  }
  if (
    model.provider === "openai-codex" &&
    model.api === "openai-codex-responses"
  ) {
    return "codex";
  }
  if (
    model.provider === "azure-openai-responses" &&
    model.api === "azure-openai-responses"
  ) {
    return "azure";
  }
  return undefined;
}

export function supportsProviderNativeResponses(model: Model<string>): boolean {
  return providerResponsesTransportKind(model) !== undefined;
}

function createProviderResponsesSenderForTransport(
  transport: ProviderResponsesTransportKind,
  options: CreateProviderResponsesSenderOptions,
): ProviderResponsesSender {
  switch (transport) {
    case "openai":
      return createOpenAIResponsesSender(options);
    case "codex":
      return createCodexResponsesSender(options);
    case "azure":
      return createAzureResponsesSender(options);
  }
}

export function createProviderResponsesSender(
  options: CreateProviderResponsesSenderOptions,
): ProviderResponsesSender | undefined {
  const transport = providerResponsesTransportKind(options.model);
  return transport === undefined
    ? undefined
    : createProviderResponsesSenderForTransport(transport, options);
}

export function createProviderNativeResponses(
  options: CreateProviderNativeResponsesOptions,
): ProviderResponsesLane {
  const configuration = options.configuration === undefined
    ? parseProviderNativeResponsesConfiguration()
    : bindProviderNativeResponsesConfiguration(options.configuration);
  const retryDependencies: ProviderNativeResponsesRetryDependencies = {
    random: options.retryDependencies?.random ?? Math.random,
    now: options.retryDependencies?.now ?? Date.now,
    sleep: options.retryDependencies?.sleep ?? defaultSleep,
  };
  return Object.freeze({
    claims(model: Model<string>): boolean {
      return supportsProviderNativeResponses(model);
    },
    async execute(
      input: Parameters<ProviderResponsesLane["execute"]>[0],
    ): Promise<Response> {
      enterProfileCapture(input.observation, 1);
      let capture: Awaited<
        ReturnType<
          Pick<ProviderAuthBindingAuthority, "capture">["capture"]
        >
      >;
      try {
        capture = await options.bindings.capture(input.model.provider);
        completeProfileCapture(input.observation, 1, "success");
        observeManagedProfileAttribution(input.observation, capture, 1);
      } catch (error) {
        completeProfileCapture(
          input.observation,
          1,
          input.signal.aborted ? "aborted" : "failed",
        );
        throw error;
      }
      const attemptedCredentialIds: string[] = [];
      let profileAttempt = 1;
      let physicalAttempt = 0;
      let selectionReason: "active" | "http_429_switch" = "active";
      if (capture.facts.kind === "managed") {
        input.credentialActivity?.credentialCaptured({
          ...capture.facts,
          lane: "provider_native",
          selectionReason,
        });
      }
      for (;;) {
        let response: Response;
        let responseAttempt = physicalAttempt + 1;
        try {
          response = await options.bindings.runBound(capture, async () => {
            const authLocation = {
              phase: "lane_request_preparation",
              lane: "provider_native",
              step: "resolve_provider_auth",
              attempt: responseAttempt,
            } as const;
            const authStep = `p3.resolve_provider_auth.${responseAttempt}`;
            enterProviderResponsesStep(
              input.observation?.journey,
              authStep,
              authLocation,
            );
            let auth: Awaited<
              ReturnType<Pick<Models, "getAuth">["getAuth"]>
            >;
            try {
              auth = await options.models.getAuth(input.model);
              completeProviderResponsesStep(
                input.observation?.journey,
                authStep,
                authLocation,
                auth === undefined ? "failed" : "success",
              );
            } catch (error) {
              completeProviderResponsesStep(
                input.observation?.journey,
                authStep,
                authLocation,
                input.signal.aborted ? "aborted" : "failed",
              );
              throw error;
            }
            if (auth === undefined) {
              return errorResponse(502, "api_error", "Provider is not configured");
            }
            const transport = providerResponsesTransportKind(input.model);
            if (transport === undefined) {
              return errorResponse(
                502,
                "api_error",
                "Provider native transport is unavailable",
              );
            }
            const sender = createProviderResponsesSenderForTransport(transport, {
              model: input.model,
              auth,
              fetch: options.fetch,
              ...(input.operation === "responses"
                ? { sessionId: input.sessionId }
                : {}),
            });
            const isCodex = transport === "codex";
            try {
              for (let retryAttempt = 0; ; retryAttempt += 1) {
                physicalAttempt += 1;
                responseAttempt = physicalAttempt;
                const profileId = safeProfileId(capture);
                const physicalObservation:
                  | ProviderResponsesPhysicalAttemptObservation
                  | undefined = input.observation === undefined
                  ? undefined
                  : {
                      journey: input.observation.journey,
                      attempt: responseAttempt,
                      ...(profileId === undefined ? {} : { profileId }),
                    };
                let physicalResponse: Response;
                try {
                  physicalResponse = await sender.send(
                    input.operation,
                    input.rawBody,
                    input.signal,
                    physicalObservation,
                  );
                } catch (error) {
                  if (input.signal.aborted) throw error;
                  if (
                    !(error instanceof ProviderResponsesNetworkError) ||
                    input.operation !== "responses" ||
                    retryAttempt >= configuration.transport.maxRetries
                  ) {
                    observeProviderResponses(input.observation?.journey, {
                      kind: "failure_detected",
                      failureId: `${input.observation?.requestId ?? "provider-native"}:provider_native_transport_failed:${responseAttempt}`,
                      role: "primary",
                      classification: "provider_native_transport_failed",
                      origin: "network_os",
                      originPrecision: "boundary",
                      location: {
                        phase: "upstream_execution",
                        lane: "provider_native",
                        step: "dispatch_provider_native",
                        attempt: responseAttempt,
                      },
                    });
                    throw error;
                  }
                  await retryDependencies.sleep(
                    isCodex
                      ? 1_000 * 2 ** retryAttempt
                      : openAIRetryDelayMs(
                          undefined,
                          retryAttempt,
                          configuration.transport.maxRetryDelayMs,
                          retryDependencies.random,
                          retryDependencies.now,
                        ),
                    input.signal,
                  );
                  continue;
                }

                const classifyLocation = {
                  phase: "upstream_execution",
                  lane: "provider_native",
                  step: "classify_native_retry",
                  attempt: responseAttempt,
                } as const;
                const classifyStep =
                  `p4.classify_native_retry.${responseAttempt}`;
                enterProviderResponsesStep(
                  input.observation?.journey,
                  classifyStep,
                  classifyLocation,
                );
                if (physicalResponse.status === 429) {
                  observeProviderResponses(input.observation?.journey, {
                    kind: "failure_detected",
                    failureId: `${input.observation?.requestId ?? "provider-native"}:provider_http_429:${responseAttempt}`,
                    role:
                      capture.facts.kind === "managed"
                        ? "supporting"
                        : "primary",
                    classification: "provider_http_429",
                    origin: "provider",
                    originPrecision: "external_boundary",
                    location: classifyLocation,
                  });
                }
                completeProviderResponsesStep(
                  input.observation?.journey,
                  classifyStep,
                  classifyLocation,
                  "success",
                );

                if (
                  physicalResponse.ok ||
                  input.operation !== "responses" ||
                  retryAttempt >= configuration.transport.maxRetries
                ) {
                  return physicalResponse;
                }
                let retryable: boolean;
                try {
                  retryable = isCodex
                    ? await shouldRetryCodexResponse(physicalResponse)
                    : shouldRetryOpenAIResponse(physicalResponse);
                } catch (error) {
                  if (!isCodex || input.signal.aborted) throw error;
                  await releaseRetryResponse(physicalResponse);
                  await retryDependencies.sleep(
                    1_000 * 2 ** retryAttempt,
                    input.signal,
                  );
                  continue;
                }
                if (!retryable) return physicalResponse;
                await releaseRetryResponse(physicalResponse);
                const delayMs = isCodex
                  ? codexRetryDelayMs(
                      physicalResponse,
                      retryAttempt,
                      configuration.transport.maxRetryDelayMs,
                      retryDependencies.now,
                    )
                  : openAIRetryDelayMs(
                      physicalResponse,
                      retryAttempt,
                      configuration.transport.maxRetryDelayMs,
                      retryDependencies.random,
                      retryDependencies.now,
                    );
                await retryDependencies.sleep(
                  delayMs,
                  input.signal,
                );
              }
            } catch (error) {
              if (input.signal.aborted) throw error;
              return errorResponse(
                502,
                "api_error",
                "Upstream provider request failed",
              );
            }
          });
        } catch (error) {
          if (capture.facts.kind === "managed") {
            input.credentialActivity?.credentialAttempt({
              ...capture.facts,
              lane: "provider_native",
              selectionReason,
              attempt: profileAttempt,
              outcome: input.signal.aborted ? "aborted" : "failed",
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
              response.status === 429
                ? "http_429"
                : response.ok
                  ? "success"
                  : "failed",
          });
        }
        if (response.status !== 429) {
          return finishObservedResponse(
            input.observation,
            response,
            responseAttempt,
          );
        }
        if (!isManagedProviderAuthBindingCapture(capture)) {
          return finishObservedResponse(
            input.observation,
            response,
            responseAttempt,
          );
        }
        attemptedCredentialIds.push(capture.facts.credentialId);
        const advanceLocation = {
          phase: "upstream_execution",
          lane: "provider_native",
          step: "advance_provider_profile",
          attempt: responseAttempt,
        } as const;
        const advanceStep = `p4.advance_provider_profile.${responseAttempt}`;
        enterProviderResponsesStep(
          input.observation?.journey,
          advanceStep,
          advanceLocation,
        );
        if (profileAttempt >= MAX_PROFILE_ATTEMPTS_PER_REQUEST) {
          completeProviderResponsesStep(
            input.observation?.journey,
            advanceStep,
            advanceLocation,
            "failed",
          );
          observeProviderResponses(input.observation?.journey, {
            kind: "failure_detected",
            failureId: `${input.observation?.requestId ?? "provider-native"}:provider_profile_attempt_limit_exhausted_after_final_429`,
            role: "primary",
            classification:
              "provider_profile_attempt_limit_exhausted_after_final_429",
            origin: "luckytoken",
            originPrecision: "exact",
            location: advanceLocation,
          });
          return finishObservedResponse(
            input.observation,
            response,
            responseAttempt,
          );
        }
        const requestedDelay = retryAfterMs(response, retryDependencies.now);
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
            capture,
            attemptedCredentialIds,
            signal: input.signal,
            ...(requestedDelay === undefined
              ? {}
              : { retryAfterMs: requestedDelay }),
          });
        } catch (error) {
          completeProviderResponsesStep(
            input.observation?.journey,
            advanceStep,
            advanceLocation,
            input.signal.aborted ? "aborted" : "failed",
          );
          if (!input.signal.aborted) {
            observeProviderResponses(input.observation?.journey, {
              kind: "failure_detected",
              failureId: `${input.observation?.requestId ?? "provider-native"}:provider_profile_transition_failed`,
              role: "primary",
              classification: "provider_profile_transition_failed",
              origin: "luckytoken",
              originPrecision: "exact",
              location: advanceLocation,
            });
          }
          throw error;
        }
        if (transition.outcome !== "switched") {
          completeProviderResponsesStep(
            input.observation?.journey,
            advanceStep,
            advanceLocation,
            "failed",
          );
          const classification =
            transition.outcome === "exhausted"
              ? "provider_profile_exhausted_after_final_429"
              : `provider_profile_${transition.outcome}_after_final_429`;
          observeProviderResponses(input.observation?.journey, {
            kind: "failure_detected",
            failureId: `${input.observation?.requestId ?? "provider-native"}:${classification}`,
            role: "primary",
            classification,
            origin: "luckytoken",
            originPrecision: "exact",
            location: advanceLocation,
          });
          return finishObservedResponse(
            input.observation,
            response,
            responseAttempt,
          );
        }
        completeProviderResponsesStep(
          input.observation?.journey,
          advanceStep,
          advanceLocation,
          "success",
        );
        observeProviderResponses(input.observation?.journey, {
          kind: "artifact_observed",
          artifactId:
            `provider_native_upstream_response_wire.${responseAttempt}`,
          artifactKind: "provider_native_upstream_response_wire",
          state: "unavailable",
          ...(response.headers.get("content-type") === null
            ? {}
            : { mediaType: response.headers.get("content-type")! }),
          reason: "response_body_not_read_before_profile_switch",
          location: {
            phase: "upstream_execution",
            lane: "provider_native",
            step: "read_provider_native_response",
            attempt: responseAttempt,
          },
        });
        await releaseRetryResponse(response);
        capture = transition.capture;
        profileAttempt += 1;
        selectionReason = "http_429_switch";
        enterProfileCapture(input.observation, physicalAttempt + 1);
        completeProfileCapture(
          input.observation,
          physicalAttempt + 1,
          "success",
        );
        observeManagedProfileAttribution(
          input.observation,
          capture,
          physicalAttempt + 1,
        );
      }
    },
  });
}
