import type { Models } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";

import type {
  RequestJourneyLocation,
  RequestJourneyObservationInput,
  RequestJourneyObserver,
} from "../../diagnostics/contract.js";
import {
  resolveDataPlanePublicModel,
  type PublicModelSource,
} from "../../public-model-seam.js";
import type {
  ClientProtocolHandler,
  ClientProtocolRequestContext,
} from "../../http.js";
import type {
  ProviderResponsesLane,
  ProviderResponsesObservationContext,
} from "../../provider-native-responses/contract.js";
import { resolveRequestIdentity } from "../../request-identity.js";
import type { DirectResponsesCompactLane } from "./compact-contract.js";
import {
  bindOpenAIResponsesConfiguration,
  parseOpenAIResponsesConfiguration,
  type OpenAIResponsesConfiguration,
} from "./configuration.js";
import {
  readResponsesRequestBody,
  ResponsesRequestBodyTooLargeError,
  UnsupportedResponsesContentEncodingError,
} from "./request-body.js";
import {
  renderResponsesError,
  type PreparedHttpResponse,
} from "./response.js";
import {
  bufferNativeResponsesResponse,
  projectNativeResponsesBody,
  ResponsesNativeBodyReadError,
} from "./native-response.js";
import {
  createResponseSessionState,
  type ResponseSessionState,
} from "./session-state.js";
import { executeSemanticCompact } from "./compact-semantic.js";
import type { ExecutionOperation } from "../../execution.js";
import type { RouterOptionDefaults } from "../options.js";

export interface OpenAIResponsesCompactHandlerOptions {
  readonly models: Models;
  readonly publicModels?: PublicModelSource;
  readonly directLane?: DirectResponsesCompactLane;
  readonly providerNativeLane?: ProviderResponsesLane;
  readonly configuration?: OpenAIResponsesConfiguration;
  readonly stateFile: string;
  readonly sessionState?: ResponseSessionState;
  readonly createSessionId?: () => string;
  readonly createResponseId?: () => string;
  readonly executeOperation?: ExecutionOperation;
  readonly routerDefaults?: RouterOptionDefaults;
  readonly now?: () => number;
  readonly maxRequestBytes: number;
}

function toResponse(prepared: PreparedHttpResponse): Response {
  return new Response(prepared.body, {
    status: prepared.status,
    headers: { "content-type": prepared.contentType },
  });
}

function errorResponse(status: number, message: string): Response {
  return toResponse(renderResponsesError(status, "api_error", message));
}

