import type { Models } from "@earendil-works/pi-ai";

import type { AliasModelSource } from "./alias-model-seam.js";
import { canonicalTargetKey } from "./aliases/domain.js";
import type { ClientProtocolHandler } from "./http.js";
import { renderResponsesModelsList } from "./protocols/openai-responses/models.js";

export interface ModelsDiscoveryHandlerOptions {
  readonly models: Models;
  /** External Provider Package IDs; Pi builtins and models.json stay hidden. */
  readonly providerIds: readonly string[];
  /**
   * Ticket 15 alias-only discovery: when wired, `GET /v1/models` lists only
   * currently callable mapped aliases (id = alias, owned_by = real
   * Provider). Canonical identity is never projected independently; an alias
   * may intentionally contain provider/model-shaped text. Without it the
   * legacy provider/model_id listing applies (handler-level test seam).
   */
  readonly aliasSource?: AliasModelSource;
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
      if (options.aliasSource === undefined) {
        const list = renderResponsesModelsList(
          options.models,
          created,
          new Set(options.providerIds),
        );
        return new Response(JSON.stringify(list), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // Alias-only discovery: every configured alias whose canonical target
      // is in the current served catalog snapshot, sorted by alias. The real
      // Provider id is exposed as owned_by; canonical model identity is never
      // projected independently from the configured alias string.
      const snapshot = await options.aliasSource.requestSnapshot();
      const callableTargets = new Set(
        options.models
          .getModels()
          .map((model) => canonicalTargetKey({ provider: model.provider, model: model.id })),
      );
      const data = snapshot
        .entries()
        .filter((entry) =>
          callableTargets.has(
            canonicalTargetKey({
              provider: entry.target.providerId,
              model: entry.target.modelId,
            }),
          ),
        )
        .sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0))
        .map((entry) => ({
          id: entry.alias,
          object: "model" as const,
          created,
          owned_by: entry.target.providerId,
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
    },
  });
}
