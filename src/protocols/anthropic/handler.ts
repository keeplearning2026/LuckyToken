import type { Models } from "@earendil-works/pi-ai";
import type { UpstreamFailureFact } from "@luckytoken/provider-contract/diagnostics";
import { randomUUID } from "node:crypto";
import { bindCredentialActivityToExecutionFacts } from "../../credentials/activity.js";

import {
  resolveRequestIdentity,
} from "../../request-identity.js";
import {
  bindAnthropicConfiguration,
  parseAnthropicConfiguration,
  type AnthropicConfiguration,
} from "./configuration.js";
import {
  execute,
  ExecutionAbortedError,
  ExecutionFailure,
  type ExecutionOperation,
} from "../../execution.js";
import {
  type ClientProtocolHandler,
  type ClientProtocolRequestContext,
  HttpRequestAbortedError,
} from "../../http.js";
import type {
  RequestJourneyLocation,
  RequestJourneyObservationInput,
  RequestJourneyObserver,
  RequestJourneyOperation,
} from "../../diagnostics/contract.js";
import {
  ModelResolutionFailure,
} from "../../model-resolution.js";
import {
  resolveDataPlanePublicModel,
  type PublicModelSource,
} from "../../public-model-seam.js";
import {
  composeOptions,
  type RouterOptionDefaults,
} from "./options.js";
import { InvalidRequest, UnsupportedFeature } from "./failures.js";
import {
  assertImplementedAnthropicProfile,
  resolveAnthropicSourceProfile,
} from "./profile.js";
import {
  convertValidatedAnthropicRequestWithPolicy,
  extractAnthropicModelSelector,
  validateAnthropicSourceRequest,
} from "./request.js";
import {
  assertAnthropicModelAwareValidity,
  defaultAnthropicModelValidityPolicy,
  type AnthropicModelValidityPolicy,
} from "./representability.js";
import { convertAssistantMessageToAnthropicWithPolicy } from "./response.js";
import { renderAnthropicAtomicSse } from "./sse.js";
import {
  renderAnthropicError,
  renderAnthropicJsonSuccess,
  type PreparedHttpResponse,
} from "./wire.js";
import {
  mapUpstreamFailureFact,
  requestIdFromFact,
} from "./failure-rendering.js";
import type { AnthropicProviderNativeLane } from "./native-lane-contract.js";
import { executeAnthropicSemanticInvocation } from "./semantic/execution.js";

export const anthropicMessagesProtocolId = "anthropic-messages";

/** Request-edge correlation for requests currently being handled. The HTTP
 * boundary reads it only when it must synthesize a transport error. */
const requestIds = new WeakMap<Request, string>();

function observeJourney(
  journey: RequestJourneyObserver | undefined,
  observation: RequestJourneyObservationInput,
): void {
  try {
    journey?.observe(observation);
  } catch {
    // A caller-provided observer must never affect protocol handling.
  }
}

function enterJourneyStep(
  journey: RequestJourneyObserver | undefined,
  stepInstanceId: string,
  location: RequestJourneyLocation,
): void {
  observeJourney(journey, {
    kind: "step_entered",
    stepInstanceId,
    location,
  });
}

function completeJourneyStep(
  journey: RequestJourneyObserver | undefined,
  stepInstanceId: string,
  location: RequestJourneyLocation,
  protocol?: string,
  operation?: RequestJourneyOperation,
): void {
  observeJourney(journey, {
    kind: "step_completed",
    stepInstanceId,
    completion: "success",
    location,
    ...(protocol === undefined ? {} : { protocol }),
    ...(operation === undefined ? {} : { operation }),
  });
}

function failJourneyStep(
  journey: RequestJourneyObserver | undefined,
  stepInstanceId: string,
  location: RequestJourneyLocation,
  protocol: string,
  operation: RequestJourneyOperation,
): void {
  observeJourney(journey, {
    kind: "step_completed",
    stepInstanceId,
    completion: "failed",
    location,
    protocol,
    operation,
  });
}

interface AnthropicEarlyFailure {
  readonly stepInstanceId: string;
  readonly location: RequestJourneyLocation;
  readonly classification: string;
  readonly origin: "client" | "luckytoken";
}

function observeAnthropicEarlyFailure(
  journey: RequestJourneyObserver | undefined,
  requestId: string,
  response: Response,
  failure: AnthropicEarlyFailure,
): Response {
  failJourneyStep(
    journey,
    failure.stepInstanceId,
    failure.location,
    anthropicMessagesProtocolId,
    "model_generation",
  );
  observeJourney(journey, {
    kind: "failure_detected",
    failureId: `${requestId}:${failure.classification}`,
    role: "primary",
    classification: failure.classification,
    origin: failure.origin,
    originPrecision: "exact",
    location: failure.location,
  });

  const presentationLocation = {
    phase: "client_response_preparation",
    step: "prepare_anthropic_error_response",
  } as const;
  enterJourneyStep(
    journey,
    "p6.prepare_anthropic_error_response",
    presentationLocation,
  );
  observeJourney(journey, {
    kind: "client_response_prepared",
    status: response.status,
    ...(response.headers.get("content-type") === null
      ? {}
      : { mediaType: response.headers.get("content-type")! }),
    location: presentationLocation,
  });
  completeJourneyStep(
    journey,
    "p6.prepare_anthropic_error_response",
    presentationLocation,
    anthropicMessagesProtocolId,
    "model_generation",
  );

  const outcomeLocation = {
    phase: "outcome_commit",
    step: "commit_request_outcome",
  } as const;
  enterJourneyStep(journey, "p7.commit_request_outcome", outcomeLocation);
  observeJourney(journey, {
    kind: "work_outcome_committed",
    outcome: "failed",
    terminalAuthority: "anthropic_messages_handler",
    location: outcomeLocation,
  });
  completeJourneyStep(
    journey,
    "p7.commit_request_outcome",
    outcomeLocation,
    anthropicMessagesProtocolId,
    "model_generation",
  );
  return response;
}