function jsonError(status: number, message: string): Response {
  return toResponse(renderResponsesError(status, "invalid_request_error", message));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function observeCompactJourney(
  journey: RequestJourneyObserver | undefined,
  input: RequestJourneyObservationInput,
): void {
  try {
    journey?.observe(input);
  } catch {
    // Diagnostics cannot affect compact routing, execution, or response bytes.
  }
}

function observeCompactRequestArtifact(
  journey: RequestJourneyObserver | undefined,
  request: Request,
  bytes: Uint8Array<ArrayBuffer>,
  location: RequestJourneyLocation,
): void {
  const capturedBytes = Math.min(bytes.byteLength, 256 * 1_024);
  observeCompactJourney(journey, {
    kind: "artifact_observed",
    artifactId: "client_request_wire",
    artifactKind: "client_request_wire",
    state: capturedBytes < bytes.byteLength ? "partial" : "captured",
    ...(request.headers.get("content-type") === null
      ? {}
      : { mediaType: request.headers.get("content-type")! }),
    bytes: bytes.subarray(0, capturedBytes),
    originalBytes: bytes.byteLength,
    capturedBytes,
    truncated: capturedBytes < bytes.byteLength,
    location,
  });
}

function enterCompactStep(
  journey: RequestJourneyObserver | undefined,
  stepInstanceId: string,
  location: RequestJourneyLocation,
): void {
  observeCompactJourney(journey, {
    kind: "step_entered",
    stepInstanceId,
    location,
  });
}

function completeCompactStep(
  journey: RequestJourneyObserver | undefined,
  stepInstanceId: string,
  location: RequestJourneyLocation,
  completion: "success" | "failed" | "aborted" = "success",
  identifyOperation = false,
): void {
  observeCompactJourney(journey, {
    kind: "step_completed",
    stepInstanceId,
    completion,
    ...(identifyOperation
      ? {
          operation: "conversation_compaction" as const,
          protocol: "openai-responses",
        }
      : {}),
    location,
  });
}

function observeProviderCompactTerminal(
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
  enterCompactStep(journey, presentationStep, presentationLocation);
  observeCompactJourney(journey, {
    kind: "client_response_prepared",
    status: response.status,
    ...(response.headers.get("content-type") === null
      ? {}
      : { mediaType: response.headers.get("content-type")! }),
    location: presentationLocation,
  });
  completeCompactStep(
    journey,
    presentationStep,
    presentationLocation,
    "success",
    true,
  );

  const outcomeLocation = {
    phase: "outcome_commit",
    lane: "provider_native",
    step: "commit_request_outcome",
  } as const;
  enterCompactStep(journey, "p7.commit_request_outcome", outcomeLocation);
  observeCompactJourney(journey, {
    kind: "work_outcome_committed",
    outcome,
    terminalAuthority: "openai_responses_provider_native_lane",
    location: outcomeLocation,
  });
  completeCompactStep(
    journey,
    "p7.commit_request_outcome",
    outcomeLocation,
    "success",
    true,
  );
}

function preserveProviderCompactResponse(
  journey: RequestJourneyObserver | undefined,
  input: Readonly<{
    body: Uint8Array<ArrayBuffer>;
    status: number;
    headers: Readonly<Record<string, string>>;
    attempt: number;
  }>,
): Response {
  const location = {
    phase: "lane_response_processing",
    lane: "provider_native",
    step: "preserve_provider_native_response",
    attempt: input.attempt,
  } as const;
  const step = `p5.preserve_provider_native_response.${input.attempt}`;
  enterCompactStep(journey, step, location);
  const capturedBytes = Math.min(input.body.byteLength, 256 * 1_024);
  observeCompactJourney(journey, {
    kind: "artifact_observed",
    artifactId: "provider_native_preserved_response_wire",
    artifactKind: "provider_native_preserved_response_wire",
    state: capturedBytes < input.body.byteLength ? "partial" : "captured",
    ...(input.headers["content-type"] === undefined
      ? {}
      : { mediaType: input.headers["content-type"] }),
    bytes: input.body.subarray(0, capturedBytes),
    originalBytes: input.body.byteLength,
    capturedBytes,
    truncated: capturedBytes < input.body.byteLength,
    location,
  });
  const response = new Response(input.body, {
    status: input.status,
    headers: { ...input.headers },
  });
  completeCompactStep(journey, step, location);
  return response;
}

async function providerCompact(
  lane: ProviderResponsesLane,
  request: Request,
  rawBody: string,
  model: Parameters<ProviderResponsesLane["claims"]>[0],
  alias: string | undefined,
  journey: RequestJourneyObserver | undefined,
): Promise<Response> {
  let finalAttempt = 1;
  const observation: ProviderResponsesObservationContext | undefined =
    journey === undefined
      ? undefined
      : {
          requestId: journey.requestId,
          journey,
          finalResponseAttempt(attempt: number): void {
            if (Number.isSafeInteger(attempt) && attempt > 0) {
              finalAttempt = attempt;
            }
          },
        };
  let response: Response;
  try {
    response = await lane.execute({
      model,
      rawBody,
      signal: request.signal,
      operation: "compact",
      ...(observation === undefined ? {} : { observation }),
    });
  } catch (error) {
    if (request.signal.aborted) throw error;
    const failureResponse = errorResponse(502, "Upstream compact request failed");
    observeProviderCompactTerminal(journey, failureResponse, "failed");
    return failureResponse;
  }

  const bufferLocation = {
    phase: "lane_response_processing",
    lane: "provider_native",
    step: "buffer_provider_native_response",
    attempt: finalAttempt,
  } as const;
  const bufferStep = `p5.buffer_provider_native_response.${finalAttempt}`;
  enterCompactStep(journey, bufferStep, bufferLocation);
  let upstream: Awaited<ReturnType<typeof bufferNativeResponsesResponse>>;
  try {
    upstream = await bufferNativeResponsesResponse(response, request.signal);
    completeCompactStep(journey, bufferStep, bufferLocation);
  } catch (error) {
    completeCompactStep(
      journey,
      bufferStep,
      bufferLocation,
      request.signal.aborted ? "aborted" : "failed",
    );
    if (request.signal.aborted) throw error;
    const failureResponse = errorResponse(
      502,
      error instanceof ResponsesNativeBodyReadError
        ? "Upstream compact response could not be read"
        : "Upstream compact request failed",
    );
    observeProviderCompactTerminal(journey, failureResponse, "failed");
    return failureResponse;
  }
  if (upstream.status >= 400 && alias !== undefined) {
    const failureResponse = errorResponse(502, "Upstream provider failed");
    observeProviderCompactTerminal(journey, failureResponse, "failed");
    return failureResponse;
  }
  if (alias === undefined || upstream.status >= 400) {
    const preserved = preserveProviderCompactResponse(journey, {
      body: upstream.body,
      status: upstream.status,
      headers: upstream.headers,
      attempt: finalAttempt,
    });
    observeProviderCompactTerminal(
      journey,
      preserved,
      preserved.status >= 400 ? "failed" : "success",
    );
    return preserved;
  }
  const contentType = upstream.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().includes("json")) {
    const preserved = preserveProviderCompactResponse(journey, {
      body: upstream.body,
      status: upstream.status,
      headers: upstream.headers,
      attempt: finalAttempt,
    });
    observeProviderCompactTerminal(journey, preserved, "success");
    return preserved;
  }
  const projectionLocation = {
    phase: "lane_response_processing",
    lane: "provider_native",
    step: "project_native_alias",
    attempt: finalAttempt,
  } as const;
  const projectionStep = `p5.project_native_alias.${finalAttempt}`;
  enterCompactStep(journey, projectionStep, projectionLocation);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(upstream.body)) as unknown;
  } catch {
    completeCompactStep(
      journey,
      projectionStep,
      projectionLocation,
      "failed",
    );
    observeCompactJourney(journey, {
      kind: "failure_detected",
      failureId:
        `${journey?.requestId ?? "compact"}:provider_native_alias_projection_failed:${finalAttempt}`,
      role: "primary",
      classification: "provider_native_alias_projection_failed",
      origin: "luckytoken",
      originPrecision: "exact",
      location: projectionLocation,
    });
    const failureResponse = errorResponse(
      502,
      "Upstream response could not be projected safely",
    );
    observeProviderCompactTerminal(journey, failureResponse, "failed");
    return failureResponse;
  }
  let body = upstream.body;
  if (isRecord(parsed) && Object.hasOwn(parsed, "model")) {
    const projected = projectNativeResponsesBody(body, contentType, alias);
    if ("error" in projected) {
      completeCompactStep(
        journey,
        projectionStep,
        projectionLocation,
        "failed",
      );
      observeCompactJourney(journey, {
        kind: "failure_detected",
        failureId:
          `${journey?.requestId ?? "compact"}:provider_native_alias_projection_failed:${finalAttempt}`,
        role: "primary",
        classification: "provider_native_alias_projection_failed",
        origin: "luckytoken",
        originPrecision: "exact",
        location: projectionLocation,
      });
      const failureResponse = errorResponse(
        502,
        "Upstream response could not be projected safely",
      );
      observeProviderCompactTerminal(journey, failureResponse, "failed");
      return failureResponse;
    }
    body = projected.body;
  }
  completeCompactStep(journey, projectionStep, projectionLocation);
  const preserved = preserveProviderCompactResponse(journey, {
    body,
    status: upstream.status,
    headers: upstream.headers,
    attempt: finalAttempt,
  });
  observeProviderCompactTerminal(journey, preserved, "success");
  return preserved;
}

