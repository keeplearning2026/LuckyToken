import type {
  CodexFetchFunction,
  CodexNativeModelSource,
} from "../../codex-native-seam.js";
import {
  CodexResponsesPassthroughBodyReadError,
  CodexResponsesPassthroughTransportError,
  passthroughCodexResponsesCompact,
} from "../../codex-responses-passthrough.js";
import type { DirectResponsesCompactLane } from "../../protocols/openai-responses/compact-contract.js";
import type {
  RequestJourneyLocation,
  RequestJourneyObservationInput,
  RequestJourneyObserver,
} from "../../diagnostics/contract.js";
import {
  renderResponsesError,
  type PreparedHttpResponse,
} from "../../protocols/openai-responses/response.js";
import { preserveDirectStatusText } from "../../local-native-http-response.js";

export interface CreateCodexDirectCompactLaneOptions {
  readonly models: CodexNativeModelSource;
  readonly fetch: CodexFetchFunction;
}

function toResponse(prepared: PreparedHttpResponse): Response {
  return new Response(prepared.body, {
    status: prepared.status,
    headers: { "content-type": prepared.contentType },
  });
}

function errorResponse(status: number, type: string, message: string): Response {
  return toResponse(renderResponsesError(status, type, message));
}

function observeLocalCompact(
  journey: RequestJourneyObserver | undefined,
  observation: RequestJourneyObservationInput,
): void {
  try {
    journey?.observe(observation);
  } catch {
    // Compact execution remains authoritative over diagnostics.
  }
}

function enterLocalCompactStep(
  journey: RequestJourneyObserver | undefined,
  stepInstanceId: string,
  location: RequestJourneyLocation,
): void {
  observeLocalCompact(journey, { kind: "step_entered", stepInstanceId, location });
}

function completeLocalCompactStep(
  journey: RequestJourneyObserver | undefined,
  stepInstanceId: string,
  location: RequestJourneyLocation,
  completion: "success" | "failed",
): void {
  observeLocalCompact(journey, {
    kind: "step_completed",
    stepInstanceId,
    completion,
    location,
  });
}

function observeLocalCompactTerminal(
  journey: RequestJourneyObserver | undefined,
  response: Response,
  outcome: "success" | "failed",
): void {
  const presentationLocation = {
    phase: "client_response_preparation",
    lane: "direct",
    step: outcome === "success" ? "prepare_direct_response" : "render_direct_error_response",
  } as const;
  const presentationStep =
    outcome === "success" ? "p6.prepare_direct_response" : "p6.render_direct_error_response";
  enterLocalCompactStep(journey, presentationStep, presentationLocation);
  observeLocalCompact(journey, {
    kind: "client_response_prepared",
    status: response.status,
    ...(response.headers.get("content-type") === null
      ? {}
      : { mediaType: response.headers.get("content-type")! }),
    location: presentationLocation,
  });
  completeLocalCompactStep(journey, presentationStep, presentationLocation, "success");
  const outcomeLocation = {
    phase: "outcome_commit",
    lane: "direct",
    step: "commit_request_outcome",
  } as const;
  enterLocalCompactStep(journey, "p7.commit_request_outcome", outcomeLocation);
  observeLocalCompact(journey, {
    kind: "work_outcome_committed",
    outcome,
    terminalAuthority: "codex_direct_compact_lane",
    location: outcomeLocation,
  });
  completeLocalCompactStep(journey, "p7.commit_request_outcome", outcomeLocation, "success");
}

export function createCodexDirectCompactLane(
  options: CreateCodexDirectCompactLaneOptions,
): DirectResponsesCompactLane {
  return Object.freeze({
    claims(selector: string): boolean {
      return options.models.has(selector);
    },
    async execute(
      input: Parameters<DirectResponsesCompactLane["execute"]>[0],
    ): Promise<Response> {
      observeLocalCompact(input.journey, {
        kind: "model_resolved",
        providerId: "codex-local",
        modelId: input.selector,
        location: {
          phase: "request_resolution",
          lane: "direct",
          step: "recognize_local_model",
        },
      });
      const envelopeLocation = {
        phase: "lane_request_preparation",
        lane: "direct",
        step: "preserve_caller_envelope",
      } as const;
      enterLocalCompactStep(
        input.journey,
        "p3.preserve_caller_envelope",
        envelopeLocation,
      );
      completeLocalCompactStep(
        input.journey,
        "p3.preserve_caller_envelope",
        envelopeLocation,
        "success",
      );
      try {
        const upstream = await passthroughCodexResponsesCompact({
          rawBody: input.rawBody,
          requestUrl: input.request.url,
          requestHeaders: input.request.headers,
          signal: input.request.signal,
          fetch: options.fetch,
          ...(input.journey === undefined ? {} : { journey: input.journey }),
        });
        const preserveLocation = {
          phase: "lane_response_processing",
          lane: "direct",
          step: "preserve_direct_response",
        } as const;
        enterLocalCompactStep(
          input.journey,
          "p5.preserve_direct_response",
          preserveLocation,
        );
        const response = new Response(upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: upstream.headers,
        });
        completeLocalCompactStep(
          input.journey,
          "p5.preserve_direct_response",
          preserveLocation,
          "success",
        );
        observeLocalCompactTerminal(
          input.journey,
          response,
          response.status >= 400 ? "failed" : "success",
        );
        return preserveDirectStatusText(response);
      } catch (error) {
        if (input.request.signal.aborted) throw error;
        if (
          error instanceof CodexResponsesPassthroughTransportError ||
          error instanceof CodexResponsesPassthroughBodyReadError
        ) {
          const response = errorResponse(
            502,
            "api_error",
            "Upstream compact request failed",
          );
          observeLocalCompactTerminal(input.journey, response, "failed");
          return response;
        }
        throw error;
      }
    },
  });
}