function encodedBoundedSummary(value: unknown): Readonly<{
  bytes: Uint8Array<ArrayBuffer>;
  originalBytes: number;
  truncated: boolean;
}> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.byteLength <= 256 * 1_024) {
    return Object.freeze({
      bytes,
      originalBytes: bytes.byteLength,
      truncated: false,
    });
  }
  const fallback = new TextEncoder().encode(
    JSON.stringify({
      schema: "luckytoken.bounded_summary.v1",
      completeness: "counts_only_due_to_byte_bound",
      originalBytes: bytes.byteLength,
    }),
  );
  return Object.freeze({
    bytes: fallback,
    originalBytes: bytes.byteLength,
    truncated: true,
  });
}

function semanticFailureLocation(
  failure: UpstreamFailureFact,
): RequestJourneyLocation {
  const attempt = failure.attemptCount;
  const attemptField = attempt === undefined ? {} : { attempt };
  if (failure.kind === "conversion") {
    return {
      phase: "upstream_execution",
      lane: "semantic_conversion",
      direction: "pi_to_provider",
      step: "convert_pi_request",
      subject: "envelope",
      ...attemptField,
    };
  }
  if (
    (failure.kind === "protocol" || failure.kind === "upstream_stream") &&
    failure.phase === "unexpected_eof"
  ) {
    return {
      phase: "upstream_execution",
      lane: "semantic_conversion",
      step: "validate_pi_terminal",
      ...attemptField,
    };
  }
  if (failure.kind === "protocol" || failure.kind === "upstream_stream") {
    return {
      phase: "upstream_execution",
      lane: "semantic_conversion",
      direction: "provider_to_pi",
      step:
        failure.phase === "stream"
          ? "construct_pi_terminal"
          : "decode_provider_events",
      subject: "envelope",
      ...attemptField,
    };
  }
  if (failure.kind === "transport" || failure.kind === "timeout") {
    const dispatch =
      failure.phase === "request" ||
      failure.phase === "connect" ||
      failure.phase === "request_body" ||
      failure.phase === "retry_delay";
    return {
      phase: "upstream_execution",
      lane: "semantic_conversion",
      step: dispatch ? "dispatch_provider_request" : "read_provider_response",
      ...attemptField,
    };
  }
  if (failure.kind === "http") {
    return {
      phase: "upstream_execution",
      lane: "semantic_conversion",
      step: "read_provider_response",
      ...attemptField,
    };
  }
  return {
    phase: "upstream_execution",
    lane: "semantic_conversion",
    step: "validate_pi_terminal",
    ...attemptField,
  };
}

export interface AnthropicMessagesHandlerOptions {
  readonly models: Models;
  readonly createSessionId?: () => string;
  readonly configuration?: AnthropicConfiguration;
  readonly providerNativeLane?: AnthropicProviderNativeLane;
  readonly modelValidityPolicy?: AnthropicModelValidityPolicy;
  readonly createMessageId?: () => string;
  /** Backend-lifetime Public Model source. When absent, direct handler tests
   * use the canonical provider/model selector seam. */
  readonly publicModels?: PublicModelSource;
  /** Request body byte ceiling. Single source of truth: the composition root
   *  passes `config.limits.maxRequestBytes`; this handler consumes it and
   *  never supplies its own default. */
  readonly maxRequestBytes: number;
  readonly routerDefaults?: RouterOptionDefaults;
  readonly now?: () => number;
  /**
   * Ticket 20: the neutral Pi execution operation. The composition root
   * binds the Provider usage-semantics resolver into the operation
   * (`createExecutionOperation`); the handler never names or carries
   * Provider semantics data. Absent defaults to plain `execute`, whose
   * snapshots are honest Partial undeclared_semantics.
   */
  readonly executeOperation?: ExecutionOperation;
}

interface AnthropicMessagesDependencies {
  readonly models: Models;
  readonly createSessionId: () => string;
  readonly configuration: AnthropicConfiguration;
  readonly providerNativeLane: AnthropicProviderNativeLane | undefined;
  readonly modelValidityPolicy: AnthropicModelValidityPolicy;
  readonly createMessageId: () => string;
  readonly publicModels: PublicModelSource | undefined;
  readonly maxRequestBytes: number;
  readonly routerDefaults: RouterOptionDefaults;
  readonly now: () => number;
  readonly executeOperation: ExecutionOperation;
}

function toResponse(prepared: PreparedHttpResponse): Response {
  const headers: Record<string, string> = {
    "content-type": prepared.contentType,
  };
  if (prepared.headers !== undefined) {
    for (const [name, value] of Object.entries(prepared.headers)) {
      headers[name] = value;
    }
  }
  return new Response(prepared.body, {
    status: prepared.status,
    headers,
  });
}