export function createOpenAIResponsesCompactHandler(
  options: OpenAIResponsesCompactHandlerOptions,
): ClientProtocolHandler {
  const configuration =
    options.configuration === undefined
      ? parseOpenAIResponsesConfiguration()
      : bindOpenAIResponsesConfiguration(options.configuration);
  const sessionState =
    options.sessionState ??
    createResponseSessionState({
      stateFile: options.stateFile,
      storeFalsePolicy: configuration.conversion.response.storeFalse,
    });
  const createSessionId = options.createSessionId ?? randomUUID;
  const createResponseId = options.createResponseId ?? (() => `resp_${randomUUID()}`);
  const now = options.now ?? Date.now;
  const routerDefaults = Object.freeze({ ...(options.routerDefaults ?? {}) });

  return Object.freeze({
    method: "POST",
    pathname: "/v1/responses/compact",
    async handle(
      request: Request,
      context?: ClientProtocolRequestContext,
    ): Promise<Response> {
      const journey = context?.journey;
      try {
        const mediaLocation = {
          phase: "protocol_ingress",
          step: "validate_media_and_encoding",
        } as const;
        enterCompactStep(journey, "p1.validate_media_and_encoding", mediaLocation);
        const contentType = request.headers.get("content-type")
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase();
        if (contentType !== "application/json") {
          completeCompactStep(
            journey,
            "p1.validate_media_and_encoding",
            mediaLocation,
            "failed",
            true,
          );
          return jsonError(415, "Content-Type must be application/json");
        }
        completeCompactStep(
          journey,
          "p1.validate_media_and_encoding",
          mediaLocation,
          "success",
          true,
        );
        const identityLocation = {
          phase: "protocol_ingress",
          step: "establish_request_identity",
        } as const;
        enterCompactStep(journey, "p1.establish_request_identity", identityLocation);
        const requestIdentity = resolveRequestIdentity(
          request.headers,
          createSessionId,
        );
        observeCompactJourney(journey, {
          kind: "request_identity_established",
          effectiveSessionId: requestIdentity.effectiveSessionId,
          ...(requestIdentity.clientSessionId === undefined
            ? {}
            : { clientSessionId: requestIdentity.clientSessionId }),
          location: identityLocation,
        });
        completeCompactStep(
          journey,
          "p1.establish_request_identity",
          identityLocation,
        );
        const bodyLocation = {
          phase: "protocol_ingress",
          step: "read_and_decode_body",
        } as const;
        enterCompactStep(journey, "p1.read_and_decode_body", bodyLocation);
        const decoded = await readResponsesRequestBody(request, options.maxRequestBytes);
        observeCompactRequestArtifact(journey, request, decoded.wireBytes, bodyLocation);
        completeCompactStep(
          journey,
          "p1.read_and_decode_body",
          bodyLocation,
        );
        if (!isRecord(decoded.json)) return jsonError(400, "Invalid compaction request body");
        const body = decoded.json;
        const selectorLocation = {
          phase: "request_resolution",
          step: "extract_model_selector",
        } as const;
        enterCompactStep(
          journey,
          "p2.extract_model_selector",
          selectorLocation,
        );
        if (typeof body.model !== "string" || body.model.length === 0) {
          completeCompactStep(
            journey,
            "p2.extract_model_selector",
            selectorLocation,
            "failed",
            true,
          );
          return jsonError(400, "Compaction request requires a model");
        }
        const selector = body.model;
        completeCompactStep(
          journey,
          "p2.extract_model_selector",
          selectorLocation,
          "success",
          true,
        );
        const localRecognitionLocation = {
          phase: "request_resolution",
          lane: "direct",
          step: "recognize_direct",
        } as const;
        enterCompactStep(
          journey,
          "p2.recognize_direct",
          localRecognitionLocation,
        );
        const directClaimed = options.directLane?.claims(selector) === true;
        completeCompactStep(
          journey,
          "p2.recognize_direct",
          localRecognitionLocation,
        );
        if (directClaimed) {
          observeCompactJourney(journey, {
            kind: "lane_committed",
            lane: "direct",
            location: {
              phase: "request_resolution",
              lane: "direct",
              step: "commit_lane",
            },
          });
          return options.directLane.execute({
            request,
            rawBody: decoded.wireBytes,
            selector,
            ...(journey === undefined ? {} : { journey }),
          });
        }

        const resolutionLocation = {
          phase: "request_resolution",
          step: "resolve_public_model",
        } as const;
        enterCompactStep(
          journey,
          "p2.resolve_public_model",
          resolutionLocation,
        );
        const resolution = await resolveDataPlanePublicModel(
          options.models,
          options.publicModels,
          selector,
        );
        if (resolution.kind === "unknown") {
          return jsonError(400, `Unknown model: ${selector}`);
        }
        if (resolution.kind === "unavailable") {
          return errorResponse(503, "The requested model is not currently available");
        }
        const model = resolution.model;
        observeCompactJourney(journey, {
          kind: "model_resolved",
          requestedModel: selector,
          providerId: model.provider,
          modelId: model.id,
          location: resolutionLocation,
        });
        completeCompactStep(
          journey,
          "p2.resolve_public_model",
          resolutionLocation,
        );
        const alias =
          options.publicModels === undefined ? undefined : resolution.alias;
        if (options.providerNativeLane !== undefined) {
          const providerRecognitionLocation = {
            phase: "request_resolution",
            lane: "provider_native",
            step: "recognize_provider_native",
          } as const;
          enterCompactStep(
            journey,
            "p2.recognize_provider_native",
            providerRecognitionLocation,
          );
          const providerNativeClaimed = options.providerNativeLane.claims(
            model,
            "compact",
          );
          completeCompactStep(
            journey,
            "p2.recognize_provider_native",
            providerRecognitionLocation,
          );
          if (providerNativeClaimed) {
            observeCompactJourney(journey, {
              kind: "lane_committed",
              lane: "provider_native",
              location: {
                phase: "request_resolution",
                lane: "provider_native",
                step: "commit_lane",
              },
            });
            return providerCompact(
              options.providerNativeLane,
              request,
              decoded.text,
              model,
              alias,
              journey,
            );
          }
        }

        observeCompactJourney(journey, {
          kind: "lane_committed",
          lane: "semantic_conversion",
          location: {
            phase: "request_resolution",
            lane: "semantic_conversion",
            step: "commit_lane",
          },
        });
        return executeSemanticCompact({
          request,
          body,
          model,
          models: options.models,
          configuration,
          sessionState,
          requestIdentity,
          createResponseId,
          ...(options.executeOperation === undefined
            ? {}
            : { executeOperation: options.executeOperation }),
          routerDefaults,
          now,
          ...(journey === undefined ? {} : { journey }),
        });
      } catch (error) {
        if (request.signal.aborted) throw error;
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
          return jsonError(415, "Unsupported Content-Encoding");
        }
        if (error instanceof SyntaxError) {
          return jsonError(400, "Request body is not valid JSON");
        }
        return errorResponse(500, "Internal server error");
      }
    },
  });
}
