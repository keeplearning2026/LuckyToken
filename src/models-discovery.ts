import type { Models } from "@earendil-works/pi-ai";

import type { RequestJourneyObservationInput } from "./diagnostics/contract.js";
import type { PublicModelSource } from "./public-model-seam.js";
import {
  observeRequestJourney,
  type ClientProtocolHandler,
  type ClientProtocolRequestContext,
} from "./http.js";
import { renderResponsesModelsList } from "./protocols/openai-responses/models.js";

export interface ModelsDiscoveryHandlerOptions {
  readonly models: Models;
  /** External Provider Package IDs; Pi builtins and models.json stay hidden. */
  readonly providerIds?: readonly string[];
  /** Runtime publication authority. When wired, this is the only source of
   * selectors rendered by /v1/models. */
  readonly publicModels?: PublicModelSource;
  readonly now?: () => number;
}

function observeDiscovery(
  context: ClientProtocolRequestContext | undefined,
  input: RequestJourneyObservationInput,
): void {
  if (context !== undefined) observeRequestJourney(context, input);
}

function renderProjectionFailure(
  context: ClientProtocolRequestContext | undefined,
): Response {
  const primaryLocation = {
    phase: "client_response_preparation",
    step: "project_model_list",
  } as const;
  const failureId = "p6.project_model_list.failed";
  observeDiscovery(context, {
    kind: "step_completed",
    stepInstanceId: "p6.project_model_list",
    completion: "failed",
    operation: "model_discovery",
    protocol: "openai-responses",
    location: primaryLocation,
  });
  observeDiscovery(context, {
    kind: "failure_detected",
    failureId,
    role: "primary",
    classification: "model_list_projection_failed",
    origin: "luckytoken",
    originPrecision: "exact",
    location: primaryLocation,
  });
  const presentationLocation = {
    phase: "client_response_preparation",
    step: "render_client_error",
  } as const;
  observeDiscovery(context, {
    kind: "step_entered",
    stepInstanceId: "p6.render_client_error",
    location: presentationLocation,
  });
  const response = new Response(null, { status: 500 });
  observeDiscovery(context, {
    kind: "client_response_prepared",
    status: response.status,
    location: presentationLocation,
  });
  observeDiscovery(context, {
    kind: "step_completed",
    stepInstanceId: "p6.render_client_error",
    completion: "success",
    operation: "model_discovery",
    protocol: "openai-responses",
    location: presentationLocation,
  });
  const outcomeLocation = {
    phase: "outcome_commit",
    step: "commit_request_outcome",
  } as const;
  observeDiscovery(context, {
    kind: "step_entered",
    stepInstanceId: "p7.commit_request_outcome",
    location: outcomeLocation,
  });
  observeDiscovery(context, {
    kind: "work_outcome_committed",
    outcome: "failed",
    terminalAuthority: "model_discovery_handler",
    location: outcomeLocation,
  });
  observeDiscovery(context, {
    kind: "step_completed",
    stepInstanceId: "p7.commit_request_outcome",
    completion: "success",
    operation: "model_discovery",
    protocol: "openai-responses",
    location: outcomeLocation,
  });
  return response;
}

function renderDiscoverySuccess(
  context: ClientProtocolRequestContext | undefined,
  list: unknown,
): Response {
  const encodeLocation = {
    phase: "client_response_preparation",
    step: "encode_model_list",
  } as const;
  observeDiscovery(context, {
    kind: "step_entered",
    stepInstanceId: "p6.encode_model_list",
    location: encodeLocation,
  });
  const response = new Response(JSON.stringify(list), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  observeDiscovery(context, {
    kind: "client_response_prepared",
    status: response.status,
    mediaType: "application/json",
    location: encodeLocation,
  });
  observeDiscovery(context, {
    kind: "step_completed",
    stepInstanceId: "p6.encode_model_list",
    completion: "success",
    operation: "model_discovery",
    protocol: "openai-responses",
    location: encodeLocation,
  });

  const outcomeLocation = {
    phase: "outcome_commit",
    step: "commit_request_outcome",
  } as const;
  observeDiscovery(context, {
    kind: "step_entered",
    stepInstanceId: "p7.commit_request_outcome",
    location: outcomeLocation,
  });
  observeDiscovery(context, {
    kind: "work_outcome_committed",
    outcome: "success",
    terminalAuthority: "model_discovery_handler",
    location: outcomeLocation,
  });
  observeDiscovery(context, {
    kind: "step_completed",
    stepInstanceId: "p7.commit_request_outcome",
    completion: "success",
    operation: "model_discovery",
    protocol: "openai-responses",
    location: outcomeLocation,
  });
  return response;
}

/**
 * Shared model discovery: `GET /v1/models`.
 *
 * This endpoint is deliberately NOT bound to any Client Protocol's Auth: it
 * is a cross-protocol metadata surface that any client may query to learn
 * what selectors the local endpoint serves. The wire format is the OpenAI
 * Responses list shape (`{object:"list", data:[{id, object:"model", ...}]}`),
 * owned by the Responses models renderer.
 */
export function createModelsDiscoveryHandler(
  options: ModelsDiscoveryHandlerOptions,
): ClientProtocolHandler {
  const now = options.now ?? Date.now;
  return Object.freeze({
    method: "GET",
    pathname: "/v1/models",
    handle: async (
      request: Request,
      context?: ClientProtocolRequestContext,
    ): Promise<Response> => {
      request.signal.throwIfAborted();
      const created = Math.floor(now() / 1000);
      if (options.publicModels !== undefined) {
        const readLocation = {
          phase: "client_response_preparation",
          step: "read_publication_snapshot",
        } as const;
        observeDiscovery(context, {
          kind: "step_entered",
          stepInstanceId: "p6.read_publication_snapshot",
          location: readLocation,
        });
        const snapshot = await options.publicModels.requestSnapshot();
        observeDiscovery(context, {
          kind: "step_completed",
          stepInstanceId: "p6.read_publication_snapshot",
          completion: "success",
          operation: "model_discovery",
          protocol: "openai-responses",
          location: readLocation,
        });
        const projectionLocation = {
          phase: "client_response_preparation",
          step: "project_model_list",
        } as const;
        observeDiscovery(context, {
          kind: "step_entered",
          stepInstanceId: "p6.project_model_list",
          location: projectionLocation,
        });
        let data: ReadonlyArray<{
          readonly id: string;
          readonly object: "model";
          readonly created: number;
          readonly owned_by: string;
        }>;
        try {
          data = snapshot.publishedModels().map((entry) => ({
            id: entry.alias,
            object: "model" as const,
            created,
            owned_by: entry.providerId,
          }));
        } catch {
          return renderProjectionFailure(context);
        }
        observeDiscovery(context, {
          kind: "step_completed",
          stepInstanceId: "p6.project_model_list",
          completion: "success",
          operation: "model_discovery",
          protocol: "openai-responses",
          location: projectionLocation,
        });
        return renderDiscoverySuccess(
          context,
          Object.freeze({
            object: "list" as const,
            data: Object.freeze(data),
          }),
        );
      }
      const list = renderResponsesModelsList(
        options.models,
        created,
        new Set(options.providerIds ?? []),
      );
      return renderDiscoverySuccess(context, list);
    },
  });
}
