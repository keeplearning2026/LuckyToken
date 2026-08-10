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
  const qualified = catalog.filter(
    (model) => `${model.provider}/${model.id}` === selector,
  );
  if (qualified.length === 1) return qualified[0] as Model<string>;
  if (qualified.length > 1) {
    throw new ModelResolutionFailure(`Ambiguous qualified model selector: ${selector}`);
  }

  const unqualified = catalog.filter((model) => model.id === selector);
  if (unqualified.length === 1) return unqualified[0] as Model<string>;
  if (unqualified.length > 1) {
    throw new ModelResolutionFailure(`Ambiguous model selector: ${selector}`);
  }
  throw new ModelResolutionFailure(`Unknown model selector: ${selector}`);
}
