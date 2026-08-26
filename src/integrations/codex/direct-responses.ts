import type { DirectResponsesLane } from "../../protocols/openai-responses/handler.js";
import type {
  CodexDirectFetch,
  CodexDirectModelSource,
} from "../../codex-direct-seam.js";
import {
  CodexDirectResponsesBodyReadError,
  CodexDirectResponsesTransportError,
  executeCodexDirectResponses,
} from "../../codex-direct-responses-transport.js";
import { extractResponsesPassthroughUsage } from "../../protocols/openai-responses/passthrough-usage.js";
import {
  renderResponsesError,
  type PreparedHttpResponse,
} from "../../protocols/openai-responses/response.js";
import type {
  RequestJourneyLocation,
  RequestJourneyObservationInput,
  RequestJourneyObserver,
} from "../../diagnostics/contract.js";
import {
  preserveDirectResponse,
  preserveDirectStatusText,
} from "../../direct-http-response.js";

export interface CreateCodexDirectResponsesLaneOptions {
  readonly models: CodexDirectModelSource;
  readonly fetch: CodexDirectFetch;
}

function toResponse(prepared: PreparedHttpResponse): Response {
  return new Response(prepared.body, {
    status: prepared.status,
    headers: { "content-type": prepared.contentType },
  });
}

function observeCodexDirectJourney(
  journey: RequestJourneyObserver | undefined,
  observation: RequestJourneyObservationInput,
): void {
  try {
    journey?.observe(observation);
  } catch {
    // Direct Mode behavior is authoritative over observation failure.
  }
}

function enterCodexDirectStep(
  journey: RequestJourneyObserver | undefined,
  stepInstanceId: string,
  location: RequestJourneyLocation,
): void {
  observeCodexDirectJourney(journey, {
    kind: "step_entered",
    stepInstanceId,
    location,
  });
}

function completeCodexDirectStep(
  journey: RequestJourneyObserver | undefined,
  stepInstanceId: string,
  location: RequestJourneyLocation,
  completion: "success" | "failed",
): void {
  observeCodexDirectJourney(journey, {
    kind: "step_completed",
    stepInstanceId,
    completion,
    location,
  });
}

function observeCodexDirectTerminal(
  journey: RequestJourneyObserver | undefined,
  response: Response,
  outcome: "success" | "failed",
  presentationStep: "prepare_direct_response" | "render_direct_error_response",
): void {
  observeCodexDirectJourney(journey, {
    kind: "client_response_prepared",
    status: response.status,
    ...(response.headers.get("content-type") === null
      ? {}
      : { mediaType: response.headers.get("content-type")! }),
    location: {
      phase: "client_response_preparation",
      lane: "direct",
      step: presentationStep,
    },
  });
  observeCodexDirectJourney(journey, {
    kind: "work_outcome_committed",
    outcome,
    terminalAuthority: "codex_direct_responses_lane",
    location: {
      phase: "outcome_commit",
      lane: "direct",
      step: "commit_request_outcome",
    },
  });
}

async function executeDirect(
  input: Parameters<DirectResponsesLane["execute"]>[0],
  fetch: CodexDirectFetch,
): Promise<Response> {
  try {
    const upstream = await executeCodexDirectResponses({
      rawBody: input.rawBody,
      requestUrl: input.request.url,
      requestHeaders: input.request.headers,
      signal: input.request.signal,
      fetch,
      ...(input.journey === undefined ? {} : { journey: input.journey }),
    });
    input.request.signal.throwIfAborted();
    const usage = extractResponsesPassthroughUsage(
      upstream.body,
      upstream.headers.get("content-type") ?? "",
      upstream.status >= 200 && upstream.status < 300 && input.streamRequested
        ? "event-stream"
        : "json",
    );
    if (usage !== undefined) {
      observeCodexDirectJourney(input.journey, {
        kind: "terminal_usage_observed",
        usage,
        location: {
          phase: "lane_response_processing",
          lane: "direct",
          step: "observe_direct_usage",
        },
      });
    }
    const responseLocation = {
      phase: "lane_response_processing",
      lane: "direct",
      step: "preserve_direct_response",
    } as const;
    enterCodexDirectStep(
      input.journey,
      "p5.preserve_direct_response",
      responseLocation,
    );
    const response = new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
    completeCodexDirectStep(
      input.journey,
      "p5.preserve_direct_response",
      responseLocation,
      "success",
    );
    observeCodexDirectTerminal(
      input.journey,
      response,
      upstream.status >= 400 ? "failed" : "success",
      "prepare_direct_response",
    );
    return preserveDirectStatusText(response);
  } catch (error) {
    if (
      error instanceof CodexDirectResponsesTransportError ||
      error instanceof CodexDirectResponsesBodyReadError
    ) {
      const response = toResponse(
        renderResponsesError(
          502,
          "api_error",
          error instanceof CodexDirectResponsesTransportError
            ? "Upstream provider request failed"
            : "Upstream provider response could not be read",
        ),
      );
      observeCodexDirectTerminal(
        input.journey,
        response,
        "failed",
        "render_direct_error_response",
      );
      return preserveDirectResponse(response);
    }
    throw error;
  }
}

export function createCodexDirectResponsesLane(
  options: CreateCodexDirectResponsesLaneOptions,
): DirectResponsesLane {
  return Object.freeze({
    claims(selector: string): boolean {
      return options.models.has(selector);
    },
    async execute(
      input: Parameters<DirectResponsesLane["execute"]>[0],
    ): Promise<Response> {
      observeCodexDirectJourney(input.journey, {
        kind: "model_resolved",
        requestedModel: input.selector,
        providerId: "codex-direct",
        modelId: input.selector,
        location: {
          phase: "request_resolution",
          lane: "direct",
          step: "recognize_direct_model",
        },
      });
      const envelopeLocation = {
        phase: "lane_request_preparation",
        lane: "direct",
        step: "preserve_caller_envelope",
      } as const;
      enterCodexDirectStep(
        input.journey,
        "p3.preserve_caller_envelope",
        envelopeLocation,
      );
      completeCodexDirectStep(
        input.journey,
        "p3.preserve_caller_envelope",
        envelopeLocation,
        "success",
      );
      return executeDirect(input, options.fetch);
    },
  });
}
