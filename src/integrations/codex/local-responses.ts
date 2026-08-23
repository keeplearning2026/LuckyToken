import { createHash } from "node:crypto";

import type { LocalResponsesLane } from "../../protocols/openai-responses/handler.js";
import type {
  CodexFetchFunction,
  CodexLocalCredentialAuthority,
  CodexNativeModelSource,
  CodexForwardAuth,
} from "../../codex-native-seam.js";
import {
  CodexResponsesPassthroughBodyReadError,
  CodexResponsesPassthroughTransportError,
  passthroughCodexResponses,
} from "../../codex-responses-passthrough.js";
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

export interface CreateCodexLocalResponsesLaneOptions {
  readonly credentials: CodexLocalCredentialAuthority;
  readonly models: CodexNativeModelSource;
  readonly fetch: CodexFetchFunction;
}

const LOCAL_PROFILE_DOMAIN = "luckytoken:codex-local-account:v1:";

function localProfile(accountId: string): {
  readonly profileId: string;
  readonly displayName: string;
} {
  const digest = createHash("sha256")
    .update(`${LOCAL_PROFILE_DOMAIN}${accountId}`)
    .digest("hex");
  const suffix = accountId.length > 6 ? accountId.slice(-6) : digest.slice(-6);
  return Object.freeze({
    profileId: `codex-local:${digest}`,
    displayName: `Codex …${suffix}`,
  });
}

function toResponse(prepared: PreparedHttpResponse): Response {
  return new Response(prepared.body, {
    status: prepared.status,
    headers: { "content-type": prepared.contentType },
  });
}

function observeCodexLocalJourney(
  journey: RequestJourneyObserver | undefined,
  observation: RequestJourneyObservationInput,
): void {
  try {
    journey?.observe(observation);
  } catch {
    // Local lane behavior is authoritative over observation failure.
  }
}

function enterCodexLocalStep(
  journey: RequestJourneyObserver | undefined,
  stepInstanceId: string,
  location: RequestJourneyLocation,
): void {
  observeCodexLocalJourney(journey, {
    kind: "step_entered",
    stepInstanceId,
    location,
  });
}

function completeCodexLocalStep(
  journey: RequestJourneyObserver | undefined,
  stepInstanceId: string,
  location: RequestJourneyLocation,
  completion: "success" | "failed",
): void {
  observeCodexLocalJourney(journey, {
    kind: "step_completed",
    stepInstanceId,
    completion,
    location,
  });
}

function observeCodexLocalTerminal(
  journey: RequestJourneyObserver | undefined,
  response: Response,
  outcome: "success" | "failed",
  presentationStep: "prepare_local_response" | "render_local_error_response",
): void {
  observeCodexLocalJourney(journey, {
    kind: "client_response_prepared",
    status: response.status,
    ...(response.headers.get("content-type") === null
      ? {}
      : { mediaType: response.headers.get("content-type")! }),
    location: {
      phase: "client_response_preparation",
      lane: "local_native",
      step: presentationStep,
    },
  });
  observeCodexLocalJourney(journey, {
    kind: "work_outcome_committed",
    outcome,
    terminalAuthority: "codex_local_responses_lane",
    location: {
      phase: "outcome_commit",
      lane: "local_native",
      step: "commit_request_outcome",
    },
  });
}

async function executeWithAuth(
  input: Parameters<LocalResponsesLane["execute"]>[0],
  forwardAuth: CodexForwardAuth,
  profileId: string | undefined,
  fetch: CodexFetchFunction,
): Promise<Response> {
  try {
    const upstream = await passthroughCodexResponses({
      rawBody: input.rawBody,
      requestHeaders: input.request.headers,
      forwardAuth,
      signal: input.request.signal,
      fetch,
      ...(input.journey === undefined ? {} : { journey: input.journey }),
      ...(profileId === undefined ? {} : { profileId }),
    });
    input.request.signal.throwIfAborted();
    const usage = extractResponsesPassthroughUsage(
      upstream.body,
      upstream.headers["content-type"] ?? "",
      "openai-codex-responses",
      upstream.status >= 200 && upstream.status < 300 && input.streamRequested
        ? "event-stream"
        : "json",
    );
    if (usage !== undefined) {
      observeCodexLocalJourney(input.journey, {
        kind: "terminal_usage_observed",
        usage,
        location: {
          phase: "lane_response_processing",
          lane: "local_native",
          step: "observe_local_usage",
        },
      });
    }
    const responseLocation = {
      phase: "lane_response_processing",
      lane: "local_native",
      step: "preserve_local_response",
    } as const;
    enterCodexLocalStep(
      input.journey,
      "p5.preserve_local_response",
      responseLocation,
    );
    const response = new Response(upstream.body, {
      status: upstream.status,
      headers: { ...upstream.headers },
    });
    completeCodexLocalStep(
      input.journey,
      "p5.preserve_local_response",
      responseLocation,
      "success",
    );
    observeCodexLocalTerminal(
      input.journey,
      response,
      upstream.status >= 400 ? "failed" : "success",
      "prepare_local_response",
    );
    return response;
  } catch (error) {
    if (
      error instanceof CodexResponsesPassthroughTransportError ||
      error instanceof CodexResponsesPassthroughBodyReadError
    ) {
      const response = toResponse(
        renderResponsesError(
          502,
          "api_error",
          error instanceof CodexResponsesPassthroughTransportError
            ? "Upstream provider request failed"
            : "Upstream provider response could not be read",
        ),
      );
      observeCodexLocalTerminal(
        input.journey,
        response,
        "failed",
        "render_local_error_response",
      );
      return response;
    }
    throw error;
  }
}

export function createCodexLocalResponsesLane(
  options: CreateCodexLocalResponsesLaneOptions,
): LocalResponsesLane {
  return Object.freeze({
    claims(selector: string): boolean {
      return options.models.has(selector);
    },
    async execute(
      input: Parameters<LocalResponsesLane["execute"]>[0],
    ): Promise<Response> {
      observeCodexLocalJourney(input.journey, {
        kind: "model_resolved",
        providerId: "codex-local",
        modelId: input.selector,
        location: {
          phase: "request_resolution",
          lane: "local_native",
          step: "recognize_local_model",
        },
      });
      const credentialLocation = {
        phase: "lane_request_preparation",
        lane: "local_native",
        step: "resolve_local_credential",
      } as const;
      enterCodexLocalStep(
        input.journey,
        "p3.resolve_local_credential",
        credentialLocation,
      );
      const forwardAuth = await options.credentials.resolveForwardAuth(
        input.request.headers,
      );
      if (forwardAuth === undefined) {
        completeCodexLocalStep(
          input.journey,
          "p3.resolve_local_credential",
          credentialLocation,
          "failed",
        );
        const response = toResponse(
          renderResponsesError(
            401,
            "authentication_error",
            "Local Codex credential is unavailable",
          ),
        );
        observeCodexLocalTerminal(
          input.journey,
          response,
          "failed",
          "render_local_error_response",
        );
        return response;
      }
      completeCodexLocalStep(
        input.journey,
        "p3.resolve_local_credential",
        credentialLocation,
        "success",
      );
      let profileId: string | undefined;
      if (forwardAuth.accountId !== undefined) {
        const profile = localProfile(forwardAuth.accountId);
        profileId = profile.profileId;
        observeCodexLocalJourney(input.journey, {
          kind: "profile_attributed",
          ...profile,
          location: credentialLocation,
        });
      }
      return executeWithAuth(input, forwardAuth, profileId, options.fetch);
    },
  });
}
