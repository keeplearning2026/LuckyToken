import type { Model, Models } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";

import { resolveRequestIdentity } from "../../request-identity.js";
import {
  bindOpenAIResponsesConfiguration,
  parseOpenAIResponsesConfiguration,
  type OpenAIResponsesConfiguration,
} from "./configuration.js";
import {
  execute,
  ExecutionAbortedError,
} from "../../execution.js";
import type { ExecutionOperation } from "../../execution.js";
import type {
  ClientProtocolHandler,
  ClientProtocolRequestContext,
} from "../../http.js";
import type {
  RequestJourneyLocation,
  RequestJourneyObservationInput,
  RequestJourneyObserver,
  RequestJourneyOperation,
} from "../../diagnostics/contract.js";
import { ModelResolutionFailure } from "../../model-resolution.js";
import {
  resolveDataPlanePublicModel,
  type PublicModelSource,
} from "../../public-model-seam.js";
import type { RouterOptionDefaults } from "../options.js";
import { InvalidRequest } from "./request.js";
import {
  readResponsesRequestBody,
  ResponsesRequestBodyTooLargeError,
  UnsupportedResponsesContentEncodingError,
} from "./request-body.js";
import {
  renderResponsesError,
  renderResponsesErrorResponse,
  type PreparedHttpResponse,
} from "./response.js";
import { mapUpstreamFailureFact } from "./error-rendering.js";
import type { UpstreamFailureFact } from "@luckytoken/provider-contract/diagnostics";
import { extractResponsesModelSelector } from "./request.js";
import {
  createResponseSessionState,
  ResponseStateConversionFailure,
  type ResponseSessionState,
} from "./session-state.js";
import {
  bufferNativeResponsesResponse,
  projectNativeResponsesBody,
  type NativeResponsesResult,
} from "./native-response.js";
import { extractResponsesPassthroughUsage } from "./passthrough-usage.js";
import { executeSemanticResponses } from "./semantic.js";
import type {
  ProviderResponsesLane,
  ProviderResponsesObservationContext,
} from "../../provider-native-responses/contract.js";

export const openaiResponsesProtocolId = "openai-responses";

export interface DirectResponsesLane {
  claims(selector: string): boolean;
  execute(input: {
    readonly request: Request;
    readonly rawBody: Uint8Array<ArrayBuffer>;
    readonly selector: string;
    readonly streamRequested: boolean;
    readonly journey?: RequestJourneyObserver;
  }): Promise<Response>;
}

