import type { Models } from "@earendil-works/pi-ai";

/**
 * OpenAI-style model discovery list for the Responses protocol.
 *
 * `GET /v1/models` exposes every model in the Pi collection as a
 * `provider/model_id` selector, matching the selector contract owned by
 * `model-resolution.ts`: a client can take any listed `id` and send it as
 * the `model` field of a `/v1/responses` request.
 */
export interface ResponsesModelsListEntry {
  readonly id: string;
  readonly object: "model";
  readonly created: number;
  readonly owned_by: string;
}

export interface ResponsesModelsList {
  readonly object: "list";
  readonly data: readonly ResponsesModelsListEntry[];
}

export function renderResponsesModelsList(
  models: Pick<Models, "getModels">,
  created: number,
  filterProviders?: ReadonlySet<string>,
): ResponsesModelsList {
  const data = models
    .getModels()
    .filter(
      (model) =>
        filterProviders === undefined || filterProviders.has(model.provider),
    )
    .map((model) => ({
      id: `${model.provider}/${model.id}`,
      object: "model" as const,
      created,
      owned_by: model.provider,
    }));
  return Object.freeze({
    object: "list" as const,
    data: Object.freeze(data),
  });
}