/** Every Data Plane response of this handler carries the request-edge id
 *  exactly once (success, error, and passthrough alike). */
function attachRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("x-luckytoken-request-id", requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function raceWithRequestSignal<T>(
  value: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw new HttpRequestAbortedError(signal.reason);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new HttpRequestAbortedError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([value, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

function hasJsonContentType(headers: Headers): boolean {
  const contentType = headers.get("content-type");
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

async function readRawBody(
  request: Request,
  maximumBytes: number,
): Promise<string | undefined> {
  const declaredLength = request.headers.get("content-length");
  if (/^[0-9]+$/u.test(declaredLength ?? "") && Number(declaredLength) > maximumBytes) {
    return undefined;
  }
  const rawBody = await raceWithRequestSignal(request.text(), request.signal);
  return new TextEncoder().encode(rawBody).byteLength <= maximumBytes
    ? rawBody
    : undefined;
}

async function handleAnthropicMessages(
  dependencies: AnthropicMessagesDependencies,
  request: Request,
  requestId: string,
  journey: RequestJourneyObserver | undefined,
): Promise<Response> {
  let activeEarlyStep: Readonly<{
    stepInstanceId: string;
    location: RequestJourneyLocation;
  }> | undefined;
  let activeClientResponseStep:
    | Readonly<{
        stepInstanceId: string;
        classification:
          | "client_response_conversion_failed"
          | "client_response_encoding_failed";
        location: RequestJourneyLocation;
      }>
    | undefined;
  try {
    request.signal.throwIfAborted();
    const receivedAt = dependencies.now();
    const mediaLocation = {
      phase: "protocol_ingress",
      step: "validate_media_and_encoding",
    } as const;
    activeEarlyStep = {
      stepInstanceId: "p1.validate_media_and_encoding",
      location: mediaLocation,
    };
    enterJourneyStep(journey, "p1.validate_media_and_encoding", mediaLocation);
    if (!hasJsonContentType(request.headers)) {
      observeJourney(journey, {
        kind: "artifact_observed",
        artifactId: "client_request_wire",
        artifactKind: "client_request_wire",
        state: "unavailable",
        ...(request.headers.get("content-type") === null
          ? {}
          : { mediaType: request.headers.get("content-type")! }),
        reason: "body_not_read_due_to_media_type",
        location: mediaLocation,
      });
      return observeAnthropicEarlyFailure(
        journey,
        requestId,
        toResponse(
          renderAnthropicError(
            415,
            "invalid_request_error",
            "Content-Type must be application/json",
            requestId,
          ),
        ),
        {
          ...activeEarlyStep,
          classification: "unsupported_media_type",
          origin: "client",
        },
      );
    }
    completeJourneyStep(
      journey,
      "p1.validate_media_and_encoding",
      mediaLocation,
      anthropicMessagesProtocolId,
      "model_generation",
    );
    activeEarlyStep = undefined;

    const identityLocation = {
      phase: "protocol_ingress",
      step: "establish_request_identity",
    } as const;
    activeEarlyStep = {
      stepInstanceId: "p1.establish_request_identity",
      location: identityLocation,
    };
    enterJourneyStep(journey, "p1.establish_request_identity", identityLocation);
    const requestIdentity = resolveRequestIdentity(
      request.headers,
      dependencies.createSessionId,
    );
    observeJourney(journey, {
      kind: "request_identity_established",
      effectiveSessionId: requestIdentity.effectiveSessionId,
      ...(requestIdentity.clientSessionId === undefined
        ? {}
        : { clientSessionId: requestIdentity.clientSessionId }),
      location: identityLocation,
    });
    completeJourneyStep(
      journey,
      "p1.establish_request_identity",
      identityLocation,
    );
    activeEarlyStep = undefined;

    const sourceProfile = resolveAnthropicSourceProfile(request.headers);
    const bodyLocation = {
      phase: "protocol_ingress",
      step: "read_and_decode_body",
    } as const;
    activeEarlyStep = {
      stepInstanceId: "p1.read_and_decode_body",
      location: bodyLocation,
    };
    enterJourneyStep(journey, "p1.read_and_decode_body", bodyLocation);
    const rawBody = await readRawBody(request, dependencies.maxRequestBytes);
    if (rawBody === undefined) {
      observeJourney(journey, {
        kind: "artifact_observed",
        artifactId: "client_request_wire",
        artifactKind: "client_request_wire",
        state: "unavailable",
        reason: "request_body_exceeds_limit",
        location: bodyLocation,
      });
      return observeAnthropicEarlyFailure(
        journey,
        requestId,
        toResponse(
          renderAnthropicError(
            413,
            "request_too_large",
            "Request exceeds the configured maximum size",
            requestId,
          ),
        ),
        {
          ...activeEarlyStep,
          classification: "request_body_too_large",
          origin: "client",
        },
      );
    }
    const rawRequestBytes = new TextEncoder().encode(rawBody);
    const capturedRequestBytes = Math.min(
      rawRequestBytes.byteLength,
      256 * 1_024,
    );
    observeJourney(journey, {
      kind: "artifact_observed",
      artifactId: "client_request_wire",
      artifactKind: "client_request_wire",
      state:
        capturedRequestBytes < rawRequestBytes.byteLength
          ? "partial"
          : "captured",
      ...(request.headers.get("content-type") === null
        ? {}
        : { mediaType: request.headers.get("content-type")! }),
      bytes: rawRequestBytes.subarray(0, capturedRequestBytes),
      originalBytes: rawRequestBytes.byteLength,
      capturedBytes: capturedRequestBytes,
      truncated: capturedRequestBytes < rawRequestBytes.byteLength,
      location: bodyLocation,
    });
    const body: unknown = JSON.parse(rawBody);
    assertImplementedAnthropicProfile(sourceProfile);
    completeJourneyStep(journey, "p1.read_and_decode_body", bodyLocation);
    activeEarlyStep = undefined;

    const resolutionLocation = {
      phase: "request_resolution",
      step: "resolve_public_model",
    } as const;
    activeEarlyStep = {
      stepInstanceId: "p2.resolve_public_model",
      location: resolutionLocation,
    };
    enterJourneyStep(journey, "p2.resolve_public_model", resolutionLocation);
    const selector = extractAnthropicModelSelector(body);
    const resolution = await resolveDataPlanePublicModel(
      dependencies.models,
      dependencies.publicModels,
      selector,
    );
    if (resolution.kind === "unknown") {
      return observeAnthropicEarlyFailure(
        journey,
        requestId,
        toResponse(
          renderAnthropicError(
            404,
            "not_found_error",
            `Unknown model: ${selector}`,
            requestId,
          ),
        ),
        {
          ...activeEarlyStep,
          classification: "unknown_model",
          origin: "client",
        },
      );
    }
    if (resolution.kind === "unavailable") {
      return observeAnthropicEarlyFailure(
        journey,
        requestId,
        toResponse(
          renderAnthropicError(
            502,
            "api_error",
            "The requested model is not currently available",
            requestId,
          ),
        ),
        {
          ...activeEarlyStep,
          classification: "model_unavailable",
          origin: "luckytoken",
        },
      );
    }
    const model = resolution.model;
    observeJourney(journey, {
      kind: "model_resolved",
      requestedModel: selector,
      providerId: model.provider,
      modelId: model.id,
      location: resolutionLocation,
    });
    completeJourneyStep(journey, "p2.resolve_public_model", resolutionLocation);
    activeEarlyStep = undefined;
    // Passthrough response projection is alias-only: the alias captured at
    // acceptance must be echoed symmetrically by the upstream response.
    const projectAlias =
      dependencies.publicModels === undefined ? undefined : resolution.alias;
    if (dependencies.providerNativeLane !== undefined) {
      const nativeRecognitionLocation = {
        phase: "request_resolution",
        lane: "provider_native",
        step: "recognize_provider_native",
      } as const;
      enterJourneyStep(
        journey,
        "p2.recognize_provider_native",
        nativeRecognitionLocation,
      );
      const providerNativeClaimed =
        dependencies.providerNativeLane.claims(model);
      completeJourneyStep(
        journey,
        "p2.recognize_provider_native",
        nativeRecognitionLocation,
      );
      if (providerNativeClaimed) {
        observeJourney(journey, {
          kind: "lane_committed",
          lane: "provider_native",
          location: {
            phase: "request_resolution",
            lane: "provider_native",
            step: "commit_lane",
          },
        });
        const native = await dependencies.providerNativeLane.execute({
          model,
          rawBody,
          request,
          ...(projectAlias === undefined ? {} : { alias: projectAlias }),
          requestId,
          sessionId: requestIdentity.effectiveSessionId,
          onExecutionStart: () => undefined,
          ...(journey === undefined ? {} : { journey }),
        });
        const presentationLocation = {
          phase: "client_response_preparation",
          lane: "provider_native",
          step:
            native.outcome === "success"
              ? "prepare_provider_native_response"
              : "prepare_provider_native_error_response",
        } as const;
        enterJourneyStep(
          journey,
          native.outcome === "success"
            ? "p6.prepare_provider_native_response"
            : "p6.prepare_provider_native_error_response",
          presentationLocation,
        );
        observeJourney(journey, {
          kind: "client_response_prepared",
          status: native.response.status,
          ...(native.response.headers.get("content-type") === null
            ? {}
            : {
                mediaType: native.response.headers.get("content-type")!,
              }),
          location: presentationLocation,
        });
        completeJourneyStep(
          journey,
          native.outcome === "success"
            ? "p6.prepare_provider_native_response"
            : "p6.prepare_provider_native_error_response",
          presentationLocation,
        );
        const outcomeLocation = {
          phase: "outcome_commit",
          lane: "provider_native",
          step: "commit_request_outcome",
        } as const;
        enterJourneyStep(journey, "p7.commit_request_outcome", outcomeLocation);
        observeJourney(journey, {
          kind: "work_outcome_committed",
          outcome: native.outcome,
          terminalAuthority: "anthropic_provider_native_lane",
          location: outcomeLocation,
        });
        completeJourneyStep(
          journey,
          "p7.commit_request_outcome",
          outcomeLocation,
        );
        return native.response;
      }
    }
    const laneLocation = {
      phase: "request_resolution",
      lane: "semantic_conversion",
      step: "commit_lane",
    } as const;
    observeJourney(journey, {
      kind: "lane_committed",
      lane: "semantic_conversion",
      location: laneLocation,
    });
    const requestConversionLocation = {
      phase: "lane_request_preparation",
      lane: "semantic_conversion",
      direction: "client_to_pi",
      step: "validate_client_semantics",
      subject: "envelope",
    } as const;
    enterJourneyStep(
      journey,
      "p3.validate_client_semantics",
      requestConversionLocation,
    );
    const validatedRequest = validateAnthropicSourceRequest(body);
    assertAnthropicModelAwareValidity(
      validatedRequest,
      model,
      dependencies.modelValidityPolicy,
    );
    completeJourneyStep(
      journey,
      "p3.validate_client_semantics",
      requestConversionLocation,
    );
    const invocationLocation = {
      phase: "lane_request_preparation",
      lane: "semantic_conversion",
      direction: "client_to_pi",
      step: "finalize_pi_invocation",
      subject: "envelope",
    } as const;
    enterJourneyStep(journey, "p3.finalize_pi_invocation", invocationLocation);
    const invocation = convertValidatedAnthropicRequestWithPolicy(
      validatedRequest,
      receivedAt,
      dependencies.configuration.conversion.request,
    );
    for (const notice of invocation.client.notices) {
      observeJourney(journey, {
        kind: "conversion_notice_observed",
        code: notice.code,
        severity: notice.action === "ignore" ? "info" : "warning",
        location: invocationLocation,
      });
    }
    const piOptions = composeOptions(
      invocation.invocation.pi.options,
      {
        sessionId: requestIdentity.effectiveSessionId,
        signal: request.signal,
      },
      dependencies.routerDefaults,
    );
    const semanticInvocation = {
      ...invocation.invocation,
      pi: {
        context: invocation.invocation.pi.context,
        options: piOptions,
      },
    };
    try {
      const invocationSnapshot = encodedBoundedSummary({
        schema: "luckytoken.pi_invocation_summary.v1",
        selector: invocation.client.renderState.selector,
        model: { provider: model.provider, id: model.id, api: model.api },
        systemPrompt: invocation.invocation.pi.context.systemPrompt,
        messages: invocation.invocation.pi.context.messages,
        options: {
          maxTokens: piOptions.maxTokens,
          temperature: piOptions.temperature,
        },
      });
      observeJourney(journey, {
        kind: "artifact_observed",
        artifactId: "pi_invocation_snapshot",
        artifactKind: "pi_invocation_snapshot",
        state: invocationSnapshot.truncated ? "partial" : "captured",
        mediaType: "application/json",
        bytes: invocationSnapshot.bytes,
        originalBytes: invocationSnapshot.originalBytes,
        capturedBytes: invocationSnapshot.bytes.byteLength,
        truncated: invocationSnapshot.truncated,
        location: invocationLocation,
      });
    } catch {
      observeJourney(journey, {
        kind: "artifact_observed",
        artifactId: "pi_invocation_snapshot",
        artifactKind: "pi_invocation_snapshot",
        state: "unavailable",
        reason: "snapshot_projection_failed",
        location: invocationLocation,
      });
    }
    completeJourneyStep(journey, "p3.finalize_pi_invocation", invocationLocation);
    const executionLocation = {
      phase: "upstream_execution",
      lane: "semantic_conversion",
      step: "create_pi_stream",
    } as const;
    const executionFacts: NonNullable<Parameters<ExecutionOperation>[4]> = {
      notice: (notice) => {
        observeJourney(journey, {
          kind: "conversion_notice_observed",
          code: notice.code,
          severity: notice.action === "ignore" ? "info" : "warning",
          location: executionLocation,
        });
      },
      attempt: (attempt) => {
        observeJourney(journey, {
          kind: "attempt_observed",
          attempt: attempt.attempt,
          ...(attempt.status === undefined ? {} : { status: attempt.status }),
          location: {
            ...executionLocation,
            step: "observe_pi_attempt",
            attempt: attempt.attempt,
          },
        });
      },
      terminalUsage: (usage) => {
        observeJourney(journey, {
          kind: "terminal_usage_observed",
          usage,
          location: {
            phase: "lane_response_processing",
            lane: "semantic_conversion",
            step: "observe_pi_terminal_usage",
            subject: "usage",
          },
        });
      },
    };
    bindCredentialActivityToExecutionFacts(executionFacts, {
      credentialCaptured: (capture) => {
        observeJourney(journey, {
          kind: "profile_attributed",
          profileId: capture.credentialId,
          displayName: capture.displayName,
          location: {
            phase: "upstream_execution",
            lane: "semantic_conversion",
            step: "capture_semantic_profile",
          },
        });
      },
      credentialAttempt: (attempt) => {
        observeJourney(journey, {
          kind: "profile_attributed",
          profileId: attempt.credentialId,
          displayName: attempt.displayName,
          location: {
            phase: "upstream_execution",
            lane: "semantic_conversion",
            step: "attribute_semantic_profile_attempt",
            attempt: attempt.attempt,
          },
        });
      },
    });
    observeJourney(journey, {
      kind: "artifact_observed",
      artifactId: "pi_provider_outbound_request_evidence",
      artifactKind: "pi_provider_outbound_request_evidence",
      state: "unavailable",
      reason: "provider_did_not_expose",
      location: {
        phase: "upstream_execution",
        lane: "semantic_conversion",
        direction: "pi_to_provider",
        step: "convert_pi_request",
        subject: "envelope",
      },
    });
    observeJourney(journey, {
      kind: "artifact_observed",
      artifactId: "pi_provider_response_decode_evidence",
      artifactKind: "pi_provider_response_decode_evidence",
      state: "unavailable",
      reason: "provider_did_not_expose",
      location: {
        phase: "upstream_execution",
        lane: "semantic_conversion",
        direction: "provider_to_pi",
        step: "decode_provider_events",
        subject: "envelope",
      },
    });
    enterJourneyStep(journey, "p4.create_pi_stream", executionLocation);
    let message;
    try {
      const semanticResult = await executeAnthropicSemanticInvocation({
        models: dependencies.models,
        model,
        invocation: semanticInvocation,
        execution: {
          executeOperation: dependencies.executeOperation,
          factsSink: executionFacts,
        },
      });
      message = semanticResult.message;
    } catch (error) {
      failJourneyStep(
        journey,
        "p4.create_pi_stream",
        executionLocation,
        anthropicMessagesProtocolId,
        "model_generation",
      );
      throw error;
    }
    completeJourneyStep(journey, "p4.create_pi_stream", executionLocation);
    try {
      const terminalSummary = encodedBoundedSummary({
        schema: "luckytoken.pi_terminal_summary.v1",
        role: message.role,
        stopReason: message.stopReason,
        contentBlockCount: message.content.length,
        usage: message.usage,
      });
      observeJourney(journey, {
        kind: "artifact_observed",
        artifactId: "pi_terminal_summary",
        artifactKind: "pi_terminal_summary",
        state: terminalSummary.truncated ? "partial" : "captured",
        mediaType: "application/json",
        bytes: terminalSummary.bytes,
        originalBytes: terminalSummary.originalBytes,
        capturedBytes: terminalSummary.bytes.byteLength,
        truncated: terminalSummary.truncated,
        location: executionLocation,
      });
    } catch {
      observeJourney(journey, {
        kind: "artifact_observed",
        artifactId: "pi_terminal_summary",
        artifactKind: "pi_terminal_summary",
        state: "unavailable",
        reason: "snapshot_projection_failed",
        location: executionLocation,
      });
    }
    request.signal.throwIfAborted();
    const responseProjectionLocation = {
      phase: "lane_response_processing",
      lane: "semantic_conversion",
      direction: "pi_to_client",
      step: "validate_assistant_message",
      subject: "message",
    } as const;
    activeClientResponseStep = {
      stepInstanceId: "p5.validate_assistant_message",
      classification: "client_response_conversion_failed",
      location: responseProjectionLocation,
    };
    enterJourneyStep(
      journey,
      "p5.validate_assistant_message",
      responseProjectionLocation,
    );
    const responseConversion = convertAssistantMessageToAnthropicWithPolicy(
      message,
      {
        selector: invocation.client.renderState.selector,
        thinkingDisplay: invocation.client.renderState.thinkingDisplay,
        directToolNames: invocation.client.renderState.directToolNames,
        createMessageId: dependencies.createMessageId,
      },
      dependencies.configuration.conversion.response,
    );
    for (const notice of responseConversion.notices) {
      observeJourney(journey, {
        kind: "conversion_notice_observed",
        code: notice.code,
        severity: notice.action === "ignore" ? "info" : "warning",
        location: responseProjectionLocation,
      });
    }
    const target = responseConversion.message;
    completeJourneyStep(
      journey,
      "p5.validate_assistant_message",
      responseProjectionLocation,
    );
    const responseEncodingLocation = {
      phase: "client_response_preparation",
      lane: "semantic_conversion",
      direction: "pi_to_client",
      step: invocation.client.renderState.stream
        ? "encode_atomic_sse"
        : "encode_client_json",
      subject: "envelope",
    } as const;
    activeClientResponseStep = {
      stepInstanceId: "p6.encode_client_response",
      classification: "client_response_encoding_failed",
      location: responseEncodingLocation,
    };
    enterJourneyStep(journey, "p6.encode_client_response", responseEncodingLocation);
    const prepared = invocation.client.renderState.stream
      ? renderAnthropicAtomicSse(target)
      : renderAnthropicJsonSuccess(target);
    request.signal.throwIfAborted();
    const response = toResponse(prepared);
    completeJourneyStep(
      journey,
      "p6.encode_client_response",
      responseEncodingLocation,
    );
    activeClientResponseStep = undefined;
    observeJourney(journey, {
      kind: "client_response_prepared",
      status: response.status,
      ...(response.headers.get("content-type") === null
        ? {}
        : { mediaType: response.headers.get("content-type")! }),
      location: responseEncodingLocation,
    });
    const outcomeLocation = {
      phase: "outcome_commit",
      lane: "semantic_conversion",
      step: "commit_request_outcome",
    } as const;
    enterJourneyStep(journey, "p7.commit_request_outcome", outcomeLocation);
    observeJourney(journey, {
      kind: "work_outcome_committed",
      outcome: "success",
      terminalAuthority: "pi_execution",
      location: outcomeLocation,
    });
    completeJourneyStep(
      journey,
      "p7.commit_request_outcome",
      outcomeLocation,
    );
    return response;
  } catch (error) {
    if (request.signal.aborted || error instanceof HttpRequestAbortedError) {
      throw new HttpRequestAbortedError(request.signal.reason);
    }
    if (activeClientResponseStep !== undefined) {
      const failedStep = activeClientResponseStep;
      failJourneyStep(
        journey,
        failedStep.stepInstanceId,
        failedStep.location,
        anthropicMessagesProtocolId,
        "model_generation",
      );
      observeJourney(journey, {
        kind: "failure_detected",
        failureId: `${requestId}:${failedStep.classification}`,
        role: "primary",
        classification: failedStep.classification,
        origin: "luckytoken",
        originPrecision: "exact",
        location: failedStep.location,
      });
      const response = toResponse(
        renderAnthropicError(
          500,
          "api_error",
          "Internal server error",
          requestId,
        ),
      );
      const presentationLocation = {
        phase: "client_response_preparation",
        lane: "semantic_conversion",
        direction: "pi_to_client",
        step: "prepare_anthropic_error_response",
        subject: "envelope",
      } as const;
      observeJourney(journey, {
        kind: "client_response_prepared",
        status: response.status,
        ...(response.headers.get("content-type") === null
          ? {}
          : { mediaType: response.headers.get("content-type")! }),
        location: presentationLocation,
      });
      const outcomeLocation = {
        phase: "outcome_commit",
        lane: "semantic_conversion",
        step: "commit_request_outcome",
      } as const;
      enterJourneyStep(journey, "p7.commit_request_outcome", outcomeLocation);
      observeJourney(journey, {
        kind: "work_outcome_committed",
        outcome: "success",
        terminalAuthority: "pi_execution",
        location: outcomeLocation,
      });
      completeJourneyStep(
        journey,
        "p7.commit_request_outcome",
        outcomeLocation,
      );
      return response;
    }
    if (activeEarlyStep !== undefined) {
      const failure = activeEarlyStep;
      if (error instanceof SyntaxError) {
        return observeAnthropicEarlyFailure(
          journey,
          requestId,
          toResponse(
            renderAnthropicError(
              400,
              "invalid_request_error",
              "Request body is not valid JSON",
              requestId,
            ),
          ),
          {
            ...failure,
            classification: "invalid_json",
            origin: "client",
          },
        );
      }
      if (error instanceof InvalidRequest || error instanceof UnsupportedFeature) {
        return observeAnthropicEarlyFailure(
          journey,
          requestId,
          toResponse(
            renderAnthropicError(
              400,
              "invalid_request_error",
              error.message,
              requestId,
            ),
          ),
          {
            ...failure,
            classification: "invalid_request",
            origin: "client",
          },
        );
      }
      if (error instanceof ModelResolutionFailure) {
        return observeAnthropicEarlyFailure(
          journey,
          requestId,
          toResponse(
            renderAnthropicError(
              404,
              "not_found_error",
              error.message,
              requestId,
            ),
          ),
          {
            ...failure,
            classification: "unknown_model",
            origin: "client",
          },
        );
      }
      return observeAnthropicEarlyFailure(
        journey,
        requestId,
        toResponse(
          renderAnthropicError(
            500,
            "api_error",
            "Internal server error",
            requestId,
          ),
        ),
        {
          ...failure,
          classification: "protocol_ingress_failed",
          origin: "luckytoken",
        },
      );
    }
    if (error instanceof ExecutionAbortedError) {
      return toResponse(
        renderAnthropicError(
          500,
          "api_error",
          "Model execution was aborted",
          requestId,
        ),
      );
    }
    if (error instanceof SyntaxError) {
      return toResponse(
        renderAnthropicError(
          400,
          "invalid_request_error",
          "Request body is not valid JSON",
          requestId,
        ),
      );
    }
    if (error instanceof InvalidRequest || error instanceof UnsupportedFeature) {
      return toResponse(
        renderAnthropicError(
          400,
          "invalid_request_error",
          error.message,
          requestId,
        ),
      );
    }
    if (error instanceof ModelResolutionFailure) {
      return toResponse(
        renderAnthropicError(
          404,
          "not_found_error",
          error.message,
          requestId,
        ),
      );
    }
    if (
      error instanceof ExecutionFailure &&
      error.failure !== undefined &&
      error.failure.kind !== "caller_cancellation"
    ) {
      const terminalLocation = semanticFailureLocation(error.failure);
      const terminalStep = `p4.${terminalLocation.step}`;
      enterJourneyStep(journey, terminalStep, terminalLocation);
      failJourneyStep(
        journey,
        terminalStep,
        terminalLocation,
        anthropicMessagesProtocolId,
        "model_generation",
      );
      try {
        const terminalSummary = encodedBoundedSummary({
          kind: error.failure.kind,
          phase: error.failure.phase,
          status: error.failure.status,
          statusText: error.failure.statusText,
          providerType: error.failure.providerType,
          providerCode: error.failure.providerCode,
          message: error.failure.message,
          headers: error.failure.headers,
          retryable: error.failure.retryable,
          attemptCount: error.failure.attemptCount,
          snapshot: error.failure.snapshot,
          truncated: error.failure.truncated,
        });
        observeJourney(journey, {
          kind: "artifact_observed",
          artifactId: "pi_terminal_summary",
          artifactKind: "pi_terminal_summary",
          state: terminalSummary.truncated ? "partial" : "captured",
          mediaType: "application/json",
          bytes: terminalSummary.bytes,
          originalBytes: terminalSummary.originalBytes,
          capturedBytes: terminalSummary.bytes.byteLength,
          truncated: terminalSummary.truncated,
          location: terminalLocation,
        });
      } catch {
        observeJourney(journey, {
          kind: "artifact_observed",
          artifactId: "pi_terminal_summary",
          artifactKind: "pi_terminal_summary",
          state: "unavailable",
          reason: "snapshot_projection_failed",
          location: terminalLocation,
        });
      }
      observeJourney(journey, {
        kind: "failure_detected",
        failureId: `${requestId}:trusted_upstream_${error.failure.kind}_failure`,
        role: "primary",
        classification: `trusted_upstream_${error.failure.kind}_failure`,
        origin: "provider",
        originPrecision: "external_boundary",
        safeMessage: error.failure.message,
        location: terminalLocation,
      });
      const mapping = mapUpstreamFailureFact(error.failure);
      const response = toResponse(
        renderAnthropicError(
          mapping.status,
          mapping.type,
          mapping.message,
          requestIdFromFact(error.failure) ?? requestId,
          mapping.safeHeaders,
        ),
      );
      const presentationLocation = {
        phase: "client_response_preparation",
        lane: "semantic_conversion",
        step: "render_client_error",
      } as const;
      enterJourneyStep(journey, "p6.render_client_error", presentationLocation);
      observeJourney(journey, {
        kind: "client_response_prepared",
        status: response.status,
        ...(response.headers.get("content-type") === null
          ? {}
          : { mediaType: response.headers.get("content-type")! }),
        location: presentationLocation,
      });
      completeJourneyStep(
        journey,
        "p6.render_client_error",
        presentationLocation,
      );
      const outcomeLocation = {
        phase: "outcome_commit",
        lane: "semantic_conversion",
        step: "commit_request_outcome",
      } as const;
      enterJourneyStep(journey, "p7.commit_request_outcome", outcomeLocation);
      observeJourney(journey, {
        kind: "work_outcome_committed",
        outcome: "failed",
        terminalAuthority: "pi_execution",
        location: outcomeLocation,
      });
      completeJourneyStep(
        journey,
        "p7.commit_request_outcome",
        outcomeLocation,
      );
      return response;
    }
    // A Provider failure without a trusted neutral fact has no authority for
    // a client-visible status, type, code, headers, or message. Structural
    // matching keeps module duplication harmless while excluding the
    // malformed/deferred ExecutionFailure subclasses.
    if (
      error instanceof Error &&
      "kind" in error &&
      error.kind === "ExecutionFailure" &&
      "reason" in error &&
      error.reason === "error"
    ) {
      return toResponse(
        renderAnthropicError(
          502,
          "api_error",
          "Upstream provider failed",
          requestId,
        ),
      );
    }
    return toResponse(
      renderAnthropicError(
        500,
        "api_error",
        "Internal server error",
        requestId,
      ),
    );
  }
}

async function handleAnthropicMessagesWithJourney(
  dependencies: AnthropicMessagesDependencies,
  request: Request,
  context?: ClientProtocolRequestContext,
): Promise<Response> {
  const requestId = context?.requestId ?? randomUUID();
  // Publish correlation before the first await so a transport-synthesized
  // error response can still carry the exact request-edge id.
  requestIds.set(request, requestId);
  const response = await handleAnthropicMessages(
    dependencies,
    request,
    requestId,
    context?.journey,
  );
  return attachRequestId(response, requestId);
}

export function createAnthropicMessagesHandler(
  options: AnthropicMessagesHandlerOptions,
): ClientProtocolHandler {
  const policy = options.modelValidityPolicy ?? defaultAnthropicModelValidityPolicy;
  const hasCertifiedImageFidelity = policy.hasCertifiedImageFidelity;
  const modelValidityPolicy: AnthropicModelValidityPolicy = Object.freeze({
    revision: policy.revision,
    hasCertifiedImageFidelity: (
      model: Parameters<
        AnthropicModelValidityPolicy["hasCertifiedImageFidelity"]
      >[0],
    ) => hasCertifiedImageFidelity(model),
  });
  const dependencies: AnthropicMessagesDependencies = Object.freeze({
    models: options.models,
    createSessionId: options.createSessionId ?? randomUUID,
    configuration:
      options.configuration === undefined
        ? parseAnthropicConfiguration()
        : bindAnthropicConfiguration(options.configuration),
    providerNativeLane: options.providerNativeLane,
    modelValidityPolicy,
    createMessageId: options.createMessageId ?? (() => `msg_${randomUUID()}`),
    publicModels: options.publicModels,
    maxRequestBytes: options.maxRequestBytes,
    routerDefaults: Object.freeze({ ...(options.routerDefaults ?? {}) }),
    now: options.now ?? Date.now,
    executeOperation: options.executeOperation ?? execute,
  });
  return Object.freeze({
    method: "POST",
    pathname: "/v1/messages",
    handle: (request: Request, context?: ClientProtocolRequestContext) =>
      handleAnthropicMessagesWithJourney(dependencies, request, context),
    requestIdFor: (request: Request) => requestIds.get(request),
  });
}
