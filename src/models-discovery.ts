import type { Models } from "@earendil-works/pi-ai";

import type { PublicModelSource } from "./public-model-seam.js";
import type { ClientProtocolHandler } from "./http.js";
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
    handle: async (request: Request): Promise<Response> => {
      request.signal.throwIfAborted();
      const created = Math.floor(now() / 1000);
      if (options.publicModels !== undefined) {
        const snapshot = await options.publicModels.requestSnapshot();
        const data = snapshot.publishedModels().map((entry) => ({
          id: entry.alias,
          object: "model" as const,
          created,
          owned_by: entry.providerId,
        }));
        return new Response(
          JSON.stringify(
            Object.freeze({
              object: "list" as const,
              data: Object.freeze(data),
            }),
          ),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      const list = renderResponsesModelsList(
        options.models,
        created,
        new Set(options.providerIds ?? []),
      );
      return new Response(JSON.stringify(list), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
}
