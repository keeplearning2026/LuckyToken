import type { Model, Models } from "@earendil-works/pi-ai";

export class ModelResolutionFailure extends Error {
  readonly kind = "ModelResolutionFailure";

  constructor(message: string) {
    super(message);
    this.name = "ModelResolutionFailure";
  }
}

export function resolveModel(
  models: Pick<Models, "getModels">,
  selector: string,
): Model<string> {
  const catalog = models.getModels();
  // Canonical "provider/id" full-string match (Pi model-resolver step 1).
  const qualified = catalog.filter(
    (model) => `${model.provider}/${model.id}` === selector,
  );
  if (qualified.length === 1) return qualified[0] as Model<string>;
  if (qualified.length > 1) {
    throw new ModelResolutionFailure(`Ambiguous qualified model selector: ${selector}`);
  }

  // "provider/model_id": only the first slash separates provider from model_id
  // (Pi model-resolver step 2). The model_id is everything after the first
  // slash and is matched against the full model.id.
  const slashIndex = selector.indexOf("/");
  if (slashIndex !== -1) {
    const provider = selector.substring(0, slashIndex).trim();
    const modelId = selector.substring(slashIndex + 1).trim();
    if (provider.length > 0 && modelId.length > 0) {
      const providerMatches = catalog.filter(
        (model) =>
          model.provider === provider && model.id === modelId,
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
  }

  // Bare model id (Pi model-resolver step 3).
  const unqualified = catalog.filter((model) => model.id === selector);
  if (unqualified.length === 1) return unqualified[0] as Model<string>;
  if (unqualified.length > 1) {
    throw new ModelResolutionFailure(`Ambiguous model selector: ${selector}`);
  }
  throw new ModelResolutionFailure(`Unknown model selector: ${selector}`);
}
