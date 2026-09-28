import type { CommandCodeModelCatalog } from "./catalog-file.js";
import type { CommandCodeResponsesStreamOptions } from "./models.js";

/**
 * Read-only, Provider-neutral view of the catalog's Provider Native wire
 * capabilities, keyed by the exact catalog model id. Provider scoping stays
 * with the caller that knows which Provider serves this catalog, so facts
 * never leak across Providers.
 */
export interface CommandCodeModelCapabilities {
  /**
   * Declared disposition for one model id. `undefined` means the catalog
   * declares none for that id, so the caller keeps the caller's own bytes.
   */
  responsesStreamOptions(
    modelId: string,
  ): CommandCodeResponsesStreamOptions | undefined;
}

/**
 * Project the validated catalog into the Token-owned capability view. The view
 * is deliberately separate from the Pi `Model`: no `Model` field, copy, clone,
 * or rebuild carries this wire policy.
 */
export function createCommandCodeModelCapabilities(
  catalog: CommandCodeModelCatalog,
): CommandCodeModelCapabilities {
  const responsesStreamOptionsById = new Map(
    catalog.models.map(
      (model) => [model.id, model.responsesStreamOptions] as const,
    ),
  );
  return Object.freeze({
    responsesStreamOptions: (modelId: string) =>
      responsesStreamOptionsById.get(modelId),
  });
}