export interface OpenAIResponsesHandlerOptions {
  readonly models: Models;
  readonly directLane?: DirectResponsesLane;
  readonly providerNativeLane?: ProviderResponsesLane;
  readonly createSessionId?: () => string;
  readonly configuration?: OpenAIResponsesConfiguration;
  readonly stateFile: string;
  /**
   * Optional injected session state (test seam). When omitted, the handler
   * creates and owns its own store bound to `stateFile`.
   */
  readonly sessionState?: ResponseSessionState;
  /** Backend-lifetime Public Model source. When absent, direct handler tests
   * use the canonical provider/model selector seam. */
  readonly publicModels?: PublicModelSource;
  /** Request body byte ceiling. Single source of truth: the composition root
   *  passes `config.limits.maxRequestBytes`; this handler consumes it and
   *  never supplies its own default. */
  readonly maxRequestBytes: number;
  readonly routerDefaults?: RouterOptionDefaults;
  readonly createResponseId?: () => string;
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

interface OpenAIResponsesDependencies {
  readonly models: Models;
  readonly directLane: DirectResponsesLane | undefined;
  readonly providerNativeLane: ProviderResponsesLane | undefined;
  readonly createSessionId: () => string;
  readonly configuration: OpenAIResponsesConfiguration;
  readonly sessionState: ResponseSessionState;
  readonly publicModels: PublicModelSource | undefined;
  readonly maxRequestBytes: number;
  readonly routerDefaults: RouterOptionDefaults;
  readonly createResponseId: () => string;
  readonly now: () => number;
  readonly executeOperation: ExecutionOperation;
}

function toResponse(prepared: PreparedHttpResponse): Response {
  return new Response(prepared.body, {
    status: prepared.status,
    headers: { "content-type": prepared.contentType },
  });
}

function observeResponsesJourney(
  journey: RequestJourneyObserver | undefined,
  observation: RequestJourneyObservationInput,
): void {
  try {
    journey?.observe(observation);
  } catch {
    // Request serving remains authoritative over observation failure.
  }
}

function enterResponsesJourneyStep(
  journey: RequestJourneyObserver | undefined,
  stepInstanceId: string,
  location: RequestJourneyLocation,
): void {
  observeResponsesJourney(journey, {
    kind: "step_entered",
    stepInstanceId,
    location,
  });
}

function completeResponsesJourneyStep(
  journey: RequestJourneyObserver | undefined,
  stepInstanceId: string,
  location: RequestJourneyLocation,
  protocol?: string,
  operation?: RequestJourneyOperation,
): void {
  observeResponsesJourney(journey, {
    kind: "step_completed",
    stepInstanceId,
    completion: "success",
    location,
    ...(protocol === undefined ? {} : { protocol }),
    ...(operation === undefined ? {} : { operation }),
  });
}

function failResponsesJourneyStep(
  journey: RequestJourneyObserver | undefined,
  stepInstanceId: string,
  location: RequestJourneyLocation,
  completion: "failed" | "aborted" = "failed",
): void {
  observeResponsesJourney(journey, {
    kind: "step_completed",
    stepInstanceId,
    completion,
    location,
  });
}

interface ResponsesEarlyFailure {
  readonly stepInstanceId: string;
  readonly location: RequestJourneyLocation;
  readonly classification: string;
  readonly origin: "client" | "luckytoken";
}

function observeResponsesEarlyFailure(
  journey: RequestJourneyObserver | undefined,
  requestId: string,
  response: Response,
  failure: ResponsesEarlyFailure,
): Response {
  observeResponsesJourney(journey, {
    kind: "step_completed",
    stepInstanceId: failure.stepInstanceId,
    completion: "failed",
    protocol: openaiResponsesProtocolId,
    operation: "model_generation",
    location: failure.location,
  });
  observeResponsesJourney(journey, {
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
    step: "prepare_openai_responses_error_response",
  } as const;
  enterResponsesJourneyStep(
    journey,
    "p6.prepare_openai_responses_error_response",
    presentationLocation,
  );
  observeResponsesJourney(journey, {
    kind: "client_response_prepared",
    status: response.status,
    ...(response.headers.get("content-type") === null
      ? {}
      : { mediaType: response.headers.get("content-type")! }),
    location: presentationLocation,
  });
  completeResponsesJourneyStep(
    journey,
    "p6.prepare_openai_responses_error_response",
    presentationLocation,
    openaiResponsesProtocolId,
    "model_generation",
  );

  const outcomeLocation = {
    phase: "outcome_commit",
    step: "commit_request_outcome",
  } as const;
  enterResponsesJourneyStep(
    journey,
    "p7.commit_request_outcome",
    outcomeLocation,
  );
  observeResponsesJourney(journey, {
    kind: "work_outcome_committed",
    outcome: "failed",
    terminalAuthority: "openai_responses_handler",
    location: outcomeLocation,
  });
  completeResponsesJourneyStep(
    journey,
    "p7.commit_request_outcome",
    outcomeLocation,
    openaiResponsesProtocolId,
    "model_generation",
  );
  return response;
}

function observeResponsesWireArtifact(
  journey: RequestJourneyObserver | undefined,
  input: Readonly<{
    artifactId: string;
    artifactKind: string;
    bytes: Uint8Array;
    mediaType?: string;
    location: RequestJourneyLocation;
  }>,
): void {
  const capturedBytes = Math.min(input.bytes.byteLength, 256 * 1_024);
  observeResponsesJourney(journey, {
    kind: "artifact_observed",
    artifactId: input.artifactId,
    artifactKind: input.artifactKind,
    state: capturedBytes < input.bytes.byteLength ? "partial" : "captured",
    ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
    bytes: input.bytes.slice(0, capturedBytes),
    originalBytes: input.bytes.byteLength,
    capturedBytes,
    truncated: capturedBytes < input.bytes.byteLength,
    location: input.location,
  });
}

function observeProviderNativeTerminalResponse(
  journey: RequestJourneyObserver | undefined,
  response: Response,
  outcome: "success" | "failed",
): void {
  const presentationLocation = {
    phase: "client_response_preparation",
    lane: "provider_native",
    step:
      outcome === "success"
        ? "prepare_provider_native_response"
        : "prepare_provider_native_error_response",
  } as const;
  const presentationStep =
    outcome === "success"
      ? "p6.prepare_provider_native_response"
      : "p6.prepare_provider_native_error_response";
  enterResponsesJourneyStep(journey, presentationStep, presentationLocation);
  observeResponsesJourney(journey, {
    kind: "client_response_prepared",
    status: response.status,
    ...(response.headers.get("content-type") === null
      ? {}
      : { mediaType: response.headers.get("content-type")! }),
    location: presentationLocation,
  });
  completeResponsesJourneyStep(
    journey,
    presentationStep,
    presentationLocation,
  );

  const outcomeLocation = {
    phase: "outcome_commit",
    lane: "provider_native",
    step: "commit_request_outcome",
  } as const;
  enterResponsesJourneyStep(
    journey,
    "p7.commit_request_outcome",
    outcomeLocation,
  );
  observeResponsesJourney(journey, {
    kind: "work_outcome_committed",
    outcome,
    requestOutcome: outcome,
    terminalAuthority: "openai_responses_provider_native_lane",
    location: outcomeLocation,
  });
  completeResponsesJourneyStep(
    journey,
    "p7.commit_request_outcome",
    outcomeLocation,
  );
}

async function raceWithRequestSignal<T>(
  value: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw new ExecutionAbortedError(signal.reason);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new ExecutionAbortedError(signal.reason));
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
  return (
    contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json"
  );
}

async function handleOpenAIResponses(
  dependencies: OpenAIResponsesDependencies,
  request: Request,
  requestId: string,
  journey: RequestJourneyObserver | undefined,
): Promise<Response> {
  let activeEarlyStep: Readonly<{
    stepInstanceId: string;
    location: RequestJourneyLocation;
  }> | undefined;
  try {
    request.signal.throwIfAborted();
    const mediaLocation = {
      phase: "protocol_ingress",
      step: "validate_media_and_encoding",
    } as const;
    activeEarlyStep = {
      stepInstanceId: "p1.validate_media_and_encoding",
      location: mediaLocation,
    };
    enterResponsesJourneyStep(
      journey,
      "p1.validate_media_and_encoding",
      mediaLocation,
    );
    if (!hasJsonContentType(request.headers)) {
      observeResponsesJourney(journey, {
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
      return observeResponsesEarlyFailure(
        journey,
        requestId,
        toResponse(
          renderResponsesError(
            415,
            "invalid_request_error",
            "Content-Type must be application/json",
          ),
        ),
        {
          ...activeEarlyStep,
          classification: "unsupported_media_type",
          origin: "client",
        },
      );
    }
    completeResponsesJourneyStep(
      journey,
      "p1.validate_media_and_encoding",
      mediaLocation,
      openaiResponsesProtocolId,
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
    enterResponsesJourneyStep(
      journey,
      "p1.establish_request_identity",
      identityLocation,
    );
    const requestIdentity = resolveRequestIdentity(
      request.headers,
      dependencies.createSessionId,
    );
    observeResponsesJourney(journey, {
      kind: "request_identity_established",
      effectiveSessionId: requestIdentity.effectiveSessionId,
      ...(requestIdentity.clientSessionId === undefined
        ? {}
        : { clientSessionId: requestIdentity.clientSessionId }),
      location: identityLocation,
    });
    completeResponsesJourneyStep(
      journey,
      "p1.establish_request_identity",
      identityLocation,
    );
    activeEarlyStep = undefined;

    const bodyLocation = {
      phase: "protocol_ingress",
      step: "read_and_decode_body",
    } as const;
    activeEarlyStep = {
      stepInstanceId: "p1.read_and_decode_body",
      location: bodyLocation,
    };
    enterResponsesJourneyStep(
      journey,
      "p1.read_and_decode_body",
      bodyLocation,
    );
    const decodedBody = await readResponsesRequestBody(
      request,
      dependencies.maxRequestBytes,
    );
    const rawBody = decodedBody.text;
    const body: unknown = decodedBody.json;
    const rawRequestBytes = decodedBody.wireBytes;
    observeResponsesJourney(journey, {
      kind: "artifact_observed",
      artifactId: "client_request_wire",
      artifactKind: "client_request_wire",
      state: "captured",
      mediaType: "application/json",
      bytes: rawRequestBytes,
      originalBytes: rawRequestBytes.byteLength,
      capturedBytes: rawRequestBytes.byteLength,
      truncated: false,
      location: bodyLocation,
    });
    completeResponsesJourneyStep(
      journey,
      "p1.read_and_decode_body",
      bodyLocation,
    );
    activeEarlyStep = undefined;

    // Native passthrough selection happens before any conversion or local
    // state expansion: a model declared Responses-wire-compatible forwards
    // the raw request verbatim to the upstream endpoint, never through Pi.
    const selectorLocation = {
      phase: "request_resolution",
      step: "extract_model_selector",
    } as const;
    enterResponsesJourneyStep(
      journey,
      "p2.extract_model_selector",
      selectorLocation,
    );
    activeEarlyStep = {
      stepInstanceId: "p2.extract_model_selector",
      location: selectorLocation,
    };
    const selector = extractResponsesModelSelector(body);
    completeResponsesJourneyStep(
      journey,
      "p2.extract_model_selector",
      selectorLocation,
      openaiResponsesProtocolId,
      "model_generation",
    );
    activeEarlyStep = undefined;
    const streamRequested = (body as { readonly stream?: unknown }).stream === true;
    if (dependencies.directLane !== undefined) {
      const localRecognitionLocation = {
        phase: "request_resolution",
        lane: "direct",
        step: "recognize_direct",
      } as const;
      enterResponsesJourneyStep(
        journey,
        "p2.recognize_direct",
        localRecognitionLocation,
      );
      const localClaimed = dependencies.directLane.claims(selector);
      completeResponsesJourneyStep(
        journey,
        "p2.recognize_direct",
        localRecognitionLocation,
      );
      if (localClaimed) {
        observeResponsesJourney(journey, {
          kind: "lane_committed",
          lane: "direct",
          location: {
            phase: "request_resolution",
            lane: "direct",
            step: "commit_lane",
          },
        });
        return dependencies.directLane.execute({
          request,
          rawBody: decodedBody.wireBytes,
          selector,
          streamRequested,
          ...(journey === undefined ? {} : { journey }),
        });
      }
    }
    const resolutionLocation = {
      phase: "request_resolution",
      step: "resolve_public_model",
    } as const;
    enterResponsesJourneyStep(
      journey,
      "p2.resolve_public_model",
      resolutionLocation,
    );
    activeEarlyStep = {
      stepInstanceId: "p2.resolve_public_model",
      location: resolutionLocation,
    };
    const resolution = await resolveDataPlanePublicModel(
      dependencies.models,
      dependencies.publicModels,
      selector,
    );
    if (resolution.kind === "unknown") {
      return observeResponsesEarlyFailure(
        journey,
        requestId,
        toResponse(
          renderResponsesError(
            400,
            "invalid_request_error",
            `Unknown model: ${selector}`,
            "unknown_model",
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
      return observeResponsesEarlyFailure(
        journey,
        requestId,
        toResponse(
          renderResponsesError(
            503,
            "api_error",
            "The requested model is not currently available",
            "model_unavailable",
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
    observeResponsesJourney(journey, {
      kind: "model_resolved",
      requestedModel: selector,
      providerId: model.provider,
      modelId: model.id,
      location: resolutionLocation,
    });
    completeResponsesJourneyStep(
      journey,
      "p2.resolve_public_model",
      resolutionLocation,
    );
    activeEarlyStep = undefined;
    // Passthrough response projection is alias-only: the alias captured at
    // acceptance must be echoed symmetrically by the upstream response.
    const projectAlias =
      dependencies.publicModels === undefined ? undefined : resolution.alias;
    if (dependencies.providerNativeLane !== undefined) {
      const providerRecognitionLocation = {
        phase: "request_resolution",
        lane: "provider_native",
        step: "recognize_provider_native",
      } as const;
      enterResponsesJourneyStep(
        journey,
        "p2.recognize_provider_native",
        providerRecognitionLocation,
      );
      const providerNativeClaimed = dependencies.providerNativeLane.claims(
        model,
        "responses",
      );
      completeResponsesJourneyStep(
        journey,
        "p2.recognize_provider_native",
        providerRecognitionLocation,
      );
      if (providerNativeClaimed) {
        observeResponsesJourney(journey, {
          kind: "lane_committed",
          lane: "provider_native",
          location: {
            phase: "request_resolution",
            lane: "provider_native",
            step: "commit_lane",
          },
        });
        return providerNativeBranch(
          dependencies,
          request,
          model,
          rawBody,
          streamRequested,
          requestIdentity.effectiveSessionId,
          projectAlias,
          journey,
        );
      }
    }

    observeResponsesJourney(journey, {
      kind: "lane_committed",
      lane: "semantic_conversion",
      location: {
        phase: "request_resolution",
        lane: "semantic_conversion",
        step: "commit_lane",
      },
    });

    return executeSemanticResponses({
      request,
      body,
      model,
      requestIdentity,
      models: dependencies.models,
      configuration: dependencies.configuration,
      sessionState: dependencies.sessionState,
      routerDefaults: dependencies.routerDefaults,
      createResponseId: dependencies.createResponseId,
      now: dependencies.now,
      executeOperation: dependencies.executeOperation,
      ...(journey === undefined ? {} : { journey }),
    });
  } catch (error) {
    if (request.signal.aborted || error instanceof ExecutionAbortedError) {
      throw new ExecutionAbortedError(request.signal.reason);
    }
    if (activeEarlyStep !== undefined) {
      const failure = activeEarlyStep;
      if (error instanceof ResponsesRequestBodyTooLargeError) {
        observeResponsesJourney(journey, {
          kind: "artifact_observed",
          artifactId: "client_request_wire",
          artifactKind: "client_request_wire",
          state: "unavailable",
          reason: "request_body_exceeds_limit",
          location: failure.location,
        });
        return observeResponsesEarlyFailure(
          journey,
          requestId,
          toResponse(
            renderResponsesError(
              413,
              "request_too_large",
              "Request exceeds the configured maximum size",
            ),
          ),
          {
            ...failure,
            classification: "request_body_too_large",
            origin: "client",
          },
        );
      }
      if (error instanceof UnsupportedResponsesContentEncodingError) {
        observeResponsesJourney(journey, {
          kind: "artifact_observed",
          artifactId: "client_request_wire",
          artifactKind: "client_request_wire",
          state: "unavailable",
          reason: "unsupported_content_encoding",
          location: failure.location,
        });
        return observeResponsesEarlyFailure(
          journey,
          requestId,
          toResponse(
            renderResponsesError(
              415,
              "invalid_request_error",
              "Unsupported Content-Encoding",
            ),
          ),
          {
            ...failure,
            classification: "unsupported_content_encoding",
            origin: "client",
          },
        );
      }
      if (error instanceof SyntaxError) {
        return observeResponsesEarlyFailure(
          journey,
          requestId,
          toResponse(
            renderResponsesError(
              400,
              "invalid_request_error",
              "Request body is not valid JSON",
            ),
          ),
          {
            ...failure,
            classification: "invalid_json",
            origin: "client",
          },
        );
      }
      if (error instanceof InvalidRequest) {
        return observeResponsesEarlyFailure(
          journey,
          requestId,
          toResponse(
            renderResponsesError(400, "invalid_request_error", error.message),
          ),
          {
            ...failure,
            classification: "invalid_request",
            origin: "client",
          },
        );
      }
      if (error instanceof ModelResolutionFailure) {
        return observeResponsesEarlyFailure(
          journey,
          requestId,
          toResponse(
            renderResponsesError(404, "not_found_error", error.message),
          ),
          {
            ...failure,
            classification: "unknown_model",
            origin: "client",
          },
        );
      }
      const hasContentEncoding =
        request.headers.get("content-encoding")?.trim().length !== 0 &&
        request.headers.get("content-encoding") !== null;
      return observeResponsesEarlyFailure(
        journey,
        requestId,
        toResponse(
          renderResponsesError(500, "api_error", "Internal server error"),
        ),
        {
          ...failure,
          classification: hasContentEncoding
            ? "request_body_decode_failed"
            : "protocol_ingress_failed",
          origin: hasContentEncoding ? "client" : "luckytoken",
        },
      );
    }
    if (error instanceof ResponsesRequestBodyTooLargeError) {
      return toResponse(
        renderResponsesError(
          413,
          "request_too_large",
          "Request exceeds the configured maximum size",
        ),
      );
    }
    if (error instanceof UnsupportedResponsesContentEncodingError) {
      return toResponse(
        renderResponsesError(
          415,
          "invalid_request_error",
          "Unsupported Content-Encoding",
        ),
      );
    }
    if (error instanceof SyntaxError) {
      return toResponse(
        renderResponsesError(
          400,
          "invalid_request_error",
          "Request body is not valid JSON",
        ),
      );
    }
    if (error instanceof InvalidRequest) {
      return toResponse(
        renderResponsesError(400, "invalid_request_error", error.message),
      );
    }
    if (error instanceof ResponseStateConversionFailure) {
      return toResponse(
        renderResponsesError(400, "invalid_request_error", error.message),
      );
    }
    if (error instanceof ModelResolutionFailure) {
      return toResponse(
        renderResponsesError(404, "not_found_error", error.message),
      );
    }
    if (
      error instanceof Error &&
      "kind" in error &&
      error.kind === "ExecutionFailure" &&
      "reason" in error &&
      error.reason === "error"
    ) {
      // A formed failed Response (stop reason error) is handled inside the
      // try block; anything reaching here is a pre-commit execution failure
      // and returns the non-streaming error envelope — never a fabricated
      // response.failed.
      const execution = error as unknown as {
        diagnostic?: unknown;
        failure?: UpstreamFailureFact;
        message: string;
      };
      if (execution.failure !== undefined) {
        const mapping = mapUpstreamFailureFact(execution.failure);
        return renderResponsesErrorResponse({
          status: mapping.status,
          type: mapping.type,
          message: mapping.message,
          code: mapping.code,
          param: mapping.param,
          safeHeaders: mapping.safeHeaders,
        });
      }
    }
    if (
      error instanceof Error &&
      "kind" in error &&
      error.kind === "ExecutionFailure" &&
      "reason" in error &&
      error.reason === "error"
    ) {
      return toResponse(
        renderResponsesError(502, "api_error", "Upstream provider failed"),
      );
    }
    return toResponse(
      renderResponsesError(500, "api_error", "Internal server error"),
    );
  }
}

/** Provider Native execution stays behind its lane seam. The protocol owns
 * lifecycle observation and alias projection, never Provider credentials or
 * request construction. */
async function providerNativeBranch(
  dependencies: OpenAIResponsesDependencies,
  request: Request,
  model: Model<string>,
  rawBody: string,
  streamRequested: boolean,
  sessionId: string,
  alias: string | undefined,
  journey: RequestJourneyObserver | undefined,
): Promise<Response> {
  const lane = dependencies.providerNativeLane;
  if (lane === undefined) throw new Error("Provider Native lane is unavailable");
  let finalAttempt = 1;
  const observation: ProviderResponsesObservationContext | undefined =
    journey === undefined
      ? undefined
      : {
          requestId: journey.requestId,
          journey,
          finalResponseAttempt: (attempt: number) => {
            if (Number.isSafeInteger(attempt) && attempt > 0) {
              finalAttempt = attempt;
            }
          },
        };
  let upstream: NativeResponsesResult;
  const bufferLocation = {
    phase: "lane_response_processing",
    lane: "provider_native",
    step: "buffer_provider_native_response",
  } as const;
  let bufferEntered = false;
  try {
    const response = await raceWithRequestSignal(
      lane.execute({
        model,
        rawBody,
        signal: request.signal,
        sessionId,
        operation: "responses",
        ...(observation === undefined ? {} : { observation }),
      }),
      request.signal,
    );
    enterResponsesJourneyStep(
      journey,
      "p5.buffer_provider_native_response",
      bufferLocation,
    );
    bufferEntered = true;
    upstream = await bufferNativeResponsesResponse(response, request.signal);
    observeResponsesWireArtifact(journey, {
      artifactId: `provider_native_upstream_response_wire.${finalAttempt}`,
      artifactKind: "provider_native_upstream_response_wire",
      bytes: upstream.body,
      ...(upstream.headers["content-type"] === undefined
        ? {}
        : { mediaType: upstream.headers["content-type"] }),
      location: bufferLocation,
    });
    completeResponsesJourneyStep(
      journey,
      "p5.buffer_provider_native_response",
      bufferLocation,
    );
  } catch (error) {
    if (bufferEntered) {
      failResponsesJourneyStep(
        journey,
        "p5.buffer_provider_native_response",
        bufferLocation,
        request.signal.aborted ? "aborted" : "failed",
      );
    }
    if (request.signal.aborted) throw error;
    const failureResponse = toResponse(
      renderResponsesError(502, "api_error", "Upstream provider request failed"),
    );
    observeProviderNativeTerminalResponse(journey, failureResponse, "failed");
    return failureResponse;
  }
  request.signal.throwIfAborted();
  const usageLocation = {
    phase: "lane_response_processing",
    lane: "provider_native",
    step: "observe_provider_native_usage",
  } as const;
  enterResponsesJourneyStep(
    journey,
    "p5.observe_provider_native_usage",
    usageLocation,
  );
  const terminalUsage = extractResponsesPassthroughUsage(
    upstream.body,
    upstream.headers["content-type"] ?? "",
    model.api,
    upstream.status >= 200 && upstream.status < 300 && streamRequested
      ? "event-stream"
      : "json",
  );
  if (terminalUsage !== undefined) {
    observeResponsesJourney(journey, {
      kind: "terminal_usage_observed",
      usage: terminalUsage,
      location: usageLocation,
    });
  }
  completeResponsesJourneyStep(
    journey,
    "p5.observe_provider_native_usage",
    usageLocation,
  );
  if (upstream.status >= 400 && alias !== undefined) {
    // Alias mode never forwards upstream error bytes: arbitrary upstream
    // error text or headers could name the canonical target. The client
    // receives a legal fixed value-free error instead.
    const failureResponse = toResponse(
      renderResponsesError(502, "api_error", "Upstream provider failed"),
    );
    const preserveLocation = {
      phase: "lane_response_processing",
      lane: "provider_native",
      step: "preserve_provider_response",
    } as const;
    enterResponsesJourneyStep(
      journey,
      "p5.preserve_provider_response",
      preserveLocation,
    );
    observeResponsesJourney(journey, {
      kind: "artifact_observed",
      artifactId: "provider_native_preserved_response_wire",
      artifactKind: "provider_native_preserved_response_wire",
      state: "unavailable",
      reason: "upstream_error_replaced_for_alias_safety",
      location: preserveLocation,
    });
    completeResponsesJourneyStep(
      journey,
      "p5.preserve_provider_response",
      preserveLocation,
    );
    observeProviderNativeTerminalResponse(journey, failureResponse, "failed");
    return failureResponse;
  }
  // Ticket 15 symmetry: a successful upstream response must expose the
  // requested alias, never the canonical model id. The buffered body is
  // projected before any byte is committed; an unprojectable shape fails
  // safely (no upstream bytes, no canonical identity).
  let body = upstream.body;
  const preserveLocation = {
    phase: "lane_response_processing",
    lane: "provider_native",
    step: "preserve_provider_response",
  } as const;
  enterResponsesJourneyStep(
    journey,
    "p5.preserve_provider_response",
    preserveLocation,
  );
  if (alias !== undefined) {
    const projected = projectNativeResponsesBody(
      body,
      upstream.headers["content-type"] ?? "",
      alias,
    );
    if ("error" in projected) {
      // The detailed projection reason is value-free and useful for
      // investigation; the client sees only the fixed safe envelope.
      failResponsesJourneyStep(
        journey,
        "p5.preserve_provider_response",
        preserveLocation,
      );
      observeResponsesJourney(journey, {
        kind: "artifact_observed",
        artifactId: "provider_native_preserved_response_wire",
        artifactKind: "provider_native_preserved_response_wire",
        state: "unavailable",
        reason: "response_projection_failed",
        location: preserveLocation,
      });
      const failureResponse = toResponse(
        renderResponsesError(
          502,
          "api_error",
          "Upstream response could not be projected safely",
        ),
      );
      observeProviderNativeTerminalResponse(journey, failureResponse, "failed");
      return failureResponse;
    }
    body = projected.body;
  }
  observeResponsesWireArtifact(journey, {
    artifactId: "provider_native_preserved_response_wire",
    artifactKind: "provider_native_preserved_response_wire",
    bytes: body,
    ...(upstream.headers["content-type"] === undefined
      ? {}
      : { mediaType: upstream.headers["content-type"] }),
    location: preserveLocation,
  });
  completeResponsesJourneyStep(
    journey,
    "p5.preserve_provider_response",
    preserveLocation,
  );
  const response = new Response(body, {
    status: upstream.status,
    headers: { ...upstream.headers },
  });
  observeProviderNativeTerminalResponse(
    journey,
    response,
    upstream.status >= 400 ? "failed" : "success",
  );
  return response;
}

function dependenciesConfiguration(
  options: OpenAIResponsesHandlerOptions,
): OpenAIResponsesConfiguration {
  return options.configuration === undefined
    ? parseOpenAIResponsesConfiguration()
    : bindOpenAIResponsesConfiguration(options.configuration);
}

export function createOpenAIResponsesHandler(
  options: OpenAIResponsesHandlerOptions,
): ClientProtocolHandler {
  const configuration = dependenciesConfiguration(options);
  const sessionState =
    options.sessionState ??
    createResponseSessionState({
      stateFile: options.stateFile,
      ...(options.now === undefined ? {} : { now: options.now }),
      storeFalsePolicy: configuration.conversion.response.storeFalse,
    });
  const dependencies: OpenAIResponsesDependencies = Object.freeze({
    models: options.models,
    directLane: options.directLane,
    providerNativeLane: options.providerNativeLane,
    createSessionId: options.createSessionId ?? randomUUID,
    configuration,
    sessionState,
    publicModels: options.publicModels,
    maxRequestBytes: options.maxRequestBytes,
    routerDefaults: Object.freeze({ ...(options.routerDefaults ?? {}) }),
    createResponseId: options.createResponseId ?? (() => `resp_${randomUUID()}`),
    now: options.now ?? Date.now,
    executeOperation: options.executeOperation ?? execute,
  });
  return Object.freeze({
    method: "POST",
    pathname: "/v1/responses",
    handle: (request: Request, context?: ClientProtocolRequestContext) =>
      handleOpenAIResponses(
        dependencies,
        request,
        context?.requestId ?? randomUUID(),
        context?.journey,
      ),
  });
}
