import type { Model, Models } from "@earendil-works/pi-ai";

export class ModelResolutionFailure extends Error {
  readonly kind = "ModelResolutionFailure";

  constructor(message: string) {
    super(message);
    this.name = "ModelResolutionFailure";
  }
}

/**
 * The single owner of the selector string format.
 *
 * Every model selector follows the `provider/model_id` convention: the first
 * slash splits the provider id from the model id, and everything after the
 * first slash is the model id (which may itself contain slashes). If the
 * selector format ever changes, this tool is the only place that needs to
 * change: `parse` (split) and `format` (join) are the two directions of the
 * same format knowledge, and `displayName` owns its presentation projection;
 * matching semantics stay in `resolveModel`.
 */
export interface ParsedModelSelector {
  readonly provider: string | undefined;
  readonly modelId: string;
}

export const selectorTool = {
  /** Split a selector into provider and model id. */
  parse(selector: string): ParsedModelSelector {
    const slashIndex = selector.indexOf("/");
    if (slashIndex === -1) {
      return { provider: undefined, modelId: selector.trim() };
    }
    return {
      provider: selector.substring(0, slashIndex).trim(),
      modelId: selector.substring(slashIndex + 1).trim(),
    };
  },
  /** Join a provider and a model id into a canonical selector string. */
  format(provider: string, modelId: string): string {
    return `${provider}/${modelId}`;
  },
  /** Project a qualified selector as a compact model-first display name. */
  displayName(selector: string): string {
    const { provider, modelId } = selectorTool.parse(selector);
    if (provider === undefined || provider.length === 0 || modelId.length === 0) {
      return selector;
    }
    return `${modelId} [${provider}]`;
  },
};

export function resolveModel(
  models: Pick<Models, "getModels">,
  selector: string,
): Model<string> {
  const catalog = models.getModels();
  const { provider, modelId } = selectorTool.parse(selector);
  // "provider/model_id": the first slash separates provider from model_id,
  // and the model_id (which may itself contain slashes) is matched against
  // the full model.id. This also covers the canonical "provider/id"
  // full-string form: splitting on the first slash yields exactly the same
  // provider and model id, so no separate concatenation step is needed.
  if (provider !== undefined && modelId.length > 0) {
    const providerMatches = catalog.filter(
      (model) => model.provider === provider && model.id === modelId,
    );
    if (providerMatches.length === 1) {
      return providerMatches[0] as Model<string>;
    }
    if (providerMatches.length > 1) {
      throw new ModelResolutionFailure(
        `Ambiguous model selector: ${selector}`,
      );
    }
  }

  // Bare model id (Pi model-resolver step 3).
  const unqualified = catalog.filter((model) => model.id === selector);
  if (unqualified.length === 1) return unqualified[0] as Model<string>;
  if (unqualified.length > 1) {
    throw new ModelResolutionFailure(`Ambiguous model selector: ${selector}`);
  }
  throw new ModelResolutionFailure(`Unknown model selector: ${selector}`);
}
